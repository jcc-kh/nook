import {
  resolveTimeouts,
  type CheckinTimeouts,
  type LearnedRoutine,
  type MonitoringMode,
  type NoResponseAction,
  type TrustedContact,
} from "../shared/settings.ts";
import { LEGEND_OPTIONS, tripStart, withLegend } from "../shared/templates.ts";
import type { UserRecord } from "../store/index.ts";

/** Trusted contact as Nook refers to them ("Sam" / "your trusted contact"). */
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

/** Settings summary line. */
function escalationSummary(action: NoResponseAction, c?: TrustedContact): string {
  switch (action) {
    case "CONTACT_TRUSTED":
      return `text ${yours(c)} your location`;
    case "NONE":
      return "keep checking in";
  }
}

/** What happens if a check-in and one follow-up go unanswered. */
function escalationPlan(action: NoResponseAction, c?: TrustedContact): string {
  switch (action) {
    case "CONTACT_TRUSTED":
      return `I'll text ${yours(c)} your location`;
    case "NONE":
      return "I'll keep checking in";
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

/** When Nook watches without being asked. */
function monitoringPlan(user: UserRecord): string {
  switch (user.monitoringMode) {
    case "MANUAL":
      return "I'll only watch when you ask. Text 'walk me home' or 'heading out' when you leave.";
    case "AWAY_FROM_HOME":
      return "When you're away from home and moving, I'll keep an eye on things quietly. If you stop for a few minutes, I'll check in. Reply ok if you got where you were going. You can also text 'walk me home' anytime.";
    case "EVENINGS":
    default:
      return `In the evenings (${clockLabel(user.nightStart ?? "22:00")}-${clockLabel(user.nightEnd ?? "06:00")}), if you're not home, I'll ask if you're heading home. You can also text 'walk me home' anytime.`;
  }
}

function timingSummary(t: Required<CheckinTimeouts>): string {
  return `follow up after ${t.nudgeAfterSec}s, next step ${t.escalateAfterSec}s after that, check in if your location stops for ${t.noUpdateMin} min`;
}

/** Places, varied by situation so Nook doesn't repeat one stock phrase. */
const BUSIER_PLACES = [
  "somewhere with more people around",
  "to an open public place",
  "to a busier street",
  "somewhere well-lit",
] as const;

/** Picks the "somewhere busier" wording from what they said, rotating otherwise. */
export function busierPlace(detail: string | undefined, turn: number): string {
  const d = detail?.toLowerCase() ?? "";
  if (/\b(dark|unlit|no lights?|pitch black)\b/.test(d)) return "somewhere well-lit";
  if (/\b(no one|nobody|noone|empty|deserted|alone)\b/.test(d)) return "somewhere with more people around";
  if (/\b(lost|which way|wrong way|side street|alley)\b/.test(d)) return "to a busier street";
  return BUSIER_PLACES[turn % BUSIER_PLACES.length]!;
}

export const copy = {
  askContact: "Who should I contact if something seems wrong? Send me their name and phone number, or share their contact card.",
  /** First message to a new user: who Nook is, then the first question. */
  welcome:
    "Hey, I'm Nook 🌙 I keep an eye on your walks and check in if something seems unusual.\n\n" +
    `You can always text me normally, or use a Tapback: ${LEGEND_OPTIONS}\n\n` +
    "First, what should I call you?",
  askUserName: "What should I call you? I'll also use it so your trusted contact knows who I'm texting about.",
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
    c.name ? `Got it. ${c.name} is your trusted contact.` : "Got it. Your trusted contact is saved.",

  askMonitoring:
    "When should I keep an eye on your location?\n\n1. Only when I tell Nook I'm heading somewhere\n2. Evenings, if I'm not home\n3. Whenever I'm away from home and moving",

  askEscalation: (c?: TrustedContact) =>
    `If I check in and don't hear back, what should I do?\n\n1. Text ${yours(c)} your location\n2. Keep checking in\n\nIf you tell me you're in immediate danger, I'll alert ${yours(c)} either way.`,

  locationRequest:
    "Next, share your location with me using the card below (choose Share Indefinitely), or reply 'skip' to do it later.",
  locationTerminal: "(terminal) Share a location with /loc <lat> <lon>, or reply 'skip'.",
  locationWaiting:
    "I don't see your location yet. Tap the card above and choose Share Indefinitely, or reply 'skip' to do it later.",
  locationConnected: "Location sharing is connected ✓",
  locationSkipped: "No problem. I can't watch your trips until you share your location with me.",

  askHome: "Are you at home right now? Reply yes and I'll remember this spot as home, or no.",
  homeLater: "Okay. Text 'home' the next time you're there.",

  /** Recap of what the user chose, in terms of what Nook will actually do. */
  done(user: UserRecord): string {
    const c = user.trustedContact;
    const lines = [
      "You're all set.",
      monitoringPlan(user),
      "If something feels off, I can help you keep going or find somewhere with more people around. If you'd rather keep your attention on your surroundings, you can ask me to call and guide you.",
      c
        ? `If you need urgent help, use ‼️ or just tell me what's happening. I'll tell you what to do next and send ${yours(c)} your location and what you told me.`
        : "If you need urgent help, use ‼️ or just tell me what's happening. I'll tell you what to do next.",
      `You can always reply normally, or use: ${LEGEND_OPTIONS}`,
    ];
    if (user.homeLat === undefined) {
      lines.push("One more thing: text 'home' next time you're there, so I know where home is and can tell when you've made it back.");
    }
    lines.push("Text 'settings' anytime to change any of this.");
    return lines.join("\n\n");
  },

  pickNumber: (n: number) => `Reply with a number from 1 to ${n}.`,
  yesOrNo: "Reply yes or no.",

  learnedNothing:
    "I haven't learned enough about your routine yet. As you use Nook, I'll pick up patterns like places you visit often and routes you commonly take.",

  talkLink: (url: string) => `📞 Tap to talk to me now: ${url}`,
  contactAlerted: (name?: string) => `I texted ${name ?? "your trusted contact"} your location.`,
  contactUnreachable: (name?: string) =>
    `My message to ${name ?? "your trusted contact"} didn't go through. If you need help, contact someone directly. Reply when you can and let me know you're okay.`,
  emergencyDelivered: (name?: string, attachmentsOk = true) =>
    attachmentsOk
      ? `Sent. ${name ?? "Your trusted contact"} has your location and what you told me.`
      : `Sent. ${name ?? "Your trusted contact"} has your location and what you told me, but your voice message didn't attach.`,
  emergencyFailed: (name?: string) =>
    name
      ? `My message to ${name} didn't go through. Please call 911 or ${name} directly if you can.`
      : "My message to your trusted contact didn't go through. Please call 911 directly if you can.",
  emergencyNoContact: "I don't have a trusted contact saved, so I couldn't alert anyone. Please call 911 directly if you can.",
  voiceNoteForwarded: (name?: string) => `Your voice message was sent to ${name ?? "your trusted contact"} too.`,
  voiceNoteForwardFailed: (name?: string) =>
    `I couldn't send your voice message to ${name ?? "your trusted contact"}. Please call ${name ?? "them"} or 911 directly if you can.`,

  // --- safety states (see brain/engine.ts applyIntent) ---
  /** Uneasy: ask which way, unless they already said. */
  uneasyAsk: (dest: string, place = "somewhere with more people around") =>
    `Got it. Do you want to keep heading ${toDestination(dest)}, or get ${place} first?`,
  callOffer: `If you'd rather keep your attention on your surroundings, I can call and guide you. Say "call me" or tap ❓.`,
  uneasyKeepGoing: (dest: string, instruction?: string) =>
    `Okay. Keep heading ${toDestination(dest)}. ${instruction ? withPeriod(instruction) : "I'll keep tracking the route."}`,
  busierOptions: (lines: string[]) =>
    `Here are a few nearby places that appear to be open:\n\n${lines.join("\n")}\n\nSend the number you want, or say "keep going" to stay on your route.`,
  busierNone:
    "I couldn't find a nearby open place with enough information to route you there reliably. If you can, head toward a main street or somewhere with people around. You can also ask me to call.",
  busierPicked: (name: string, instruction?: string) =>
    `Okay. Head toward ${name}. ${instruction ? withPeriod(instruction) : "I'll guide you from here."}`,
  navNoFix: (moving: boolean) =>
    moving
      ? "Your location hasn't updated recently enough for me to give you a reliable turn. Keep to main streets for now while I wait for a fresh update."
      : "Your location hasn't updated recently enough for me to give you a reliable turn. Stay somewhere visible or near an open public place while I wait for a fresh update.",
  /** Uneasy again after a route was already chosen. */
  stillUneasy: (callsOn: boolean) =>
    callsOn
      ? "Got it. Do you want to keep going, find somewhere with more people around, or have me call?"
      : "Got it. Do you want to keep going, or find somewhere with more people around?",

  /** Ambiguous danger: confirm before alerting anyone. */
  dangerConfirm: "Are you in immediate danger right now? Reply yes or no.",
  dangerConfirmNudge: "Are you in immediate danger right now? Reply yes or no, or tap ‼️ if yes.",
  /** Confirmed danger. Never offers or starts a Nook call. */
  dangerGuidance: (contactName: string | undefined, askedForCall: boolean) => {
    if (!contactName) {
      return "Call 911 now if you can.\n\nI don't have a trusted contact saved, so I can't alert anyone for you.";
    }
    if (askedForCall) return `Call 911 now if you can. I'm sending ${contactName} your current location and what you told me.`;
    return [
      "Call 911 now if you can.",
      `I'm sending ${contactName} your current location and what you told me.`,
      `If typing is difficult, you can send me a quick voice message and I'll pass it on to ${contactName}.`,
    ].join("\n\n");
  },
  dangerStill: (contactName?: string) =>
    contactName
      ? `If you haven't already, call 911 now. ${contactName} has your latest location and what you told me. I'll keep your trip active — let me know when you're safe.`
      : "If you haven't already, call 911 now. I'll keep your trip active — let me know when you're safe.",
  dangerResolved: "Glad you're safe. I'll keep monitoring the rest of the trip.",

  /** Voice mode. */
  callStarting: "Calling you now.",
  callEnded: withLegend("The call ended. Everything okay?"),
  callMissed: withLegend("I couldn't reach you. Everything okay?"),
  callsUnavailable: "I can't place a call right now, but I can still help here. Tell me what you need.",
  /** Reached the busier stop they picked while uneasy. */
  interimArrived: (name: string, dest: string) =>
    `You've reached ${name}. When you're ready to continue ${toDestination(dest)}, just say "keep going."`,
  /** Follow-up to the trusted contact once the user says they're okay. */
  contactUpdateSafe: (who: string) => `Update from Nook: ${who} just told me they're okay.`,

  /** Destinations. */
  destinationSet: (name: string) => `Got it. Heading to ${name}. I'll use that route.`,
  destinationUnreadable: "I couldn't open that link. Send me the Apple Maps place, full link, or address instead.",
  arrivedAt: (name: string) => `Looks like you made it to ${name} 👍`,

  voiceNoteUnclear: "I received your voice message, but couldn't transcribe it clearly. Can you type what you need instead?",
  voiceNoteOnboarding: "I can't use voice messages during setup. Could you type your answer?",

  homeSaved: "Home saved.",
  homeNoFix: "I can't see your location right now. Make sure location sharing with me is on, then text 'home' again.",

  greetingIdle:
    "Hey. Text 'walk me home' when you head out. In the evenings, if you're not home, I'll ask if you're heading home. Text 'stop' anytime.",
  greetingPrompted: "Reply yes to start the trip, or text 'stop' if you're not heading out.",
  greetingWalking: "Hey. I'm keeping an eye on this trip. Text 'stop' if you don't need me, or tell me if you need anything.",
  idleUnclear: "I didn't catch a trip in that. Text 'walk me home' when you head out, or 'settings' to change your setup.",
  /** Explicit trip start (walk me home / yes to a prompt). */
  started: tripStart("Got it. I'll keep an eye on the trip and check in if something seems unusual."),
  /** Movement detected outside the night window. */
  tripDetected: tripStart("Looks like you're on the move. I'll keep an eye on the trip and check in if something seems unusual."),
  /** Night movement detected. */
  nightOut: tripStart("Looks like you're heading out. I'll keep an eye on the trip and check in if something seems unusual."),
  nightOutUnfamiliar: tripStart(
    "Looks like you're heading through an area you don't usually visit. I'll keep an eye on the trip and check in if something seems unusual.",
  ),
  /** Open walk resumed after a server restart. */
  softRejoin: "Picking this trip back up. I'll check in if something seems unusual.",
  unfamiliarArea:
    "Looks like you're heading through an area you don't usually visit. I'll check in if something seems unusual.",
  dismissed: "Okay, I'll stop checking in on this trip. Text 'walk me home' anytime.",
  dismissedIdle: "Okay, I'm not watching right now. Text 'walk me home' when you want me to.",

  confirmMonitoring: (mode: MonitoringMode) =>
    `Change monitoring to ${monitoringLabel[mode]}? Reply yes to confirm.`,
  confirmContact: (c: TrustedContact) =>
    `Make ${contactLabel(c)} your trusted contact? Reply yes to confirm.`,
  confirmEscalation: (action: NoResponseAction, c?: TrustedContact) =>
    `If I check in and don't hear back, ${escalationPlan(action, c)}. Save this? Reply yes to confirm.`,

  askNudgeAfter: (current: number) =>
    `If you don't answer a check-in, how many seconds should I wait before following up? (30-600, now ${current}s. Say 'same' to keep it.)`,
  askEscalateAfter: (current: number) =>
    `After the follow-up, how many seconds before I take the next step? (30-600, now ${current}s. Say 'same' to keep it.)`,
  askNoUpdate: (current: number) =>
    `If your location stops updating while I'm watching, how many minutes before I check in? (2-15, now ${current} min. Say 'same' to keep it.)`,
  badTiming: (min: number, max: number, unit: string) => `Send a number from ${min} to ${max} ${unit}.`,
  confirmTimeouts: (t: Required<CheckinTimeouts>) =>
    `Save these timings? ${capitalize(timingSummary(t))}. Reply yes to confirm.`,
  changeSaved: "Done. Your settings are updated.",
  changeCancelled: "Okay, I didn't change anything.",

  settings(user: UserRecord): string {
    const c = user.trustedContact;
    const lines = [
      "Nook settings",
      `Name: ${user.displayName ?? "not set"}`,
      `Monitoring: ${user.monitoringMode ? monitoringLabel[user.monitoringMode] : "not set"}`,
      `Trusted contact: ${c ? contactLabel(c) : "not set"}`,
      `If I don't hear back: ${user.escalation ? escalationSummary(user.escalation.onNoTextResponse, c) : "not set"}`,
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

/** "home" → "home"; "Joe's Pizza" → "to Joe's Pizza". */
function toDestination(dest: string): string {
  return dest === "home" ? "home" : `to ${dest}`;
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function withPeriod(s: string): string {
  const t = capitalize(s.trim());
  return /[.!?]$/.test(t) ? t : `${t}.`;
}
