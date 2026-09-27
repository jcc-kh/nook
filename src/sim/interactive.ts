/**
 * Interactive walk-home REPL — you play the user; the brain is the agent.
 *
 *   bun run sim:play
 *   USE_GEMINI=1 bun run sim:play
 *
 * Tip: type chat naturally — "walk me home" is a text, not a GPS command.
 * GPS moves use: step | cruise | stay +3m | +45m | home | bodega | friend
 */
import * as readline from "node:readline";
import { SimClock } from "../shared/clock.ts";
import { createBrainEngine } from "../brain/engine.ts";
import { createLlm } from "../llm/index.ts";
import { distanceM } from "../shared/geo.ts";
import { closePool } from "../store/db.ts";
import type { Action } from "../shared/types.ts";
import { DEMO, DEMO_ORIGIN, DEMO_BODEGA, DEMO_FRIEND } from "./demo.ts";
import { toCell } from "../shared/cell.ts";

// Tiger SSL deprecation noise (harmless for local sim)
const _warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  const s = String(args[0] ?? "");
  if (s.includes("SECURITY WARNING") || s.includes("sslmode")) return;
  _warn(...args);
};

const WALK_MPS = 1.3;
const WALK_STEP_S = 20;

const COMMANDS = new Set([
  "help",
  "?",
  "quit",
  "exit",
  "q",
  "status",
  "night",
  "day",
  "ping",
  "bodega",
  "friend",
  "home",
  "step",
  "walk", // alias for step (GPS). Use chat for "walk me home".
  "cruise",
  "stay",
  "text",
  "react",
  "why",
  "plan",
  "sc",
  "scenario",
]);

const clock = new SimClock(new Date("2026-04-14T02:30:00.000Z"));
let msgSeq = 0;
let lastOutboundId: string | null = null;
let lastLat = DEMO_ORIGIN.lat;
let lastLon = DEMO_ORIGIN.lon;

const llm = createLlm();
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

const brain = createBrainEngine({
  clock,
  getUser,
  parseReply: llm.parseReply,
  writeMessages: llm.writeMessages,
  persist: false,
  verbose: true,
});

function fmtTime(): string {
  return clock.now().toISOString().replace(".000Z", "Z");
}

function rt() {
  return brain.getRuntime(DEMO.userId) as {
    phase: string;
    walkId: string | null;
    suppressCheckinUntil: Date | null;
    lastCheckinAt: Date | null;
    checkinOpenedAt: Date | null;
    nudged: boolean;
    walkStartedAt: Date | null;
    plan: {
      lateMin: number;
      expectedMin: number;
      routeCells: string[];
      stops: { cell: string; kind?: string; label?: string; allowedDwellMin: number }[];
    } | null;
  };
}

function explainSilence(actions: Action[]) {
  if (actions.length > 0) return;
  const s = rt();
  const now = clock.now();
  const bits: string[] = [];

  if (s.phase === "IDLE") {
    bits.push("IDLE: no walk yet — chat \"walk me home\" or run cruise");
  } else if (s.phase === "WALKING") {
    bits.push("WALKING: agent only texts on unusual events (not every ping)");
    if (s.suppressCheckinUntil && now < s.suppressCheckinUntil) {
      const left = Math.ceil(
        (s.suppressCheckinUntil.getTime() - now.getTime()) / 60_000,
      );
      bits.push(
        `R9a cool-down: no check-in for ~${left} more min after your 👍 (try +${left}m then stay +3m)`,
      );
    }
    if (s.walkStartedAt && s.plan) {
      const elapsed =
        (now.getTime() - s.walkStartedAt.getTime()) / 60_000;
      const untilLate = s.plan.lateMin - elapsed;
      if (untilLate > 0) {
        bits.push(
          `late check-in (R7) in ~${untilLate.toFixed(0)} min of walk time (try +${Math.ceil(untilLate) + 1}m)`,
        );
      }
    }
  } else if (s.phase === "CHECKING_IN") {
    bits.push(
      "CHECKING_IN: waiting for your 👍 (react 👍) or else +61s → nudge, +61s → alert",
    );
  } else if (s.phase === "PROMPTED") {
    bits.push("PROMPTED: react 👍 to start walk, or 👎 to dismiss");
  }

  for (const b of bits) console.log(`  · ${b}`);
}

