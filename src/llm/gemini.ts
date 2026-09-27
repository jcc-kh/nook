import { GoogleGenAI } from "@google/genai";
import type { ClassifyInput, WalkPlan, WriteMessages } from "../shared/types.ts";
import { templates } from "../shared/templates.ts";
import { CLASSIFY_PROMPT, classifyFallback, guardIntent, sanitizeIntent } from "./classify.ts";
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
} {
  const ai = new GoogleGenAI({ apiKey });

  async function generateJson(prompt: string): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Gemini timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
    });
    const response = await Promise.race([
      ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
          temperature: 0.4,
          responseMimeType: "application/json",
        },
      }),
      timeout,
    ]).finally(() => clearTimeout(timer));
    const text = response.text ?? "";
    if (!text.trim()) throw new Error("empty Gemini response");
    return extractJsonObject(text);
  }

  const writeMessages: WriteMessages = async (plan: WalkPlan) => {
    try {
      const raw = await generateJson(
        `You write short iMessage texts for Nook, a friend who walks someone home at night.
Tone: texting a close friend. ALWAYS lowercase. brief (under ~90 chars). casual, not chatbotty.
Never use em dashes (—) or en dashes (–). use commas or periods instead.
No emoji and no "tap 👍" instructions: Nook appends the reaction legend itself.
Return JSON with exactly these string keys: prompt, checkin, nudge, arrived, ended, unclear.

Context: expected walk ~${Math.round(plan.expectedMin)} min, late after ~${Math.round(plan.lateMin)} min, ${plan.stops.length} known stop(s) on route.

Meanings:
- prompt: casual "heading home?" when night movement shows up
- checkin: quick "you good?" mid-walk
- nudge: follow-up when they ghosted a check-in
- arrived: they made it home
- ended: walk wrapped somewhere else
- unclear: didn't get what they said; ask if they're okay, uneasy, want a call, or in danger`,
      );
      const obj = raw as Record<string, unknown>;
      const pick = (key: string, fallback: string) =>
        typeof obj[key] === "string" && (obj[key] as string).trim()
          ? (obj[key] as string).trim()
          : fallback;
      return {
        prompt: pick("prompt", templates.prompt),
        checkin: pick("checkin", templates.checkin),
        nudge: pick("nudge", templates.nudge),
        arrived: pick("arrived", templates.arrived),
        ended: pick("ended", templates.ended),
        unclear: pick("unclear", templates.unclear),
      };
    } catch (err) {
      console.warn("[llm:gemini] writeMessages failed, using templates", err);
      return writeMessagesFallback(plan);
    }
  };

  const classify: ClassifyInput = async (text: string) => {
    const regex = classifyFallback(text);
    // Unmistakable danger never waits on the model.
    if (regex.kind === "danger" && regex.clear) return regex;
    try {
      const raw = await generateJson(`${CLASSIFY_PROMPT}\n\nMessage: ${JSON.stringify(text)}`);
      return guardIntent(regex, sanitizeIntent(raw, text));
    } catch (err) {
      console.warn("[llm:gemini] classify failed, using regex", err);
      return regex;
    }
  };

  return { writeMessages, classify };
}
