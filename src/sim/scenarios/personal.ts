/**
 * Personalization scenarios (CONTEXT L3): usual route, off-route (R6),
 * late vs baseline (R7), known-stop dwell (R5a), friend overstay (R15).
 *
 * Requires seeded history:
 *   bun run seed:user && bun run seed:history
 *   bun run sim:personal
 */
import { SimClock } from "../../shared/clock.ts";
import { toCell } from "../../shared/cell.ts";
import { distanceM } from "../../shared/geo.ts";
import { createBrainEngine } from "../../brain/engine.ts";
import { createLlm } from "../../llm/index.ts";
import { closePool, query } from "../../store/db.ts";
import { upsertDemoUser } from "../../store/users.ts";
import {
  loadKnownStops,
  loadRouteCells,
  loadWalkBaselines,
} from "../../store/walks.ts";
import type { Action, WalkPlan } from "../../shared/types.ts";
import type { UserRecord } from "../../store/types.ts";
import { DEMO, DEMO_BODEGA, DEMO_FRIEND, DEMO_ORIGIN } from "../demo.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function night(): Date {
  return new Date("2026-04-14T02:30:00.000Z");
}

function banner(title: string) {
  console.log("\n" + "─".repeat(64));
  console.log(title);
  console.log("─".repeat(64));
}

function logActions(actions: Action[]) {
  if (actions.length === 0) {
    console.log("  → (silent)");
    return;
  }
  for (const a of actions) {
    if (a.type === "SendText") {
      console.log(`  → SendText[${a.tag}] "${a.text}"`);
    } else if (a.type === "AlertContact") {
      console.log(`  → AlertContact "${a.text}"`);
    } else if (a.type === "StartCall") {
      console.log(`  → StartCall`);
    }
  }
}

function getPlan(brain: ReturnType<typeof createBrainEngine>): WalkPlan | null {
  const rt = brain.getRuntime(DEMO.userId) as { plan: WalkPlan | null };
  return rt.plan;
}

function printPlan(plan: WalkPlan | null, label: string) {
  if (!plan) {
    console.log(`  [${label}] no WalkPlan loaded`);
    return;
  }
  console.log(
    `  [${label}] expected=${plan.expectedMin.toFixed(1)}m  late=${plan.lateMin.toFixed(1)}m  routeCells=${plan.routeCells.length}  stops=${plan.stops.length}`,
  );
  for (const s of plan.stops) {
    console.log(
      `           stop ${s.cell} kind=${s.kind ?? "?"} dwell≤${s.allowedDwellMin}m label=${s.label ?? ""}`,
    );
  }
}

/** Far east of the usual N–S corridor — not on seeded polyline. */
const OFF_ROUTE = { lat: 40.8045, lon: -73.9550 } as const;

async function startWalk(
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
    messageId: `wmh-${crypto.randomUUID().slice(0, 6)}`,
    text: "walk me home",
    time: clock.now(),
  });
  assert(brain.getPhase(DEMO.userId) === "WALKING", "expected WALKING");
  printPlan(getPlan(brain), "plan after walk start");
}

async function ensureSeed(): Promise<{
  baseline: { n: number; p50Min: number; p90Min: number } | null;
  routeCells: string[];
  stops: Awaited<ReturnType<typeof loadKnownStops>>;
}> {
  await upsertDemoUser({ ...DEMO });
  const originCell = toCell(DEMO_ORIGIN.lat, DEMO_ORIGIN.lon);
  const baseline = await loadWalkBaselines(DEMO.userId, originCell);
  const routeCells = await loadRouteCells(DEMO.userId, originCell);
  const stops = await loadKnownStops(DEMO.userId);

  console.log("\nTiger personalization snapshot for demo-alex:");
  console.log(
    `  walk_baselines @ ${originCell}:`,
    baseline
      ? `n=${baseline.n} p50=${baseline.p50Min.toFixed(1)}m p90=${baseline.p90Min.toFixed(1)}m`
      : "NONE — run: bun run seed:history",
  );
  console.log(`  route cells from past walks: ${routeCells.length}`);
  console.log(`  known_stops: ${stops.length}`);

  if (!baseline || baseline.n < 3 || routeCells.length === 0) {
    throw new Error(
      "Need seeded history before personalization tests.\n  bun run seed:user && bun run seed:history",
    );
  }
  return { baseline, routeCells, stops };
}

