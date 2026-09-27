import type { ClassifyInput, WriteMessages } from "../shared/types.ts";
import { templates } from "../shared/templates.ts";
import { classifyLocal } from "./classify.ts";

export const writeMessagesFallback: WriteMessages = async () => ({
  prompt: templates.prompt,
  checkin: templates.checkin,
  arrived: templates.arrived,
  ended: templates.ended,
});

/** Deterministic rules, then the conservative read. Used when Gemini is off. */
export const classifyFallback: ClassifyInput = async (text, ctx) => classifyLocal(text, ctx);
