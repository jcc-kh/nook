import type { NoResponseAction } from "./settings.ts";
import type { SendTextTag } from "./types.ts";

/**
 * Tapback shortcuts. Every message that relies on them also says the options in
 * words, and the legend is appended in code so LLM-written copy can't drop it.
 */
export const LEGEND = "reply normally, or use: 👍 safe · 👎 uneasy · ❓ call me · ‼️ immediate danger";

export function withLegend(text: string): string {
  return `${text}\n${LEGEND}`;
}

/** Canned copy used when Gemini is absent or fails (L1-L2 default). Friend iMessage voice. */
export const templates = {
  prompt: "heading home?",
  started: "ok i'm with you. i'll only text if something looks off.",
  checkin: "you good?",
  nudge: "still there? reply ok if you're fine, or tell me what's going on",
  arrived: "home safe 👍 night!",
  ended: "ok wrapping up, looks like you're staying put",
  unclear: "didn't catch that. are you okay, feeling uneasy, want me to call, or in immediate danger?",
  checkinOffRoute: "this isn't your usual way home. all good? or tell me where you're headed",
  checkinNoUpdate: "haven't seen your location in a bit. you ok?",
  /** They were moving, then stayed in one spot. 👍 / ok means they arrived on purpose. */
  stoppedCheckin:
    "you've been in one spot for a few minutes. reply ok if you're where you want to be, or say you're still on your way",
  stoppedDone: "cool, i'll assume you got where you were going. text walk me home if you head out",
  stillGoing: "ok, still with you. i'll check in again if you stop for a bit",
  finalNudge: "still nothing. reply ok when you can, or text stop and i'll back off",
  /** After they 👍'd a dwell check-in but are still parked away from home. */
  lingerOffer:
    "you haven't moved for a while but you said you were good, so i'm assuming you're fine. reply yes if you still want me keeping tabs, or text stop",
  lingerDrop: "cool, i'll stop hovering. text walk me home anytime",
} as const satisfies Record<string, string>;

export type TemplateKey = keyof typeof templates;

/** Lines appended to every trip start: hands-free calls and destination sharing. */
export const TRIP_START_EXTRAS =
  "ask me to call anytime for hands-free guidance. heading somewhere other than home? share the apple maps place or directions here and i'll use that route. text stop anytime.";

export function tripStart(lead: string): string {
  return `${lead}\n\n${LEGEND}\n\n${TRIP_START_EXTRAS}`;
}

export type ContactAlertKind = "quiet" | "offroute" | "unconfirmed";

/**
 * Non-emergency text to the trusted contact (a check-in went unanswered), who
 * may never have heard of Nook. `who` is the user's name and number.
 */
export function contactAlert(kind: ContactAlertKind, who: string, quote?: string): string {
  const intro = `hey, this is nook. ${who} has you as their get-home contact.`;
  switch (kind) {
    case "quiet":
      return `${intro} they're out and haven't answered my check-ins for a few minutes. last location below. could you check on them?`;
    case "offroute":
      return `${intro} they went off their usual route and haven't answered my check-ins. last location below. could you check on them?`;
    case "unconfirmed":
      return `${intro} they texted me "${quote ?? "help"}" and haven't answered since. last location below. please check on them.`;
  }
}

function waitLabel(sec: number): string {
  if (sec % 60 !== 0) return `${sec} seconds`;
  const min = sec / 60;
  return min === 1 ? "a minute" : `${min} minutes`;
}

/** Appended to the nudge so the user knows what their no-reply setting will do next. */
export function nextStepLine(action: NoResponseAction, afterSec: number, contactName?: string): string {
  const them = contactName ?? "your person";
  switch (action) {
    case "CONTACT_TRUSTED":
      return `if i don't hear back in ${waitLabel(afterSec)} i'll text ${them} your location`;
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
