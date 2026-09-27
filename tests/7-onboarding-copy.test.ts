/**
 * Onboarding and check-in copy: tapbacks are always explained in words, calls
 * are never offered as an escalation step, legacy settings are migrated.
 */
import { describe, expect, test } from "bun:test";
import { copy, escalationOptions } from "../src/messenger/copy.ts";
import { escalationKeyword, parseIntent } from "../src/messenger/parse.ts";
import { normalizeNoResponseAction } from "../src/shared/settings.ts";
import { LEGEND } from "../src/shared/templates.ts";
import { allText, harness, makeUser, START } from "./helpers.ts";

describe("onboarding copy", () => {
  test("welcome explains every tapback in words", () => {
    for (const s of ["👍 safe", "👎 uneasy", "❓ call me", "‼️ immediate danger", "911"]) {
      expect(copy.welcome).toContain(s);
    }
  });

  test("escalation menu has no call option", () => {
    expect(escalationOptions).toEqual(["CONTACT_TRUSTED", "NONE"]);
    const menu = copy.askEscalation({ phone: "+15555550100", name: "Sam" });
    expect(menu).toContain("1. text Sam my location");
    expect(menu).toContain("2. just keep checking in");
    expect(menu).not.toMatch(/\b3\./);
    expect(menu.toLowerCase()).not.toContain("call me");
    expect(menu).toContain("‼️");
  });

  test("done() recap includes the legend and the 911 line", () => {
    const done = copy.done(makeUser());
    expect(done).toContain(LEGEND);
    expect(done).toContain("911");
  });

  test("trip start asks for an Apple Maps destination and mentions calls", () => {
    expect(copy.started).toContain(LEGEND);
    expect(copy.started).toContain("apple maps");
    expect(copy.started).toContain("call");
  });
});

describe("settings migration", () => {
  test("legacy call steps map to text-only equivalents", () => {
    expect(normalizeNoResponseAction("CALL_THEN_CONTACT")).toBe("CONTACT_TRUSTED");
    expect(normalizeNoResponseAction("CALL_USER")).toBe("NONE");
    expect(normalizeNoResponseAction("CONTACT_TRUSTED")).toBe("CONTACT_TRUSTED");
    expect(normalizeNoResponseAction("NONE")).toBe("NONE");
  });

  test("escalation answers only yield text options", () => {
    const pick = escalationKeyword("Sam");
    expect(pick("text sam")).toBe("CONTACT_TRUSTED");
    expect(pick("just keep checking in")).toBe("NONE");
    expect(pick("call me")).toBeUndefined();
  });

  test("'call me' is a call request, 'call me Alex' renames", () => {
    expect(parseIntent("call me")).toBeNull();
    expect(parseIntent("call me now")).toBeNull();
    expect(parseIntent("call me i'm lost")).toBeNull();
    expect(parseIntent("call me Alex")).toEqual({ kind: "name", name: "Alex" });
  });
});

describe("check-in copy", () => {
  test("every check-in carries the legend", async () => {
    const h = harness({ user: { timeouts: { nudgeAfterSec: 30, escalateAfterSec: 30 } } });
    await h.startWalk();
    await h.ping({ lat: START.lat + 0.001, lon: START.lon });
    let checkin = "";
    for (let i = 0; i < 20 && !checkin; i++) {
      h.clock.advance(30_000);
      checkin = allText(await h.tick());
    }
    expect(checkin.length).toBeGreaterThan(0);
    expect(checkin).toContain(LEGEND);
  });

  test("unclear reply spells out all four options", async () => {
    const h = harness();
    await h.startWalk();
    const out = allText(await h.text("asdfgh"));
    expect(out).toMatch(/okay|safe/);
    expect(out).toContain("uneasy");
    expect(out).toContain("call");
    expect(out).toContain("immediate danger");
  });
});
