/**
 * Fixture navigation: routes, off-route reroute with cooldown, stale fixes,
 * safe destinations, Apple Maps links, and the uneasy "busier" flow.
 */
import { describe, expect, test } from "bun:test";
import { parseMapsLink } from "../src/messenger/parse.ts";
import { createFixtureProvider, createNavService } from "../src/nav/index.ts";
import { locateOnRoute } from "../src/nav/geometry.ts";
import { alerts, allText, harness, HOME, NAV_CONFIG, START } from "./helpers.ts";

const T0 = new Date("2026-04-14T02:30:00.000Z");
const homeDest = { name: "home", ...HOME, source: "home" };

describe("fixture provider", () => {
  const provider = createFixtureProvider();

  test("route from Amsterdam to home has hand-written steps", async () => {
    const r = await provider.route(START, homeDest);
    expect(r).not.toBeNull();
    expect(r!.steps.length).toBeGreaterThanOrEqual(2);
    expect(r!.steps.length).toBeLessThanOrEqual(4);
    expect(r!.steps[0]!.instruction).toContain("Amsterdam");
  });

  test("locateOnRoute snaps a point on the path", async () => {
    const r = (await provider.route(START, homeDest))!;
    const pos = locateOnRoute(r, { lat: 40.8045, lon: -73.96266 });
    expect(pos).not.toBeNull();
    expect(pos!.offRouteM).toBeLessThan(40);
    expect(pos!.stepIndex).toBe(0);
  });

  test("closed places are never offered", async () => {
    const nav = createNavService(provider, NAV_CONFIG);
    const places = await nav.findSafeDestinations(START);
    expect(places.length).toBeGreaterThan(0);
    expect(places.length).toBeLessThanOrEqual(3);
    expect(places.some((p) => p.id === "pastry")).toBe(false);
    expect(places[0]!.walkMin).toBeGreaterThan(0);
  });
});

describe("navigation updates", () => {
  test("fresh fix → one instruction; stale fix → no instruction", async () => {
    const nav = createNavService(createFixtureProvider(), NAV_CONFIG);
    const fresh = await nav.navigationUpdate({ key: "w1", position: { ...START, time: T0 }, destination: homeDest, now: T0 });
    expect(fresh.navigationFresh).toBe(true);
    expect(fresh.instruction).toBeTruthy();
    expect(fresh.remaining!.distanceM).toBeGreaterThan(100);

    const stale = await nav.navigationUpdate({
      key: "w1",
      position: { ...START, time: T0 },
      destination: homeDest,
      now: new Date(T0.getTime() + 45_000),
    });
    expect(stale.navigationFresh).toBe(false);
    expect(stale.contextFresh).toBe(true);
    expect(stale.instruction).toBeNull();
    expect(stale.note).toBeTruthy();
  });

  test("off route > 60 m reroutes, but not again inside the cooldown", async () => {
    const nav = createNavService(createFixtureProvider(), NAV_CONFIG);
    await nav.navigationUpdate({ key: "w2", position: { ...START, time: T0 }, destination: homeDest, now: T0 });
    // ~150 m west of Amsterdam
    const off = { lat: 40.8035, lon: -73.9660 };
    const t1 = new Date(T0.getTime() + 30_000);
    const a = await nav.navigationUpdate({ key: "w2", position: { ...off, time: t1 }, destination: homeDest, now: t1 });
    expect(a.rerouted).toBe(true);
    const off2 = { lat: 40.8030, lon: -73.9672 };
    const t2 = new Date(t1.getTime() + 5_000);
    const b = await nav.navigationUpdate({ key: "w2", position: { ...off2, time: t2 }, destination: homeDest, now: t2 });
    expect(b.rerouted).toBe(false);
  });

  test("arrival within 30 m", async () => {
    const nav = createNavService(createFixtureProvider(), NAV_CONFIG);
    const u = await nav.navigationUpdate({ key: "w3", position: { ...HOME, time: T0 }, destination: homeDest, now: T0 });
    expect(u.arrived).toBe(true);
  });
});

describe("Apple Maps links", () => {
  test("full maps.apple.com place link", () => {
    const l = parseMapsLink("https://maps.apple.com/?ll=40.805206,-73.965782&q=Tom%27s%20Restaurant");
    expect(l).toMatchObject({ lat: 40.805206, lon: -73.965782, name: "Tom's Restaurant" });
  });

  test("directions link uses the destination", () => {
    const l = parseMapsLink("https://maps.apple.com/?daddr=40.805992,-73.965207&dirflg=w");
    expect(l).toMatchObject({ lat: 40.805992, lon: -73.965207 });
  });

  test("address-only link", () => {
    const l = parseMapsLink("https://maps.apple.com/?address=2880%20Broadway,%20New%20York");
    expect(l?.address).toContain("2880 Broadway");
  });

  test("short links are flagged (expansion not supported yet)", () => {
    expect(parseMapsLink("https://maps.apple/p/abc123")?.short).toBe(true);
  });

  test("plain text is not a link", () => {
    expect(parseMapsLink("heading to toms")).toBeNull();
  });
});

describe("engine: uneasy → busier / destination", () => {
  test("busier: offers open places, number picks one, arrival is acknowledged", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("👎");
    const opts = await h.text("busier");
    expect(allText(opts)).toContain("1.");
    expect(allText(opts)).not.toContain("Hungarian Pastry");
    const picked = await h.text("1");
    expect(h.rt().routeChoice).toBe("busier");
    expect(h.rt().interim).not.toBeNull();
    expect(allText(picked)).toContain(h.rt().interim!.name);
    expect(alerts(picked)).toHaveLength(0);
  });

  test("keep going: stays on the way home with an instruction", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("👎");
    const out = await h.text("keep going");
    expect(h.rt().routeChoice).toBe("destination");
    expect(allText(out)).toContain("keep heading to home");
  });

  test("shared Apple Maps place becomes the trip destination", async () => {
    const h = harness();
    await h.startWalk();
    const out = await h.text("https://maps.apple.com/?ll=40.805206,-73.965782&q=Tom%27s%20Restaurant");
    expect(h.rt().destination?.name).toBe("Tom's Restaurant");
    expect(allText(out)).toContain("Tom's Restaurant");
  });

  test("unreadable short link asks for the full link", async () => {
    const h = harness();
    await h.startWalk();
    const out = await h.text("https://maps.apple/p/abc123");
    expect(allText(out)).toContain("couldn't read that link");
  });

  test("voice tools: safe destinations → set destination → navigation", async () => {
    const h = harness();
    await h.startWalk();
    const walkId = h.walkId()!;
    const list = (await h.brain.safeDestinations(walkId)) as { ok: boolean; places: { place_id: string }[] };
    expect(list.ok).toBe(true);
    const pick = list.places[0]!.place_id;
    const set = (await h.brain.setDestination(walkId, pick)) as { ok: boolean; navigation: { instruction: string | null } };
    expect(set.ok).toBe(true);
    expect(set.navigation.instruction).toBeTruthy();
    const nav = (await h.brain.navigation(walkId)) as { destination: { name: string } | null };
    expect(nav.destination?.name).toBe(h.rt().interim!.name);
  });
});
