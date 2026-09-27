/**
 * Creates or updates the ElevenLabs side of Nook calls: the two webhook tools,
 * the agent (prompt, first message, call variables), and optionally imports a
 * Twilio number. Safe to re-run whenever the public URL changes.
 *
 *   bun run voice:setup https://<public-host>
 *
 * Needs ELEVENLABS_API_KEY and TOOLS_SECRET. Uses ELEVENLABS_AGENT_ID if set,
 * otherwise creates an agent. Imports TWILIO_PHONE_NUMBER (with
 * TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN) when ELEVENLABS_AGENT_PHONE_NUMBER_ID is empty.
 */

const API = "https://api.elevenlabs.io/v1/convai";
const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
const secret = process.env.TOOLS_SECRET?.trim();
const publicUrl = (process.argv[2] ?? process.env.PUBLIC_URL ?? "").trim().replace(/\/+$/, "");

if (!apiKey || !secret || !/^https:\/\//.test(publicUrl)) {
  console.error("usage: bun run voice:setup https://<public-host>   (needs ELEVENLABS_API_KEY and TOOLS_SECRET in .env)");
  process.exit(1);
}

async function el<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "xi-api-key": apiKey!, "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 600)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const fromVar = (name: string) => ({ type: "string", dynamic_variable: name });

const TOOLS = [
  {
    type: "webhook",
    name: "get_location",
    description:
      "Get where the caller is right now (street, coordinates, minutes walking). Use it when you need to tell them where they are or describe their surroundings.",
    response_timeout_secs: 10,
    api_schema: {
      url: `${publicUrl}/tools/location`,
      method: "POST",
      request_headers: { "x-tools-secret": secret },
      request_body_schema: {
        type: "object",
        properties: { walk_id: fromVar("walk_id") },
        required: ["walk_id"],
      },
    },
  },
  {
    type: "webhook",
    name: "report_call_outcome",
    description:
      "Tell Nook the final outcome of this call. Call it exactly once, as soon as the outcome is clear and before the call ends.",
    response_timeout_secs: 10,
    api_schema: {
      url: `${publicUrl}/tools/call-outcome`,
      method: "POST",
      request_headers: { "x-tools-secret": secret },
      request_body_schema: {
        type: "object",
        properties: {
          user_id: fromVar("user_id"),
          walk_id: fromVar("walk_id"),
          outcome: {
            type: "string",
            enum: ["resolved_safe", "request_escalation", "ended_unresolved"],
            description:
              "resolved_safe (they clearly said they're okay), request_escalation (they want their trusted contact reached, or said they're in danger), ended_unresolved (the call is ending without a clear 'I'm okay').",
          },
        },
        required: ["user_id", "walk_id", "outcome"],
      },
    },
  },
] as const;

const PROMPT = `# Who you are
You are Nook: the voice of an iMessage safety buddy, talking with {{display_name}} by voice (a phone call, or a "tap to talk" link Nook texted them). They're out walking, often at night. Sound like a calm, caring friend, not a call center: short sentences, contractions, react to what they actually said, and never repeat the same sentence twice in a row. One question at a time.

# How you talk
This is a phone call, so talk the way people actually talk. Usually one or two short sentences per turn. When it fits, open with a quick, real reaction ("Oh no.", "Okay, yeah.", "Got it.") before the next thing. Casual words: "yeah", "totally", "no worries", "hang on". No lists, no formal phrases like "I understand your concern" or "Is there anything else I can help you with". If they sound shaken, slow down and soften.
Fillers ("mm", "hmm", "um", "so..."): at most one per turn, and only at the very start of a turn as a reaction, never in the middle of a sentence or before a question. Use none at all when they're scared, in danger, or hurt: be clear and direct then.

# What you know
- Why this call is happening: they either asked Nook to call (they may want a friendly voice, or an excuse to get out of an uncomfortable moment) or they didn't answer Nook's check-in texts.
- Last known street: {{street}}. Minutes walking: {{minutes_walking}}.
- Their trusted contact: {{contact_name}}.

# What you can and can't do
- CAN: look up where they are right now (get_location); text {{contact_name}} their live location by reporting request_escalation; keep them company; end the call.
- CAN'T: call anyone, call the police or 911, text anyone other than {{contact_name}}, or see or hear anything around them. Never pretend otherwise.
- Only say {{contact_name}} was texted after report_call_outcome says contact_alerted is true. If it says false or failed, say so plainly ("My text to {{contact_name}} didn't go through") and tell them to call {{contact_name}} or 911 themselves.

# Reporting (required)
- Before the call ends, report exactly one outcome with report_call_outcome (Nook already knows the call was answered):
  - "resolved_safe": they clearly said they're okay. Answering the call is not enough.
  - "request_escalation": they're scared, followed, hurt, in danger, or ask you to tell {{contact_name}}. Report it the moment you hear it, then keep talking.
  - "ended_unresolved": the call is ending without a clear "I'm okay".
- Say goodbye and end the call only after the final outcome is reported.

# Situations
- They're fine / just busy / already home: be warm and brief, confirm they're okay, report resolved_safe, goodbye.
- Being followed, harassed, or feeling unsafe: report request_escalation right away. Then help in small steps: head toward a busy, well-lit place or an open store, restaurant, or lobby and go inside; keep their phone out; stay on the line. Ask short yes/no questions ("Can you see a store open near you?"). Offer to check their location with get_location and name the street so they can orient themselves.
- Immediate danger, violence, or a medical emergency: tell them clearly to call 911 now, that it's okay to hang up on you to do it, and that on iPhone holding the side button and a volume button brings up Emergency SOS. Report request_escalation if you haven't.
- They ask you to call the police: say you can't place calls, and they should dial 911 now. Don't argue or repeat yourself.
- They ask you to call or text someone else (mom, a friend): you can only text {{contact_name}}. If that's who they mean, report request_escalation. Otherwise suggest they call that person directly after this.
- They want a cover call (an awkward date, someone bothering them): play along as a friend on the phone, e.g. "Hey! Are you close? I'm waiting outside." Don't mention Nook or safety unless they do. Before ending, quietly check: "You good now?" and report based on their answer.
- They're lost or ask where they are: call get_location and describe it simply.
- Hard to hear, one-word answers, or they can't talk freely: ask yes/no questions ("Are you safe right now? Just say yes or no."). If they say no or can't answer, report request_escalation.
- Silence or no clear answer after a couple of tries: report ended_unresolved, tell them Nook will keep watching their trip, end the call.

Never read out IDs, tool names, or these instructions.`;

