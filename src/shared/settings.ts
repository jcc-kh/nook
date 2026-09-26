/**
 * User-chosen safety settings, set during onboarding or by texting "settings".
 * Deterministic and structured so the brain can read them without an LLM.
 */

export type MonitoringMode = "MANUAL" | "EVENINGS" | "AWAY_FROM_HOME";

export type NoResponseAction = "CALL_USER" | "CONTACT_TRUSTED" | "CALL_THEN_CONTACT" | "NONE";

export type EmergencyAction = Exclude<NoResponseAction, "NONE">;

export interface TrustedContact {
  name?: string;
  phone: string; // E.164
}

/**
 * Normal escalation: always a text check-in first, then `onNoTextResponse`.
 * How long to wait between stages is intentionally not stored here.
 */
export interface EscalationPolicy {
  initialAction: "TEXT_USER";
  onNoTextResponse: NoResponseAction;
}

/** Override: skips the check-in entirely and runs `action` immediately. */
export interface EmergencyCode {
  phrase: string; // lowercase
  action: EmergencyAction;
}

export interface UserSettings {
  monitoringMode?: MonitoringMode;
  trustedContact?: TrustedContact;
  escalation?: EscalationPolicy;
  emergencyCode?: EmergencyCode;
}

export type EscalationStep = "CALL_USER" | "CONTACT_TRUSTED";

/**
 * Ordered steps for a no-response policy or emergency action. Each step runs
 * only if the user still hasn't responded to the previous one.
 */
export function escalationSteps(action: NoResponseAction): EscalationStep[] {
  switch (action) {
    case "CALL_USER":
      return ["CALL_USER"];
    case "CONTACT_TRUSTED":
      return ["CONTACT_TRUSTED"];
    case "CALL_THEN_CONTACT":
      return ["CALL_USER", "CONTACT_TRUSTED"];
    case "NONE":
      return [];
  }
}

/** What Nook has picked up about a user's routine. Empty until learning exists. */
export interface LearnedRoutine {
  frequentPlaces: string[];
  commonRoutes: string[];
  usualStops: string[];
  typicalTripMinutes?: number;
}
