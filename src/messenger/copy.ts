import {
  resolveTimeouts,
  type CheckinTimeouts,
  type LearnedRoutine,
  type MonitoringMode,
  type NoResponseAction,
  type TrustedContact,
} from "../shared/settings.ts";
import { LEGEND, tripStart, withLegend } from "../shared/templates.ts";
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
export const escalationOptions: NoResponseAction[] = ["CONTACT_TRUSTED", "NONE"];

const monitoringLabel: Record<MonitoringMode, string> = {
  MANUAL: "only when you start a trip",
  EVENINGS: "evenings, when you're not home",
  AWAY_FROM_HOME: "when you're out and moving",
};

/** User's voice, used in the settings summary. */
function escalationSummary(action: NoResponseAction, c?: TrustedContact): string {
  switch (action) {
    case "CONTACT_TRUSTED":
      return `text me first, then text ${theirs(c)} my location`;
    case "NONE":
      return "text me first, then just keep checking in";
  }
}

/** Nook's voice: what happens if a check-in can't confirm they're okay. */
function escalationPlan(action: NoResponseAction, c?: TrustedContact): string {
  switch (action) {
    case "CONTACT_TRUSTED":
      return `i'll text ${yours(c)} your location`;
    case "NONE":
      return "i'll just keep checking in with you";
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
      return "if you're away from home and moving, i'll watch quietly. if you were moving and then stop for a few minutes, i'll check in. reply ok if you got where you were going. you can also text 'walk me home' anytime.";
    case "EVENINGS":
    default:
      return `in the evenings (${clockLabel(user.nightStart ?? "22:00")}-${clockLabel(user.nightEnd ?? "06:00")}), if you're not home, i'll ask if you're heading home. you can also text 'walk me home' anytime.`;
  }
}

function timingSummary(t: Required<CheckinTimeouts>): string {
  return `nudge after ${t.nudgeAfterSec}s, next step ${t.escalateAfterSec}s after that, check in if your location stops for ${t.noUpdateMin} min`;
}

