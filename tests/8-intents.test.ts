/**
 * One SafetyIntent for every input method, deterministic rules first, and all
 * state changes in applyIntent: classification, context replies, precedence,
 * negation, transitions, idempotency, and text / voice-note parity.
 */
import { describe, expect, test } from "bun:test";
import { classifyLocal, reactionIntent } from "../src/llm/classify.ts";
import type { Action, Awaiting, ClassifyContext, RouteChoice } from "../src/shared/types.ts";
import { alerts, allText, calls, harness, texts } from "./helpers.ts";

const ctx = (awaiting: Awaiting = null): ClassifyContext => ({ safetyState: "safe", awaiting, recent: [] });
const classify = (t: string, awaiting: Awaiting = null) => classifyLocal(t, ctx(awaiting)).intent;

describe("classifier: one intent per meaning", () => {
  test.each(["I'm okay", "all good", "I'm safe now"])("safe: %s", (t) => expect(classify(t).kind).toBe("safe"));

  test("👍 👎 ❓ ‼️ map to safe / uneasy / call / clear danger", () => {
    expect(reactionIntent("👍")?.kind).toBe("safe");
    expect(reactionIntent("👎")?.kind).toBe("uneasy");
    expect(reactionIntent("❓")?.kind).toBe("call");
    expect(reactionIntent("‼️")).toMatchObject({ kind: "danger", clear: true });
  });

  test.each(["I'm not okay", "I'm not safe"])("negated safe is not safe: %s", (t) => {
    expect(classify(t).kind).not.toBe("safe");
  });

  test.each(["this area feels weird", "it's really dark", "there's nobody around", "I feel uncomfortable"])(
    "uneasy: %s",
    (t) => expect(classify(t).kind).toBe("uneasy"),
  );

  test.each(["someone is walking behind me", "I think someone might be following me", "help", "I'm scared"])(
    "ambiguous never becomes clear danger: %s",
    (t) => {
      const i = classify(t);
      expect(i.kind === "danger" && i.clear).toBe(false);
      expect(["uneasy", "danger"]).toContain(i.kind);
    },
  );

  test.each(["someone is chasing me", "he has a knife", "I've been attacked", "I'm in immediate danger"])(
    "clear danger: %s",
    (t) => expect(classify(t)).toMatchObject({ kind: "danger", clear: true, quote: t }),
  );

  test("danger quote keeps the user's exact words", () => {
    const t = "I think this guy might be following me.";
    expect(classify(t)).toMatchObject({ kind: "danger", clear: false, quote: t });
  });

  test.each(["call me", "can you call"])("call: %s", (t) => expect(classify(t).kind).toBe("call"));

  test.each<[string, RouteChoice]>([
    ["keep going", "destination"],
    ["busier", "busier"],
    ["find somewhere open", "busier"],
  ])("route choice: %s", (t, choice) => expect(classify(t)).toEqual({ kind: "route_choice", choice }));

  test.each(["stop", "stop checking in", "stop tracking this trip"])("stop: %s", (t) => {
    expect(classify(t).kind).toBe("stop");
  });

  test("\"stop following me\" is not a stop request", () => {
    expect(classify("stop following me").kind).not.toBe("stop");
  });
});

describe("classifier: short replies depend on the open question", () => {
  test("danger confirmation: yes → clear danger, no → uneasy", () => {
    expect(classify("yes", "danger_confirmation")).toMatchObject({ kind: "danger", clear: true });
    expect(classify("no", "danger_confirmation").kind).toBe("uneasy");
  });

  test("route question: a bare yes is not a choice", () => {
    expect(classify("yes", "route_choice").kind).toBe("unclear");
    expect(classify("ok", "route_choice").kind).toBe("unclear");
    expect(classify("keep going", "route_choice")).toEqual({ kind: "route_choice", choice: "destination" });
  });

  test("check-in: yeah → safe, no → uneasy (never immediate danger)", () => {
    expect(classify("yeah", "checkin").kind).toBe("safe");
    expect(classify("no", "checkin").kind).toBe("uneasy");
  });

  test("a bare yes during setup-like context is not danger", () => {
    expect(classify("yes").kind).not.toBe("danger");
  });

  test("context replies are labelled as such", () => {
    expect(classifyLocal("yes", ctx("danger_confirmation")).classifier).toBe("context");
  });
});

