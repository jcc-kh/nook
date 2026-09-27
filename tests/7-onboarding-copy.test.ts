/**
 * Onboarding and check-in copy: tapbacks are always explained in words, calls
 * are never offered as an escalation step, legacy settings are migrated.
 */
import { describe, expect, test } from "bun:test";
import { copy, escalationOptions } from "../src/messenger/copy.ts";
import { escalationKeyword, parseIntent } from "../src/messenger/parse.ts";
import { normalizeNoResponseAction } from "../src/shared/settings.ts";
import { LEGEND, LEGEND_OPTIONS } from "../src/shared/templates.ts";
import { allText, harness, makeUser, START } from "./helpers.ts";

describe("onboarding copy", () => {
  test("welcome explains every tapback in words and asks for a name", () => {
    for (const s of ["👍 I'm good", "👎 Something feels off", "❓ Call me", "‼️ I need help now"]) {
      expect(copy.welcome).toContain(s);
    }
    expect(copy.welcome).toContain("First, what should I call you?");
  });

  test("escalation menu has no call option", () => {
    expect(escalationOptions).toEqual(["CONTACT_TRUSTED", "NONE"]);
    const menu = copy.askEscalation({ phone: "+15555550100", name: "Sam" });
    expect(menu).toContain("1. Text Sam your location");
    expect(menu).toContain("2. Keep checking in");
    expect(menu).not.toMatch(/\b3\./);
    expect(menu.toLowerCase()).not.toContain("call me");
    expect(menu).toContain("I'll alert Sam either way");
  });

  test("done() recap includes the tapbacks and the urgent-help line", () => {
    const done = copy.done(makeUser());
    expect(done).toContain(LEGEND_OPTIONS);
    expect(done).toContain("If you need urgent help, use ‼️");
    expect(done).toContain("send Sam your location");
  });

  test("trip start carries the legend and asks for an Apple Maps destination", () => {
    expect(copy.started).toContain(LEGEND);
    expect(copy.started).toContain("Apple Maps place or address");
  });

  test("Nook copy uses normal capitalization", () => {
    for (const text of [copy.welcome, copy.started, copy.nightOut, copy.dangerConfirm, copy.callStarting, copy.dangerResolved]) {
      expect(text.charAt(0)).toBe(text.charAt(0).toUpperCase());
    }
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
    expect(out).toContain("Are you okay");
    expect(out).toContain("does something feel off");
    expect(out).toContain("would you like me to call");
    expect(out).toContain("do you need urgent help");
  });
});
