import {
  resolveTimeouts,
  type CheckinTimeouts,
  type LearnedRoutine,
  type MonitoringMode,
  type NoResponseAction,
  type TrustedContact,
} from "../shared/settings.ts";
import type { UserRecord } from "../store/index.ts";

/** Trusted contact as the user refers to them ("Alex" / "my trusted person"). */
function theirs(contact?: TrustedContact): string {
  return contact?.name ?? "my trusted person";
}

/** Trusted contact as Nook refers to them ("Alex" / "your trusted contact"). */
function yours(contact?: TrustedContact): string {
  return contact?.name ?? "your trusted contact";
}

export const monitoringOptions: MonitoringMode[] = ["MANUAL", "EVENINGS", "AWAY_FROM_HOME"];
export const escalationOptions: NoResponseAction[] = [
  "CALL_USER",
  "CONTACT_TRUSTED",
  "CALL_THEN_CONTACT",
  "NONE",
];

const monitoringLabel: Record<MonitoringMode, string> = {
  MANUAL: "only when you start a trip",
  EVENINGS: "evenings",
  AWAY_FROM_HOME: "whenever you're away from home",
};

/** User's voice, used in the settings summary. */
function escalationSummary(action: NoResponseAction, c?: TrustedContact): string {
  switch (action) {
    case "CALL_USER":
      return "text me first, then call me";
    case "CONTACT_TRUSTED":
      return `text me first, then contact ${theirs(c)}`;
    case "CALL_THEN_CONTACT":
      return `text me first, then call me, then contact ${theirs(c)} if I still don't respond`;
    case "NONE":
      return "text me first, nothing further";
  }
}

/** Nook's voice: what happens if a check-in goes unanswered. */
function escalationPlan(action: NoResponseAction, c?: TrustedContact): string {
  switch (action) {
    case "CALL_USER":
      return "i'll call you";
    case "CONTACT_TRUSTED":
      return `i'll contact ${yours(c)}`;
    case "CALL_THEN_CONTACT":
      return `i'll call you, then contact ${yours(c)} if you still don't respond`;
    case "NONE":
      return "i won't escalate further";
  }
}

export function learnedSummary(r: LearnedRoutine): string {
  const lines = [
    r.frequentPlaces.length ? `places you visit often: ${r.frequentPlaces.join(", ")}` : "",
    r.commonRoutes.length ? `routes you commonly take: ${r.commonRoutes.join(", ")}` : "",
    r.usualStops.length ? `usual stops: ${r.usualStops.join(", ")}` : "",
    r.typicalTripMinutes ? `typical trip: about ${r.typicalTripMinutes} min` : "",
  ].filter(Boolean);
  return lines.length ? ["here's what i've picked up so far:", ...lines].join("\n") : copy.learnedNothing;
}

function contactLabel(c: TrustedContact): string {
  return c.name ?? `the number ending in ${c.phone.slice(-4)}`;
}

/** "22:00" → "10pm", "06:30" → "6:30am". */
function clockLabel(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${suffix}` : `${h12}${suffix}`;
}

/** Nook's voice: when it will watch without being asked. */
function monitoringPlan(user: UserRecord): string {
  switch (user.monitoringMode) {
    case "MANUAL":
      return "i'll only watch when you ask. text 'walk me home' or 'heading out' when you leave.";
    case "AWAY_FROM_HOME":
      return "i'll keep an eye on things whenever you're away from home. you can also text 'walk me home' anytime.";
    case "EVENINGS":
    default:
      return `i'll keep an eye on your trips in the evenings (${clockLabel(user.nightStart ?? "22:00")}-${clockLabel(user.nightEnd ?? "06:00")}). you can also text 'walk me home' anytime.`;
  }
}

function timingSummary(t: Required<CheckinTimeouts>): string {
  return `nudge after ${t.nudgeAfterSec}s, next step ${t.escalateAfterSec}s after that, check in if your location stops for ${t.noUpdateMin} min`;
}