function printActions(actions: Action[]) {
  if (actions.length === 0) {
    console.log("  agent: (silent)");
    explainSilence(actions);
    return;
  }
  for (const a of actions) {
    if (a.type === "SendText") {
      msgSeq += 1;
      lastOutboundId = `out-${msgSeq}`;
      console.log(`  agent → you [${a.tag}]  id=${lastOutboundId}`);
      console.log(`         "${a.text}"`);
    } else if (a.type === "AlertContact") {
      console.log(`  agent → trusted contact`);
      console.log(
        `         "${a.text}" @ ${a.lat.toFixed(5)},${a.lon.toFixed(5)}`,
      );
    } else if (a.type === "StartCall") {
      console.log(`  agent → CALL you (walk ${a.walkId})`);
    }
  }
}

async function handleEvent(event: Parameters<typeof brain.handle>[0]) {
  const before = rt().phase;
  const actions = await brain.handle(event);
  const after = rt().phase;
  printActions(actions);
  if (before !== after) {
    console.log(`  phase ${before} → ${after}  t=${fmtTime()}`);
  } else {
    console.log(`  phase=${after}  t=${fmtTime()}`);
  }
  if (after === "WALKING" && before !== "WALKING" && actions.length === 0) {
    console.log(
      "  · walk started (R4/R3). Agent stays quiet until something looks off — try: stay +3m",
    );
  }
}

async function sendText(text: string) {
  msgSeq += 1;
  console.log(`  you → agent (iMessage): "${text}"`);
  await handleEvent({
    type: "UserText",
    userId: DEMO.userId,
    messageId: `in-${msgSeq}`,
    text,
    time: clock.now(),
  });
}

async function walkStep(meters = WALK_MPS * WALK_STEP_S) {
  const distHome = distanceM(lastLat, lastLon, DEMO.homeLat, DEMO.homeLon);
  if (distHome < 5) {
    console.log("  already at home");
    await ping(DEMO.homeLat, DEMO.homeLon);
    return;
  }
  const step = Math.min(meters, distHome);
  const t = step / distHome;
  const lat = lastLat + (DEMO.homeLat - lastLat) * t;
  const lon = lastLon + (DEMO.homeLon - lastLon) * t;
  clock.advance(Math.round((step / WALK_MPS) * 1000));
  await ping(lat, lon);
}

async function cruise(durationS = 150) {
  if (rt().phase !== "IDLE") {
    console.log(
      `  cruise is for IDLE→prompt (R2). You're ${rt().phase}. Use step/stay/+Nm instead.`,
    );
    return;
  }
  const steps = Math.max(2, Math.ceil(durationS / WALK_STEP_S));
  console.log(`  cruising ${steps} steps toward home (R2 needs ~2 min walking)…`);
  for (let i = 0; i < steps; i++) {
    const before = rt().phase;
    await walkStep();
    if (rt().phase !== before) break;
  }
}

async function ping(lat: number, lon: number) {
  lastLat = lat;
  lastLon = lon;
  const dHome = distanceM(lat, lon, DEMO.homeLat, DEMO.homeLon);
  console.log(`  [gps] ${lat.toFixed(5)}, ${lon.toFixed(5)}  (~${dHome.toFixed(0)} m from home)`);
  await handleEvent({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat,
    lon,
  });
}

function parseArgs(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean);
}

function help() {
  console.log(`
Natural chat (no prefix needed):
  walk me home

Tapbacks:  react 👍

GPS / time:
  step | cruise | stay +3m | +10m | home | bodega | friend
  plan                show WalkPlan (expected/late/route/stops from Tiger)
  why | status | help | quit

Personalization macros (need: bun run seed:history first):
  sc usual            walk along usual corridor — expect silence
  sc offroute         leave route 2 min — expect R6 check-in
  sc late             jump past personalized late — expect R7
  sc bodega           dwell at known stop (R5a silent then overstay)
  sc friend           16 min at Sam's — expect R15 end + alert

Automated suite (non-interactive):
  bun run sim:personal
`);
}

function printPlan() {
  const s = rt();
  if (!s.plan) {
    console.log("  no WalkPlan yet — start a walk first (walk me home)");
    return;
  }
  const p = s.plan;
  console.log(
    `  expected=${p.expectedMin.toFixed(1)}m  late=${p.lateMin.toFixed(1)}m  routeCells=${p.routeCells.length}  stops=${p.stops.length}`,
  );
  if (s.walkStartedAt) {
    const elapsed = (clock.now().getTime() - s.walkStartedAt.getTime()) / 60_000;
    console.log(
      `  elapsed=${elapsed.toFixed(1)}m  untilLate=${(p.lateMin - elapsed).toFixed(1)}m`,
    );
  }
  console.log(`  route sample: ${p.routeCells.slice(0, 6).join(" | ") || "(none)"}`);
  for (const st of p.stops) {
    console.log(
      `  stop ${st.cell} kind=${st.kind ?? "?"} ≤${st.allowedDwellMin}m ${st.label ?? ""}`,
    );
  }
}

