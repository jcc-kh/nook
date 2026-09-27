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
      "Tell Nook how this call is going. Call it with 'started' as soon as the caller answers, then exactly once more with the final outcome before the call ends.",
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
            description:
              "One of: started (they answered), resolved_safe (they clearly said they're okay), request_escalation (they want their trusted contact reached, or said they're in danger), ended_unresolved (the call is ending without a clear 'I'm okay').",
          },
        },
        required: ["user_id", "walk_id", "outcome"],
      },
    },
  },
] as const;

const PROMPT = `You are Nook, a calm, warm friend on the phone with {{display_name}}, who is walking somewhere, often at night. Nook is an iMessage safety buddy; you're its voice.

Why you're calling: either they asked Nook to call them (they may want a friendly voice, or a "call" to get out of an uncomfortable situation), or they didn't answer Nook's check-in texts. Last known street: {{street}}. Minutes walking: {{minutes_walking}}.

How to run the call:
1. Right after the caller first speaks, call report_call_outcome with outcome "started". Do this once.
2. Keep it short and natural, like a friend. Ask if they're okay. If they seem to want a cover story, play along as a friend checking when they'll arrive.
3. If they want to know where they are, call get_location and describe it simply.
4. Decide the outcome and call report_call_outcome exactly once more:
   - "resolved_safe" only when they clearly say they're okay and don't need anything. Picking up is not enough.
   - "request_escalation" if they ask you to contact their trusted person, say someone is following or bothering them, sound scared, or say they're in danger. Tell them you're texting their trusted contact now with their location, and stay on the line.
   - "ended_unresolved" if the call is ending and you never got a clear "I'm okay" (silence, confusion, they hang up mid-sentence).
5. Only after reporting the final outcome, say goodbye and end the call.

Never say you are contacting police or emergency services. If they ask for emergency services, tell them to call 911 directly. Never read out IDs or tool names.`;

const FIRST_MESSAGE = "Hey {{display_name}}, it's Nook. Just checking in on you. Are you okay?";

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
          },
        },
        prompt: {
          prompt: PROMPT,
          llm: "gemini-2.5-flash",
          temperature: 0.3,
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
  await ensurePhone(agentId);
  console.log("[voice:setup] done. Restart the server so it picks up any new .env values.");
}

main().catch((err) => {
  console.error("[voice:setup] failed:", err);
  process.exit(1);
});
