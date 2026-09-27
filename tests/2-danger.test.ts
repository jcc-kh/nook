/**
 * Immediate danger: conservative classification, confirmation when ambiguous,
 * alert even with escalation NONE, no repeat alerts, "okay now" follow-up.
 */
import { describe, expect, test } from "bun:test";
import { classifyFallback, guardIntent } from "../src/llm/classify.ts";
import type { SafetyIntent } from "../src/shared/types.ts";
import { alerts, allText, calls, harness } from "./helpers.ts";

describe("classifier", () => {
  const kind = (t: string) => classifyFallback(t);

  test.each([
    "someone is chasing me",
    "he has a knife",
    "call 911",
    "i'm in danger",
    "he won't let me leave",
    "i got attacked",
  ])("clear danger: %s", (t) => {
    const i = kind(t);
    expect(i.kind).toBe("danger");
    expect(i.kind === "danger" && i.clear).toBe(true);
  });

  test.each(["help", "someone is following me", "sos"])("ambiguous danger: %s", (t) => {
    const i = kind(t);
    expect(i.kind).toBe("danger");
    expect(i.kind === "danger" && i.clear).toBe(false);
  });

  test.each(["someone walking behind me", "this street is sketchy", "i feel uneasy", "kinda scared"])(
    "uneasy, not danger: %s",
    (t) => expect(kind(t).kind).toBe("uneasy"),
  );

  test.each(["i'm not in danger", "no emergency, just walking"])("negated: %s", (t) => {
    expect(kind(t).kind).not.toBe("danger");
  });

  test("Gemini can't raise clear danger on its own", () => {
    const regex: SafetyIntent = { kind: "unclear" };
    const out = guardIntent(regex, { kind: "danger", clear: true });
    expect(out).toMatchObject({ kind: "danger", clear: false });
  });

  test("Gemini can't erase a regex danger signal", () => {
    const regex: SafetyIntent = { kind: "danger", clear: true, quote: "he has a knife" };
    expect(guardIntent(regex, { kind: "safe" })).toMatchObject({ kind: "danger", clear: true });
    const ambiguous: SafetyIntent = { kind: "danger", clear: false };
    expect(guardIntent(ambiguous, { kind: "safe" })).toMatchObject({ kind: "danger", clear: false });
  });
});

describe("engine danger flow", () => {
  test("ambiguous → confirm first, no alert; 'yes' → alert with confirmation", async () => {
    const h = harness();
    await h.startWalk();
    const first = await h.text("someone is following me");
    expect(alerts(first)).toHaveLength(0);
    expect(allText(first)).toContain("immediate danger");
    const yes = await h.text("yes");
    const [alert] = alerts(yes);
    expect(alert?.emergency).toBe(true);
    expect(alert?.text).toContain("someone is following me");
    expect(alert?.text).toContain('answered "yes"');
    expect(allText(yes)).toContain("911");
  });

  test("ambiguous → 'no' never alerts and settles on uneasy", async () => {
    const h = harness();
    await h.startWalk();
    await h.text("help");
    const no = await h.text("no");
    expect(alerts(no)).toHaveLength(0);
    expect(h.rt().safety).not.toBe("immediate_danger");
  });

  test("ambiguous → ‼️ confirms", async () => {
    const h = harness();
    await h.startWalk();
    await h.text("help");
    const out = await h.react("‼️");
    expect(alerts(out)[0]?.text).toContain("tapped ‼️ when nook asked");
  });

  test("escalation NONE still alerts the trusted contact in immediate danger", async () => {
    const h = harness({ user: { escalation: { initialAction: "TEXT_USER", onNoTextResponse: "NONE" } } });
    await h.startWalk();
    const out = await h.react("‼️");
    expect(alerts(out).filter((a) => a.emergency)).toHaveLength(1);
  });

  test("no trusted contact: no alert, still told to call 911", async () => {
    const h = harness({ user: { trustedContact: undefined, contact: undefined } });
    await h.startWalk();
    const out = await h.react("‼️");
    expect(alerts(out)).toHaveLength(0);
    expect(allText(out)).toContain("911");
    expect(allText(out)).toContain("don't have a trusted contact");
  });

  test("repeated danger doesn't re-alert", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("‼️");
    const again = await h.text("someone is chasing me");
    expect(alerts(again)).toHaveLength(0);
    expect(allText(again)).toContain("still here");
  });

  test("danger with no open walk still alerts (starts a trip)", async () => {
    const h = harness();
    await h.ping();
    const out = await h.text("he has a knife");
    expect(alerts(out).filter((a) => a.emergency)).toHaveLength(1);
    expect(calls(out)).toHaveLength(0);
  });

  test("'i'm okay' after an alert updates the contact", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("‼️");
    const ok = await h.text("i'm safe now");
    const [update] = alerts(ok);
    expect(update?.followUp).toBe(true);
    expect(update?.text).toContain("they're okay");
    expect(h.rt().safety).toBe("safe");
  });

  test("'stop' doesn't dismiss Nook during immediate danger", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("‼️");
    await h.text("stop");
    expect(h.rt().safety).toBe("immediate_danger");
    expect(h.walkId()).not.toBeNull();
  });

  test("'going to call 911' is danger, not a destination", async () => {
    const h = harness();
    await h.startWalk();
    const out = await h.text("i'm going to call 911");
    expect(h.rt().destination).toBeNull();
    expect(h.rt().safety).toBe("immediate_danger");
    expect(alerts(out)).toHaveLength(1);
  });
});