/** Off usual N–S corridor. */
const OFF_ROUTE = { lat: 40.8045, lon: -73.9550 };

async function runScenario(name: string) {
  const phase = rt().phase;
  switch (name) {
    case "usual": {
      if (phase !== "WALKING") {
        console.log("  start a walk first: walk me home");
        return;
      }
      console.log("  walking usual corridor (6 steps)…");
      for (let i = 1; i <= 6; i++) {
        const t = i / 10;
        const lat = DEMO_ORIGIN.lat + (DEMO.homeLat - DEMO_ORIGIN.lat) * t;
        clock.advance(20_000);
        await ping(lat, DEMO_ORIGIN.lon);
      }
      break;
    }
    case "offroute":
    case "off": {
      if (phase !== "WALKING") {
        console.log("  start a walk first: walk me home");
        return;
      }
      console.log("  leaving usual route for 2+ min (R6)…");
      await ping(OFF_ROUTE.lat, OFF_ROUTE.lon);
      clock.advance(2 * 60_000 + 1000);
      await ping(OFF_ROUTE.lat, OFF_ROUTE.lon);
      break;
    }
    case "late": {
      if (phase !== "WALKING" || !rt().plan) {
        console.log("  start a walk first: walk me home");
        return;
      }
      const late = rt().plan!.lateMin;
      const jump = Math.ceil(late) + 1;
      console.log(`  advancing +${jump}m past late=${late.toFixed(1)} (R7a)…`);
      // clear suppress if any
      if (rt().suppressCheckinUntil) {
        const left = rt().suppressCheckinUntil!.getTime() - clock.now().getTime();
        if (left > 0) clock.advance(left + 1000);
      }
      clock.advance(jump * 60_000);
      await ping(
        (DEMO_ORIGIN.lat + DEMO.homeLat) / 2,
        DEMO_ORIGIN.lon,
      );
      break;
    }
    case "bodega": {
      if (phase !== "WALKING") {
        console.log("  start a walk first: walk me home");
        return;
      }
      console.log("  dwell at bodega under allow, then overstay (R5a)…");
      await ping(DEMO_BODEGA.lat, DEMO_BODEGA.lon);
      const allow =
        rt().plan?.stops.find((s) => s.cell === toCell(DEMO_BODEGA.lat, DEMO_BODEGA.lon))
          ?.allowedDwellMin ?? 10;
      const under = Math.max(1, Math.floor(allow) - 1);
      for (let i = 0; i < under; i++) {
        clock.advance(60_000);
        await ping(DEMO_BODEGA.lat, DEMO_BODEGA.lon);
      }
      console.log(`  …exceeding ${allow}m allow`);
      clock.advance(3 * 60_000);
      await ping(DEMO_BODEGA.lat, DEMO_BODEGA.lon);
      break;
    }
    case "friend": {
      if (phase !== "WALKING") {
        console.log("  start a walk first: walk me home");
        return;
      }
      console.log("  dwelling at Sam's for 16 min (R15)…");
      await ping(DEMO_FRIEND.lat, DEMO_FRIEND.lon);
      for (let i = 0; i < 16; i++) {
        clock.advance(60_000);
        await ping(DEMO_FRIEND.lat, DEMO_FRIEND.lon);
        if (rt().phase === "IDLE") break;
      }
      break;
    }
    default:
      console.log("  usage: sc usual|offroute|late|bodega|friend");
  }
}

function printWhy() {
  console.log("  --- why ---");
  explainSilence([]);
  const s = rt();
  console.log(`  phase=${s.phase} walk=${s.walkId ?? "none"}`);
  if (s.suppressCheckinUntil) {
    console.log(`  suppressCheckinUntil=${s.suppressCheckinUntil.toISOString()}`);
  }
  if (s.plan) {
    console.log(
      `  plan expected=${s.plan.expectedMin.toFixed(0)}m late=${s.plan.lateMin.toFixed(0)}m routeCells=${s.plan.routeCells.length}`,
    );
  }
  if (s.walkStartedAt) {
    const elapsed = (clock.now().getTime() - s.walkStartedAt.getTime()) / 60_000;
    console.log(`  walk elapsed=${elapsed.toFixed(1)} min`);
  }
}

