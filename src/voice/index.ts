import type { StartCall } from "../shared/types.ts";

/**
 * Outbound calls through an ElevenLabs agent on a Twilio number.
 * The agent reports back through POST /tools/location and /tools/call-outcome
 * (see src/index.ts), using `user_id` / `walk_id` from the dynamic variables.
 */

const OUTBOUND_URL = "https://api.elevenlabs.io/v1/convai/twilio/outbound-call";

export interface VoiceConfig {
  apiKey: string;
  agentId: string;
  agentPhoneNumberId: string;
}

export function voiceConfigFromEnv(): VoiceConfig | null {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const agentId = process.env.ELEVENLABS_AGENT_ID?.trim();
  const agentPhoneNumberId = process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID?.trim();
  if (!apiKey || !agentId || !agentPhoneNumberId) return null;
  return { apiKey, agentId, agentPhoneNumberId };
}

/** Places the call; throws if it can't be placed so the caller can treat it as unresolved. */
export async function placeCall(cfg: VoiceConfig, toNumber: string, action: StartCall): Promise<string | undefined> {
  const res = await fetch(OUTBOUND_URL, {
    method: "POST",
    headers: { "xi-api-key": cfg.apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: cfg.agentId,
      agent_phone_number_id: cfg.agentPhoneNumberId,
      to_number: toNumber,
      conversation_initiation_client_data: {
        dynamic_variables: {
          user_id: action.userId,
          walk_id: action.walkId,
          display_name: action.vars.displayName,
          street: action.vars.street,
          minutes_walking: Math.round(action.vars.minutesWalking),
        },
      },
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
