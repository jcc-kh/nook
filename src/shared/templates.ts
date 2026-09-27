import type { NoResponseAction } from "./settings.ts";
import type { SendTextTag } from "./types.ts";

/** Canned copy used when Gemini is absent or fails (L1–L2 default). */
export const templates = {
  prompt: "Heading home? 👍",
  started: "Got it, I'm with you until you're home. I'll only check in if something looks off. Text 'call me' anytime.",
  checkin: "You ok? Tap 👍 or text me.",
  nudge: "Still there? Tap 👍 so I know you're alright.",
  arrived: "I see that you got home safe. Have a good rest!",
  ended: "Walk ended — staying somewhere else tonight.",
  unclear: "Didn't catch that — tap 👍 if you're good, or text me.",
  checkinOffRoute: "Looks like you're off your usual route. All good? Tap 👍 or tell me where you're headed.",
  checkinNoUpdate: "I haven't had a location update from you in a few minutes. You ok? Tap 👍 or text me.",
  finalNudge: "Haven't heard back. Tap 👍 when you can — I won't reach out to anyone.",
} as const satisfies Record<string, string>;

export type TemplateKey = keyof typeof templates;

export type ContactAlertKind = "quiet" | "offroute" | "help";

/**
 * Text to the trusted contact, who is only texted when something is wrong and
 * may never have heard of Nook. `who` is the user's name or number.
 */
export function contactAlert(kind: ContactAlertKind, who: string): string {
  const intro = `Nook here: ${who} added you as their trusted contact for getting home safe.`;
  switch (kind) {
    case "quiet":
      return `${intro} They're out and haven't answered my check-ins. Last known location below.`;
    case "offroute":
      return `${intro} They went off their usual route and haven't answered my check-ins. Last known location below.`;
    case "help":
      return `${intro} They need help. Please check on them now. Last known location below.`;
  }
}

function waitLabel(sec: number): string {
  if (sec % 60 !== 0) return `${sec} seconds`;
  const min = sec / 60;
  return min === 1 ? "a minute" : `${min} minutes`;
}

/** Appended to the nudge so the user knows what their no-reply setting will do next. */
export function nextStepLine(action: NoResponseAction, afterSec: number, contactName?: string): string {
  const them = contactName ?? "your trusted contact";
  const within = `If I don't hear back in ${waitLabel(afterSec)}`;
  switch (action) {
    case "CALL_USER":
      return `${within}, I'll call you.`;
    case "CONTACT_TRUSTED":
      return `${within}, I'll text ${them}.`;
    case "CALL_THEN_CONTACT":
      return `${within}, I'll call you, then text ${them}.`;
    case "NONE":
      return "";
  }
}

export function templateForTag(tag: SendTextTag): string {
  switch (tag) {
    case "prompt":
      return templates.prompt;
    case "started":
      return templates.started;
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
