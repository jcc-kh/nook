/**
 * L2 scenario suite: R5b, R7, R8 (timer), R9a, R10 (+ escalation policy / timeouts), R16
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
    trustedContact: { phone: DEMO.contact, name: "Sam" },
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

  // R5b must not fire on a steady walk with frequent pings (~20 m apart)
  {
    const clock = new SimClock(night());
    const brain = createBrainEngine({ clock, getUser, persist: true });
    await startWalking(brain, clock);
    let sends = 0;
    for (let i = 1; i <= 20; i++) {
      clock.advance(15_000);
      const a = await brain.handle({
        type: "LocationPing",
        userId: DEMO.userId,
        time: clock.now(),
        lat: DEMO_ORIGIN.lat + i * 0.000175,
        lon: DEMO_ORIGIN.lon,
      });
      sends += a.filter((x) => x.type === "SendText" && x.tag === "checkin").length;
    }
    assert(sends === 0, `R5b: steady walk should not check in (got ${sends})`);
    console.log("R5b steady walk ok");
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

  // R8: no location update for 3 min → check-in from the timer alone
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
    clock.advance(2 * 60_000);
    const early = await brain.tick(clock.now());
    assert(early.length === 0, "R8: nothing before noUpdateMin");
    clock.advance(60_000 + 500);
    const actions = await brain.tick(clock.now());
    assert(
      actions.some((a) => a.type === "SendText" && a.tag === "checkin"),
      "R8: expected checkin from tick with no new ping",
    );
    assert(brain.getPhase(DEMO.userId) === "CHECKING_IN", "R8: CHECKING_IN");
    clock.advance(60_000);
    const again = await brain.tick(clock.now());
    assert(
      !again.some((a) => a.type === "SendText" && a.tag === "checkin"),
      "R8: fires once per silence",
    );
    console.log("R8 ok");
  }

  // R10 policy: NONE → one final nudge, no contact, no call
  {
    const clock = new SimClock(night());
    const brain = createBrainEngine({
      clock,
      getUser: async () => ({
        ...(await getUser()),
        escalation: { initialAction: "TEXT_USER" as const, onNoTextResponse: "NONE" as const },
      }),
      persist: true,
    });
    await startWalking(brain, clock);
    await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat: DEMO_ORIGIN.lat + 0.001,
      lon: DEMO_ORIGIN.lon,
    });
    clock.advance(3 * 60_000 + 500);
    await brain.tick(clock.now());
    clock.advance(60_000);
    const nudge = await brain.tick(clock.now());
    assert(nudge.some((a) => a.type === "SendText" && a.tag === "nudge"), "NONE: nudge");
    clock.advance(60_000);
    const final = await brain.tick(clock.now());
    assert(
      final.some((a) => a.type === "SendText" && a.text.includes("still nothing")),
      "NONE: final nudge",
    );
    assert(
      !final.some((a) => a.type === "AlertContact" || a.type === "StartCall"),
      "NONE: no contact / call",
    );
    clock.advance(5 * 60_000);
    const after = await brain.tick(clock.now());
    assert(after.length === 0, "NONE: silent after the final nudge");
    console.log("R10 NONE floor ok");
  }

  // R10 policy: CONTACT_TRUSTED with custom 30 s / 30 s timeouts. Silence never places a call.
  {
    const clock = new SimClock(night());
    const brain = createBrainEngine({
      clock,
      getUser: async () => ({
        ...(await getUser()),
        trustedContact: { phone: DEMO.contact, name: "Sam" },
        escalation: { initialAction: "TEXT_USER" as const, onNoTextResponse: "CONTACT_TRUSTED" as const },
        timeouts: { nudgeAfterSec: 30, escalateAfterSec: 30 },
      }),
      persist: true,
    });
    await startWalking(brain, clock);
    await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat: DEMO_ORIGIN.lat + 0.001,
      lon: DEMO_ORIGIN.lon,
    });
    clock.advance(3 * 60_000 + 500);
    await brain.tick(clock.now());
    clock.advance(30_000);
    const nudge = await brain.tick(clock.now());
    assert(nudge.some((a) => a.type === "SendText" && a.tag === "nudge"), "CONTACT_TRUSTED: nudge at 30 s");
    clock.advance(30_000);
    const alert = await brain.tick(clock.now());
    assert(alert.some((a) => a.type === "AlertContact"), "CONTACT_TRUSTED: contact at 60 s");
    assert(!alert.some((a) => a.type === "StartCall"), "CONTACT_TRUSTED: never calls");
    assert(brain.getPhase(DEMO.userId) === "ALERTED", "CONTACT_TRUSTED: ALERTED");
    console.log("R10 CONTACT_TRUSTED + custom timeouts ok");
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
    const acked = await brain.handle(like);
    assert(brain.getPhase(DEMO.userId) === "IDLE", "R9a: stop ack ends the walk");
    assert(
      acked.some((a) => a.type === "SendText" && a.tag === "ended"),
      "R9a: tells them we'll assume they got where they were going",
    );
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
