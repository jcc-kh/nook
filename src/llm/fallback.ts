import type { ParseReply, WriteMessages } from "../shared/types.ts";
import { templates } from "../shared/templates.ts";

export const writeMessagesFallback: WriteMessages = async () => ({
  prompt: templates.prompt,
  checkin: templates.checkin,
  nudge: templates.nudge,
  arrived: templates.arrived,
  ended: templates.ended,
  unclear: templates.unclear,
});

/** Regex parser used when Gemini is off or fails. */
export const parseReplyFallback: ParseReply = async (text) => {
  const plain = text.replace(/[‘’]/g, "'");
  const t = plain.toLowerCase();
  if (/\b(help|emergency|scared|danger|unsafe|following me|call 911)\b/.test(t)) return { status: "help" };
  const place = plain.match(/\b(?:i'?m|i am|staying|still|just) at\s+(.+)/i)?.[1]?.replace(/[.!]+$/, "").trim();
  if (place) return { status: "ok", placeLabel: place };
  if (/\b(ok|okay|k|fine|good|safe|all good|yep|yes|yeah|home|here)\b/.test(t)) return { status: "ok" };
  return { status: "unclear" };
};
