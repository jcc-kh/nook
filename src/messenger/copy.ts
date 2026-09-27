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
      return "I'll call you";
    case "CONTACT_TRUSTED":
      return `I'll contact ${yours(c)}`;
    case "CALL_THEN_CONTACT":
      return `I'll call you, then contact ${yours(c)} if you still don't respond`;
    case "NONE":
      return "I won't escalate further";
  }
}

export function learnedSummary(r: LearnedRoutine): string {
  const lines = [
    r.frequentPlaces.length ? `Places you visit often: ${r.frequentPlaces.join(", ")}` : "",
    r.commonRoutes.length ? `Routes you commonly take: ${r.commonRoutes.join(", ")}` : "",
    r.usualStops.length ? `Usual stops: ${r.usualStops.join(", ")}` : "",
    r.typicalTripMinutes ? `Typical trip: about ${r.typicalTripMinutes} min` : "",
  ].filter(Boolean);
  return lines.length ? ["Here's what I've picked up so far:", ...lines].join("\n") : copy.learnedNothing;
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
      return "I'll only watch when you ask. Text 'walk me home' or 'heading out' when you leave.";
    case "AWAY_FROM_HOME":
      return "I'll keep an eye on things whenever you're away from home. You can also text 'walk me home' anytime.";
    case "EVENINGS":
    default:
      return `I'll keep an eye on your trips in the evenings (${clockLabel(user.nightStart ?? "22:00")}–${clockLabel(user.nightEnd ?? "06:00")}). You can also text 'walk me home' anytime.`;
  }
}

function timingSummary(t: Required<CheckinTimeouts>): string {
  return `nudge after ${t.nudgeAfterSec}s, next step ${t.escalateAfterSec}s after that, check in if your location stops for ${t.noUpdateMin} min`;
}

