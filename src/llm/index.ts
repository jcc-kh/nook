import type { ParseReply, WriteMessages } from "../shared/types.ts";
import { templates } from "../shared/templates.ts";

/**
 * Person B fills these in L3/L5. Do not import from the location-ping rule path.
 * Hour-0 fallbacks: templates only.
 */

export const writeMessagesFallback: WriteMessages = async () => ({
  prompt: templates.prompt,
  checkin: templates.checkin,
  nudge: templates.nudge,
  arrived: templates.arrived,
  ended: templates.ended,
  unclear: templates.unclear,
});

export const parseReplyFallback: ParseReply = async () => ({
  status: "unclear",
});

export function notImplementedLlm(): never {
  throw new Error("TODO: Person B — src/llm (Gemini writeMessages / parseReply)");
}
