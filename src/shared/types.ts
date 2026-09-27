/** Only time source in app code — never Date.now() for rules. */
export interface Clock {
  now(): Date;
}

export interface SimClock extends Clock {
  set(t: Date): void;
  advance(ms: number): void;
}

export type WalkPhase =
  | "IDLE"
  | "PROMPTED"
  | "WALKING"
  | "CHECKING_IN"
  | "ALERTED"
  | "CALLING"
  | "ARRIVED"
  | "ENDED_ELSEWHERE";

export type RuleId =
  | "R1"
  | "R2"
  | "R2x"
  | "R3"
  | "R4"
  | "R5a"
  | "R5b"
  | "R6"
  | "R7a"
  | "R7b"
  | "R8"
  | "R9a"
  | "R9b"
  | "R10"
  | "R11"
  | "R12" // typed; unwired until L5
  | "R14"
  | "R15"
  | "R16"
  | "R17"; // destination shared / changed

export type SendTextTag =
  | "prompt"
  | "started"
  | "checkin"
  | "nudge"
  | "arrived"
  | "ended";

// --- Events (edge → brain) ---

export type Event = LocationPing | UserText | UserReaction | CallEvent;

export interface LocationPing {
  type: "LocationPing";
  userId: string;
  time: Date; // Clock.now()
  lat: number;
  lon: number;
  accuracyM?: number;
  /** From Find My shortAddress when present; for getLiveContext, not LLM. */
  shortAddress?: string;
}

export interface UserText {
  type: "UserText";
  userId: string;
  messageId: string;
  /** Typed text, or the transcript of `voiceNote` ("" when transcription failed). */
  text: string;
  time: Date;
  voiceNote?: VoiceNoteRef;
}

/** An iMessage voice note, saved locally; `text` on the event carries its transcript. */
export interface VoiceNoteRef {
  id: string;
  path: string;
  mimeType: string;
  transcribed: boolean;
}

export interface UserReaction {
  type: "UserReaction";
  userId: string;
  emoji: string; // e.g. 👍 👎 ‼️ ❓
  targetMessageId: string;
  time: Date;
}

/**
 * Call lifecycle from the voice agent. Calls are a hands-free companion, never
 * an escalation step, so no outcome except `request_escalation` reaches the contact.
 * - `started`: the user answered.
 * - `resolved_safe`: the user confirmed on the call that they're okay.
 * - `request_escalation`: immediate danger, or the user asked for their trusted contact.
 * - `ended_unresolved`: hung up / dropped / unanswered without a clear "I'm okay"
 *   (Nook follows up with a text check-in).
 */
export type CallOutcome = "started" | "resolved_safe" | "request_escalation" | "ended_unresolved";

export const CALL_OUTCOMES: readonly CallOutcome[] = [
  "started",
  "resolved_safe",
  "request_escalation",
  "ended_unresolved",
];

export interface CallEvent {
  type: "CallEvent";
  userId: string;
  walkId: string;
  callType: CallOutcome;
  time: Date;
  /** The user's own words from the call (request_escalation), quoted in the contact alert. */
  situation?: string;
}

/** Drop before emit if lat/lon missing. */

// --- Safety model ---

/** How safe the user says they are. Independent of how they're talking to Nook. */
export type SafetyState = "safe" | "uneasy" | "immediate_danger";

/** How the user is talking to Nook right now. Voice is a mode, not an escalation level. */
export type Channel = "text" | "voice";

export type RouteChoice = "destination" | "busier";

export type CallReason =
  | "manual_call"
  | "uneasy_companion"
  | "navigation_help"
  | "lost"
  | "hands_free_guidance";

/** Where a statement came from; reactions, typed text and voice notes share one pipeline. */
export type InputSource = "reaction" | "text" | "voice_note" | "voice_call";

/**
 * What the user meant, whatever the input method. 👍 👎 ❓ ‼️ map to
 * safe / uneasy / call / danger(clear); text and voice-note transcripts are
 * classified into the same shape.
 */
