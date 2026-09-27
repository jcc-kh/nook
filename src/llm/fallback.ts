import type { ClassifyInput, WriteMessages } from "../shared/types.ts";
import { templates } from "../shared/templates.ts";
import { classifyFallback as classifyText } from "./classify.ts";

export const writeMessagesFallback: WriteMessages = async () => ({
  prompt: templates.prompt,
  checkin: templates.checkin,
  nudge: templates.nudge,
  arrived: templates.arrived,
  ended: templates.ended,
  unclear: templates.unclear,
});

/** Regex classifier used when Gemini is off or fails. */
export const classifyFallback: ClassifyInput = async (text) => classifyText(text);
