import type { CallReason, RouteChoice, SafetyIntent } from "../shared/types.ts";

/**
 * One intent pipeline for tapbacks, typed text and voice-note transcripts.
 *
 * Calling ordinary unease an emergency is the costliest mistake (Nook turns
 * alarmist and people stop trusting it), so the regex layer only marks danger
 * as `clear` for unmistakable phrases. Everything merely threatening is
 * `clear: false`, which makes Nook ask "are you in immediate danger right now?".
 */

const TAPBACKS: Record<string, SafetyIntent> = {
  "👍": { kind: "safe" },
  "👎": { kind: "uneasy" },
  "❓": { kind: "call", reason: "manual_call" },
  "‼": { kind: "danger", clear: true, quote: "tapped ‼️ (immediate danger)" },
};

export function reactionIntent(emoji: string): SafetyIntent | null {
  return TAPBACKS[emoji.replace(/\uFE0F/g, "").trim()] ?? null;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Phrases that deny danger ("not in danger", "don't call me") are removed before matching. */
const NEGATIONS: RegExp[] = [
  /\b(i'?m |i am )?not (in )?(any )?(danger|an emergency|hurt|scared|lost)\b/g,
  /\bno (danger|emergency)\b/g,
  /\b(don'?t|do not|dont) need (help|a call|you to call( me)?)\b/g,
  /\bno need to call( me)?\b/g,
  /\b(don'?t|do not|dont) call( me)?\b/g,
];

const CLEAR_DANGER: RegExp[] = [
  /\b(chas(e|ed|ing) me|is chasing|are chasing|keeps? chasing)\b/,
  /\b(attack(ed|ing)? me|being attacked|assault(ed|ing)? me)\b/,
  /\b(someone|somebody|a guy|a man|a woman|he|she|they)('s| is| are| just)? (attacking|hitting|punching|grabbing|grabbed|hit|punched|stabbed|robbing|mugging|choking|dragging) me\b/,
  /\b(got|been|being|was|just got) (mugged|robbed|stabbed|shot|assaulted|attacked|kidnapped|jumped)\b/,
  /\b(has|have|with|pulled( out)?|holding|showing|pointing) a (gun|knife|weapon)\b/,
  /\b(gun|knife) (at|on|to) me\b/,
  /\b(i'?m|i am) (hurt|bleeding|injured)\b/,
  /\b(call|get|send) (the )?(police|cops|911|an ambulance)\b/,
  /\b(dial|calling) 911\b/,
  /\bneed (the )?(police|an ambulance|ambulance)\b/,
  /\b(i'?m|i am) in (immediate |real )?danger\b/,
  /\bin immediate danger\b/,
  /\b(forcing|pulling|dragging|pushing) me into\b/,
  /\bwon'?t let me (go|leave)\b/,
  /\b(following|chasing) me\b.{0,40}\b(can'?t (get away|lose (him|her|them))|won'?t stop|getting closer|grabbed)\b/,
  /\bhelp me now\b|\bhelp help\b|\bsos sos\b/,
];

const AMBIGUOUS_DANGER: RegExp[] = [
  /\bhelp\b/,
  /\bemergency\b/,
  /\bsos\b/,
  /\bdanger(ous)?\b/,
  /\b(following|stalking) me\b/,
  /\b(being|getting) followed\b/,
  /\bharass(ing|ed)? me\b/,
  /\b(someone|somebody|a guy|a man)('s| is)? (touching|grabbing at|cornering) me\b/,
];

/** "help me find the station" is a navigation ask, not an emergency. */
const HELP_DIRECTIVE = /\bhelp (me )?(find|get|with|navigate|figure|pick|choose|decide|out)\b/;

const CALL: RegExp[] = [
  /\bcall me\b/,
  /\bgive me a (call|ring)\b/,
  /\bcan (you|u) call\b/,
  /\bphone me\b/,
  /\bring me\b/,
  /\btalk (to me|me home|me through)\b/,
  /\bstay on the (phone|line)\b/,
  /\bon the phone with me\b/,
  /\bguide me\b/,
  /\bhands[- ]?free\b/,
  /\bvoice mode\b/,
];

const LOST = /\b(lost|don'?t know where i am|no idea where i am|which way|wrong way)\b/;
const NAVIGATION = /\b(navigat\w*|directions?|how do i get|route me|way home|guide me|which way)\b/;
const HANDS_FREE = /\b(hands[- ]?free|talk me (home|through)|guide me home|walk me through|stay on the (phone|line)|on the phone with me)\b/;

const UNEASY: RegExp[] = [
  /\b(scared|nervous|uneasy|uncomfortable|anxious|afraid|freaked|freaking out|on edge)\b/,
  /\b(creepy|creeped|sketchy|sus|shady)\b/,
  /\bweird (vibe|vibes|guy|man|dude|feeling|person|people)\b/,
  /\b(don'?t|do not|dont) feel (safe|good|right|great|ok|okay)\b/,
  /\b(unsafe|not safe)\b/,
  /\bnot (ok|okay|fine|good|great|alright|all right|so good)\b/,
  /\bfeel(s|ing)? off\b/,
  /\b(someone|somebody|a guy|a man|people|he|they|guy)('s| is| are)? (behind|staring|watching|lurking|walking behind|yelling|hanging around|loitering)\b/,
  /\bwalking behind me\b/,
  /\b(dark|empty|deserted) (street|block|area|here)\b/,
  /\b(no one|nobody) (around|here|out)\b/,
  LOST,
];

const WANTS_BUSIER =
  /\b(busier|busy|crowded|well[- ]lit|lit up|brighter|somewhere (safe|safer|public|with people|open)|people around|open (store|shop|place)|go inside|a store|a cafe|somewhere busy)\b/;
const WANTS_DESTINATION =
  /\b(keep (going|heading|walking)|continue|stay (on|the) (route|course)|(go|head|going|heading|get) (straight )?home|just (get|go) home|stick to (the|my) route)\b/;

const SAFE_START =
  /^(ok|okay|k|kk|fine|good|great|all good|yep|yes|yeah|ya|yup|safe|all set|made it|home|here|no worries|thumbs up|👍|i'?m (ok|okay|fine|good|safe|home|here|alright|all right|great)|we'?re (good|fine|ok|okay))\b/;
const SAFE_ANY = /\b(ok|okay|fine|all good|safe|i'?m good|made it|got home|i'?m home)\b/;
const PLACE = /\b(?:i'?m|i am|staying|still|just) at\s+(.+)/i;

function any(patterns: RegExp[], t: string): boolean {
  return patterns.some((p) => p.test(t));
}

function wants(t: string): RouteChoice | undefined {
  if (WANTS_BUSIER.test(t)) return "busier";
  if (WANTS_DESTINATION.test(t)) return "destination";
  return undefined;
}

function callReason(t: string): CallReason {
  if (LOST.test(t)) return "lost";
  if (HANDS_FREE.test(t)) return "hands_free_guidance";
  if (NAVIGATION.test(t)) return "navigation_help";
  if (any(UNEASY, t)) return "uneasy_companion";
  return "manual_call";
}

/** Deterministic classifier. Used alone when Gemini is off, and as the guard around Gemini. */
export function classifyFallback(raw: string): SafetyIntent {
  const original = raw.replace(/[\u2018\u2019]/g, "'").trim();
  let t = normalize(raw);
  if (!t) return { kind: "unclear" };
  for (const n of NEGATIONS) t = t.replace(n, " ");
  t = t.replace(/\s+/g, " ").trim();
  const quote = original.slice(0, 280);

  if (any(CLEAR_DANGER, t)) {
    return { kind: "danger", clear: true, quote, ...(any(CALL, t) && { wantsCall: true }) };
  }
  const helpDirective = HELP_DIRECTIVE.test(t);
  const scrubbed = helpDirective ? t.replace(HELP_DIRECTIVE, " ") : t;
  const ambiguous = any(AMBIGUOUS_DANGER, scrubbed);
  const call = any(CALL, t);

  // They asked for a call: the agent can confirm on the line, so don't make them answer a text first.
  if (call) return { kind: "call", reason: ambiguous ? "uneasy_companion" : callReason(t) };
  if (ambiguous) return { kind: "danger", clear: false, quote };

  const w = wants(t);
  if (any(UNEASY, t) || helpDirective) {
    return {
      kind: "uneasy",
      detail: quote,
      ...(w && { wants: w }),
      ...(LOST.test(t) && { lost: true }),
    };
  }
  if (w && t.split(" ").length <= 8) return { kind: "route_choice", choice: w };

  const place = original.match(PLACE)?.[1]?.replace(/[.!]+$/, "").trim();
  if (place && place.length <= 60) return { kind: "safe", placeLabel: place };
  if (SAFE_START.test(t) || SAFE_ANY.test(t)) return { kind: "safe" };
  return { kind: "unclear" };
}

/** Coerce an LLM JSON answer into a SafetyIntent; null when it doesn't fit. */
export function sanitizeIntent(obj: unknown, text: string): SafetyIntent | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const choice = (v: unknown): RouteChoice | undefined =>
    v === "destination" || v === "busier" ? v : undefined;
  const reasons: CallReason[] = ["manual_call", "uneasy_companion", "navigation_help", "lost", "hands_free_guidance"];
  switch (o.kind) {
    case "safe": {
      const placeLabel = str(o.placeLabel);
      return { kind: "safe", ...(placeLabel && { placeLabel }) };
    }
    case "uneasy": {
      const w = choice(o.wants);
      return {
        kind: "uneasy",
        detail: text.slice(0, 280),
        ...(w && { wants: w }),
        ...(o.lost === true && { lost: true }),
      };
    }
    case "call": {
      const r = reasons.find((x) => x === o.reason);
      return { kind: "call", reason: r ?? "manual_call" };
    }
    case "danger":
      return { kind: "danger", clear: o.clear === true, quote: text.slice(0, 280) };
    case "route_choice": {
      const c = choice(o.choice) ?? choice(o.wants);
      return c ? { kind: "route_choice", choice: c } : null;
    }
    case "unclear":
      return { kind: "unclear" };
    default:
      return null;
  }
}

/**
 * Combine the regex read with an LLM read. The LLM can never raise an
 * emergency on its own, and can never erase a danger signal the regex saw
 * (short of turning it into a call request).
 */
export function guardIntent(regex: SafetyIntent, llm: SafetyIntent | null): SafetyIntent {
  if (regex.kind === "danger" && regex.clear) return regex;
  if (!llm) return regex;
  if (regex.kind === "danger") {
    if (llm.kind === "danger") return llm.clear ? { ...llm, quote: regex.quote } : regex;
    if (llm.kind === "call") return llm;
    return regex;
  }
  if (llm.kind === "danger") return { kind: "danger", clear: false, ...(llm.quote && { quote: llm.quote }) };
  if (regex.kind === "call" && llm.kind !== "call") return regex;
  return llm;
}

export const CLASSIFY_PROMPT = `You classify one message from someone walking home at night to Nook, their safety buddy.
Return JSON only: {"kind": "...", ...}.
Kinds:
- "safe": they're fine / arrived / heading somewhere on purpose. Optional "placeLabel" if they name where they're staying ("at sam's").
- "uneasy": nervous, uncomfortable, someone behind them, dark or empty street, lost. Optional "wants": "busier" (wants somewhere busier / public / open) or "destination" (keep going where they were heading). Optional "lost": true.
- "call": they want Nook to call them / talk them through it. "reason": "manual_call" | "uneasy_companion" | "navigation_help" | "lost" | "hands_free_guidance".
- "danger": they may be in immediate danger. "clear": true ONLY when the message states an unmistakable emergency (being attacked or chased, a weapon, hurt, asking for police/911, "I'm in danger"). If it only sounds threatening or you're unsure, use "clear": false.
- "route_choice": the message only answers "keep heading there or go somewhere busier?". "choice": "destination" | "busier".
- "unclear": can't tell.
Prefer "uneasy" or "danger" with "clear": false over "clear": true. "someone walking behind me" is uneasy; "someone is chasing me and I can't get away" is danger with clear true.`;