export const copy = {
  askContact: "who should i contact if something seems wrong? send me their name and phone number (or share their contact card).",
  /** First message to a new user: who Nook is, then the first question. */
  welcome:
    "hi, i'm nook 🌙 i keep an eye on your trips and check in if something seems unusual. if i can't confirm you're okay, i can call you or reach someone you trust.\n\nfirst, what's your name?",
  askUserName: "what's your name? i'll use it when i check in, and so your trusted contact knows who i'm texting about.",
  badUserName: "just your first name is fine, like 'alex'.",
  userNameSaved: (name: string) => `nice to meet you, ${name}.`,
  confirmUserName: (name: string) => `change your name to ${name}? reply yes to confirm.`,
  askContactName: "got the number. what's their name?",
  askContactPhone: (name: string) => `what's ${name}'s phone number?`,
  badContactName: "just their first name is fine, like 'sam' or 'mom'.",
  badContact:
    "that doesn't look like a valid phone number. send it with the area code, like: sam 646 555 1234 (or +44… for other countries).",
  contactIsSelf: "that's your own number. send the number of someone you trust.",
  contactSaved: (c: TrustedContact) =>
    c.name ? `got it, ${c.name} is your trusted contact.` : "got it, your trusted contact is saved.",

  askMonitoring:
    "when should i keep an eye on your location?\n1. only when i tell nook i'm heading somewhere\n2. during evenings / nighttime\n3. whenever i'm away from home",

  askEscalation: (c?: TrustedContact) =>
    `if something seems unusual, i'll check in with you by text first.\n\nif you don't respond, what should i do next?\n1. call me\n2. contact ${theirs(c)}\n3. call me, then contact ${theirs(c)} if i still don't respond\n4. don't escalate further`,

  locationRequest:
    "next, share your location with me using the card below (choose share indefinitely). or reply 'skip' to do it later.",
  locationTerminal: "(terminal) share a location with /loc <lat> <lon>, or reply 'skip'.",
  locationWaiting:
    "i don't see your location yet. tap the card above and choose share indefinitely, or reply 'skip' to do it later.",
  locationConnected: "location sharing is connected ✓",
  locationSkipped: "no problem. i can't watch your trips until you share your location with me.",

  askHome: "are you at home right now? reply yes and i'll remember this spot as home, or no.",
  homeLater: "okay. text 'home' the next time you're there.",

  /** Recap of what the user chose, in terms of what Nook will actually do. */
  done(user: UserRecord): string {
    const lines = ["you're all set 🌙", monitoringPlan(user)];
    if (user.escalation) {
      lines.push(
        `if something looks unusual i'll text you first. if you don't answer, ${escalationPlan(user.escalation.onNoTextResponse, user.trustedContact)}.`,
      );
    }
    if (user.homeLat === undefined) {
      lines.push(
        "one more thing: text 'home' next time you're there, so i know where home is and can tell when you've made it back.",
      );
    }
    lines.push(
      "text 'settings' anytime to change when i monitor, who i contact, how i escalate, or your check-in timing.",
    );
    return lines.join("\n\n");
  },

  pickNumber: (n: number) => `reply with a number from 1 to ${n}.`,
  yesOrNo: "reply yes or no.",

  learnedNothing:
    "i haven't learned enough about your routine yet. as you use nook, i'll gradually pick up patterns like places you visit often and routes you commonly take.",

  callFailed: "i tried to call you but couldn't place the call. tap 👍 if you're okay, or text me.",
  contactAlerted: (name?: string) => `i've let ${name ?? "your trusted contact"} know and sent them your location.`,
  contactUnreachable: (name?: string) =>
    `i tried to reach ${name ?? "your trusted contact"} but my message didn't go through. if you need help, contact someone directly. tap 👍 if you're okay.`,

  homeSaved: "home saved.",
  homeNoFix:
    "i can't see your location right now. make sure location sharing with me is on, then text 'home' again.",

  greetingIdle:
    "hey, text me 'walk me home' when you head out, or i'll notice if you start walking at night. text 'stop' anytime to dismiss me",
  greetingPrompted: "still waiting. 👍 to start the walk, or 👎 / text 'stop' if you're not heading out",
  greetingWalking: "hey, still with you on this trip. text 'stop' if you don't need me, or text if you need anything",
  idleUnclear: "i can walk you home, or text 'settings'. didn't catch a trip in that",
  /** Night movement / soft rejoin after a restart. starts tracking, no reaction needed. */
  nightOut: "hey, saw that you were out. it's getting late, i'll walk you home. text 'stop' if you don't need me",
  nightOutUnfamiliar:
    "hey, saw that you were out. it's getting late, i'll walk you home. this isn't an area you've been much; i'll check in if anything looks off. text 'stop' anytime",
  unfamiliarArea:
    "noticed you started walking but this isn't an area you've been. i'll check in with you in a bit. text 'stop' if you're all set",
  dismissed: "got it, i'll stop asking. text walk me home anytime",
  dismissedIdle: "okay, i'm not watching right now. text walk me home when you want me",

  confirmMonitoring: (mode: MonitoringMode) =>
    `change monitoring to ${monitoringLabel[mode]}? reply yes to confirm.`,
  confirmContact: (c: TrustedContact) =>
    `make ${contactLabel(c)} your trusted contact? reply yes to confirm.`,
  confirmEscalation: (action: NoResponseAction, c?: TrustedContact) =>
    `if you miss a check-in, ${escalationPlan(action, c)}. save this? reply yes to confirm.`,

  askNudgeAfter: (current: number) =>
    `if you don't answer a check-in, how many seconds should i wait before nudging you? (30-600, now ${current}s. say 'same' to keep it.)`,
  askEscalateAfter: (current: number) =>
    `after the nudge, how many seconds before i take the next step? (30-600, now ${current}s. say 'same' to keep it.)`,
  askNoUpdate: (current: number) =>
    `if your location stops updating while i'm watching, how many minutes before i check in? (2-15, now ${current} min. say 'same' to keep it.)`,
  badTiming: (min: number, max: number, unit: string) => `send a number from ${min} to ${max} ${unit}.`,
  confirmTimeouts: (t: Required<CheckinTimeouts>) =>
    `save these timings? ${timingSummary(t)}. reply yes to confirm.`,
  changeSaved: "done, your settings are updated.",
  changeCancelled: "okay, i didn't change anything.",

  settings(user: UserRecord): string {
    const c = user.trustedContact;
    const lines = [
      "nook settings",
      `name: ${user.displayName ?? "not set"}`,
      `monitoring: ${user.monitoringMode ? monitoringLabel[user.monitoringMode] : "not set"}`,
      `trusted contact: ${c ? contactLabel(c) : "not set"}`,
      `if something seems unusual: ${
        user.escalation ? escalationSummary(user.escalation.onNoTextResponse, c) : "not set"
      }`,
      `check-in timing: ${timingSummary(resolveTimeouts(user.timeouts))}`,
      `home: ${user.homeLat !== undefined ? "saved" : "not saved yet (text 'home' when you're there)"}`,
      "",
      "you can say things like:",
      "- 'change my name'",
      "- 'only monitor when i start a trip'",
      "- 'change my trusted contact'",
      "- 'don't contact anyone if i miss a check-in'",
      "- 'change my check-in timing'",
      "- 'what have you learned about me?'",
    ];
    return lines.join("\n");
  },
};
