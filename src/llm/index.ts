import type { ParseReply, WriteMessages } from "../shared/types.ts";
import { templates } from "../shared/templates.ts";

/**
 * Person B fills these in L3/L5. Do not import from the location-ping rule path
 * except via injected parseReply dependency.
 */

export const writeMessagesFallback: WriteMessages = async () => ({
  prompt: templates.prompt,
  checkin: templates.checkin,
  nudge: templates.nudge,
  arrived: templates.arrived,
  ended: templates.ended,
  unclear: templates.unclear,
});

/** Stub parser for sim/tests until Gemini is wired. */
export const parseReplyFallback: ParseReply = async (text) => {
  const t = text.toLowerCase();
  if (/help|emergency|scared|danger/.test(t)) return { status: "help" };
  if (/ok|fine|good|safe|all good|i'?m good/.test(t)) {
    return { status: "ok" };
  }
  if (/i'?m at |at .+|staying at/.test(t)) {
    const m = text.match(/at\s+(.+)/i);
    return { status: "ok", placeLabel: m?.[1]?.trim() ?? "somewhere" };
  }
  return { status: "unclear" };
};

export function notImplementedLlm(): never {
  throw new Error("TODO: Person B — src/llm (Gemini writeMessages / parseReply)");
}