describe("classifier: precedence and negation", () => {
  test("uneasy + call → call, flagged uneasy", () => {
    expect(classify("this place feels weird, call me")).toMatchObject({ kind: "call", uneasy: true, reason: "uneasy_companion" });
    expect(classify("I'm scared, can you call me?")).toMatchObject({ kind: "call", uneasy: true });
  });

  test("clear danger beats a call request", () => {
    expect(classify("someone is chasing me, call me")).toMatchObject({ kind: "danger", clear: true, wantsCall: true });
  });

  test("\"I'm okay, don't call me\" → safe", () => expect(classify("I'm okay, don't call me").kind).toBe("safe"));
  test("\"Don't call me\" is not a call", () => expect(classify("Don't call me").kind).not.toBe("call"));
  test("\"I'm not in danger, I just feel weird here\" → uneasy", () => {
    expect(classify("I'm not in danger, I just feel weird here").kind).toBe("uneasy");
  });
  test("\"I thought someone was following me but I'm okay now\" → safe", () => {
    expect(classify("I thought someone was following me but I'm okay now").kind).toBe("safe");
  });
  test("\"I don't need help anymore\" → safe", () => expect(classify("I don't need help anymore").kind).toBe("safe"));
  test("\"no one is chasing me\" is not danger", () => expect(classify("no one is chasing me").kind).not.toBe("danger"));
});

