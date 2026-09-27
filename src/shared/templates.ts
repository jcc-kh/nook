import type { NoResponseAction } from "./settings.ts";
import type { SendTextTag } from "./types.ts";

/** Canned copy used when Gemini is absent or fails (L1-L2 default). Friend iMessage voice. */
export const templates = {
  prompt: "heading home? 👍",
  started: "ok i'm with you. only texting if something looks off. text stop anytime, or call me if you need me",
  checkin: "you good? 👍 or just text me (or stop to dismiss)",
  nudge: "still there? tap 👍 so i know, or text stop",
  arrived: "home safe 👍 night!",
  ended: "ok wrapping up, looks like you're staying put",
  unclear: "wait what? 👍 if you're good, text stop to dismiss, or just text me",
  checkinOffRoute: "this isn't your usual way home. all good? 👍 or tell me where you're headed (or stop)",
  checkinNoUpdate: "haven't seen your location in a bit. you ok? 👍 or text stop",
  finalNudge: "still nothing. tap 👍 when you can, or text stop and i'll back off",
  /** After they 👍'd a dwell check-in but are still parked away from home. */
  lingerOffer:
    "you haven't moved for a while but you 👍'd my last one so i'm assuming you're good. 👍 if you still want me keeping tabs, or text stop",
  lingerDrop: "cool, i'll stop hovering. text walk me home anytime",
} as const satisfies Record<string, string>;

export type TemplateKey = keyof typeof templates;

export type ContactAlertKind = "quiet" | "offroute" | "help";

/**
 * Text to the trusted contact, who is only texted when something is wrong and
 * may never have heard of Nook. `who` is the user's name when Nook has one.
 */
export function contactAlert(kind: ContactAlertKind, who: string): string {
  const intro = `hey, ${who} has you as their get-home contact on nook.`;
  switch (kind) {
    case "quiet":
      return `${intro} they're out and haven't answered me. last location below.`;
    case "offroute":
      return `${intro} they went off their usual route and went quiet. last location below.`;
    case "help":
      return `${intro} they need help, please check on them. last location below.`;
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
  const within = `if i don't hear back in ${waitLabel(afterSec)}`;
  switch (action) {
    case "CALL_USER":
      return `${within} i'll call you`;
    case "CONTACT_TRUSTED":
      return `${within} i'll text ${them}`;
    case "CALL_THEN_CONTACT":
      return `${within} i'll call you, then text ${them}`;
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
