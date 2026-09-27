import type {
  EmergencyAction,
  LearnedRoutine,
  MonitoringMode,
  NoResponseAction,
  TrustedContact,
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
export const emergencyOptions: EmergencyAction[] = ["CALL_USER", "CONTACT_TRUSTED", "CALL_THEN_CONTACT"];

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

/** Nook's voice: what the emergency word does. */
export function emergencyConsequence(action: EmergencyAction, c?: TrustedContact): string {
  switch (action) {
    case "CALL_USER":
      return "I'll call you immediately";
    case "CONTACT_TRUSTED":
      return `I'll contact ${yours(c)} immediately`;
    case "CALL_THEN_CONTACT":
      return `I'll call you immediately, then contact ${yours(c)} if you don't respond`;
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

export const copy = {
  intro:
    "Hi, I'm Nook 🌙 I keep an eye on your trips and check in if something seems unusual. If I can't confirm you're okay, I can call you or reach someone you trust.",
  locationConnected: "Location sharing is connected ✓",
  locationRequest: "First, share your location with me using the card below.",
  locationTerminal: "(terminal) Fake a location with /loc <lat> <lon>",

  askContact: "Who should I contact if something seems wrong? Send me their name and phone number.",
  contactSaved: (c: TrustedContact) =>
    c.name ? `Got it — ${c.name} is your trusted contact.` : "Got it — your trusted contact is saved.",
  badContact: "I couldn't read a phone number there. Try something like: Alex +1 646 123 4567",

  askMonitoring:
    "When should I keep an eye on your location?\n1. Only when I tell Nook I'm heading somewhere\n2. During evenings / nighttime\n3. Whenever I'm away from home",

  askEscalation: (c?: TrustedContact) =>
    `If something seems unusual, I'll check in with you by text first.\n\nIf you don't respond, what should I do next?\n1. Call me\n2. Contact ${theirs(c)}\n3. Call me, then contact ${theirs(c)} if I still don't respond\n4. Don't escalate further`,

  offerCode:
    "Want a discreet emergency word? If you send or say it, I'll skip the normal check-in and immediately take the action you choose.\n\nReply yes or no.",
  askCodePhrase: "What should it be? Pick a word you wouldn't normally text.",
  badCodePhrase: "Pick a word or short phrase (letters only) that you wouldn't normally text.",
  askCodeAction: (phrase: string, c?: TrustedContact) =>
    `If you send or say '${phrase}', what should I do?\n1. Call me immediately\n2. Contact ${theirs(c)} immediately\n3. Call me, then contact ${theirs(c)} if I don't respond`,
  codeSet: (phrase: string, action: EmergencyAction, c?: TrustedContact) =>
    `'${phrase}' is set. If you send or say it, ${emergencyConsequence(action, c)}.`,

  done: "You're all set 🌙\nI'll keep an eye on your trips based on the settings you chose and check in if something looks unusual.\n\nYou can text 'settings' anytime to change when I monitor, who I contact, how I escalate, or your emergency word.",

  pickNumber: (n: number) => `Reply with a number from 1 to ${n}.`,
  yesOrNo: "Reply yes or no.",

  learnedNothing:
    "I haven't learned enough about your routine yet. As you use Nook, I'll gradually pick up patterns like places you visit often and routes you commonly take.",

  homeSaved: "Home saved.",
  homeNoFix:
    "I can't see your location right now. Make sure location sharing with me is on, then text 'home' again.",

  confirmMonitoring: (mode: MonitoringMode) =>
    `Change monitoring to ${monitoringLabel[mode]}? Reply yes to confirm.`,
  confirmContact: (c: TrustedContact) =>
    `Make ${contactLabel(c)} your trusted contact? Reply yes to confirm.`,
  confirmEscalation: (action: NoResponseAction, c?: TrustedContact) =>
    `If you miss a check-in, ${escalationPlan(action, c)}. Save this? Reply yes to confirm.`,
  confirmCode: (phrase: string, action: EmergencyAction, c?: TrustedContact) =>
    `Set your emergency word to '${phrase}'? If you send or say it, ${emergencyConsequence(action, c)}. Reply yes to confirm.`,
  confirmCodeRemoval: "Turn off your emergency word? Reply yes to confirm.",
  confirmYesNo: "Reply yes to confirm, or no to keep things as they are.",
  changeSaved: "Done — your settings are updated.",
  codeRemoved: "Done — your emergency word is off.",
  changeCancelled: "Okay, I didn't change anything.",
  noCodeToRemove: "You don't have an emergency word set.",
  finishSetupFirst: "Let's finish setup first.",

  settings(user: UserRecord): string {
    const c = user.trustedContact;
    const lines = [
      "Nook settings",
      `Monitoring: ${user.monitoringMode ? monitoringLabel[user.monitoringMode] : "not set"}`,
      `Trusted contact: ${c ? contactLabel(c) : "not set"}`,
      `If something seems unusual: ${
        user.escalation ? escalationSummary(user.escalation.onNoTextResponse, c) : "not set"
      }`,
      `Emergency word: ${user.emergencyCode ? "configured" : "not set"}`,
      `Home: ${user.homeLat !== undefined ? "saved" : "not saved yet (text 'home' when you're there)"}`,
      "",
      "You can say things like:",
      "- 'only monitor when I start a trip'",
      "- 'change my trusted contact'",
      "- 'don't contact anyone if I miss a check-in'",
      "- 'change my emergency word'",
      "- 'what have you learned about me?'",
    ];
    return lines.join("\n");
  },
};
