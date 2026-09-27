/**
 * L3 suite: R5a, R6, R9b, R15 (after seed:history)
 */
import { SimClock } from "../../shared/clock.ts";
import { toCell } from "../../shared/cell.ts";
import { createBrainEngine } from "../../brain/engine.ts";
import { closePool, query } from "../../store/db.ts";
import { upsertDemoUser } from "../../store/users.ts";
import { DEMO, DEMO_BODEGA, DEMO_FRIEND, DEMO_ORIGIN } from "../demo.ts";
import { parseReplyFallback } from "../../llm/index.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function night(): Date {
  return new Date("2026-04-14T02:30:00.000Z");
}

async function main() {
  await upsertDemoUser({ ...DEMO });

  const baselines = await query(
    `SELECT * FROM walk_baselines WHERE user_id = $1 LIMIT 5`,
    [DEMO.userId],
  );
  console.log("[sim:l3] walk_baselines rows:", baselines.rows.length);

  const stops = await query(
    `SELECT * FROM known_stops WHERE user_id = $1`,
    [DEMO.userId],
  );
  console.log("[sim:l3] known_stops rows:", stops.rows.length);

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

  const clock = new SimClock(night());
  const brain = createBrainEngine({
    clock,
    getUser,
    parseReply: parseReplyFallback,
    persist: true,
  });

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

  // R5a: dwell at bodega under allowed — keep pings <4 min apart so R8 does not fire
  const bodegaCell = toCell(DEMO_BODEGA.lat, DEMO_BODEGA.lon);
  await brain.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: DEMO_BODEGA.lat,
    lon: DEMO_BODEGA.lon,
  });
  let a5Silent = true;
  for (let i = 0; i < 5; i++) {
    clock.advance(60_000);
    const a5 = await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat: DEMO_BODEGA.lat,
      lon: DEMO_BODEGA.lon,
    });
    if (a5.some((a) => a.type === "SendText" && a.tag === "checkin")) {
      a5Silent = false;
      break;
    }
  }
  // May or may not have plan stop loaded — if known stop present, no checkin
  const rt = brain.getRuntime(DEMO.userId) as { plan: { stops: { cell: string }[] } | null };
  if (rt.plan?.stops.some((s) => s.cell === bodegaCell)) {
    assert(a5Silent, "R5a: should stay silent under allowed dwell");
    console.log("R5a ok (known stop loaded)");
  } else {
    console.log("R5a skipped (run seed:history so known_stops populate)");
  }

  // R9b / R15 via text
  const endActions = await brain.handle({
    type: "UserText",
    userId: DEMO.userId,
    messageId: "t2",
    text: "I'm at Sam's",
    time: clock.now(),
  });
  assert(
    endActions.some((a) => a.type === "AlertContact") ||
      brain.getPhase(DEMO.userId) === "IDLE",
    "R15: expected end elsewhere",
  );
  console.log("R9b/R15 ok");

  // R6 off-route: new walk with route cells if any
  const brain2 = createBrainEngine({
    clock,
    getUser,
    parseReply: parseReplyFallback,
    persist: true,
  });
  clock.set(new Date(night().getTime() + 3600_000));
  await brain2.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: DEMO_ORIGIN.lat,
    lon: DEMO_ORIGIN.lon,
  });
  await brain2.handle({
    type: "UserText",
    userId: DEMO.userId,
    messageId: "wmh2",
    text: "walk me home",
    time: clock.now(),
  });
  // Far off route
  await brain2.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: DEMO_ORIGIN.lat + 0.01,
    lon: DEMO_ORIGIN.lon + 0.01,
  });
  clock.advance(2 * 60_000 + 500);
  const a6 = await brain2.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: DEMO_ORIGIN.lat + 0.01,
    lon: DEMO_ORIGIN.lon + 0.01,
  });
  const rt2 = brain2.getRuntime(DEMO.userId) as {
    plan: { routeCells: string[] } | null;
  };
  if (rt2.plan && rt2.plan.routeCells.length > 0) {
    assert(
      a6.some((a) => a.type === "SendText") ||
        (await query(
          `SELECT 1 FROM events WHERE user_id=$1 AND rule_id='R6' LIMIT 1`,
          [DEMO.userId],
        )).rows.length > 0,
      "R6: expected off-route checkin",
    );
    console.log("R6 ok");
  } else {
    console.log("R6 skipped (no route cells — seed:history first)");
  }

  // friend dwell R15
  await query(
    `UPDATE walks SET ended_at = now(), status = 'ENDED_ELSEWHERE', duration_s = 1
     WHERE user_id = $1 AND ended_at IS NULL`,
    [DEMO.userId],
  );
  const brain3 = createBrainEngine({ clock, getUser, persist: true });
  clock.set(new Date(night().getTime() + 7200_000));
  await brain3.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: DEMO_ORIGIN.lat,
    lon: DEMO_ORIGIN.lon,
  });
  await brain3.handle({
    type: "UserText",
    userId: DEMO.userId,
    messageId: "wmh3",
    text: "walk me home",
    time: clock.now(),
  });
  assert(brain3.getPhase(DEMO.userId) === "WALKING", "R15 setup walking");
  const plan3 = (brain3.getRuntime(DEMO.userId) as { plan: unknown }).plan;
  assert(plan3 != null, "R15 setup: plan loaded");
  await brain3.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: DEMO_FRIEND.lat,
    lon: DEMO_FRIEND.lon,
  });
  for (let i = 0; i < 16; i++) {
    clock.advance(60_000);
    await brain3.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat: DEMO_FRIEND.lat,
      lon: DEMO_FRIEND.lon,
    });
  }
  const friendCell = toCell(DEMO_FRIEND.lat, DEMO_FRIEND.lon);
  const rt3 = brain3.getRuntime(DEMO.userId) as {
    plan: { stops: { cell: string; kind?: string }[] } | null;
    phase: string;
  };
  const r15events = await query(
    `SELECT 1 FROM events WHERE user_id=$1 AND rule_id='R15' LIMIT 1`,
    [DEMO.userId],
  );
  assert(
    rt3.phase === "IDLE" || r15events.rows.length > 0,
    `R15 friend dwell → IDLE (phase=${rt3.phase}, cell=${friendCell})`,
  );
  console.log("R15 friend dwell ok");

  console.log("\n[sim:l3] done");
  await closePool();
}

main().catch(async (err) => {
  console.error("[sim:l3] failed:", err);
  await closePool().catch(() => {});
  process.exit(1);
});
