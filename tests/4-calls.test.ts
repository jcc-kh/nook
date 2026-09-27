/**
 * Calls are opt-in only: silence never places a call, a call that ends badly
 * never alerts anyone, and "call me" without a call transport answers by text.
 */
import { describe, expect, test } from "bun:test";
import type { Action } from "../src/shared/types.ts";
import { alerts, allText, calls, harness, START } from "./helpers.ts";

async function runSilence(h: ReturnType<typeof harness>): Promise<Action[]> {
  await h.startWalk();
  await h.ping({ lat: START.lat + 0.001, lon: START.lon });
  const all: Action[] = [];
  for (let i = 0; i < 40; i++) {
    h.clock.advance(30_000);
    all.push(...(await h.tick()));
  }
  return all;
}

describe("calls never escalate", () => {
  test("CONTACT_TRUSTED: silence → nudge → contact text, never a call", async () => {
    const h = harness({ user: { timeouts: { nudgeAfterSec: 30, escalateAfterSec: 30 } } });
    const all = await runSilence(h);
    expect(allText(all).length).toBeGreaterThan(0);
    expect(calls(all)).toHaveLength(0);
    expect(alerts(all).length).toBeGreaterThanOrEqual(1);
    expect(alerts(all).every((a) => !a.emergency)).toBe(true);
  });

  test("NONE: silence → nudges only, no call, no contact", async () => {
    const h = harness({
      user: {
        escalation: { initialAction: "TEXT_USER", onNoTextResponse: "NONE" },
        timeouts: { nudgeAfterSec: 30, escalateAfterSec: 30 },
      },
    });
    const all = await runSilence(h);
    expect(calls(all)).toHaveLength(0);
    expect(alerts(all)).toHaveLength(0);
  });

  test("ended_unresolved sends a text check-in and never alerts", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("❓");
    expect(h.phase()).toBe("CALLING");
    const out = await h.call("ended_unresolved");
    expect(alerts(out)).toHaveLength(0);
    expect(allText(out)).toContain("Everything okay?");
    expect(h.phase()).not.toBe("CALLING");
    // ...and ignoring that check-in follows the normal text path, still no call.
    const later: Action[] = [];
    for (let i = 0; i < 20; i++) {
      h.clock.advance(30_000);
      later.push(...(await h.tick()));
    }
    expect(calls(later)).toHaveLength(0);
  });

  test("resolved_safe goes back to walking quietly", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("❓");
    const out = await h.call("resolved_safe");
    expect(alerts(out)).toHaveLength(0);
    expect(h.phase()).toBe("WALKING");
  });

  test("request_escalation on a call = immediate danger, call stays up", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("❓");
    const out = await h.call("request_escalation", "a man grabbed my arm");
    const [alert] = alerts(out);
    expect(alert?.emergency).toBe(true);
    expect(alert?.text).toContain("a man grabbed my arm");
    expect(h.phase()).toBe("CALLING");
  });

  test("call events for another walk are ignored", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("❓");
    const out = await h.call("ended_unresolved", undefined, "some-old-walk");
    expect(out).toHaveLength(0);
    expect(h.phase()).toBe("CALLING");
  });

  test("calls not configured → text reply, no StartCall, not stuck CALLING", async () => {
    const h = harness({ callsEnabled: false });
    await h.startWalk();
    const out = await h.text("call me");
    expect(calls(out)).toHaveLength(0);
    expect(allText(out)).toContain("can't place a call");
    expect(h.phase()).not.toBe("CALLING");
  });

  test("call vars carry reason, state, context and an opening line", async () => {
    const h = harness();
    await h.startWalk();
    await h.text("i feel uneasy");
    const [start] = calls(await h.text("call me"));
    expect(start?.vars.callReason).toBe("uneasy_companion");
    expect(start?.vars.safetyState).toBe("uneasy");
    expect(start?.vars.recentContext).toContain("i feel uneasy");
    expect(start?.vars.openingLine).toContain("somewhere with more people around");
    expect(start?.vars.lat).toBeCloseTo(START.lat, 4);
  });
});
