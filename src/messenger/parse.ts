import type {
  EmergencyAction,
  MonitoringMode,
  NoResponseAction,
  TrustedContact,
} from "../shared/settings.ts";

/** Deterministic text parsing for onboarding and settings. No LLM on this path. */

export const HOME_RE = /^\s*home\s*[.!]?\s*$/i;
export const LOC_RE = /^\/loc\s+(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)\s*$/i;
const SETTINGS_RE = /^\s*(my\s+|nook\s+)?settings\s*[?.!]?\s*$/i;
const LEARNED_RE = /\b(what (have|did) you learn(ed)?|learned about me|what do you know about me)\b/i;
const CANCEL_RE = /^\s*(cancel|never ?mind|forget it|stop)\b/i;
const PHONE_RE = /\+?\d[\d\s().-]{5,}\d/;

/** US-default E.164 normalization; returns null when it can't be a phone number. */
export function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (raw.trim().startsWith("+")) return digits.length >= 8 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanName(raw: string): string | undefined {
  const name = raw
    .replace(/[,:;()"“”]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      /^(change (my )?(trusted |emergency )?contact( to)?|(my )?(trusted |emergency )?contact( is)?|it'?s|it is)\s+/i,
      "",
    )
    .replace(/^[\s.-]+|[\s.!-]+$/g, "");
  if (!name || /\d/.test(name) || name.length > 40) return undefined;
  return name;
}

/** "Alex +1 646 123 4567", "+16461234567", "my mom, 646-123-4567". */
export function parseContact(text: string): { contact?: TrustedContact; sawNumber: boolean } {
  const match = text.match(PHONE_RE);
  if (!match) return { sawNumber: /\d{3}/.test(text) };
  const phone = toE164(match[0]);
  if (!phone) return { sawNumber: true };
  const name = cleanName(text.replace(match[0], " "));
  return { contact: name ? { name, phone } : { phone }, sawNumber: true };
}

/** A menu answer: "2", "2.", "option 2", or a keyword fallback. */
export function parseChoice<T>(
  text: string,
  options: readonly T[],
  keyword?: (normalized: string) => T | undefined,
): T | undefined {
  const t = normalize(text);
  const num = t.match(/^(?:option |number )?([1-9])$/);
  if (num) return options[Number(num[1]) - 1];
  return keyword?.(t);
}

export function monitoringKeyword(t: string): MonitoringMode | undefined {
  if (/\b(evenings?|night|nights|nighttime|dark)\b/.test(t)) return "EVENINGS";
  if (/\baway\b|\bnot (at )?home\b|\bwhenever\b|\balways\b/.test(t)) return "AWAY_FROM_HOME";
  if (/\bonly when\b|\bstart(ing)? a trip\b|\bheading\b|\btell (you|nook)\b|\bwhen i ask\b|\bmanual/.test(t)) {
    return "MANUAL";
  }
  return undefined;
}

/** Returns undefined for anything mixed or unclear so the menu is re-asked instead of guessed. */
export function escalationKeyword(contactName?: string) {
  return (text: string): NoResponseAction | undefined => {
    const t = text.replace(/\bif (i|you) (still )?(don't|dont|do not) (respond|answer|reply)\b/g, "");
    const call = /\bcall\b/.test(t);
    const both = /\bboth\b/.test(t);
    const contact =
      /\b(contact|reach|alert|trusted)\b/.test(t) ||
      (contactName !== undefined && t.includes(contactName.toLowerCase()));
    const negated = /\b(don't|dont|do not|never|nothing|none|nobody|no one|no)\b/.test(t);
    if (negated) return !call && !both ? "NONE" : undefined;
    if (both || (call && contact)) return "CALL_THEN_CONTACT";
    if (call) return "CALL_USER";
    if (contact) return "CONTACT_TRUSTED";
    return undefined;
  };
}

export function emergencyKeyword(contactName?: string) {
  const base = escalationKeyword(contactName);
  return (t: string): EmergencyAction | undefined => {
    const action = base(t);
    return action === "NONE" ? undefined : action;
  };
}

export function parseYesNo(text: string): boolean | undefined {
  const t = normalize(text);
  if (/^(y|yes|yeah|yep|yup|sure|ok|okay|confirm|sounds good|do it|please)\b/.test(t)) return true;
  if (/^(n|no|nope|nah|skip|not now|no thanks|cancel|never ?mind)\b/.test(t)) return false;
  return undefined;
}

export function isCancel(text: string): boolean {
  return CANCEL_RE.test(text);
}

const RESERVED_PHRASES = new Set([
  "yes", "no", "ok", "okay", "hi", "hey", "hello", "thanks", "help", "stop", "cancel",
  "home", "settings", "skip",
]);

/** 1–3 words, letters only, not a command or everyday reply. Stored lowercase. */
export function parseCodePhrase(text: string): string | undefined {
  const phrase = normalize(text);
  if (!/^[a-z][a-z' -]{2,29}$/.test(phrase)) return undefined;
  if (phrase.split(" ").length > 3 || RESERVED_PHRASES.has(phrase)) return undefined;
  return phrase;
}

/** Whole-word, case-insensitive match of the emergency phrase anywhere in a message. */
export function containsPhrase(text: string, phrase: string): boolean {
  return ` ${normalize(text)} `.includes(` ${phrase} `);
}

export type Intent =
  | { kind: "settings" }
  | { kind: "learned" }
  | { kind: "monitoring"; mode?: MonitoringMode }
  | { kind: "contact"; contact?: TrustedContact }
  | { kind: "escalation" }
  | { kind: "code"; remove: boolean };

/**
 * Keyword intents for texts sent after onboarding. Returns null when nothing
 * matches; this is where an LLM could later propose a candidate Intent.
 */
export function parseIntent(text: string): Intent | null {
  if (SETTINGS_RE.test(text)) return { kind: "settings" };
  if (LEARNED_RE.test(text)) return { kind: "learned" };
  const t = normalize(text);
  if (/\b(emergency|code|safe|secret) ?(word|phrase)\b|\bcodeword\b/.test(t)) {
    return { kind: "code", remove: /\b(remove|turn off|delete|disable|clear|no longer)\b/.test(t) };
  }
  if (/\bcheck ?-?ins?\b|\bescalat|\bif i (don't|dont|do not) (respond|answer|reply)\b/.test(t)) {
    return { kind: "escalation" };
  }
  if (/\b(trusted|emergency) (contact|person)\b|\bchange (my )?contact\b/.test(t)) {
    const { contact } = parseContact(text);
    return contact ? { kind: "contact", contact } : { kind: "contact" };
  }
  if (/\b(monitor|monitoring|keep an eye|watch)\b/.test(t)) {
    const mode = monitoringKeyword(t);
    return mode ? { kind: "monitoring", mode } : { kind: "monitoring" };
  }
  return null;
}