async function scenarioUsualPath(getUser: () => Promise<UserRecord>) {
  banner("SCENARIO: usual path (should stay quiet — on route, moving, on time)");
  const clock = new SimClock(night());
  const llm = createLlm({ useGemini: false });
  const brain = createBrainEngine({
    clock,
    getUser,
    parseReply: llm.parseReply,
    writeMessages: llm.writeMessages,
    persist: false,
    verbose: true,
  });
  await startWalk(brain, clock);
  const plan = getPlan(brain)!;
  assert(plan.routeCells.length > 0, "need route cells");

  // Walk toward home along the seeded corridor (same lon, increasing lat)
  let checkins = 0;
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const t = i / (steps + 2); // don't arrive yet
    const lat = DEMO_ORIGIN.lat + (DEMO.homeLat - DEMO_ORIGIN.lat) * t;
    const lon = DEMO_ORIGIN.lon;
    const cell = toCell(lat, lon);
    const onRoute = plan.routeCells.includes(cell);
    clock.advance(20_000);
    const actions = await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat,
      lon,
    });
    console.log(
      `  step ${i}: cell=${cell} onRoute=${onRoute} phase=${brain.getPhase(DEMO.userId)}`,
    );
    logActions(actions);
    if (actions.some((a) => a.type === "SendText" && a.tag === "checkin")) {
      checkins += 1;
    }
  }
  assert(checkins === 0, "usual path should not soft-check-in (got R6/R5b?)");
  console.log("PASS usual path — no check-in while on corridor\n");
}

async function scenarioOffRoute(getUser: () => Promise<UserRecord>) {
  banner("SCENARIO: off usual route (R6 — >200m / off routeCells for 2 min)");
  const clock = new SimClock(night());
  const llm = createLlm({ useGemini: false });
  const brain = createBrainEngine({
    clock,
    getUser,
    parseReply: llm.parseReply,
    writeMessages: llm.writeMessages,
    persist: false,
    verbose: true,
  });
  await startWalk(brain, clock);
  const plan = getPlan(brain)!;
  const offCell = toCell(OFF_ROUTE.lat, OFF_ROUTE.lon);
  assert(!plan.routeCells.includes(offCell), "off-route cell must not be on plan");

  const distCorridor = distanceM(
    OFF_ROUTE.lat,
    OFF_ROUTE.lon,
    DEMO_ORIGIN.lat,
    DEMO_ORIGIN.lon,
  );
  console.log(
    `  jumping to off-route ${OFF_ROUTE.lat},${OFF_ROUTE.lon} cell=${offCell} (~${distCorridor.toFixed(0)} m from origin)`,
  );

  await brain.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: OFF_ROUTE.lat,
    lon: OFF_ROUTE.lon,
  });
  console.log("  t+0 off-route ping");
  logActions([]);

  clock.advance(2 * 60_000 + 1000);
  const actions = await brain.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: OFF_ROUTE.lat,
    lon: OFF_ROUTE.lon,
  });
  console.log("  t+2m still off-route");
  logActions(actions);
  assert(
    actions.some((a) => a.type === "SendText" && a.tag === "checkin"),
    "R6: expected check-in after 2 min off route",
  );
  assert(brain.getPhase(DEMO.userId) === "CHECKING_IN", "R6 → CHECKING_IN");
  console.log("PASS R6 off-route check-in\n");
}

async function scenarioLate(
  getUser: () => Promise<UserRecord>,
  baseline: { p50Min: number; p90Min: number },
) {
  banner("SCENARIO: longer than usual (R7a soft / R7b urgent vs walk_baselines)");
  const clock = new SimClock(night());
  const llm = createLlm({ useGemini: false });
  const brain = createBrainEngine({
    clock,
    getUser,
    parseReply: llm.parseReply,
    writeMessages: llm.writeMessages,
    persist: false,
    verbose: true,
  });
  await startWalk(brain, clock);
  const plan = getPlan(brain)!;
  console.log(
    `  baseline p50=${baseline.p50Min.toFixed(1)} p90=${baseline.p90Min.toFixed(1)} → plan late=${plan.lateMin.toFixed(1)}m`,
  );

  // Keep gently moving on-route but NOT on a known stop cell (avoid R5a)
  const onRouteLat = DEMO_ORIGIN.lat + 0.0004; // ~40.8044 → cell 40.804

  // Just past late → R7a
  const toLate = Math.ceil(plan.lateMin) + 1;
  clock.advance(toLate * 60_000);
  let actions = await brain.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: onRouteLat,
    lon: DEMO_ORIGIN.lon,
  });
  console.log(`  after +${toLate}m (past late=${plan.lateMin.toFixed(1)})`);
  logActions(actions);
  assert(
    actions.some((a) => a.type === "SendText" && a.tag === "checkin"),
    "R7a: soft check-in when elapsed > late",
  );
  // Clear check-in with 👍 so we can test R7b
  await brain.handle({
    type: "UserReaction",
    userId: DEMO.userId,
    emoji: "👍",
    targetMessageId: "late-1",
    time: clock.now(),
  });
  console.log("  👍 resume; advance past late+10 for R7b");
  // Need elapsed > late+10 from walk start, and clear 10m R9a suppress
  const elapsedAfter = (clock.now().getTime() - night().getTime()) / 60_000;
  const need = plan.lateMin + 10 + 1;
  const more = Math.max(11, Math.ceil(need - elapsedAfter));
  clock.advance(more * 60_000);
  actions = await brain.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: onRouteLat + 0.0002,
    lon: DEMO_ORIGIN.lon,
  });
  console.log(`  after +${more}m more (elapsed > late+10)`);
  logActions(actions);
  assert(
    actions.some((a) => a.type === "SendText" && a.tag === "checkin"),
    "R7b: urgent check-in when elapsed > late+10",
  );
  console.log("PASS R7a/R7b late vs personalized baseline\n");
}

