import type { MonitoringMode, NoResponseAction, TrustedContact } from "../shared/settings.ts";

/** Deterministic text parsing for onboarding and settings. No LLM on this path. */

export const HOME_RE = /^\s*home\s*[.!]?\s*$/i;
export const LOC_RE = /^\/loc\s+(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)\s*$/i;
const SETTINGS_RE = /^\s*(my\s+|nook\s+)?settings\s*[?.!]?\s*$/i;
const LEARNED_RE = /\b(what (have|did) you learn(ed)?|learned about me|what do you know about me)\b/i;
const CANCEL_RE = /^\s*(cancel|never ?mind|forget it|stop)\b/i;
/** Words after "call me" that make it a call request, not a new name. */
const CALL_REQUEST_WORDS =
  /^(now|please|pls|plz|asap|rn|back|again|when|if|right|later|nook|maybe|quick|real quick|i|im|i'm|someone|there|so|and|because|pleaseee)\b/i;
const PHONE_RE = /\+?\d[\d\s().-]{5,}\d/;

/** NANP: area code and exchange both start 2-9 (so 000-, 1xx- and 911-style strings fail). */
const NANP_RE = /^[2-9]\d{2}[2-9]\d{6}$/;

/**
 * US-default E.164 normalization; null when it can't be a real phone number.
 * `+1…` and bare 10/11-digit numbers must be valid NANP; other `+` numbers
 * need 8-15 digits (E.164 maximum).
 */
export function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  const nanp = (ten: string) => (NANP_RE.test(ten) ? `+1${ten}` : null);
  if (raw.trim().startsWith("+")) {
    if (digits.startsWith("1")) return digits.length === 11 ? nanp(digits.slice(1)) : null;
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return nanp(digits);
  if (digits.length === 11 && digits.startsWith("1")) return nanp(digits.slice(1));
  return null;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9' -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanName(raw: string): string | undefined {
  const name = raw
    .replace(/[,:;()"“”']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      /^(change (my )?(trusted |emergency )?contact( to)?|(my )?(trusted |emergency )?contact( is)?|it'?s|it is)\s+/i,
      "",
    )
    .replace(/^[\s.-]+|[\s.!-]+$/g, "");
  return validName(name);
}

const NOT_A_NAME = new Set([
  "yes", "no", "ok", "okay", "sure", "skip", "idk", "none", "nobody", "no one", "cancel", "stop",
  "hi", "hey", "hello", "thanks", "thank you", "what", "why", "help", "not sure", "later",
]);

/** 1-3 words of letters (any script), apostrophes, periods, hyphens; up to 40 chars. */
function validName(name: string): string | undefined {
  if (!/^\p{L}[\p{L}\p{M}' .-]{0,39}$/u.test(name)) return undefined;
  if (name.split(/\s+/).length > 3 || NOT_A_NAME.has(name.toLowerCase())) return undefined;
  return name;
}

/** A bare name ("Sam", "my mom") answering "what's their name?". */
export function parseName(text: string): string | undefined {
  return cleanName(text.replace(/^(their name is|name is|name's|it's|call (them|her|him))\s+/i, ""));
}

/** The user's own name ("Alex", "I'm Alex", "change my name: Jessie"). */
export function parseOwnName(text: string): string | undefined {
  // Strip the imperative first (while :/= still present), then clean punctuation.
  let name = text.trim().replace(/^(hi|hey|hello)\s+/i, "");
  name = name.replace(
    /^((change|update|set|fix) (my |me )?name\s*(to|=|:|-)?|my name is|my name's|name's|i'?m|i am|it'?s|this is|call me)\s*/i,
    "",
  );
  name = name
    .replace(/[()"“”']/g, " ")
    .replace(/[,:;]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.,:;\-=]+|[\s.!-]+$/g, "")
    .trim();
  if (!name) return undefined;
  // leftover imperative ("change my name" with no new name) is not a name
  if (/^(my|your|the|a|an|change|update|set|fix|name)\b/i.test(name)) return undefined;
  return validName(name);
}

/**
 * "Alex +1 646 123 4567", "+16461234567", "my mom, 646-123-4567".
 * `sawNumber` with no contact: digits that aren't a valid phone number.
 * `name` alone: a name but no number yet.
 */
export function parseContact(text: string): { contact?: TrustedContact; sawNumber: boolean; name?: string } {
  const match = text.match(PHONE_RE);
  if (!match) {
    if (/\d{3}/.test(text)) return { sawNumber: true };
    const name = cleanName(text);
    return name ? { sawNumber: false, name } : { sawNumber: false };
  }
  const phone = toE164(match[0]);
  if (!phone) return { sawNumber: true };
  const name = cleanName(text.replace(match[0], " "));
  return { contact: name ? { name, phone } : { phone }, sawNumber: true };
}

export interface MapsLink {
  url: string;
  name?: string;
  lat?: number;
  lon?: number;
  address?: string;
  /** maps.apple short link: needs a redirect lookup we don't do yet. */
  short?: boolean;
}

const MAPS_URL_RE = /https?:\/\/(?:maps\.apple\.com|maps\.apple|(?:www\.)?apple\.co\/maps)[^\s<>"]*/i;
const COORD_RE = /(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/;

function coords(raw: string | null | undefined): { lat: number; lon: number } | undefined {
  const m = raw?.match(COORD_RE);
  if (!m) return undefined;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  return { lat, lon };
}

/**
 * An Apple Maps link in a message: place links (`?q=&ll=`, `/place?coordinate=&name=`),
 * directions (`?daddr=`, `/directions?destination=`) and address links.
 * Short `maps.apple/p/…` links are flagged, not resolved.
 */
export function parseMapsLink(text: string): MapsLink | null {
  const raw = text.match(MAPS_URL_RE)?.[0]?.replace(/[).,!?]+$/, "");
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const q = (k: string) => url.searchParams.get(k)?.trim() || undefined;
  if (host !== "maps.apple.com" && !url.search) return { url: raw, short: true };

  const dest = q("daddr") ?? q("destination");
  const point = coords(q("coordinate")) ?? coords(dest) ?? coords(q("ll")) ?? coords(q("sll")) ?? coords(q("center"));
  const destText = dest && !coords(dest) ? dest : undefined;
  const name = q("name") ?? q("q") ?? destText;
  const address = q("address") ?? destText;
  if (!point && !name && !address) return host === "maps.apple.com" ? null : { url: raw, short: true };
  return {
    url: raw,
    ...(name && { name }),
    ...(point && point),
    ...(address && { address }),
  };
}

/** Bare "40.80521, -73.96510" in a message. */
export function parseCoordinates(text: string): { lat: number; lon: number } | undefined {
  return coords(text);
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
    const contact =
      /\b(contact|reach|alert|trusted|text (them|her|him|my))\b/.test(t) ||
      (contactName !== undefined && t.includes(contactName.toLowerCase()));
    const keepChecking = /\b(keep checking|check in again|just check|checking in)\b/.test(t);
    const negated = /\b(don't|dont|do not|never|nothing|none|nobody|no one|no)\b/.test(t);
    if (negated || keepChecking) return contact && !negated ? undefined : "NONE";
    if (contact) return "CONTACT_TRUSTED";
    return undefined;
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

export type Intent =
  | { kind: "settings" }
  | { kind: "learned" }
  | { kind: "monitoring"; mode?: MonitoringMode }
  | { kind: "contact"; contact?: TrustedContact }
  | { kind: "escalation" }
  | { kind: "timing" }
  | { kind: "name"; name?: string };

/** "keep", "same", … while answering a timing question: leave that value as is. */
export function isKeep(text: string): boolean {
  return /^(same|keep( it)?|no change|unchanged|leave it|as is)\b/.test(normalize(text));
}

/**
 * First number in the text, converted to `unit`. A bare number is read in
 * `unit`; "90s", "2 min", "1.5 minutes" are converted.
 */
export function parseDuration(text: string, unit: "sec" | "min"): number | undefined {
  const m = text.toLowerCase().match(/(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?)?\b/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const said = m[2]?.startsWith("m") ? "min" : m[2] ? "sec" : unit;
  if (said === unit) return n;
  return said === "min" ? n * 60 : n / 60;
}

/**
 * Keyword intents for texts sent after onboarding. Returns null when nothing
 * matches; this is where an LLM could later propose a candidate Intent.
 */
export function parseIntent(text: string): Intent | null {
  if (SETTINGS_RE.test(text)) return { kind: "settings" };
  if (LEARNED_RE.test(text)) return { kind: "learned" };
  const t = normalize(text);
  if (/\b(change|update|set|fix) (my |me )?name\b|^my name is\b/.test(t)) {
    const name = parseOwnName(text);
    return name ? { kind: "name", name } : { kind: "name" };
  }
  // "call me Alex" renames; "call me", "call me now", "call me i'm lost" ask for a call.
  if (/^call me\b/.test(t)) {
    const name = parseOwnName(text);
    if (name && !CALL_REQUEST_WORDS.test(name)) return { kind: "name", name };
    return null;
  }
  if (/\btimings?\b|\btimeouts?\b|\bhow long\b|\bwait (longer|less)\b/.test(t)) {
    return { kind: "timing" };
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
