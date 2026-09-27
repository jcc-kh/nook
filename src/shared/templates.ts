import type { SendTextTag } from "./types.ts";

/** Canned copy used when Gemini is absent or fails (L1–L2 default). */
export const templates = {
  prompt: "Heading home? 👍",
  checkin: "You ok? Tap 👍 or text me.",
  nudge: "Still there? Tap 👍 so I know you're alright.",
  arrived: "I see that you got home safe. Have a good rest!",
  ended: "Walk ended — staying somewhere else tonight.",
  unclear: "Didn't catch that — tap 👍 if you're good, or text me.",
  checkinOffRoute: "Looks like you're off your usual route. All good? Tap 👍 or tell me where you're headed.",
  checkinNoUpdate: "I haven't had a location update from you in a few minutes. You ok? Tap 👍 or text me.",
  finalNudge: "Haven't heard back. Tap 👍 when you can — I won't reach out to anyone.",
  // The contact is only texted when something is wrong.
  alertContactQuiet: "Nook: no reply while walking. Last known location below.",
  alertContactOffRoute: "Nook: went off their usual route and isn't answering check-ins. Last known location below.",
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