export const copy = {
  askContact: "who should i contact if something seems wrong? send me their name and phone number (or share their contact card).",
  /** First message to a new user: who Nook is, then the first question. */
  welcome:
    "hi, i'm nook 🌙 i keep an eye on your trips and check in if something seems off.\n\n" +
    "when i check in, just reply, or tap a shortcut:\n" +
    "👍 safe\n👎 uneasy, i'll help you pick a way or somewhere busier\n❓ call me, for hands-free guidance\n‼️ immediate danger, i'll tell you to call 911 and text your trusted person where you are\n\n" +
    "first, what's your name?",
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
    "when should i keep an eye on your location?\n1. only when i tell nook i'm heading somewhere\n2. evenings, if i'm not home\n3. whenever i'm away from home and moving",

  askEscalation: (c?: TrustedContact) =>
    `if something seems unusual, i'll check in with you by text first.\n\nif i check in and can't confirm you're okay:\n1. text ${theirs(c)} my location\n2. just keep checking in with me\n\n(immediate danger is different: if you tap ‼️ or tell me you're in danger, i'll always text ${yours(c)} right away.)`,

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
        `if something looks unusual i'll text you first. if i can't confirm you're okay, ${escalationPlan(user.escalation.onNoTextResponse, user.trustedContact)}.`,
      );
    }
    lines.push(
      `when i check in: ${LEGEND}. if you tell me you're in immediate danger, i'll tell you to call 911 and text ${yours(user.trustedContact)} your location and what you said. text 'call me' anytime if you want me on the phone.`,
    );
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

  talkLink: (url: string) => `📞 tap to talk to me now: ${url}`,
  contactAlerted: (name?: string) => `i've let ${name ?? "your trusted contact"} know and sent them your location.`,
  contactUnreachable: (name?: string) =>
    `i tried to reach ${name ?? "your trusted contact"} but my message didn't go through. if you need help, contact someone directly. reply ok if you're okay.`,
  emergencyDelivered: (name?: string, attachmentsOk = true) =>
    attachmentsOk
      ? `sent. ${name ?? "your trusted contact"} has your location and what you told me.`
      : `sent ${name ?? "your trusted contact"} your location and what you told me, but your voice message didn't attach.`,
  emergencyFailed: (name?: string) =>
    `my text to ${name ?? "your trusted contact"} didn't go through. please call 911${name ? ` or ${name}` : ""} directly.`,
  emergencyNoContact: "i don't have a trusted contact saved, so i couldn't alert anyone. please call 911 directly.",
  voiceNoteForwarded: (name?: string) => `passed your voice message on to ${name ?? "your trusted contact"}.`,
  voiceNoteForwardFailed: (name?: string) =>
    `couldn't forward your voice message to ${name ?? "your trusted contact"}. if you can, call them or 911 directly.`,

  // --- safety states (see brain/engine.ts applyIntent) ---
  legend: LEGEND,
  /** Uneasy: ask which way, unless they already said. */
  uneasyAsk: (dest: string) =>
    `i've got you. want to keep heading to ${dest}, or go somewhere busier first? reply 'keep going' or 'busier'.`,
  callOffer: "if you'd rather have me on the phone, text 'call me' or tap ❓.",
  uneasyKeepGoing: (dest: string, instruction?: string) =>
    [`okay, keep heading to ${dest}. i'm watching your location.`, instruction].filter(Boolean).join(" "),
  busierOptions: (lines: string[]) =>
    `closest busier spots that look open:\n${lines.join("\n")}\nreply 1-${lines.length} and i'll route you there, or 'keep going' to stay on your way.`,
  busierNone:
    "i couldn't find an open place near you in my data. stick to main streets with lights and people, and text 'call me' if you want me on the phone.",
  busierPicked: (name: string, instruction?: string) =>
    [`okay, heading to ${name}. i'll watch until you're there.`, instruction].filter(Boolean).join(" "),
  navNoFix: "i can't see a fresh location for you right now, so i can't give turn directions. stick to busy, lit streets.",
  uneasyStillWithYou: "i'm still with you. keep to busy, lit streets. text 'call me' if you want me on the phone.",

  /** Ambiguous danger: confirm before alerting anyone. */
  dangerConfirm: "are you in immediate danger right now? reply yes or no.",
  dangerConfirmNudge: "are you in immediate danger? reply yes or no, or tap ‼️ if yes.",
  dangerGuidance: (contactName: string | undefined, calling: boolean) =>
    [
      "if you can, call 911 now.",
      contactName
        ? `i'm texting ${contactName} your location and what you told me.`
        : "i don't have a trusted contact saved, so i can't alert anyone for you.",
      calling
        ? "calling you now too."
        : "if you want me on the phone, text 'call me' or tap ❓. you can also send a voice message and i'll pass it on.",
    ].join("\n"),
  dangerStill: (contactName?: string) =>
    `i'm still here. if you can, call 911. ${contactName ? `${contactName} already has your location.` : ""} reply ok once you're safe.`.replace(/\s+/g, " ").trim(),
  dangerResolved: "okay, glad you're safe. i'll keep watching your trip.",

  /** Voice mode. */
  callStarting: "calling you now. just talk normally, silence is fine.",
  callEnded: withLegend("call ended. you okay?"),
  callMissed: withLegend("couldn't reach you on the call. you okay?"),
  callsUnavailable: "i can't place calls right now, but i'm still here by text. tell me what's going on.",
  /** Reached the busier stop they picked while uneasy. */
  interimArrived: (name: string, dest: string) =>
    `you're at ${name}. stay as long as you need. when you're ready, reply 'keep going' and i'll get you to ${dest}.`,
  /** Follow-up to the trusted contact once the user says they're okay. */
  contactUpdateSafe: (who: string) => `update from nook: ${who} just told me they're okay.`,

  /** Destinations. */
  destinationSet: (name: string) => `got it, heading to ${name}. i'll watch that route.`,
  destinationUnreadable: "couldn't read that link. can you share the place from apple maps, or send the full link or address?",
  arrivedAt: (name: string) => `made it to ${name} 👍`,

  voiceNoteUnclear: "got your voice message but couldn't make it out. can you type it?",
  voiceNoteOnboarding: "i can't use voice messages while we're setting up. can you type your answer?",

  homeSaved: "home saved.",
  homeNoFix:
    "i can't see your location right now. make sure location sharing with me is on, then text 'home' again.",

  greetingIdle:
    "hey. text 'walk me home' when you head out. in the evenings, if you're not home, i'll ask if you're heading home. text 'stop' anytime to dismiss me",
  greetingPrompted: "still waiting. reply yes to start the walk, or text 'stop' if you're not heading out",
  greetingWalking: "hey, still with you on this trip. text 'stop' if you don't need me, or text if you need anything",
  idleUnclear: "i can walk you home, or text 'settings'. didn't catch a trip in that",
  /** Explicit trip start (walk me home / yes to a prompt). */
  started: tripStart("ok i'm with you. i'll only text if something looks off."),
  /** Night movement / soft rejoin after a restart. starts tracking, no reaction needed. */
  nightOut: tripStart("hey, saw that you were out. it's getting late, i'll walk you home."),
  nightOutUnfamiliar: tripStart(
    "hey, saw that you were out. it's getting late, i'll walk you home. this isn't an area you've been much; i'll check in if anything looks off.",
  ),
  softRejoin: "hey, i'm back with you on this trip. i'll only text if something looks off. text stop anytime.",
  unfamiliarArea:
    "noticed you started walking but this isn't an area you've been. i'll check in with you in a bit. text 'stop' if you're all set",
  dismissed: "got it, i'll stop asking. text walk me home anytime",
  dismissedIdle: "okay, i'm not watching right now. text walk me home when you want me",

  confirmMonitoring: (mode: MonitoringMode) =>
    `change monitoring to ${monitoringLabel[mode]}? reply yes to confirm.`,
  confirmContact: (c: TrustedContact) =>
    `make ${contactLabel(c)} your trusted contact? reply yes to confirm.`,
  confirmEscalation: (action: NoResponseAction, c?: TrustedContact) =>
    `if i can't confirm you're okay after a check-in, ${escalationPlan(action, c)}. save this? reply yes to confirm.`,

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
