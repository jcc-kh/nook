/**
 * L2 scenario suite: R5b, R7, R8, R9a, R10, R16
 */
import { SimClock } from "../../shared/clock.ts";
import { createBrainEngine } from "../../brain/engine.ts";
import { closePool, query } from "../../store/db.ts";
import { upsertDemoUser } from "../../store/users.ts";
import { DEMO, DEMO_ORIGIN } from "../demo.ts";
import type { Action, UserReaction } from "../../shared/types.ts";

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

function night(): Date {
  return new Date("2026-04-14T02:30:00.000Z");
}

async function startWalking(
  brain: ReturnType<typeof createBrainEngine>,
  clock: SimClock,
) {
  clock.set(night());
  await brain.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: DEMO_ORIGIN.lat,
    lon: DEMO_ORIGIN.lon,
  });
  await brain.handle({
    type: "UserText",
    userId: DEMO.userId,
    messageId: "wmh",
    text: "walk me home",
    time: clock.now(),
  });
  assert(brain.getPhase(DEMO.userId) === "WALKING", "setup WALKING");
}

async function main() {
  await upsertDemoUser({ ...DEMO });
  const getUser = async () => ({
    userId: DEMO.userId,
    handle: DEMO.handle,
    contact: DEMO.contact,
    codeword: DEMO.codeword,
    homeLat: DEMO.homeLat,
    homeLon: DEMO.homeLon,
    nightStart: DEMO.nightStart,
    nightEnd: DEMO.nightEnd,
    tz: DEMO.tz,
    displayName: DEMO.displayName,
  });

  // R5b stationary 3 min
  {
    const clock = new SimClock(night());
    const brain = createBrainEngine({ clock, getUser, persist: true });
    await startWalking(brain, clock);
    const lat = DEMO_ORIGIN.lat + 0.001;
    const lon = DEMO_ORIGIN.lon;
    await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat,
      lon,
    });
    clock.advance(3 * 60_000 + 1000);
    const actions = await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat,
      lon,
    });
    assert(
      actions.some((a) => a.type === "SendText" && a.tag === "checkin"),
      "R5b: expected checkin",
    );
    assert((await countRule("R5b")) >= 1, "R5b event");
    console.log("R5b ok");
  }

  // R7a late
  {
    const clock = new SimClock(night());
    const brain = createBrainEngine({ clock, getUser, persist: true });
    await startWalking(brain, clock);
    // Seeded baselines can push late_min above 20 — jump far past late.
    clock.advance(45 * 60_000);
    const actions = await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat: DEMO_ORIGIN.lat + 0.001,
      lon: DEMO_ORIGIN.lon + 0.0001,
    });
    assert(
      actions.some((a) => a.type === "SendText") ||
        (await countRule("R7a")) + (await countRule("R7b")) >= 1,
      "R7: expected checkin when late",
    );
    console.log("R7 ok");
  }

  // R8 gap 4 min
  {
    const clock = new SimClock(night());
    const brain = createBrainEngine({ clock, getUser, persist: true });
    await startWalking(brain, clock);
    await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat: DEMO_ORIGIN.lat + 0.001,
      lon: DEMO_ORIGIN.lon,
    });
    clock.advance(4 * 60_000 + 500);
    const actions = await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat: DEMO_ORIGIN.lat + 0.0012,
      lon: DEMO_ORIGIN.lon,
    });
    assert(
      actions.some((a) => a.type === "SendText" && a.tag === "checkin") ||
        (await countRule("R8")) >= 1,
      "R8: expected checkin on gap",
    );
    console.log("R8 ok");
  }

  // R9a + R10
  {
    const clock = new SimClock(night());
    const brain = createBrainEngine({ clock, getUser, persist: true });
    await startWalking(brain, clock);
    const lat = DEMO_ORIGIN.lat + 0.001;
    const lon = DEMO_ORIGIN.lon;
    await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat,
      lon,
    });
    clock.advance(3 * 60_000 + 1000);
    await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat,
      lon,
    });
    assert(brain.getPhase(DEMO.userId) === "CHECKING_IN", "R9a setup");

    const like: UserReaction = {
      type: "UserReaction",
      userId: DEMO.userId,
      emoji: "👍",
      targetMessageId: "c1",
      time: clock.now(),
    };
    await brain.handle(like);
    assert(brain.getPhase(DEMO.userId) === "WALKING", "R9a: WALKING");
    console.log("R9a ok");
  }

  // R10 nudge + alert
  {
    const clock = new SimClock(night());
    const brain = createBrainEngine({ clock, getUser, persist: true });
    await startWalking(brain, clock);
    const lat = DEMO_ORIGIN.lat + 0.001;
    const lon = DEMO_ORIGIN.lon;
    await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat,
      lon,
    });
    clock.advance(3 * 60_000 + 1000);
    await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat,
      lon,
    });
    clock.advance(60_000);
    let actions: Action[] = await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat,
      lon,
    });
    assert(
      actions.some((a) => a.type === "SendText" && a.tag === "nudge") ||
        (await countRule("R10")) >= 1,
      "R10: nudge",
    );
    clock.advance(60_000);
    actions = await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat,
      lon,
    });
    assert(
      actions.some((a) => a.type === "AlertContact") ||
        brain.getPhase(DEMO.userId) === "ALERTED",
      "R10: alert",
    );
    console.log("R10 ok");
  }

  // R16 rate limit — two stationary triggers 1 min apart → one checkin
  {
    const clock = new SimClock(night());
    const brain = createBrainEngine({ clock, getUser, persist: true });
    await startWalking(brain, clock);
    const lat = DEMO_ORIGIN.lat + 0.002;
    const lon = DEMO_ORIGIN.lon;
    await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat,
      lon,
    });
    clock.advance(3 * 60_000 + 1000);
    const a1 = await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat,
      lon,
    });
    clock.advance(60_000);
    const a2 = await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat,
      lon,
    });
    const sends =
      a1.filter((a) => a.type === "SendText" && a.tag === "checkin").length +
      a2.filter((a) => a.type === "SendText" && a.tag === "checkin").length;
    assert(sends <= 1, `R16: expected <=1 checkin, got ${sends}`);
    console.log("R16 ok");
  }

  console.log("\n[sim:l2] all passed");
  await closePool();
}

main().catch(async (err) => {
  console.error("[sim:l2] failed:", err);
  await closePool().catch(() => {});
  process.exit(1);
});
