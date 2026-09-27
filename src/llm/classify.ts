import { z } from "zod";
import type {
  CallReason,
  Classification,
  ClassifyContext,
  RouteChoice,
  SafetyIntent,
} from "../shared/types.ts";

/**
 * One intent pipeline for tapbacks, typed text and voice-note transcripts.
 *
 * 1. `classifyDeterministic`: reactions, short replies to the open question,
 *    a narrow clear-danger list, stop, call, route choice, safe / place.
 * 2. Gemini (when on) for everything else, validated against `intentSchema`.
 * 3. `classifyConservative`: ambiguous danger, uneasy, or unclear. Used when
 *    Gemini is off or fails, and as the guard around Gemini.
 *
 * Calling ordinary unease an emergency is the costliest mistake (Nook turns
 * alarmist and people stop trusting it), so only unmistakable phrases are
 * `clear: true`. Merely threatening messages are `clear: false`, which makes
 * Nook ask "Are you in immediate danger right now?".
 *
 * Precedence: clear danger > stop > call > route choice > safe > uneasy > unclear.
 */

const TAPBACKS: Record<string, SafetyIntent> = {
  "👍": { kind: "safe" },
  "👎": { kind: "uneasy" },
  "❓": { kind: "call", reason: "manual_call" },
  "‼": { kind: "danger", clear: true, quote: 'tapped ‼️ ("I need help now")' },
};

export function reactionIntent(emoji: string): SafetyIntent | null {
  return TAPBACKS[emoji.replace(/\uFE0F/g, "").trim()] ?? null;
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** The user's words as sent, trimmed; quoted in alerts and never paraphrased. */
function quoteOf(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 280);
}

