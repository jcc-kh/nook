/**
 * The eval fixture against the deterministic classifier (what runs when
 * Gemini is off). `bun run eval:intents` runs the same cases against Gemini.
 */
import { expect, test } from "bun:test";
import cases from "./fixtures/safety-intents.json";
import { classifyFallback } from "../src/llm/fallback.ts";
import { describeResult, runIntentEval, type IntentCase } from "../src/llm/evalIntents.ts";

test("deterministic classifier matches every eval case", async () => {
  const results = await runIntentEval(cases as IntentCase[], classifyFallback);
  const mismatches = results.filter((r) => !r.ok).map(describeResult);
  expect(mismatches).toEqual([]);
});

test("no eval case produces a clear danger it shouldn't", async () => {
  const results = await runIntentEval(cases as IntentCase[], classifyFallback);
  const falseAlarms = results.filter((r) => r.clear === true && r.c.expectedClear !== true).map(describeResult);
  expect(falseAlarms).toEqual([]);
});