function parseDuration(tok: string): number | null {
  // accept +3m, 3m, +3 (default minutes)
  let m = tok.trim().match(/^\+?(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!m) {
    m = tok.trim().match(/^\+?(\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const n = Number(m[1]);
    return n * 60_000; // bare number = minutes
  }
  const n = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      return null;
  }
}

async function dispatch(line: string): Promise<"quit" | "ok"> {
  const tokens = parseArgs(line);
  const cmd = tokens[0]!.toLowerCase();
  const rest = tokens.slice(1);
  const arg = rest.join(" ");

  if (cmd.startsWith("+") && parseDuration(cmd) != null) {
    const ms = parseDuration(cmd)!;
    clock.advance(ms);
    console.log(`  clock +${cmd.slice(1)} → ${fmtTime()}`);
    await ping(lastLat, lastLon);
    return "ok";
  }

  const isCommand =
    COMMANDS.has(cmd) && !(cmd === "walk" && rest.length > 0);

  if (!isCommand) {
    await sendText(line);
    return "ok";
  }

  switch (cmd) {
    case "help":
    case "?":
      help();
      return "ok";
    case "quit":
    case "exit":
    case "q":
      return "quit";
    case "why":
      printWhy();
      return "ok";
    case "plan":
      printPlan();
      return "ok";
    case "sc":
    case "scenario":
      await runScenario((rest[0] ?? "").toLowerCase());
      return "ok";
    case "status":
      printWhy();
      console.log(
        `  gps=${lastLat.toFixed(5)},${lastLon.toFixed(5)}  outbound=${lastOutboundId ?? "none"}`,
      );
      return "ok";
    case "night":
      clock.set(new Date("2026-04-14T02:30:00.000Z"));
      console.log(`  clock → night ${fmtTime()}`);
      return "ok";
    case "day":
      clock.set(new Date("2026-04-14T16:00:00.000Z"));
      console.log(`  clock → day ${fmtTime()}`);
      return "ok";
    case "ping": {
      const lat = rest[0] ? Number(rest[0]) : lastLat;
      const lon = rest[1] ? Number(rest[1]) : lastLon;
      if (Number.isNaN(lat) || Number.isNaN(lon)) console.log("  usage: ping [lat lon]");
      else await ping(lat, lon);
      return "ok";
    }
    case "bodega":
      await ping(DEMO_BODEGA.lat, DEMO_BODEGA.lon);
      return "ok";
    case "friend":
      await ping(DEMO_FRIEND.lat, DEMO_FRIEND.lon);
      return "ok";
    case "home":
      await ping(DEMO.homeLat, DEMO.homeLon);
      return "ok";
    case "step":
    case "walk":
      await walkStep();
      return "ok";
    case "cruise":
      await cruise();
      return "ok";
    case "stay": {
      const dur = rest[0] ?? "+3m";
      const ms = parseDuration(dur);
      if (ms == null) console.log("  usage: stay +3m   (or stay 3)");
      else {
        clock.advance(ms);
        await ping(lastLat, lastLon);
      }
      return "ok";
    }
    case "text":
      if (!arg) console.log("  usage: text <message>  (or just type the message)");
      else await sendText(arg);
      return "ok";
    case "react": {
      const emoji = rest[0];
      const target = rest[1] ?? lastOutboundId;
      if (!emoji) console.log("  usage: react 👍");
      else if (!target) console.log("  no agent message to react to yet");
      else {
        console.log(`  you → tapback ${emoji} on ${target}`);
        await handleEvent({
          type: "UserReaction",
          userId: DEMO.userId,
          emoji,
          targetMessageId: target,
          time: clock.now(),
        });
      }
      return "ok";
    }
    default:
      return "ok";
  }
}

async function main() {
  console.log("Nook interactive sim — Gemini:", llm.useGemini ? "ON" : "OFF");
  console.log(`Demo ${DEMO.displayName}  home=${DEMO.homeLat},${DEMO.homeLon}`);
  console.log("Type chat like iMessage, or `help`. Starts at night.\n");

  await ping(DEMO_ORIGIN.lat, DEMO_ORIGIN.lon);
  help();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });

  process.stdout.write("you> ");
  for await (const raw of rl) {
    const line = String(raw).trim();
    if (!line) {
      process.stdout.write("you> ");
      continue;
    }
    try {
      const result = await dispatch(line);
      if (result === "quit") break;
    } catch (err) {
      console.error("  error:", err);
    }
    process.stdout.write("you> ");
  }

  rl.close();
  await closePool().catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
