import type { StartCall } from "../shared/types.ts";
import { vonageConfigFromEnv, type VonageConfig } from "./vonage.ts";

/**
 * Voice check-ins through an ElevenLabs agent: a phone call (Twilio number
 * imported into ElevenLabs, or Vonage bridged in ./vonage.ts), or a "tap to
 * talk" link opened in the browser (see ./talk.ts). The agent reports back through POST /tools/location
 * and /tools/call-outcome (see src/index.ts), using `user_id` / `walk_id` from
 * the dynamic variables.
 */

const API = "https://api.elevenlabs.io/v1/convai";

export interface VoiceConfig {
  apiKey: string;
  agentId: string;
  /** Set: place phone calls through the ElevenLabs-imported (Twilio) number. */
  agentPhoneNumberId?: string;
  /** Public HTTPS base URL of this server, for tap-to-talk links and Vonage calls. */
  publicUrl?: string;
  /** Set (with publicUrl): place phone calls through Vonage (./vonage.ts). */
  vonage?: VonageConfig;
}

export function voiceConfigFromEnv(): VoiceConfig | null {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const agentId = process.env.ELEVENLABS_AGENT_ID?.trim();
  const agentPhoneNumberId = process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID?.trim();
  const publicUrl = process.env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (!apiKey || !agentId || (!agentPhoneNumberId && !publicUrl)) return null;
  const vonage = publicUrl ? vonageConfigFromEnv() : null;
  return {
    apiKey,
    agentId,
    ...(agentPhoneNumberId && { agentPhoneNumberId }),
    ...(publicUrl && { publicUrl }),
    ...(vonage && { vonage }),
  };
}

export function callMode(cfg: VoiceConfig | null): "phone" | "vonage" | "link" | "off" {
  if (!cfg) return "off";
  if (cfg.agentPhoneNumberId) return "phone";
  return cfg.vonage ? "vonage" : "link";
}

export function callVariables(action: StartCall, contactName?: string): Record<string, string | number> {
  return {
    user_id: action.userId,
    walk_id: action.walkId,
    display_name: action.vars.displayName,
    street: action.vars.street,
    minutes_walking: Math.round(action.vars.minutesWalking),
    contact_name: contactName ?? "none saved",
  };
}

/** Places the call; throws if it can't be placed so the caller can treat it as unresolved. */
export async function placeCall(
  cfg: VoiceConfig,
  toNumber: string,
  action: StartCall,
  contactName?: string,
): Promise<string | undefined> {
  if (!cfg.agentPhoneNumberId) throw new Error("no ElevenLabs phone number configured");
  const res = await fetch(`${API}/twilio/outbound-call`, {
    method: "POST",
    headers: { "xi-api-key": cfg.apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: cfg.agentId,
      agent_phone_number_id: cfg.agentPhoneNumberId,
      to_number: toNumber,
      conversation_initiation_client_data: { dynamic_variables: callVariables(action, contactName) },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    message?: string;
    conversation_id?: string;
  };
  if (!res.ok || body.success === false) {
    throw new Error(`ElevenLabs outbound call failed (${res.status}): ${body.message ?? res.statusText}`);
  }
  return body.conversation_id;
}

/** Short-lived WebRTC token so a browser can talk to the (private) agent without our API key. */
export async function conversationToken(cfg: VoiceConfig): Promise<string> {
  const res = await fetch(`${API}/conversation/token?agent_id=${encodeURIComponent(cfg.agentId)}`, {
    headers: { "xi-api-key": cfg.apiKey },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { token?: string; detail?: unknown };
  if (!res.ok || !body.token) {
    throw new Error(`ElevenLabs conversation token failed (${res.status}): ${JSON.stringify(body.detail ?? body)}`);
  }
  return body.token;
}
