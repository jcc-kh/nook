import { GoogleGenAI } from "@google/genai";
import type {
  Classification,
  ClassifyContext,
  ClassifyInput,
  SafetyIntent,
  WalkPlan,
  WriteMessages,
} from "../shared/types.ts";
import { templates } from "../shared/templates.ts";
import {
  buildClassifyPrompt,
  buildRepairPrompt,
  classifyConservative,
  classifyDeterministic,
  guardIntent,
  intentJsonSchema,
  intentSchema,
  toSafetyIntent,
} from "./classify.ts";
import { writeMessagesFallback } from "./fallback.ts";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";
/** The brain handles one event at a time, so a slow reply would stall every user's timers. */
const TIMEOUT_MS = 4_000;

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence?.[1]?.trim() ?? trimmed;
  return JSON.parse(body);
}

export function createGeminiClient(apiKey: string): {
  writeMessages: WriteMessages;
  classify: ClassifyInput;
  /** Gemini's validated answer alone, without the deterministic layer or guard (evals only). */
  classifyModelOnly: (text: string, ctx: ClassifyContext) => Promise<SafetyIntent | null>;
} {
  const ai = new GoogleGenAI({ apiKey });

  async function generateText(prompt: string, opts: { temperature: number; schema?: unknown }): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Gemini timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
    });
    const response = await Promise.race([
      ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
          temperature: opts.temperature,
          responseMimeType: "application/json",
          ...(opts.schema !== undefined && { responseJsonSchema: opts.schema }),
        },
      }),
      timeout,
    ]).finally(() => clearTimeout(timer));
    const text = response.text ?? "";
    if (!text.trim()) throw new Error("empty Gemini response");
    return text;
  }

  const writeMessages: WriteMessages = async (plan: WalkPlan) => {
    try {
      const raw = extractJsonObject(
        await generateText(
          `You write short iMessage texts for Nook, a walking-safety assistant.
Tone: calm, attentive, useful. Normal sentence capitalization. Brief (under ~80 characters).
Not emotionally needy, not overly comforting, and never narrate your own companionship ("I'm here with you", "I've got you").
Never use em dashes or en dashes. No emoji and no "tap 👍" instructions: Nook appends the reaction legend itself.
Return JSON with exactly these string keys: prompt, checkin, arrived, ended.

Context: expected walk ~${Math.round(plan.expectedMin)} min, late after ~${Math.round(plan.lateMin)} min, ${plan.stops.length} known stop(s) on route.

Meanings:
- prompt: ask if they're heading home, when night movement shows up (e.g. "Heading home?")
- checkin: a plain mid-walk check (e.g. "Everything okay?")
- arrived: they made it home (e.g. "Looks like you made it home 👍" is fine without the emoji)
- ended: the trip wrapped up somewhere other than home`,
          { temperature: 0.4 },
        ),
      );
      const obj = raw as Record<string, unknown>;
      const pick = (key: string, fallback: string) =>
        typeof obj[key] === "string" && (obj[key] as string).trim()
          ? (obj[key] as string).trim()
          : fallback;
      return {
        prompt: pick("prompt", templates.prompt),
        checkin: pick("checkin", templates.checkin),
        arrived: pick("arrived", templates.arrived),
        ended: pick("ended", templates.ended),
      };
    } catch (err) {
      console.warn("[llm:gemini] writeMessages failed, using templates", err);
      return writeMessagesFallback(plan);
    }
  };

  /** One validated answer, one repair retry on malformed output; null if both fail. */
  async function geminiIntent(text: string, ctx: ClassifyContext) {
    const first = await generateText(buildClassifyPrompt(text, ctx), { temperature: 0, schema: intentJsonSchema });
    const parsed = parseIntent(first);
    if (parsed.ok) return toSafetyIntent(parsed.value, text);
    console.warn(`[llm:gemini] classify output invalid (${parsed.error}); retrying once`);
    const second = await generateText(buildRepairPrompt(text, ctx, first, parsed.error), {
      temperature: 0,
      schema: intentJsonSchema,
    });
    const repaired = parseIntent(second);
    if (repaired.ok) return toSafetyIntent(repaired.value, text);
    console.warn(`[llm:gemini] classify output invalid after repair (${repaired.error})`);
    return null;
  }

  const classify: ClassifyInput = async (text, ctx): Promise<Classification> => {
    const sure = classifyDeterministic(text, ctx);
    if (sure) return sure;
    const conservative = classifyConservative(text);
    if (conservative.kind === "danger") return { intent: conservative, classifier: "deterministic" };
    try {
      const llm = await geminiIntent(text, ctx);
      if (!llm) return { intent: conservative, classifier: "fallback" };
      return { intent: guardIntent(conservative, llm), classifier: "gemini" };
    } catch (err) {
      console.warn("[llm:gemini] classify failed, using the conservative fallback", err instanceof Error ? err.message : err);
      return { intent: conservative, classifier: "fallback" };
    }
  };

  return { writeMessages, classify, classifyModelOnly: geminiIntent };
}

function parseIntent(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let obj: unknown;
  try {
    obj = extractJsonObject(raw);
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  const result = intentSchema.safeParse(obj);
  if (!result.success) return { ok: false, error: result.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ") };
  return { ok: true, value: result.data };
}