describe("transitions", () => {
  test("uneasy: no contact, no call, route question, call offered once", async () => {
    const h = harness();
    await h.startWalk();
    const first = await h.text("this area feels weird");
    expect(h.rt().safety).toBe("uneasy");
    expect(alerts(first)).toHaveLength(0);
    expect(calls(first)).toHaveLength(0);
    expect(allText(first)).toContain("Do you want to keep heading home");
    expect(allText(first)).toContain("I can call and guide you");
    const again = await h.text("it's really dark");
    expect(allText(again)).toContain("keep going, find somewhere with more people around, or have me call?");
    expect(allText(again)).not.toContain("I can call and guide you");
  });

  test("uneasy with a stated preference skips the question", async () => {
    const h = harness();
    await h.startWalk();
    const out = await h.text("this street is sketchy, I want somewhere busier");
    expect(h.rt().safety).toBe("uneasy");
    expect(h.rt().routeChoice).toBe("busier");
    expect(allText(out)).not.toContain("Do you want to keep heading");
    expect(allText(out)).toContain("appear to be open");
  });

  test("\"this place feels weird, call me\" → uneasy and a call, no alert", async () => {
    const h = harness();
    await h.startWalk();
    const out = await h.text("this place feels weird, call me");
    expect(h.rt().safety).toBe("uneasy");
    expect(calls(out)).toHaveLength(1);
    expect(calls(out)[0]?.vars.callReason).toBe("uneasy_companion");
    expect(alerts(out)).toHaveLength(0);
  });

  test("a plain call request doesn't change safety", async () => {
    const h = harness();
    await h.startWalk();
    const out = await h.text("call me");
    expect(h.rt().safety).toBe("safe");
    expect(calls(out)).toHaveLength(1);
    expect(allText(out)).not.toContain("911");
  });

  test("\"someone is chasing me, call me\" → danger, alert, no Nook call", async () => {
    const h = harness();
    await h.startWalk();
    const out = await h.text("someone is chasing me, call me");
    expect(h.rt().safety).toBe("immediate_danger");
    expect(calls(out)).toHaveLength(0);
    expect(alerts(out).filter((a) => a.emergency)).toHaveLength(1);
    expect(allText(out)).toBe("Call 911 now if you can. I'm sending Sam your current location and what you told me.");
  });

  test("confirmed danger guidance: 911, contact, voice message; no call offer", async () => {
    const h = harness();
    await h.startWalk();
    const out = allText(await h.text("he has a knife"));
    expect(out).toContain("Call 911 now if you can.");
    expect(out).toContain("I'm sending Sam your current location and what you told me.");
    expect(out).toContain("send me a quick voice message");
    expect(out.toLowerCase()).not.toContain("call me");
  });

  test("call request during immediate danger starts no call", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("‼️");
    for (const out of [await h.text("call me"), await h.react("❓")]) {
      expect(calls(out)).toHaveLength(0);
      expect(allText(out)).toContain("call 911 now");
    }
    expect(h.rt().safety).toBe("immediate_danger");
  });

  test("an existing call carries on when danger becomes clear", async () => {
    const h = harness();
    await h.startWalk();
    await h.text("call me");
    await h.call("started");
    const out = await h.text("someone is chasing me");
    expect(h.phase()).toBe("CALLING");
    expect(calls(out)).toHaveLength(0);
    expect(alerts(out).filter((a) => a.emergency)).toHaveLength(1);
  });

  test("\"I'm okay, don't call me\" → safe, no call", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("👎");
    const out = await h.text("I'm okay, don't call me");
    expect(h.rt().safety).toBe("safe");
    expect(calls(out)).toHaveLength(0);
  });

  test("ambiguous danger asks the yes/no question and waits", async () => {
    const h = harness();
    await h.startWalk();
    const out = await h.text("I think someone might be following me");
    expect(texts(out)).toEqual(["Are you in immediate danger right now? Reply yes or no."]);
    expect(alerts(out)).toHaveLength(0);
    expect(h.rt().safety).not.toBe("immediate_danger");
  });

  test("route choice: destination and busier", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("👎");
    const keep = await h.text("keep going");
    expect(h.rt().routeChoice).toBe("destination");
    expect(allText(keep)).toContain("Keep heading home");
    const busier = await h.text("find somewhere open");
    expect(h.rt().routeChoice).toBe("busier");
    expect(allText(busier)).toContain("appear to be open");
  });

  test("route question: a bare yes re-asks instead of guessing", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("👎");
    const out = await h.text("yes");
    expect(h.rt().routeChoice).toBeNull();
    expect(allText(out)).toContain("Do you want to keep heading home");
  });

  test("safe after immediate danger: resolves, stops forwarding, updates the contact", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("‼️");
    const ok = await h.text("I'm safe now");
    expect(h.rt().safety).toBe("safe");
    expect(h.rt().dangerWindow).toBeNull();
    expect(allText(ok)).toContain("Glad you're safe.");
    expect(alerts(ok)[0]?.text).toBe("Update from Nook: Alex just told me they're okay.");
    const later = await h.voiceNote("just checking in", { id: "vn-late" });
    expect(alerts(later)).toHaveLength(0);
  });

  test("stop ends the trip, except during immediate danger", async () => {
    const h = harness();
    await h.startWalk();
    const out = await h.text("stop checking in");
    expect(h.walkId()).toBeNull();
    expect(allText(out)).toContain("I'll stop checking in");
  });
});