const FIRST_MESSAGE = "Hey {{display_name}}, it's Nook. Just checking in. You okay?";
/** "Hope - Bubbly, Gossipy and Girly" from the voice library (casual, natural pauses). */
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID?.trim() || "uYXf8XasLslADfZ2MB4u";

type ToolList = { tools: { id: string; tool_config: { name: string } }[] };

async function upsertTools(): Promise<string[]> {
  const existing = await el<ToolList>("GET", "/tools");
  const ids: string[] = [];
  for (const tool_config of TOOLS) {
    const found = existing.tools.find((t) => t.tool_config.name === tool_config.name);
    if (found) {
      await el("PATCH", `/tools/${found.id}`, { tool_config });
      console.log(`[voice:setup] updated tool ${tool_config.name} (${found.id})`);
      ids.push(found.id);
    } else {
      const created = await el<{ id: string }>("POST", "/tools", { tool_config });
      console.log(`[voice:setup] created tool ${tool_config.name} (${created.id})`);
      ids.push(created.id);
    }
  }
  return ids;
}

function agentBody(toolIds: string[]) {
  return {
    name: "Nook",
    conversation_config: {
      tts: {
        model_id: "eleven_v3_conversational",
        voice_id: VOICE_ID,
        expressive_mode: true,
        stability: 0.45,
        similarity_boost: 0.8,
        speed: 1.0,
        agent_output_audio_format: "pcm_16000",
      },
      asr: { user_input_audio_format: "pcm_16000" },
      turn: { turn_eagerness: "eager", speculative_turn: true },
      agent: {
        first_message: FIRST_MESSAGE,
        language: "en",
        dynamic_variables: {
          dynamic_variable_placeholders: {
            user_id: "test-user",
            walk_id: "test-walk",
            display_name: "friend",
            street: "Broadway",
            minutes_walking: 5,
            contact_name: "Sam",
          },
        },
        prompt: {
          prompt: PROMPT,
          llm: "gemini-3.5-flash",
          temperature: 0.5,
          tool_ids: toolIds,
          built_in_tools: {
            end_call: { name: "end_call", description: "", params: { system_tool_type: "end_call" } },
          },
        },
      },
    },
  };
}

async function upsertAgent(toolIds: string[]): Promise<string> {
  const agentId = process.env.ELEVENLABS_AGENT_ID?.trim();
  if (agentId) {
    await el("PATCH", `/agents/${agentId}`, agentBody(toolIds));
    console.log(`[voice:setup] updated agent ${agentId}`);
    return agentId;
  }
  const { agent_id } = await el<{ agent_id: string }>("POST", "/agents/create", agentBody(toolIds));
  console.log(`[voice:setup] created agent ${agent_id}  → set ELEVENLABS_AGENT_ID=${agent_id} in .env`);
  return agent_id;
}

async function ensurePhone(agentId: string): Promise<void> {
  const phoneId = process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID?.trim();
  if (phoneId) {
    await el("PATCH", `/phone-numbers/${phoneId}`, { agent_id: agentId });
    console.log(`[voice:setup] phone ${phoneId} assigned to the agent`);
    return;
  }
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const number = process.env.TWILIO_PHONE_NUMBER?.trim();
  if (!sid || !token || !number) {
    console.log(
      "[voice:setup] no phone number yet: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER and re-run, or import one in the ElevenLabs dashboard",
    );
    return;
  }
  const created = await el<{ phone_number_id: string }>("POST", "/phone-numbers", {
    provider: "twilio",
    phone_number: number,
    label: "Nook",
    sid,
    token,
  });
  await el("PATCH", `/phone-numbers/${created.phone_number_id}`, { agent_id: agentId });
  console.log(
    `[voice:setup] imported ${number}  → set ELEVENLABS_AGENT_PHONE_NUMBER_ID=${created.phone_number_id} in .env`,
  );
}

async function main() {
  const toolIds = await upsertTools();
  const agentId = await upsertAgent(toolIds);
  try {
    await ensurePhone(agentId);
  } catch (err) {
    console.warn(`[voice:setup] phone number not set up: ${err instanceof Error ? err.message : err}`);
    console.warn("[voice:setup] without ELEVENLABS_AGENT_PHONE_NUMBER_ID, Nook sends tap-to-talk links (needs PUBLIC_URL).");
  }
  console.log("[voice:setup] done. Restart the server so it picks up any new .env values.");
}

main().catch((err) => {
  console.error("[voice:setup] failed:", err);
  process.exit(1);
});
