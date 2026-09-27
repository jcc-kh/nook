/**
 * Runs tests/fixtures/safety-intents.json against the deterministic classifier
 * and, when GEMINI_API_KEY is set (and USE_GEMINI isn't 0), against Gemini:
 * once as the production pipeline, once as the model alone.
 * Mismatches are reported, not fatal: Nook must not depend on perfect Gemini output.
 *
 * EVAL_DELAY_MS (default 4500) spaces Gemini calls to stay under free-tier rate limits.
 * EVAL_MODEL_ONLY=0 skips the model-alone pass.
 */
import cases from "../../tests/fixtures/safety-intents.json";
import { classifyConservative, classifyDeterministic } from "../llm/classify.ts";
import { classifyFallback } from "../llm/fallback.ts";
import { createGeminiClient } from "../llm/gemini.ts";
import { geminiEnabled } from "../llm/index.ts";
import { describeResult, runIntentEval, type IntentCase, type IntentResult } from "../llm/evalIntents.ts";
import type { ClassifyContext, SafetyIntent } from "../shared/types.ts";

const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 4500);

function report(label: string, results: IntentResult[]) {
  const bad = results.filter((r) => !r.ok);
  const falseAlarms = results.filter((r) => r.clear === true && r.c.expectedClear !== true);
  const byClassifier = new Map<string, number>();
  for (const r of results) byClassifier.set(r.classifier, (byClassifier.get(r.classifier) ?? 0) + 1);
  console.log(`\n${label}: ${results.length - bad.length}/${results.length} match`);
  console.log(`  classifier used: ${[...byClassifier].map(([k, n]) => `${k}=${n}`).join(", ")}`);
  console.log(`  false clear-danger: ${falseAlarms.length}`);
  for (const r of bad) console.log(`  ✗ ${describeResult(r)}`);
}

const all = cases as IntentCase[];
report("deterministic + conservative fallback (Gemini off)", await runIntentEval(all, classifyFallback));

const key = process.env.GEMINI_API_KEY?.trim();
if (geminiEnabled() && key) {
  const gemini = createGeminiClient(key);

  /** Retries 429s after a pause so the eval measures answers, not quota. */
  async function modelOnly(text: string, ctx: ClassifyContext): Promise<SafetyIntent | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await gemini.classifyModelOnly(text, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("429")) return null;
        await Bun.sleep(20_000);
      }
    }
    return null;
  }

  // Production pipeline: only cases the deterministic layer leaves open reach Gemini, so only those are spaced out.
  const pipeline: IntentResult[] = [];
  for (const c of all) {
    const ctx: ClassifyContext = { safetyState: "safe", awaiting: c.awaiting ?? null, recent: c.recent ?? [] };
    const reachesGemini = !classifyDeterministic(c.input, ctx) && classifyConservative(c.input).kind !== "danger";
    if (reachesGemini) await Bun.sleep(DELAY_MS);
    pipeline.push(...(await runIntentEval([c], gemini.classify)));
  }
  report("production pipeline (deterministic first, guarded Gemini for the rest)", pipeline);

  if (process.env.EVAL_MODEL_ONLY !== "0") report(
    "Gemini alone (no deterministic layer, no guard)",
    await runIntentEval(
      all,
      async (text, ctx) => {
        const intent = await modelOnly(text, ctx);
        // "fallback" here means Gemini failed or returned invalid output twice.
        return { intent: intent ?? { kind: "unclear" }, classifier: intent ? "gemini" : "fallback" };
      },
      { delayMs: DELAY_MS },
    ),
  );
} else {
  console.log("\nGemini off (no GEMINI_API_KEY or USE_GEMINI=0): skipped the Gemini passes.");
}