/** Phrases that deny danger or a call are removed before matching. */
const NEGATIONS: RegExp[] = [
  /\b(i'?m |i am )?not (in )?(any )?(immediate )?(danger|an emergency|hurt|lost)\b/g,
  /\bno (danger|emergency)\b/g,
  /\b(no one|nobody|no-one)('s| is)? (chasing|following|attacking|hurting) me\b/g,
  /\b(isn'?t|is not|wasn'?t|not|aren'?t) (chasing|following|attacking|hurting) me\b/g,
  /\b(don'?t|do not|dont) need (help|a call|you to call( me)?|911|the police)\b/g,
  /\bno need to call( me)?\b/g,
  /\b(don'?t|do not|dont|no need to|please don'?t) (call|ring|phone)( me)?\b/g,
];

function stripNegations(t: string): string {
  let out = t;
  for (const n of NEGATIONS) out = out.replace(n, " ");
  return out.replace(/\s+/g, " ").trim();
}

/** Narrow on purpose: an immediate threat, attack, weapon, severe injury, or an explicit statement. */
export const CLEAR_DANGER: RegExp[] = [
  // being chased
  /\b(chas(e|ed|ing) me|is chasing|are chasing|keeps? chasing)\b/,
  /\b(following|followed) me\b.{0,40}\b(can'?t (get away|lose (him|her|them))|getting closer|grabbed me)\b/,
  // attack / assault
  /\b(attack(ed|ing)? me|being attacked|been attacked|assault(ed|ing)? me|being assaulted|been assaulted)\b/,
  /\b(someone|somebody|a guy|a man|a woman|he|she|they)('s| is| are| just)? (attacking|hitting|punching|grabbing|grabbed|hit|punched|stabbed|robbing|mugging|choking|dragging|beating) me\b/,
  /\b(got|been|being|was|just got) (mugged|robbed|stabbed|shot|assaulted|attacked|kidnapped|jumped|raped)\b/,
  /\b(forcing|pulling|dragging|pushing) me into\b/,
  /\bwon'?t let me (go|leave)\b/,
  /\b(trying|going|about|wants?) to (hurt|kill|attack|grab|rob|stab|shoot|rape) me\b/,
  // weapon
  /\b(has|have|had|with|pulled( out)?|holding|showing|pointing|waving) a (gun|knife|weapon|blade)\b/,
  /\b(gun|knife|weapon) (at|on|to) (me|my)\b/,
  // explicit
  /\b(i'?m|i am|we'?re) in (immediate |real |serious )?danger\b/,
  /\bin immediate danger\b/,
  /\b(i |we )?need (the )?(911|police|cops|an ambulance|ambulance)\b/,
  /\b(call|get|send) (the )?(police|cops|911|an ambulance)\b/,
  /\b(dial|dialing|calling) 911\b/,
  // severe injury / medical
  /\b(badly|seriously|really badly|very badly|severely) (hurt|injured)\b/,
  /\bbleeding (a lot|badly|heavily|everywhere|out)\b/,
  /\b(can'?t|cannot) breathe\b/,
  /\b(heart attack|having a stroke|having a seizure|overdos(e|ed|ing)|not breathing|unconscious)\b/,
];

/** Sounds threatening but needs a yes/no before anyone is alerted. */
const AMBIGUOUS_DANGER: RegExp[] = [
  /^(help|help me|help!+|sos|emergency|danger)[.!? ]*$/,
  /\bhelp help\b|\bhelp me (now|please)\b|\bplease help\b/,
  /\b(sos|emergency)\b/,
  /\b(following|stalking) me\b/,
  /\b(being|getting|been) followed\b/,
  /\bfollowed me\b/,
  /\bbehind me (for|the whole|all the way|since|this whole)\b/,
  /\b(for|past|over) (a few|several|like \d+|\d+|two|three|four|five) blocks\b/,
  /\bharass(ing|ed)? me\b/,
  /\bwon'?t leave me alone\b/,
  /\b(someone|somebody|a guy|a man|he|they)('s| is| are)? (touching|grabbing at|cornering|blocking) me\b/,
  /\b(i'?m|i am) (hurt|bleeding|injured)\b/,
  /\bthreaten(ing|ed)? me\b/,
];

/** "help me find the station" is a navigation ask, not an emergency. */
const HELP_DIRECTIVE = /\bhelp (me )?(find|get|with|navigate|figure|pick|choose|decide|out)\b/;

const CALL: RegExp[] = [
  /\bcall me\b/,
  /\bgive me a (call|ring)\b/,
  /\bcan (you|u) (call|ring|phone)( me)?\b(?!\s+(sam|911|the|my|them|him|her))/,
  /\b(phone|ring) me\b/,
  /\btalk (to me|me home|me through)\b/,
  /\b(i want|i'?d like|wanna|want) to talk\b/,
  /\bstay on the (phone|line)\b/,
  /\bon the phone with me\b/,
  /\bguide me\b/,
  /\bhands[- ]?free\b/,
  /\bvoice mode\b/,
];

const STOP_WHOLE =
  /^(stop|dismiss|enough|cancel|never ?mind|leave me alone|go away|not tonight|end trip|end the trip)[.!? ]*$/;
const STOP_ANY =
  /\b(stop (checking|watching|texting|asking|bugging|hovering|tracking|monitoring)( in)?( on me)?|don'?t (need|want) (you|nook)|you can (stop|go|stand down)|end (the |this )?(walk|trip)|wrap(ping)? (it |this )?up|i'?m (good|fine|ok|okay|safe).{0,20}\bstop\b)/;
const STOP_NEGATED = /\b(don'?t|do not|dont|never) stop\b/;

const LOST = /\b(lost|don'?t know where i am|no idea where i am|which way|wrong way)\b/;
const NAVIGATION = /\b(navigat\w*|directions?|how do i get|route me|way home|guide me|which way)\b/;
const HANDS_FREE =
  /\b(hands[- ]?free|talk me (home|through)|guide me home|walk me through|stay on the (phone|line)|on the phone with me)\b/;

const UNEASY: RegExp[] = [
  /\b(scared|nervous|uneasy|uncomfortable|anxious|afraid|freaked|freaking out|on edge|worried|frightened|spooked)\b/,
  /\b(creepy|creeped|sketchy|sus|shady)\b/,
  /\bweird (vibe|vibes|guy|man|dude|feeling|person|people)\b/,
  /\bfeel(s|ing)? (weird|off|strange|wrong|unsafe|uncomfortable|sketchy|creepy|bad)\b/,
  /\b(seems|is|looks) (weird|off|sketchy|creepy|shady)\b/,
  /\b(don'?t|do not|dont) (feel|like) (safe|good|right|great|ok|okay|this|it|the)\b/,
  /\b(unsafe|not safe|dangerous)\b/,
  /\bnot (ok|okay|fine|good|great|alright|all right|so good)\b/,
  /\b(someone|somebody|a guy|a man|people|he|they|guy|this guy)('s| is| are)? (behind|staring|watching|lurking|walking behind|yelling|hanging around|loitering|making me)\b/,
  /\bwalking behind me\b/,
  /\b(dark|empty|deserted|quiet) (street|block|area|here|road|path)\b/,
  /\b(really|so|very|super|pretty) dark\b/,
  /\b(no one|nobody|noone) (around|here|out)\b/,
  LOST,
];

const WANTS_BUSIER =
  /\b(busier|busy|crowded|well[- ]lit|lit up|brighter|somewhere (safe|safer|public|with people|open|lit)|more people|people around|open (store|shop|place)|public place|main street|go inside|a store|a cafe|somewhere busy|find somewhere)\b/;
const WANTS_DESTINATION =
  /\b(keep (going|heading|walking)|continue|stay (on|the) (route|course)|(go|head|going|heading|get) (straight )?home|just (get|go) home|stick to (the|my) route|destination)\b/;

/** Only the route answer, nothing else ("keep going", "busier", "find somewhere open"). */
const ROUTE_ONLY =
  /^(ok(ay)?,? |yeah,? |let'?s |i'?ll |i want to |i'?d like to |i want |i'?d rather |please )?(just )?(keep going|keep heading( home| there| to [\w' ]{1,30})?|keep walking|continue|stay on (my|the) route|stick to (my|the) route|(go|head|get) home|(go|head) to (my|the) destination|destination|the destination|busier|somewhere busier|a busier (street|place)|somewhere (with )?(more )?people( around)?|more people|somewhere open|find (me )?somewhere (open|busier|busy|public|well[- ]lit|with people)|an? open (public )?place|a public place|somewhere well[- ]lit|a main street)( please)?[.!]*$/;

const YES = /^(yes|yeah|yea|yep|yup|ya|y|uh huh|correct|affirmative)\b|^(i am|i am yes)[.! ]*$/;
const NO = /^(no|nope|nah|n|not really|no i'?m not|i'?m not)\b/;
/** A bare acknowledgement that doesn't answer "keep going or somewhere busier?". */
const BARE_ACK = /^(yes|yeah|yea|yep|yup|ya|y|ok|okay|k|kk|sure|no|nope|nah|n|maybe)[.,! ]*$/;

/** "okay", "all good", "made it": the whole message says they're fine. */
const SAFE_WHOLE =
  /^(ok|okay|k|kk|fine|good|great|all good|all set|safe|made it|home|here|no worries|thumbs up|yes|yeah|yep|yup|ya|👍|i'?m (ok|okay|fine|good|safe|home|here|alright|all right|great)|we'?re (good|fine|ok|okay|safe)|fine now|home now|good now|safe now)( now)?,?( thanks| thank you| thx| ty)?[.,!]*$/;
/** They say a concern is over; beats ambiguous cues in the same message. */
const SAFE_RESOLVED =
  /\b((i'?m|im|i am|we'?re|all) (ok|okay|fine|good|safe|alright|all right) now|false alarm|all good now|(don'?t|do not|dont) need help anymore|no longer (scared|worried|uneasy)|made it (home|back|safely)|got home|i'?m home( now)?|i'?m safe( now)?)\b/;
const SAFE_ANY = /\b(i'?m|im|i am|we'?re) (ok|okay|fine|good|alright|all right)\b|\ball good\b/;
const SAFE_NEGATED =
  /(\bnot|n't|\bnever|\bno longer|\bnothing)\b\W+(\w+\W+){0,2}(ok|okay|fine|good|safe|alright|all right)\b/;

const PLACE = /\b(?:i'?m|i am|staying|still|just|we'?re) at\s+(.+)/i;

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
  return "manual_call";
}

function hasConcern(t: string): boolean {
  const scrubbed = t.replace(HELP_DIRECTIVE, " ");
  return any(UNEASY, t) || any(AMBIGUOUS_DANGER, scrubbed);
}

function isStop(t: string): boolean {
  if (STOP_NEGATED.test(t)) return false;
  return STOP_WHOLE.test(t) || STOP_ANY.test(t);
}

function isCall(t: string): boolean {
  return any(CALL, t);
}

/**
 * High-confidence rules. Null means "not sure": Gemini (or the conservative
 * fallback) decides. `ctx.awaiting` decides what a bare "yes" / "no" means.
 */
export function classifyDeterministic(raw: string, ctx?: ClassifyContext): Classification | null {
  const t0 = normalize(raw);
  if (!t0) return { intent: { kind: "unclear" }, classifier: "deterministic" };
  const t = stripNegations(t0);
  const quote = quoteOf(raw);
  const awaiting = ctx?.awaiting ?? null;

  if (any(CLEAR_DANGER, t)) {
    return {
      intent: { kind: "danger", clear: true, quote, ...(isCall(t) && { wantsCall: true }) },
      classifier: "deterministic",
    };
  }
  if (awaiting === "danger_confirmation" && YES.test(t0) && !NO.test(t0)) {
    return {
      intent: { kind: "danger", clear: true, quote, ...(isCall(t) && { wantsCall: true }) },
      classifier: "context",
    };
  }
  if (isStop(t)) return { intent: { kind: "stop" }, classifier: "deterministic" };
  if (isCall(t)) {
    const uneasy = hasConcern(t);
    const reason = uneasy && callReason(t) === "manual_call" ? "uneasy_companion" : callReason(t);
    return { intent: { kind: "call", reason, ...(uneasy && { uneasy: true }) }, classifier: "deterministic" };
  }
  if (ROUTE_ONLY.test(t)) {
    const choice = wants(t);
    if (choice) return { intent: { kind: "route_choice", choice }, classifier: "deterministic" };
  }

  // Bare yes / no mean whatever the open question asked.
  const bareNo = NO.test(t0) && t0.split(" ").length <= 3;
  if (awaiting === "danger_confirmation" && NO.test(t0)) {
    return { intent: { kind: "uneasy", detail: quote }, classifier: "context" };
  }
  if ((awaiting === "route_choice" || awaiting === "place_choice") && BARE_ACK.test(t0)) {
    return { intent: { kind: "unclear" }, classifier: "context" };
  }
  if (awaiting === "checkin" && bareNo) {
    return { intent: { kind: "uneasy", detail: quote }, classifier: "context" };
  }

  if (SAFE_RESOLVED.test(t0) && !SAFE_NEGATED.test(t0)) return { intent: { kind: "safe" }, classifier: "deterministic" };
  if (SAFE_WHOLE.test(t) && !SAFE_NEGATED.test(t0)) return { intent: { kind: "safe" }, classifier: "deterministic" };
  if (hasConcern(t)) return null;

  const place = raw.replace(/[\u2018\u2019]/g, "'").match(PLACE)?.[1]?.replace(/[.!]+$/, "").trim();
  if (place && place.length <= 40) return { intent: { kind: "place", label: place }, classifier: "deterministic" };
  if (SAFE_ANY.test(t) && !SAFE_NEGATED.test(t0)) return { intent: { kind: "safe" }, classifier: "deterministic" };
  return null;
}

/**
 * Conservative read for anything the deterministic layer wasn't sure about:
 * ambiguous danger, uneasy, or unclear. Never safe, never clear danger.
 */
export function classifyConservative(raw: string): SafetyIntent {
  const t = stripNegations(normalize(raw));
  if (!t) return { kind: "unclear" };
  const quote = quoteOf(raw);
  const helpDirective = HELP_DIRECTIVE.test(t);
  const scrubbed = helpDirective ? t.replace(HELP_DIRECTIVE, " ") : t;
  if (any(AMBIGUOUS_DANGER, scrubbed)) return { kind: "danger", clear: false, quote };
  const w = wants(t);
  if (any(UNEASY, t) || helpDirective) {
    return { kind: "uneasy", detail: quote, ...(w && { wants: w }), ...(LOST.test(t) && { lost: true }) };
  }
  if (w && t.split(" ").length <= 8) return { kind: "route_choice", choice: w };
  return { kind: "unclear" };
}

/** Deterministic rules, then the conservative read. What runs when Gemini is off. */
export function classifyLocal(raw: string, ctx?: ClassifyContext): Classification {
  return classifyDeterministic(raw, ctx) ?? { intent: classifyConservative(raw), classifier: "fallback" };
}

// --- Gemini ------------------------------------------------------------------

const CALL_REASONS = ["manual_call", "uneasy_companion", "navigation_help", "lost", "hands_free_guidance"] as const;
const ROUTE_CHOICES = ["destination", "busier"] as const;

/**
 * What Gemini must return. Flat so the JSON schema stays simple; the quote is
 * filled in by the server from the original message, never by the model.
 */
export const intentSchema = z
  .object({
    kind: z.enum(["safe", "uneasy", "call", "danger", "route_choice", "place", "stop", "unclear"]),
    clear: z.boolean().optional().describe("danger only: true only for an unmistakable immediate threat"),
    wants: z.enum(ROUTE_CHOICES).optional().describe("uneasy only: a route preference they stated"),
    lost: z.boolean().optional().describe("uneasy only: they don't know where they are"),
    reason: z.enum(CALL_REASONS).optional().describe("call only"),
    uneasy: z.boolean().optional().describe("call only: they asked for the call because they feel uneasy"),
    choice: z.enum(ROUTE_CHOICES).optional().describe("route_choice only"),
    label: z.string().max(80).optional().describe("place only: where they are staying, in their words"),
  })
  .strict();

export type GeminiIntent = z.infer<typeof intentSchema>;

const { $schema: _unused, ...jsonSchema } = z.toJSONSchema(intentSchema) as Record<string, unknown>;
/** Passed to Gemini as `responseJsonSchema`; validation still runs on every reply. */
export const intentJsonSchema = jsonSchema;

/** Validated model output → SafetyIntent, with the user's own words as quote/detail. Null when it doesn't fit. */
export function toSafetyIntent(obj: unknown, raw: string): SafetyIntent | null {
  const parsed = intentSchema.safeParse(obj);
  if (!parsed.success) return null;
  const o = parsed.data;
  const quote = quoteOf(raw);
  switch (o.kind) {
    case "safe":
      return { kind: "safe" };
    case "uneasy":
      return { kind: "uneasy", detail: quote, ...(o.wants && { wants: o.wants }), ...(o.lost && { lost: true }) };
    case "call":
      return { kind: "call", reason: o.reason ?? "manual_call", ...(o.uneasy && { uneasy: true }) };
    case "danger":
      return { kind: "danger", clear: o.clear === true, quote };
    case "route_choice":
      return o.choice ? { kind: "route_choice", choice: o.choice } : null;
    case "place":
      return o.label?.trim() ? { kind: "place", label: o.label.trim() } : null;
    case "stop":
      return { kind: "stop" };
    case "unclear":
      return { kind: "unclear" };
  }
}

/**
 * Combine the conservative read with Gemini's. The model can never raise clear
 * danger (at most it asks the confirmation question), can't erase or soften an
 * ambiguous-danger signal, and can't turn unease into "safe".
 */
export function guardIntent(conservative: SafetyIntent, llm: SafetyIntent | null): SafetyIntent {
  if (!llm || conservative.kind === "danger") return conservative;
  if (llm.kind === "danger") return { kind: "danger", clear: false, quote: llm.quote };
  if (conservative.kind === "uneasy") {
    if (llm.kind === "safe" || llm.kind === "unclear" || llm.kind === "place") return conservative;
    if (llm.kind === "route_choice") return { ...conservative, wants: llm.choice };
  }
  return llm;
}

export const CLASSIFY_PROMPT = `You classify safety-related messages for Nook, a walking-safety assistant.

Return only one JSON object matching the provided schema.

Your job is to identify the user's current intent.

Kinds:
- "safe": they're fine, arrived, or a concern is over.
- "uneasy": something feels off (nervous, dark or empty street, someone behind them, lost). Optional "wants": "destination" | "busier" if they said which way. Optional "lost": true.
- "call": they want Nook to call them. "reason": "manual_call" | "uneasy_companion" | "navigation_help" | "lost" | "hands_free_guidance". "uneasy": true if they also say they feel uneasy.
- "danger": they may be in immediate danger. "clear": true or false (see rules).
- "route_choice": the message only answers "keep heading there, or somewhere busier?". "choice": "destination" | "busier".
- "place": they say where they're staying ("I'm at Sam's"). "label": the place in their words.
- "stop": they want Nook to stop checking in or stop tracking this trip.
- "unclear": nothing fits reliably.

Important rules:

1. Prefer "uneasy" over "danger" unless the user clearly indicates immediate danger.
2. "Someone walking behind me", "this feels weird", "it's dark", "I'm scared", and "help" alone are NOT automatically clear danger.
3. Use danger.clear=true only when the user clearly describes an immediate threat, attack, weapon, severe injury, or explicitly says they are in immediate danger.
4. If the message suggests danger but is ambiguous, use danger.clear=false.
5. Preserve the user's original wording exactly. (The server attaches the quote; do not paraphrase it anywhere.)
6. "Call me" means request a Nook voice call. It does not mean danger.
7. "I want somewhere busier", "find somewhere open", etc. are route choices, not danger.
8. If the user says they are safe after a previous danger/uneasy state, classify as safe.
9. Pay attention to negation. "I'm not okay" is not safe. "Don't call me" is not a call.
10. Do not invent facts or strengthen the user's claim.
11. If uncertain and no category fits reliably, return unclear.

Use the context to read short replies: while awaiting "danger_confirmation", "yes" is danger with clear=true and "no" is uneasy. While awaiting "route_choice", a bare "yes" is unclear.`;

export function buildClassifyPrompt(text: string, ctx: ClassifyContext): string {
  const context = {
    current_state: ctx.safetyState,
    awaiting: ctx.awaiting ?? "nothing",
    ...(ctx.destination && { destination: ctx.destination }),
    recent_messages: ctx.recent.slice(-4).map((m) => ({ role: m.from === "nook" ? "assistant" : "user", text: m.text.slice(0, 200) })),
  };
  return `${CLASSIFY_PROMPT}\n\nContext: ${JSON.stringify(context)}\n\nMessage to classify: ${JSON.stringify(text)}`;
}

export function buildRepairPrompt(text: string, ctx: ClassifyContext, badOutput: string, error: string): string {
  return `${buildClassifyPrompt(text, ctx)}

Your previous answer was invalid: ${error}
Previous answer: ${badOutput.slice(0, 300)}
Return ONLY a JSON object with a "kind" field set to one of: safe, uneasy, call, danger, route_choice, place, stop, unclear. Include only the optional fields listed for that kind. No prose, no code fences.`;
}
