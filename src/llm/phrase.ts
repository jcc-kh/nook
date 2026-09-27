import { GoogleGenAI } from "@google/genai";
import { geminiEnabled } from "./index.ts";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";
const TIMEOUT_MS = 3_500;

/**
 * One spoken line for ElevenLabs, written from Geoapify (or fixture) facts.
 * Gemini may only warm up the wording. Place names, minute counts, and the
 * turn instruction have to appear unchanged; otherwise the deterministic line is used.
 */
export async function phraseForVoice(data: unknown): Promise<string | null> {
  const facts = speechFacts(data);
  if (!facts) return null;
  if (!facts.allowModel) return facts.fallback;
  if (!geminiEnabled()) return facts.fallback;
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return facts.fallback;
  try {
    const said = await ask(key, facts);
    return said && keepsFacts(said, facts.mustInclude) ? said : facts.fallback;
  } catch (err) {
    console.warn("[llm] voice phrase failed, using the map line", err instanceof Error ? err.message : err);
    return facts.fallback;
  }
}

interface SpeechFacts {
  fallback: string;
  mustInclude: string[];
  /** False when a model rewrite could invent a place or a turn. */
  allowModel: boolean;
  brief: string;
}

function speechFacts(data: unknown): SpeechFacts | null {
  if (!data || typeof data !== "object") return null;
  const rec = data as Record<string, unknown>;
  if (rec.ok === false) return null;

  if (rec.navigation && typeof rec.navigation === "object") {
    const inner = speechFacts(rec.navigation);
    if (!inner) return null;
    const dest = typeof rec.destination === "string" ? rec.destination : null;
    if (!dest) return inner;
    return {
      ...inner,
      fallback: `Heading to ${dest}. ${inner.fallback}`,
      mustInclude: [dest, ...inner.mustInclude],
      brief: `Destination: ${dest}. ${inner.brief}`,
    };
  }

  if (Array.isArray(rec.places)) {
    const places = rec.places
      .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
      .slice(0, 2)
      .map((p) => ({
        name: typeof p.name === "string" ? p.name : "",
        minutes: typeof p.walk_minutes === "number" ? p.walk_minutes : null,
      }))
      .filter((p) => p.name);
    if (!places.length) {
      return {
        fallback: "I couldn't find a place that's open all night nearby. Stay on a main, well-lit street.",
        mustInclude: [],
        allowModel: false,
        brief: "No open-all-night place.",
      };
    }
    const bits = places.map((p) =>
      p.minutes != null ? `${p.name}, about ${p.minutes} minutes away` : p.name,
    );
    const joined = bits.length === 1 ? `There's ${bits[0]}.` : `There's ${bits[0]}, or ${bits[1]}.`;
    const hours = bits.length === 1 ? "It's open all night." : "Both are open all night.";
    return {
      fallback: `${joined} ${hours}`,
      mustInclude: places.flatMap((p) => (p.minutes != null ? [p.name, String(p.minutes)] : [p.name])),
      allowModel: true,
      brief: places.map((p) => `${p.name} open all night, ${p.minutes ?? "?"} minutes`).join("; "),
    };
  }

  if (rec.navigationFresh === false) {
    return {
      fallback: "I'm not getting a fresh location, so I won't guess a turn.",
      mustInclude: [],
      allowModel: false,
      brief: "Location too old for a turn.",
    };
  }

  const instruction = typeof rec.instruction === "string" && rec.instruction.trim() ? rec.instruction.trim() : null;
  if (!instruction) return null;
  const minutes =
    rec.remaining && typeof rec.remaining === "object" && typeof (rec.remaining as { minutes?: unknown }).minutes === "number"
      ? (rec.remaining as { minutes: number }).minutes
      : null;
  const dest =
    rec.destination && typeof rec.destination === "object" && typeof (rec.destination as { name?: unknown }).name === "string"
      ? (rec.destination as { name: string }).name
      : null;
  const tail = minutes != null && minutes > 0 ? ` About ${minutes} minutes left.` : "";
  return {
    fallback: `${instruction}${tail}`,
    mustInclude: [instruction, ...(minutes != null && minutes > 0 ? [String(minutes)] : []), ...(dest ? [dest] : [])],
    allowModel: true,
    brief: [dest && `Going to ${dest}.`, instruction, minutes != null ? `${minutes} minutes left.` : ""]
      .filter(Boolean)
      .join(" "),
  };
}

function keepsFacts(said: string, mustInclude: string[]): boolean {
  const lower = said.toLowerCase();
  return mustInclude.every((part) => lower.includes(part.toLowerCase()));
}

async function ask(apiKey: string, facts: SpeechFacts): Promise<string | null> {
  const ai = new GoogleGenAI({ apiKey });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Gemini timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
  });
  const response = await Promise.race([
    ai.models.generateContent({
      model: MODEL,
      contents: `Write ONE spoken sentence a friend would say on a phone call while walking someone home at night.
Use only the facts below. Keep every place name, every minute number, and the turn instruction exactly as written, including digits.
Do not add a street, a turn, a landmark, or a place that is not in the facts.
No emoji. Return JSON {"say":"..."} .

Facts: ${facts.brief}
Line you may warm up, but must still contain the exact names, numbers, and instruction: ${JSON.stringify(facts.fallback)}`,
      config: { temperature: 0.2, responseMimeType: "application/json" },
    }),
    timeout,
  ]).finally(() => clearTimeout(timer));
  const text = response.text ?? "";
  const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|```$/g, "").trim()) as { say?: unknown };
  return typeof parsed.say === "string" && parsed.say.trim() ? parsed.say.trim() : null;
}