export type SafetyIntent =
  | { kind: "safe"; placeLabel?: string }
  | { kind: "uneasy"; detail?: string; wants?: RouteChoice; lost?: boolean }
  | { kind: "call"; reason?: CallReason }
  /** `clear: false` = ambiguous ("help"): Nook asks before treating it as an emergency. */
  | { kind: "danger"; clear: boolean; quote?: string; wantsCall?: boolean }
  | { kind: "route_choice"; choice: RouteChoice }
  | { kind: "unclear" };

export interface Destination {
  name: string;
  lat: number;
  lon: number;
  address?: string;
  /** "home" | "apple_maps" | "safe_place" | "tool" */
  source: string;
}

// --- Actions (brain → edge) ---

export type Action = SendText | AlertContact | StartCall;

export interface SendText {
  type: "SendText";
  userId: string;
  text: string;
  tag: SendTextTag;
}

export interface AlertAttachment {
  path: string;
  mimeType: string;
}

export interface AlertContact {
  type: "AlertContact";
  userId: string;
  text: string;
  lat: number;
  lon: number;
  /** Immediate danger: rich alert, Nook tells the user the truthful delivery status. */
  emergency?: boolean;
  /** Voice notes forwarded as files after the text. */
  attachments?: AlertAttachment[];
  /** Sent after the attachments (e.g. the labelled transcript of a forwarded voice note). */
  trailer?: string;
  /** Follow-up inside an open emergency (forwarded voice note); no maps link. */
  followUp?: boolean;
  /** Voice note ids this alert forwards (marked forwarded once delivered). */
  voiceNoteIds?: string[];
}

export interface CallVars {
  displayName: string;
  street: string;
  minutesWalking: number;
  walkId: string;
  callReason?: CallReason;
  safetyState?: SafetyState;
  destinationName?: string;
  routeChoice?: RouteChoice | "none";
  /** Short summary of what the user already said, so the agent doesn't re-ask. */
  recentContext?: string;
  lat?: number;
  lon?: number;
  /** First thing the agent says; picked on the server from the call reason. */
  openingLine?: string;
}

export interface StartCall {
  type: "StartCall";
  userId: string;
  walkId: string;
  vars: CallVars;
}

/** execute(SendText) returns messageId so tapbacks can be matched. */
export type ExecuteResult = { messageId?: string };

// --- Brain ---

export interface LiveContext {
  street: string;
  lat: number;
  lon: number;
  minutesWalking: number;
  /** ISO time of the fix. */
  updatedAt: string;
  ageSec: number;
  accuracyM?: number;
  /** Fresh enough for turn-by-turn guidance (NAV_STALE_SECONDS). */
  navigationFresh: boolean;
  /** Fresh enough to describe where they are / put in an alert (90 s). */
  contextFresh: boolean;
  safetyState: SafetyState;
  destination?: string;
}

export interface Brain {
  handle(event: Event): Promise<Action[]>;
  getLiveContext(walkId: string): Promise<LiveContext | null>;
  /** Time-based rules (reply timers, no-update, lateness). Called every 30 s. */
  tick?(now: Date): Promise<Action[]>;
  /** Close any open walk and drop in-memory location state (dev sim stop). */
  resetUser?(userId: string): Promise<void>;
  /** Voice tools: open safe places near the caller, ranked. */
  safeDestinations?(walkId: string): Promise<unknown>;
  /** Voice tools: switch the active destination ("home", "trip", or a place id from safeDestinations). */
  setDestination?(walkId: string, choice: string): Promise<unknown>;
  /** Voice tools: next instruction, remaining distance, freshness. */
  navigation?(walkId: string): Promise<unknown>;
}

// --- Walk plan (loaded once on enter WALKING) ---

export interface KnownStopPlan {
  cell: string;
  label?: string;
  kind?: string; // e.g. "friend"
  allowedDwellMin: number; // max(ok_dwell, p90+2), cap 30 (60 friend), default 10
}

export interface WalkPlan {
  expectedMin: number;
  lateMin: number;
  routeCells: string[];
  bufferM: number; // 150
  stops: KnownStopPlan[];
}

// --- LLM (not on ping path) ---

export type WriteMessages = (plan: WalkPlan) => Promise<Record<string, string>>;
/** Typed text or a voice-note transcript → SafetyIntent. */
export type ClassifyInput = (text: string) => Promise<SafetyIntent>;
