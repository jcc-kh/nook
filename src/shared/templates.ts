import type { NoResponseAction } from "./settings.ts";
import type { SendTextTag } from "./types.ts";

/** Tapback shortcuts, said in words; appended in code so LLM-written copy can't drop them. */
export const LEGEND_OPTIONS = "👍 I'm good · 👎 Something feels off · ❓ Call me · ‼️ I need help now";
export const LEGEND = `Reply normally, or use: ${LEGEND_OPTIONS}`;

export function withLegend(text: string): string {
  return `${text}\n\n${LEGEND}`;
}

/**
 * Canned copy. Calm, attentive, useful: not emotionally needy, not overly
 * comforting, and never narrating Nook's own companionship.
 */
export const templates = {
  prompt: "Heading home?",
  started: "Got it. I'll keep an eye on the trip and check in if something seems unusual.",
  checkin: "Everything okay?",
  /** The only follow-up before the no-response setting kicks in. */
  nudge: "Just checking again. Reply when you can and let me know if you're okay or need anything.",
  arrived: "Looks like you made it home 👍",
  ended: "Looks like you're staying put, so I'll wrap up this trip.",
  unclear:
    "I didn't quite get that. Are you okay, does something feel off, would you like me to call, or do you need urgent help?",
  checkinDwell: "Looks like you've stopped for a bit. Everything okay?",
  checkinOffRoute: "Looks like you've gone a different way than usual. Everything okay?",
  checkinNoUpdate: "Your location hasn't updated in a few minutes. Everything okay?",
  checkinLate: "This trip is taking longer than usual. Everything okay?",
  /** "Keep checking in" setting: a later, plain check after an unanswered check-in and nudge. */
  checkinAgain: "Checking in again. Everything okay?",
  /** They were moving, then stayed in one spot. 👍 / ok means they arrived on purpose. */
  stoppedCheckin:
    "You've been in one spot for a few minutes. Reply ok if you're where you want to be, or say you're still on your way.",
  stoppedDone: "Okay, I'll assume you got where you were going. Text 'walk me home' if you head out again.",
  stillGoing: "Okay, I'll keep an eye on the trip and check in again if you stop for a bit.",
  /** After they 👍'd a dwell check-in but are still parked away from home. */
  lingerOffer:
    "You've been in the same spot for a while. Want me to keep watching this trip? Reply yes, or text stop.",
  lingerDrop: "Okay, I'll stop checking in on this trip. Text 'walk me home' anytime.",
} as const satisfies Record<string, string>;

export type TemplateKey = keyof typeof templates;

/** Appended to every trip start. */
export const TRIP_START_EXTRAS = "Heading somewhere other than home? Send me the Apple Maps place or address.";

export function tripStart(lead: string): string {
  return `${lead}\n\n${LEGEND}\n\n${TRIP_START_EXTRAS}`;
}

export type ContactAlertKind = "quiet" | "offroute" | "unconfirmed";

/**
 * Non-emergency text to the trusted contact (a check-in went unanswered), who
 * may never have heard of Nook. `who` is the user's name and number.
 */
export function contactAlert(kind: ContactAlertKind, who: string, quote?: string): string {
  const intro = `Hi, this is Nook. ${who} has you saved as their get-home contact.`;
  switch (kind) {
    case "quiet":
      return `${intro}\n\nI haven't been able to confirm they're okay for the past few minutes. Here's their latest location. Could you check on them?`;
    case "offroute":
      return `${intro}\n\nThey went off their expected route and I haven't been able to confirm they're okay. Here's their latest location. Could you check on them?`;
    case "unconfirmed":
      return `${intro}\n\nThey sent me: "${quote ?? "help"}" and haven't replied since. Here's their latest location. Please try to reach them.`;
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
  switch (action) {
    case "CONTACT_TRUSTED":
      return `If I don't hear back in ${waitLabel(afterSec)}, I'll text ${them} your location.`;
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
