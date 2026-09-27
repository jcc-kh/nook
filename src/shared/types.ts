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
  | "R16";

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
  text: string;
  time: Date;
}

export interface UserReaction {
  type: "UserReaction";
  userId: string;
  emoji: string; // e.g. 👍 👎 ‼️ ❓
  targetMessageId: string;
  time: Date;
}

/**
 * Call lifecycle from the voice agent. Picking up is not the same as being
 * safe: only `resolved_safe` calls off a pending trusted-contact step.
 * - `started`: the user answered; outcome still unknown.
 * - `resolved_safe`: the user confirmed on the call that they're okay.
 * - `request_escalation`: the user asked for their trusted contact to be reached.
 * - `ended_unresolved`: hung up / dropped / unanswered / failed to place, without a safe outcome.
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
}

/** Drop before emit if lat/lon missing. */

// --- Actions (brain → edge) ---

export type Action = SendText | AlertContact | StartCall;

export interface SendText {
  type: "SendText";
  userId: string;
  text: string;
  tag: SendTextTag;
}

export interface AlertContact {
  type: "AlertContact";
  userId: string;
  text: string;
  lat: number;
  lon: number;
}

export interface StartCall {
  type: "StartCall";
  userId: string;
  walkId: string;
  vars: {
    displayName: string;
    street: string;
    minutesWalking: number;
    walkId: string;
  };
}

/** execute(SendText) returns messageId so tapbacks can be matched. */
export type ExecuteResult = { messageId?: string };

// --- Brain ---

export interface LiveContext {
  street: string;
  lat: number;
  lon: number;
  minutesWalking: number;
}

export interface Brain {
  handle(event: Event): Promise<Action[]>;
  getLiveContext(walkId: string): Promise<LiveContext | null>;
  /** Time-based rules (reply timers, no-update, lateness). Called every 30 s. */
  tick?(now: Date): Promise<Action[]>;
  /** Close any open walk and drop in-memory location state (dev sim stop). */
  resetUser?(userId: string): Promise<void>;
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

export interface ParsedReply {
  status: "ok" | "help" | "unclear";
  placeLabel?: string;
}

export type WriteMessages = (plan: WalkPlan) => Promise<Record<string, string>>;
export type ParseReply = (text: string) => Promise<ParsedReply>;
