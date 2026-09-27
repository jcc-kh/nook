/**
 * L4 suite: R11, call outcomes, getLiveContext, resume from Tiger
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

  // R11
  const callActions = await brain.handle({
    type: "UserReaction",
    userId: DEMO.userId,
    emoji: "‼️",
    targetMessageId: "x",
    time: clock.now(),
  });
  assert(
    callActions.some((a) => a.type === "StartCall"),
    "R11: StartCall",
  );
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
  assert(ctx!.street === "W 116th St", "getLiveContext street");
  console.log("getLiveContext ok", ctx);

  // User asks on the call for their contact to be reached
  const alertActions = await brain.handle({
    type: "CallEvent",
    userId: DEMO.userId,
    walkId,
    callType: "request_escalation",
    time: clock.now(),
  });
  assert(
    alertActions.some((a) => a.type === "AlertContact"),
    "request_escalation: AlertContact",
  );
  assert(brain.getPhase(DEMO.userId) === "CALLING", "request_escalation: stay CALLING");
  console.log("request_escalation ok");

  await brain.handle({
    type: "CallEvent",
    userId: DEMO.userId,
    walkId,
    callType: "ended_unresolved",
    time: clock.now(),
  });
  assert(brain.getPhase(DEMO.userId) === "WALKING", "call ended → WALKING");

  // Resume: new engine hydrates open walk
  const open = await getOpenWalk(DEMO.userId);
  assert(open != null, "open walk in Tiger");
  const brain2 = createBrainEngine({ clock, getUser, persist: true });
  await brain2.ensureHydrated(DEMO.userId);
  assert(
    brain2.getPhase(DEMO.userId) === "WALKING" ||
      brain2.getPhase(DEMO.userId) === "CALLING",
    `resume phase, got ${brain2.getPhase(DEMO.userId)}`,
  );
  console.log("resume ok", brain2.getPhase(DEMO.userId));

  console.log("\n[sim:l4] all passed");
  await closePool();
}

main().catch(async (err) => {
  console.error("[sim:l4] failed:", err);
  await closePool().catch(() => {});
  process.exit(1);
});
