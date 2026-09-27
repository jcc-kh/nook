/**
 * Local reach-out demo: prints whether/when the brain texts the user.
 *
 * Primary ack path is iMessage tapbacks (CONTEXT R9a: 👍 resumes walk).
 * Free-text classify (R9b / Gemini) is shown only as a side check.
 *
 *   bun run sim:reachout
 *   USE_GEMINI=0 bun run sim:reachout
 *   USE_GEMINI=1 bun run sim:reachout
 */
import { SimClock } from "../../shared/clock.ts";
import { createBrainEngine } from "../../brain/engine.ts";
import { createLlm } from "../../llm/index.ts";
import { closePool } from "../../store/db.ts";
import type { Action, UserReaction } from "../../shared/types.ts";
import { DEMO, DEMO_ORIGIN } from "../demo.ts";

function night(): Date {
  return new Date("2026-04-14T02:30:00.000Z");
}

function banner(title: string) {
  console.log("\n" + "=".repeat(64));
  console.log(title);
  console.log("=".repeat(64));
}

function logActions(label: string, actions: Action[]) {
  if (actions.length === 0) {
    console.log(`  ${label} → (no outbound)`);
    return;
  }
  for (const a of actions) {
    if (a.type === "SendText") {
      console.log(`  ${label} → SendText[${a.tag}] "${a.text}"`);
    } else if (a.type === "AlertContact") {
      console.log(`  ${label} → AlertContact "${a.text}"`);
    } else if (a.type === "StartCall") {
      console.log(`  ${label} → StartCall walk=${a.walkId}`);
    }
  }
}

async function runPass(label: string, useGemini: boolean) {
  banner(`${label}  (Gemini ${useGemini ? "ON" : "OFF"})`);

  const llm = createLlm({ useGemini });
  const clock = new SimClock(night());
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

  const brain = createBrainEngine({
    clock,
    getUser,
    classify: llm.classify,
    writeMessages: llm.writeMessages,
    persist: false,
    verbose: true,
  });

  // --- Daytime: should NOT prompt ---
  clock.set(new Date("2026-04-14T16:00:00.000Z"));
  let actions = await brain.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: DEMO_ORIGIN.lat,
    lon: DEMO_ORIGIN.lon,
  });
  logActions("daytime ping", actions);

  // --- Night + "walk me home" ---
  clock.set(night());
  actions = await brain.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat: DEMO_ORIGIN.lat,
    lon: DEMO_ORIGIN.lon,
  });
  logActions("night ping (idle)", actions);

  actions = await brain.handle({
    type: "UserText",
    userId: DEMO.userId,
    messageId: "wmh-1",
    text: "walk me home",
    time: clock.now(),
  });
  logActions("user: walk me home", actions);
  console.log(`  phase=${brain.getPhase(DEMO.userId)}`);

  // --- Stationary 3+ min → R5b check-in ---
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
  actions = await brain.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat,
    lon,
  });
  logActions("stationary 3m (expect checkin)", actions);
  console.log(`  phase=${brain.getPhase(DEMO.userId)}`);

  // --- 👍 on a stop check-in → they reached a place, walk ends ---
  const like: UserReaction = {
    type: "UserReaction",
    userId: DEMO.userId,
    emoji: "👍",
    targetMessageId: "checkin-1",
    time: clock.now(),
  };
  actions = await brain.handle(like);
  logActions("user tapback 👍 on stop check-in (settled)", actions);
  console.log(`  phase=${brain.getPhase(DEMO.userId)}`);

  // A new explicit trip, so the late-walk demo still has something open.
  actions = await brain.handle({
    type: "UserText",
    userId: DEMO.userId,
    messageId: "wmh-2",
    text: "walk me home",
    time: clock.now(),
  });
  logActions("user: walk me home again", actions);

  // --- late walk → R7 check-in ---
  clock.advance(45 * 60_000);
  actions = await brain.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat,
    lon,
  });
  logActions("45m later (expect late checkin)", actions);

  // --- no tapback → nudge (R10) ---
  clock.advance(61_000);
  actions = await brain.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat,
    lon,
  });
  logActions("61s no tapback (expect nudge)", actions);

  // --- still no tapback → alert ---
  clock.advance(61_000);
  actions = await brain.handle({
    type: "LocationPing",
    userId: DEMO.userId,
    time: clock.now(),
    lat,
    lon,
  });
  logActions("another 61s (expect alert)", actions);

  // --- R9b side check: free-text only when they type instead of reacting ---
  console.log("\n  --- R9b free-text classify (only if user texts, not tapback) ---");
  for (const sample of [
    "HELP someone is following me",
    "staying at Sam's tonight",
    "asdfgh",
  ]) {
    const parsed = await llm.classify(sample, { safetyState: "safe", awaiting: null, recent: [] });
    console.log(`  text: "${sample}" →`, parsed);
  }
}

async function main() {
  const force = process.env.USE_GEMINI;
  const hasKey = Boolean(process.env.GEMINI_API_KEY?.trim());

  if (force === "1") {
    if (!hasKey) throw new Error("USE_GEMINI=1 but GEMINI_API_KEY is empty");
    await runPass("Gemini pass", true);
  } else if (force === "0") {
    await runPass("Template pass", false);
  } else {
    await runPass("1/2 Template pass", false);
    if (hasKey) {
      await runPass("2/2 Gemini pass", true);
    } else {
      console.log("\n[skip] Gemini pass — set GEMINI_API_KEY to enable");
    }
  }

  console.log("\nreachout demo done.\n");
  await closePool().catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