export const copy = {
  askContact: "Who should I contact if something seems wrong? Send me their name and phone number (or share their contact card).",
  /** First message to a new user: who Nook is, then the first question. */
  welcome:
    "Hi, I'm Nook 🌙 I keep an eye on your trips and check in if something seems unusual. If I can't confirm you're okay, I can call you or reach someone you trust.\n\nFirst, what's your name?",
  askUserName: "What's your name? I'll use it when I check in, and so your trusted contact knows who I'm texting about.",
  badUserName: "Just your first name is fine, like 'Alex'.",
  userNameSaved: (name: string) => `Nice to meet you, ${name}.`,
  confirmUserName: (name: string) => `Change your name to ${name}? Reply yes to confirm.`,
  askContactName: "Got the number. What's their name?",
  askContactPhone: (name: string) => `What's ${name}'s phone number?`,
  badContactName: "Just their first name is fine, like 'Sam' or 'Mom'.",
  badContact:
    "That doesn't look like a valid phone number. Send it with the area code, like: Sam 646 555 1234 (or +44… for other countries).",
  contactIsSelf: "That's your own number. Send the number of someone you trust.",
  contactSaved: (c: TrustedContact) =>
    c.name ? `Got it, ${c.name} is your trusted contact.` : "Got it, your trusted contact is saved.",

  askMonitoring:
    "When should I keep an eye on your location?\n1. Only when I tell Nook I'm heading somewhere\n2. During evenings / nighttime\n3. Whenever I'm away from home",

  askEscalation: (c?: TrustedContact) =>
    `If something seems unusual, I'll check in with you by text first.\n\nIf you don't respond, what should I do next?\n1. Call me\n2. Contact ${theirs(c)}\n3. Call me, then contact ${theirs(c)} if I still don't respond\n4. Don't escalate further`,

  locationRequest:
    "Next, share your location with me using the card below (choose Share Indefinitely). Or reply 'skip' to do it later.",
  locationTerminal: "(terminal) Share a location with /loc <lat> <lon>, or reply 'skip'.",
  locationWaiting:
    "I don't see your location yet. Tap the card above and choose Share Indefinitely, or reply 'skip' to do it later.",
  locationConnected: "Location sharing is connected ✓",
  locationSkipped: "No problem. I can't watch your trips until you share your location with me.",

  askHome: "Are you at home right now? Reply yes and I'll remember this spot as home, or no.",
  homeLater: "Okay. Text 'home' the next time you're there.",

  /** Recap of what the user chose, in terms of what Nook will actually do. */
  done(user: UserRecord): string {
    const lines = ["You're all set 🌙", monitoringPlan(user)];
    if (user.escalation) {
      lines.push(
        `If something looks unusual I'll text you first. If you don't answer, ${escalationPlan(user.escalation.onNoTextResponse, user.trustedContact)}.`,
      );
    }
    if (user.homeLat === undefined) {
      lines.push(
        "One more thing: text 'home' next time you're there, so I know where home is and can tell when you've made it back.",
      );
    }
    lines.push(
      "Text 'settings' anytime to change when I monitor, who I contact, how I escalate, or your check-in timing.",
    );
    return lines.join("\n\n");
  },

  pickNumber: (n: number) => `Reply with a number from 1 to ${n}.`,
  yesOrNo: "Reply yes or no.",

  learnedNothing:
    "I haven't learned enough about your routine yet. As you use Nook, I'll gradually pick up patterns like places you visit often and routes you commonly take.",

  callFailed: "I tried to call you but couldn't place the call. Tap 👍 if you're okay, or text me.",
  contactAlerted: (name?: string) => `I've let ${name ?? "your trusted contact"} know and sent them your location.`,
  contactUnreachable: (name?: string) =>
    `I tried to reach ${name ?? "your trusted contact"} but my message didn't go through. If you need help, contact someone directly. Tap 👍 if you're okay.`,

  homeSaved: "Home saved.",
  homeNoFix:
    "I can't see your location right now. Make sure location sharing with me is on, then text 'home' again.",

  greetingIdle:
    "Hey. Text me 'walk me home' when you head out, or I'll notice if you start walking at night.",
  greetingPrompted: "Still waiting — tap 👍 to start the walk, or 👎 if you're not heading out.",
  greetingWalking:
    "Still with you. Tap 👍 if you're good, or text me if you need help.",
  idleUnclear:
    "I can walk you home, or you can text 'settings'. I didn't catch a trip in that.",
  unfamiliarArea:
    "I noticed you start walking, but this is not an area you've been. Will check in with you in a bit.",

  confirmMonitoring: (mode: MonitoringMode) =>
    `Change monitoring to ${monitoringLabel[mode]}? Reply yes to confirm.`,
  confirmContact: (c: TrustedContact) =>
    `Make ${contactLabel(c)} your trusted contact? Reply yes to confirm.`,
  confirmEscalation: (action: NoResponseAction, c?: TrustedContact) =>
    `If you miss a check-in, ${escalationPlan(action, c)}. Save this? Reply yes to confirm.`,

  askNudgeAfter: (current: number) =>
    `If you don't answer a check-in, how many seconds should I wait before nudging you? (30–600, now ${current}s. Say 'same' to keep it.)`,
  askEscalateAfter: (current: number) =>
    `After the nudge, how many seconds before I take the next step? (30–600, now ${current}s. Say 'same' to keep it.)`,
  askNoUpdate: (current: number) =>
    `If your location stops updating while I'm watching, how many minutes before I check in? (2–15, now ${current} min. Say 'same' to keep it.)`,
  badTiming: (min: number, max: number, unit: string) => `Send a number from ${min} to ${max} ${unit}.`,
  confirmTimeouts: (t: Required<CheckinTimeouts>) =>
    `Save these timings? ${timingSummary(t)}. Reply yes to confirm.`,
  changeSaved: "Done, your settings are updated.",
  changeCancelled: "Okay, I didn't change anything.",

  settings(user: UserRecord): string {
    const c = user.trustedContact;
    const lines = [
      "Nook settings",
      `Name: ${user.displayName ?? "not set"}`,
      `Monitoring: ${user.monitoringMode ? monitoringLabel[user.monitoringMode] : "not set"}`,
      `Trusted contact: ${c ? contactLabel(c) : "not set"}`,
      `If something seems unusual: ${
        user.escalation ? escalationSummary(user.escalation.onNoTextResponse, c) : "not set"
      }`,
      `Check-in timing: ${timingSummary(resolveTimeouts(user.timeouts))}`,
      `Home: ${user.homeLat !== undefined ? "saved" : "not saved yet (text 'home' when you're there)"}`,
      "",
      "You can say things like:",
      "- 'change my name'",
      "- 'only monitor when I start a trip'",
      "- 'change my trusted contact'",
      "- 'don't contact anyone if I miss a check-in'",
      "- 'change my check-in timing'",
      "- 'what have you learned about me?'",
    ];
    return lines.join("\n");
  },
};
