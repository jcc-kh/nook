/**
 * L4 suite: opt-in calls (❓), immediate danger (‼️) without a call, call
 * outcomes, getLiveContext, resume from Tiger
 */
import { SimClock } from "../../shared/clock.ts";
import { createBrainEngine } from "../../brain/engine.ts";
import { closePool, query } from "../../store/db.ts";
import { upsertDemoUser } from "../../store/users.ts";
import { getOpenWalk } from "../../store/walks.ts";
import { DEMO, DEMO_ORIGIN } from "../demo.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function night(): Date {
  return new Date("2026-04-14T02:30:00.000Z");
}

async function main() {
  await upsertDemoUser({ ...DEMO });
  const getUser = async () => ({
    userId: DEMO.userId,
    handle: DEMO.handle,
    contact: DEMO.contact,
    trustedContact: { phone: DEMO.contact, name: "Sam" },
    homeLat: DEMO.homeLat,
    homeLon: DEMO.homeLon,
    nightStart: DEMO.nightStart,
    nightEnd: DEMO.nightEnd,
    tz: DEMO.tz,
    displayName: DEMO.displayName,
  });

  const clock = new SimClock(night());
  const brain = createBrainEngine({ clock, getUser, persist: true });

  await brain.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: DEMO_ORIGIN.lat,
    lon: DEMO_ORIGIN.lon,
    shortAddress: "W 116th St",
  });
  await brain.handle({
    type: "UserText",
    userId: DEMO.userId,
    messageId: "wmh",
    text: "walk me home",
    time: clock.now(),
  });

  // R11: ❓ asks for a call
  const callActions = await brain.handle({
    type: "UserReaction",
    userId: DEMO.userId,
    emoji: "❓",
    targetMessageId: "x",
    time: clock.now(),
  });
  const start = callActions.find((a) => a.type === "StartCall");
  assert(start, "R11: StartCall");
  assert(start.vars.callReason === "manual_call", "R11: manual_call reason");
  assert(start.vars.openingLine, "R11: opening line");
  assert(!callActions.some((a) => a.type === "AlertContact"), "R11: no contact alert");
  assert(brain.getPhase(DEMO.userId) === "CALLING", "R11: CALLING");
  const r11 = await query(
    `SELECT 1 FROM events WHERE user_id=$1 AND rule_id='R11' LIMIT 1`,
    [DEMO.userId],
  );
  assert(r11.rows.length > 0, "R11 event");
  console.log("R11 ok");

  const walkId = (brain.getRuntime(DEMO.userId) as { walkId: string }).walkId;
  const ctx = await brain.getLiveContext(walkId);
  assert(ctx != null, "getLiveContext");
  assert(ctx.street === "W 116th St", "getLiveContext street");
  assert(typeof ctx.navigationFresh === "boolean" && typeof ctx.contextFresh === "boolean", "freshness flags");
  console.log("getLiveContext ok", ctx);

  // Immediate danger reported on the call: rich alert, call stays up
  const alertActions = await brain.handle({
    type: "CallEvent",
    userId: DEMO.userId,
    walkId,
    callType: "request_escalation",
    situation: "someone grabbed my arm",
    time: clock.now(),
  });
  const alert = alertActions.find((a) => a.type === "AlertContact");
  assert(alert?.emergency, "request_escalation: emergency AlertContact");
  assert(alert.text.includes("someone grabbed my arm"), "request_escalation: quotes the situation");
  assert(brain.getPhase(DEMO.userId) === "CALLING", "request_escalation: stay CALLING");
  console.log("request_escalation ok");

  const ended = await brain.handle({
    type: "CallEvent",
    userId: DEMO.userId,
    walkId,
    callType: "ended_unresolved",
    time: clock.now(),
  });
  assert(!ended.some((a) => a.type === "AlertContact"), "ended_unresolved: never alerts");
  assert(ended.some((a) => a.type === "SendText"), "ended_unresolved: text check-in");
  assert(brain.getPhase(DEMO.userId) !== "CALLING", "call ended → not CALLING");
  console.log("ended_unresolved ok", brain.getPhase(DEMO.userId));

  // Resume: new engine hydrates open walk
  const open = await getOpenWalk(DEMO.userId);
  assert(open != null, "open walk in Tiger");
  assert(open.safetyState === "immediate_danger", `persisted safety_state, got ${open.safetyState}`);
  const brain2 = createBrainEngine({ clock, getUser, persist: true });
  await brain2.ensureHydrated(DEMO.userId);
  assert(brain2.getPhase(DEMO.userId) !== "CALLING", `resume phase, got ${brain2.getPhase(DEMO.userId)}`);
  console.log("resume ok", brain2.getPhase(DEMO.userId));
  await brain2.resetUser(DEMO.userId);

  // ‼️ on a fresh walk: alert + 911 guidance, no call
  const clock3 = new SimClock(night());
  const brain3 = createBrainEngine({ clock: clock3, getUser, persist: true });
  await brain3.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock3.now(),
    lat: DEMO_ORIGIN.lat,
    lon: DEMO_ORIGIN.lon,
    shortAddress: "W 116th St",
  });
  const danger = await brain3.handle({
    type: "UserReaction",
    userId: DEMO.userId,
    emoji: "‼️",
    targetMessageId: "y",
    time: clock3.now(),
  });
  assert(danger.some((a) => a.type === "AlertContact" && a.emergency), "‼️: emergency alert");
  assert(!danger.some((a) => a.type === "StartCall"), "‼️: no call");
  assert(danger.some((a) => a.type === "SendText" && a.text.includes("911")), "‼️: tells them to call 911");
  console.log("‼️ ok");
  await brain3.resetUser(DEMO.userId);

  console.log("\n[sim:l4] all passed");
  await closePool();
}

main().catch(async (err) => {
  console.error("[sim:l4] failed:", err);
  await closePool().catch(() => {});
  process.exit(1);
});
