/**
 * User-chosen safety settings, set during onboarding or by texting "settings".
 * Deterministic and structured so the brain can read them without an LLM.
 */

export type MonitoringMode = "MANUAL" | "EVENINGS" | "AWAY_FROM_HOME";

/**
 * What happens when a check-in can't confirm the user is okay. Calling is never
 * an escalation step: calls are an opt-in companion mode the user asks for.
 */
export type NoResponseAction = "CONTACT_TRUSTED" | "NONE";

/** Stored values from before calls were removed from escalation. */
export function normalizeNoResponseAction(raw: string | null | undefined): NoResponseAction | undefined {
  switch (raw) {
    case "CONTACT_TRUSTED":
    case "CALL_THEN_CONTACT":
      return "CONTACT_TRUSTED";
    case "NONE":
    case "CALL_USER":
      return "NONE";
    default:
      return undefined;
  }
}

export interface TrustedContact {
  name?: string;
  phone: string; // E.164
}

/**
 * Normal escalation: always a text check-in first, then `onNoTextResponse`.
 * Stage timing lives in `CheckinTimeouts`.
 */
export interface EscalationPolicy {
  initialAction: "TEXT_USER";
  onNoTextResponse: NoResponseAction;
}

/** Check-in timing. Missing fields fall back to `DEFAULT_TIMEOUTS`. */
export interface CheckinTimeouts {
  /** Seconds after a check-in with no reply before the nudge. */
  nudgeAfterSec?: number;
  /** Seconds after the nudge before the escalation step. */
  escalateAfterSec?: number;
  /** Minutes without a location update before a check-in. */
  noUpdateMin?: number;
}

export const DEFAULT_TIMEOUTS = {
  nudgeAfterSec: 60,
  escalateAfterSec: 60,
  noUpdateMin: 3,
} as const;

export const TIMEOUT_LIMITS = {
  nudgeAfterSec: { min: 30, max: 600 },
  escalateAfterSec: { min: 30, max: 600 },
  noUpdateMin: { min: 2, max: 15 },
} as const;

export type TimeoutKey = keyof typeof DEFAULT_TIMEOUTS;

export function clampTimeout(key: TimeoutKey, value: number): number {
  const { min, max } = TIMEOUT_LIMITS[key];
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function resolveTimeouts(t?: CheckinTimeouts): Required<CheckinTimeouts> {
  return {
    nudgeAfterSec: clampTimeout("nudgeAfterSec", t?.nudgeAfterSec ?? DEFAULT_TIMEOUTS.nudgeAfterSec),
    escalateAfterSec: clampTimeout(
      "escalateAfterSec",
      t?.escalateAfterSec ?? DEFAULT_TIMEOUTS.escalateAfterSec,
    ),
    noUpdateMin: clampTimeout("noUpdateMin", t?.noUpdateMin ?? DEFAULT_TIMEOUTS.noUpdateMin),
  };
}

export interface UserSettings {
  monitoringMode?: MonitoringMode;
  trustedContact?: TrustedContact;
  escalation?: EscalationPolicy;
  timeouts?: CheckinTimeouts;
}

/** What Nook has picked up about a user's routine. Empty until learning exists. */
export interface LearnedRoutine {
  frequentPlaces: string[];
  commonRoutes: string[];
  usualStops: string[];
  typicalTripMinutes?: number;
}
