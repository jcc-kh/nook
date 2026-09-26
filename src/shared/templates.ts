import type { SendTextTag } from "./types.ts";

/** Canned copy used when Gemini is absent or fails (L1–L2 default). */
export const templates = {
  prompt: "Heading home? 👍",
  checkin: "You ok? Tap 👍 or text me.",
  nudge: "Still there? Tap 👍 so I know you're alright.",
  arrived: "Got home safe.",
  ended: "Walk ended — staying somewhere else tonight.",
  unclear: "Didn't catch that — tap 👍 if you're good, or text me.",
  alertContactQuiet: "Nook: no reply while walking. Last known location below.",
  alertContactHome: "Nook: made it home.",
  alertContactElsewhere: "Nook: ended the walk elsewhere.",
  alertContactHelp: "Nook: needs help — check on them.",
} as const satisfies Record<string, string>;

export type TemplateKey = keyof typeof templates;

export function templateForTag(tag: SendTextTag): string {
  switch (tag) {
    case "prompt":
      return templates.prompt;
    case "checkin":
      return templates.checkin;
    case "nudge":
      return templates.nudge;
    case "arrived":
      return templates.arrived;
    case "ended":
      return templates.ended;
  }
}
