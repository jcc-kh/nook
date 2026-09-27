import type { ClassifyInput, WriteMessages } from "../shared/types.ts";
import { createGeminiClient } from "./gemini.ts";
import { classifyFallback, writeMessagesFallback } from "./fallback.ts";

export { classifyFallback, writeMessagesFallback } from "./fallback.ts";
export { classifyLocal, reactionIntent } from "./classify.ts";

/**
 * LLM craft/classify. Never imported from the location-ping rule path except via
 * injected classify / writeMessages dependencies on the brain.
 */

export interface Llm {
  writeMessages: WriteMessages;
  classify: ClassifyInput;
  /** True when Gemini is active (API key present and USE_GEMINI !== "0"). */
  useGemini: boolean;
}

/** Resolve whether Gemini should run for this process. */
export function geminiEnabled(): boolean {
  if (process.env.USE_GEMINI === "0") return false;
  if (process.env.USE_GEMINI === "1") return Boolean(process.env.GEMINI_API_KEY?.trim());
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

export function createLlm(opts?: { useGemini?: boolean }): Llm {
  const useGemini = opts?.useGemini ?? geminiEnabled();
  if (useGemini) {
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key) {
      console.warn("[llm] USE_GEMINI requested but GEMINI_API_KEY missing — templates only");
      return { writeMessages: writeMessagesFallback, classify: classifyFallback, useGemini: false };
    }
    console.log("[llm] Gemini enabled");
    const { writeMessages, classify } = createGeminiClient(key);
    return { writeMessages, classify, useGemini: true };
  }
  console.log("[llm] templates + regex fallback (Gemini off)");
  return { writeMessages: writeMessagesFallback, classify: classifyFallback, useGemini: false };
}
