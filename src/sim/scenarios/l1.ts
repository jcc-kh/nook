/**
 * L1 scenario suite: R1, R2, R2x, R3, R4, R14 (arrival texts the user, not the contact)
 * Usage: bun run sim:l1
 */
import { SimClock } from "../../shared/clock.ts";
import { createBrainEngine } from "../../brain/engine.ts";
import { closePool, query } from "../../store/db.ts";
import { upsertDemoUser, countPings } from "../../store/users.ts";
import { DEMO, DEMO_ORIGIN } from "../demo.ts";
import { playRoute, walkingPoints } from "../playback.ts";
import type { Action, LocationPing, UserText } from "../../shared/types.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function countRule(ruleId: string): Promise<number> {
  const res = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM events WHERE user_id = $1 AND rule_id = $2`,
    [DEMO.userId, ruleId],
  );
  return Number(res.rows[0]?.n ?? 0);
}

function nightStart(): Date {
  // A Tuesday 22:30 America/New_York — use fixed UTC that is 22:30 ET (EDT = UTC-4)
  return new Date("2026-04-14T02:30:00.000Z"); // 22:30 EDT Apr 13
}

function dayStart(): Date {
  return new Date("2026-04-13T18:00:00.000Z"); // 14:00 EDT
}

async function main() {
  await upsertDemoUser({ ...DEMO });
  await query(
    `UPDATE walks SET ended_at = COALESCE(ended_at, now()), status = 'ENDED_ELSEWHERE',
            duration_s = COALESCE(duration_s, 1)
     WHERE user_id = $1 AND ended_at IS NULL`,
    [DEMO.userId],
  );
  const clock = new SimClock(nightStart());
  const getUser = async () => ({
    userId: DEMO.userId,
    handle: DEMO.handle,
    contact: DEMO.contact,
    homeLat: DEMO.homeLat,
    homeLon: DEMO.homeLon,
    nightStart: DEMO.nightStart,
    nightEnd: DEMO.nightEnd,
    tz: DEMO.tz,
    displayName: DEMO.displayName,
  });
  const brain = createBrainEngine({ clock, getUser, persist: true });

  const before = await countPings(DEMO.userId);

  // --- R1 daytime: pings stored, no SendText ---
  clock.set(dayStart());
  const dayPts = walkingPoints(DEMO_ORIGIN, {
    lat: DEMO_ORIGIN.lat + 0.002,
    lon: DEMO_ORIGIN.lon,
  });
  const r1Actions: Action[] = [];
  await playRoute({
    clock,
    start: dayStart(),
    userId: DEMO.userId,
    points: dayPts,
    onPing: async (ping: LocationPing) => {
      r1Actions.push(...(await brain.handle(ping)));
    },
  });
  assert(
    r1Actions.filter((a) => a.type === "SendText").length === 0,
    "R1: expected no SendText in daytime",
  );
  const afterR1 = await countPings(DEMO.userId);
  assert(afterR1 > before, "R1: expected pings to increase");
  console.log("R1 ok");

  // --- R2 night auto-start (no 👍 required) ---
  // Stay >150 m from home the whole time (home - 0.003 ≈ 333 m)
  const farOrigin = { lat: DEMO.homeLat - 0.004, lon: DEMO.homeLon };
  const walkPts = walkingPoints(
    farOrigin,
    { lat: farOrigin.lat + 0.0012, lon: farOrigin.lon },
    { speedMps: 1.3, intervalS: 15 },
  );
  const last = walkPts[walkPts.length - 1]!;
  if (last.tOffsetMs < 130_000) {
    walkPts.push({
      tOffsetMs: 130_000,
      lat: last.lat + 0.0002,
      lon: last.lon,
    });
  }

  clock.set(nightStart());
  let promptActions: Action[] = [];
  await playRoute({
    clock,
    start: nightStart(),
    userId: DEMO.userId,
    points: walkPts,
    onPing: async (ping: LocationPing) => {
      promptActions.push(...(await brain.handle(ping)));
    },
  });
  const starts = promptActions.filter(
    (a) => a.type === "SendText" && a.tag === "started",
  );
  assert(starts.length === 1, `R2: expected 1 started, got ${starts.length}`);
  assert(brain.getPhase(DEMO.userId) === "WALKING", "R2: expected WALKING");
  assert((await countRule("R2")) >= 1, "R2: events row missing");
  console.log("R2 ok");

  // R2 again while already walking — no second start
  clock.advance(5 * 60_000);
  const again = await brain.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: farOrigin.lat + 0.002,
    lon: farOrigin.lon,
  });
  assert(
    again.filter((a: Action) => a.type === "SendText" && a.tag === "started").length === 0,
    "R2: second start while already walking",
  );
  console.log("R2 no-double-start ok");
  await brain.resetUser(DEMO.userId);

  // --- R2x vehicle ---
  const brain2 = createBrainEngine({ clock, getUser, persist: true });
  clock.set(new Date(nightStart().getTime() + 3 * 60 * 60_000));
  const fast = walkingPoints(farOrigin, {
    lat: farOrigin.lat + 0.01,
    lon: farOrigin.lon,
  }, { speedMps: 8, intervalS: 5 });
  let fastActions: Action[] = [];
  await playRoute({
    clock,
    start: clock.now(),
    userId: DEMO.userId,
    points: fast,
    onPing: async (ping: LocationPing) => {
      fastActions = await brain.handle(ping);
    },
  });
  // use brain2 for clean IDLE state
  await playRoute({
    clock,
    start: new Date(nightStart().getTime() + 4 * 60 * 60_000),
    userId: DEMO.userId,
    points: fast,
    onPing: async (ping: LocationPing) => {
      fastActions = await brain2.handle(ping);
    },
  });
  assert(
    fastActions.filter((a: Action) => a.type === "SendText" && (a.tag === "prompt" || a.tag === "started"))
      .length === 0,
    "R2x: vehicle should not start a walk",
  );
  console.log("R2x ok");

  // --- R3: soft-rejoin overdue walk instead of "Still out? Getting worried" ---
  const brain3 = createBrainEngine({ clock, getUser, persist: true });
  clock.set(new Date(nightStart().getTime() + 5 * 60 * 60_000));
  await playRoute({
    clock,
    start: clock.now(),
    userId: DEMO.userId,
    points: walkPts,
    onPing: async (ping: LocationPing) => {
      await brain3.handle(ping);
    },
  });
  assert(brain3.getPhase(DEMO.userId) === "WALKING", "R3 setup: WALKING after night start");
  // Simulate a restart: new engine hydrates the same open walk after it's past lateMin
  const rt = brain3.getRuntime(DEMO.userId);
  const lateMin = rt.plan?.lateMin ?? 20;
  clock.advance((lateMin + 15) * 60_000);
  const brain3b = createBrainEngine({ clock, getUser, persist: true });
  const rejoin = await brain3b.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: farOrigin.lat + 0.002,
    lon: farOrigin.lon,
  });
  assert(brain3b.getPhase(DEMO.userId) === "WALKING", "R3 soft-rejoin: WALKING");
  assert(
    rejoin.some(
      (a: Action) =>
        a.type === "SendText" &&
        a.tag === "started" &&
        /back with you on this trip/i.test(a.text),
    ),
    "R3 soft-rejoin: expected softRejoin, not worried check-in",
  );
  assert(
    !rejoin.some(
      (a: Action) => a.type === "SendText" && /getting worried/i.test(a.text),
    ),
    "R3 soft-rejoin: must not send worried check-in",
  );
  console.log("R3 soft-rejoin ok");
  await brain3b.resetUser(DEMO.userId);

  // --- R4 walk me home at noon ---
  const brain4 = createBrainEngine({ clock, getUser, persist: true });
  clock.set(dayStart());
  const text: UserText = {
    type: "UserText",
    userId: DEMO.userId,
    messageId: "t1",
    text: "walk me home",
    time: clock.now(),
  };
  await brain4.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: DEMO_ORIGIN.lat,
    lon: DEMO_ORIGIN.lon,
  });
  await brain4.handle(text);
  assert(brain4.getPhase(DEMO.userId) === "WALKING", "R4: expected WALKING");
  assert((await countRule("R4")) >= 1, "R4 event");
  console.log("R4 ok");

  // --- R14 arrive home ---
  await brain4.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: DEMO.homeLat,
    lon: DEMO.homeLon,
  });
  clock.advance(10_000);
  const arriveActions = await brain4.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: DEMO.homeLat + 0.00001,
    lon: DEMO.homeLon,
  });
  assert(
    arriveActions.some((a: Action) => a.type === "SendText" && a.tag === "arrived"),
    "R14: expected arrived text to the user",
  );
  assert(
    !arriveActions.some((a: Action) => a.type === "AlertContact"),
    "R14: contact must not be texted on arrival",
  );
  assert(brain4.getPhase(DEMO.userId) === "IDLE", "R14: expected IDLE");
  assert((await countRule("R14")) >= 1, "R14 event");
  console.log("R14 ok");

  console.log("\n[sim:l1] all passed");
  await closePool();
}

main().catch(async (err) => {
  console.error("[sim:l1] failed:", err);
  await closePool().catch(() => {});
  process.exit(1);
});
