import { GoogleGenAI } from "@google/genai";
import type { ParseReply, WalkPlan, WriteMessages } from "../shared/types.ts";
import { templates } from "../shared/templates.ts";
import { parseReplyFallback, writeMessagesFallback } from "./fallback.ts";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence?.[1]?.trim() ?? trimmed;
  return JSON.parse(body);
}

export function createGeminiClient(apiKey: string): {
  writeMessages: WriteMessages;
  parseReply: ParseReply;
} {
  const ai = new GoogleGenAI({ apiKey });

  async function generateJson(prompt: string): Promise<unknown> {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        temperature: 0.4,
        responseMimeType: "application/json",
      },
    });
    const text = response.text ?? "";
    if (!text.trim()) throw new Error("empty Gemini response");
    return extractJsonObject(text);
  }

  const writeMessages: WriteMessages = async (plan: WalkPlan) => {
    try {
      const raw = await generateJson(
        `You write short iMessage texts for Nook — a friend who walks someone home at night.
Tone: like texting a close friend. lowercase ok. brief (under ~90 chars). casual, not chatbotty or corporate. optional 👍 only.
Return JSON with exactly these string keys: prompt, checkin, nudge, arrived, ended, unclear.

Context: expected walk ~${Math.round(plan.expectedMin)} min, late after ~${Math.round(plan.lateMin)} min, ${plan.stops.length} known stop(s) on route.

Meanings:
- prompt: casual "heading home?" when night movement shows up
- checkin: quick "you good?" mid-walk
- nudge: follow-up when they ghosted a check-in
- arrived: they made it home
- ended: walk wrapped somewhere else
- unclear: didn't get what they said`,
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

  const parseReply: ParseReply = async (text: string) => {
    try {
      const raw = await generateJson(
        `Classify this walk-home check-in reply for a safety agent.
Return JSON: {"status":"ok"|"help"|"unclear","placeLabel"?:string}
- ok: they're fine / safe / heading somewhere intentional
- help: danger, emergency, scared, need help
- unclear: can't tell
If they name a place they're staying, set placeLabel.

Reply: ${JSON.stringify(text)}`,
      );
      const obj = raw as { status?: string; placeLabel?: string };
      const status =
        obj.status === "ok" || obj.status === "help" || obj.status === "unclear"
          ? obj.status
          : "unclear";
      return {
        status,
        ...(typeof obj.placeLabel === "string" && obj.placeLabel.trim()
          ? { placeLabel: obj.placeLabel.trim() }
          : {}),
      };
    } catch (err) {
      console.warn("[llm:gemini] parseReply failed, using fallback", err);
      return parseReplyFallback(text);
    }
  };

  return { writeMessages, parseReply };
}