async function scenarioKnownStop(getUser: () => Promise<UserRecord>) {
  banner("SCENARIO: known bodega stop (R5a — silent under dwell, check-in after)");
  const clock = new SimClock(night());
  const llm = createLlm({ useGemini: false });
  const brain = createBrainEngine({
    clock,
    getUser,
    parseReply: llm.parseReply,
    writeMessages: llm.writeMessages,
    persist: false,
    verbose: true,
  });
  await startWalk(brain, clock);
  const plan = getPlan(brain)!;
  const bodegaCell = toCell(DEMO_BODEGA.lat, DEMO_BODEGA.lon);
  const stop = plan.stops.find((s) => s.cell === bodegaCell);
  assert(stop, "bodega must be on WalkPlan.stops — re-run seed:history");
  console.log(
    `  dwelling at ${DEMO_BODEGA.label} allowedDwell=${stop.allowedDwellMin}m`,
  );

  await brain.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: DEMO_BODEGA.lat,
    lon: DEMO_BODEGA.lon,
  });

  // Under allowed dwell — keep pinging so R8 gap doesn't fire
  const under = Math.max(1, Math.floor(stop.allowedDwellMin) - 1);
  let sawCheckin = false;
  for (let i = 0; i < under; i++) {
    clock.advance(60_000);
    const a = await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat: DEMO_BODEGA.lat,
      lon: DEMO_BODEGA.lon,
    });
    if (a.some((x) => x.type === "SendText" && x.tag === "checkin")) {
      sawCheckin = true;
      break;
    }
  }
  assert(!sawCheckin, "R5a: should stay silent under allowed dwell");
  console.log(`  silent for ${under}m under allow ✓`);

  // Past allow → R5a check-in
  clock.advance(3 * 60_000);
  const actions = await brain.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: DEMO_BODEGA.lat,
    lon: DEMO_BODEGA.lon,
  });
  console.log(`  after exceeding allowed dwell`);
  logActions(actions);
  assert(
    actions.some((a) => a.type === "SendText" && a.tag === "checkin"),
    "R5a: check-in after overstaying known stop",
  );
  console.log("PASS R5a known-stop dwell\n");
}

async function scenarioFriend(getUser: () => Promise<UserRecord>) {
  banner("SCENARIO: friend place overstay (R15 — end walk + alert contact)");
  const clock = new SimClock(night());
  const llm = createLlm({ useGemini: false });
  const brain = createBrainEngine({
    clock,
    getUser,
    parseReply: llm.parseReply,
    writeMessages: llm.writeMessages,
    persist: false,
    verbose: true,
  });
  await startWalk(brain, clock);
  const plan = getPlan(brain)!;
  const friendCell = toCell(DEMO_FRIEND.lat, DEMO_FRIEND.lon);
  assert(
    plan.stops.some((s) => s.cell === friendCell && s.kind === "friend"),
    "Sam's must be on plan as friend",
  );

  await brain.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: DEMO_FRIEND.lat,
    lon: DEMO_FRIEND.lon,
  });
  // Ping every minute for 16 min
  let ended = false;
  for (let i = 0; i < 16; i++) {
    clock.advance(60_000);
    const a = await brain.handle({
      type: "LocationPing",
      userId: DEMO.userId,
      time: clock.now(),
      lat: DEMO_FRIEND.lat,
      lon: DEMO_FRIEND.lon,
    });
    if (a.some((x) => x.type === "AlertContact")) {
      console.log(`  at +${i + 1}m:`);
      logActions(a);
      ended = true;
      break;
    }
  }
  assert(ended, "R15: expected AlertContact after >15 min at friend");
  assert(brain.getPhase(DEMO.userId) === "IDLE", "walk ended elsewhere → IDLE");
  console.log("PASS R15 friend overstay\n");
}

async function main() {
  console.log("Nook personalization scenarios (usual route / late / stops)");
  const { baseline, routeCells, stops } = await ensureSeed();

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

  // Show what Tiger thinks is "usual"
  banner("What Tiger learned as 'usual'");
  console.log(`  routeCells sample: ${routeCells.slice(0, 8).join(" | ")}${routeCells.length > 8 ? " …" : ""}`);
  for (const s of stops) {
    console.log(
      `  stop ${s.cell} visits=${s.visits} kind=${s.kind} label=${s.label} okDwell=${s.okDwellMin}`,
    );
  }

  await scenarioUsualPath(getUser);
  await scenarioOffRoute(getUser);
  await scenarioLate(getUser, baseline!);
  await scenarioKnownStop(getUser);
  await scenarioFriend(getUser);

  console.log("All personalization scenarios passed.\n");
  await closePool().catch(() => {});
}

main().catch(async (err) => {
  console.error(err);
  await closePool().catch(() => {});
  process.exit(1);
});