describe("no-response: one follow-up, never a dramatic final nudge", () => {
  async function unanswered(escalation: "CONTACT_TRUSTED" | "NONE") {
    const h = harness({
      user: {
        timeouts: { nudgeAfterSec: 30, escalateAfterSec: 30 },
        escalation: { initialAction: "TEXT_USER", onNoTextResponse: escalation },
      },
    });
    await h.startWalk();
    await h.ping();
    const out: Action[] = [];
    for (let i = 0; i < 16; i++) {
      h.clock.advance(30_000);
      out.push(...(await h.tick()));
    }
    return { h, out };
  }

  test("keep checking in: check-in, one follow-up, then a plain check later", async () => {
    const { h, out } = await unanswered("NONE");
    const nudges = out.filter((a) => a.type === "SendText" && a.tag === "nudge");
    expect(nudges).toHaveLength(1);
    expect(allText(out)).toContain("Just checking again.");
    expect(alerts(out)).toHaveLength(0);
    for (let i = 0; i < 20; i++) {
      h.clock.advance(30_000);
      out.push(...(await h.tick()));
    }
    expect(allText(out)).toContain("Checking in again. Everything okay?");
  });

  test("text contact: check-in, one follow-up, then the contact alert", async () => {
    const { out } = await unanswered("CONTACT_TRUSTED");
    expect(out.filter((a) => a.type === "SendText" && a.tag === "nudge")).toHaveLength(1);
    const [alert] = alerts(out);
    expect(alert?.text).toContain("Hi, this is Nook.");
  });
});

describe("idempotency", () => {
  test("the same danger message delivered twice alerts once", async () => {
    const h = harness();
    await h.startWalk();
    const event = { type: "UserText" as const, userId: h.user.userId, messageId: "dup-1", text: "he has a knife", time: h.clock.now() };
    const first = await h.brain.handle(event);
    const second = await h.brain.handle(event);
    expect(alerts(first)).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  test("the same ‼️ reaction delivered twice alerts once", async () => {
    const h = harness();
    await h.startWalk();
    const event = { type: "UserReaction" as const, userId: h.user.userId, emoji: "‼️", targetMessageId: "t1", messageId: "r1", time: h.clock.now() };
    expect(alerts(await h.brain.handle(event))).toHaveLength(1);
    expect(await h.brain.handle(event)).toHaveLength(0);
  });

  test("a voice note redelivered during danger is forwarded once", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("‼️");
    const first = await h.voiceNote("he's still behind me", { id: "vn-1" });
    const second = await h.voiceNote("he's still behind me", { id: "vn-1" });
    expect(alerts(first)).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  test("a repeated call request doesn't start a second call", async () => {
    const h = harness();
    await h.startWalk();
    expect(calls(await h.text("call me"))).toHaveLength(1);
    expect(calls(await h.react("❓"))).toHaveLength(0);
  });

  test("a repeated escalation callback alerts once", async () => {
    const h = harness();
    await h.startWalk();
    await h.text("call me");
    const first = await h.call("request_escalation", "someone grabbed my arm");
    const second = await h.call("request_escalation", "someone grabbed my arm");
    expect(alerts(first)).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  test("asking for busier places twice reuses the first lookup", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("👎");
    const first = allText(await h.text("busier"));
    const second = allText(await h.text("somewhere busier"));
    expect(second).toBe(first);
  });
});

describe("voice note parity: same transcript, same intent and transition", () => {
  const cases = [
    "this area feels weird",
    "I'm okay",
    "keep going",
    "I think someone might be following me",
    "someone is chasing me",
    "call me",
    "stop",
  ];
  for (const words of cases) {
    test(words, async () => {
      const typed = harness();
      const spoken = harness();
      await typed.startWalk();
      await spoken.startWalk();
      await typed.react("👎");
      await spoken.react("👎");
      const a = await typed.text(words);
      const b = await spoken.voiceNote(words);
      expect(spoken.rt().safety).toBe(typed.rt().safety);
      expect(spoken.phase()).toBe(typed.phase());
      expect(texts(b)).toEqual(texts(a));
      expect(calls(b).length).toBe(calls(a).length);
      expect(alerts(b).map((x) => x.emergency)).toEqual(alerts(a).map((x) => x.emergency));
    });
  }

  test("👎 and \"This area feels weird.\" behave the same", async () => {
    const tapped = harness();
    const typed = harness();
    await tapped.startWalk();
    await typed.startWalk();
    await tapped.react("👎");
    await typed.text("This area feels weird.");
    expect(typed.rt().safety).toBe(tapped.rt().safety);
  });
});
