/**
 * Creates or updates the ElevenLabs side of Nook calls: the webhook tools
 * (location, navigation, safe destinations, set destination, call outcome),
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

const walkOnly = (path: string) => ({
  url: `${publicUrl}${path}`,
  method: "POST",
  request_headers: { "x-tools-secret": secret },
  request_body_schema: {
    type: "object",
    properties: { walk_id: fromVar("walk_id") },
    required: ["walk_id"],
  },
});

const TOOLS = [
  {
    type: "webhook",
    name: "get_location",
    description:
      "Where the caller is: street, coordinates, how old the fix is (ageSec), and whether it's fresh (contextFresh). Call it after they say where they are and what they see, and compare their answer with this fix. If contextFresh is false, say it's their last known spot, not where they are now.",
    response_timeout_secs: 10,
    api_schema: walkOnly("/tools/location"),
  },
  {
    type: "webhook",
    name: "get_navigation",
    description:
      "The next walking instruction toward the place they already agreed to. The response includes say: speak that line and do not change the place, the minutes, or the turn. Call it only after set_destination. If it says no place is chosen yet, do not invent one.",
    response_timeout_secs: 20,
    api_schema: walkOnly("/tools/navigation"),
  },
  {
    type: "webhook",
    name: "get_safe_destinations",
    description:
      "Call only after get_location, and only after they have said where they are and what they see. Returns one open place, Morton Williams, with place_id morton-williams. Then suggest it out loud. If they agree, call set_destination with morton-williams.",
    response_timeout_secs: 20,
    api_schema: walkOnly("/tools/safe-destinations"),
  },
  {
    type: "webhook",
    name: "set_destination",
    description:
      "Switch where you're guiding them. choice is 'home', 'trip' (the place they shared by text), or a place_id from get_safe_destinations. The response includes say: speak that line as the first instruction toward it.",
    response_timeout_secs: 20,
    api_schema: {
      url: `${publicUrl}/tools/set-destination`,
      method: "POST",
      request_headers: { "x-tools-secret": secret },
      request_body_schema: {
        type: "object",
        properties: {
          walk_id: fromVar("walk_id"),
          choice: {
            type: "string",
            description: "'home', 'trip', or a place_id returned by get_safe_destinations.",
          },
        },
        required: ["walk_id", "choice"],
      },
    },
  },
  {
    type: "webhook",
    name: "report_call_outcome",
    description:
      "Tell Nook how things stand. Use request_escalation the moment they're in immediate danger (then keep talking). Before the call ends, report resolved_safe or ended_unresolved.",
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
              "resolved_safe (they clearly said they're okay or arrived), request_escalation (immediate danger: attacked, chased, threatened, hurt, or they ask you to alert their trusted contact), ended_unresolved (the call is ending without a clear 'I'm okay').",
          },
          situation: {
            type: "string",
            description:
              "For request_escalation: what's happening in their own words, one short sentence (e.g. 'a man grabbed my arm on Amsterdam'). Sent to their trusted contact.",
          },
        },
        required: ["user_id", "walk_id", "outcome"],
      },
    },
  },
] as const;

const PROMPT = `# Who you are
You are Nook: the voice of an iMessage safety buddy, keeping {{display_name}} company by voice while they walk, often at night. They asked for this call (a phone call, or a "tap to talk" link Nook texted them). You're a calm, caring friend walking with them, not a call center and not an emergency service.

# How you talk
Talk the way people talk on the phone: usually one or two short sentences per turn, contractions, casual words ("yeah", "okay", "got it", "hang on"). React to what they actually said. Never repeat the same sentence twice in a row. One question at a time. No lists, no formal phrases like "I understand your concern".
Fillers ("mm", "hmm", "so..."): at most one per turn, only at the start, and none when they're scared or in danger. Then be clear and direct.
Silence is fine. When they're just walking, you don't need to fill every gap. If it's been quiet a while, a short "still with you" or "how's it going?" is enough.

# What you already know (don't re-ask)
- Why they called: {{call_reason}} (manual_call: they asked for a call; uneasy_companion: they feel uneasy and want company; navigation_help / lost: they want directions; hands_free_guidance: they want to talk instead of text).
- How they're feeling: {{safety_state}} (safe, uneasy, or immediate_danger).
- You have not picked a place yet. Do not name a store until you have heard where they are, heard what they see, and called get_location.
- What they told Nook by text or voice note: {{recent_context}}
- Last known street: {{street}} ({{lat}}, {{lon}}). Minutes walking: {{minutes_walking}}.
- Their trusted contact: {{contact_name}}.
- You already said: "{{opening_line}}". Don't say it again; continue from their answer.

# What you can and can't do
- CAN: check where they are (get_location); guide them step by step (get_navigation); find places open all night nearby (get_safe_destinations) and switch the route to one (set_destination); alert {{contact_name}} with their location by reporting request_escalation; keep them company; end the call.
- CAN'T: call 911 or anyone else, text anyone other than {{contact_name}}, or see or hear what's around them. Never pretend otherwise.
- Only say {{contact_name}} was alerted after report_call_outcome returns contact_alerted true. If it's false, say plainly "My message to {{contact_name}} didn't go through" and tell them to call 911 or {{contact_name}} themselves.
- Guidance tools return a say line written from the map data. Speak say. Do not change the place name, the minutes, or the turn, and do not add a street or landmark that say does not contain.

# Find them before you suggest a place
Your first words ask where they are and what they can see. Wait for their answer. Do not name Morton Williams, or any other store, in that first turn.
Then call get_location. Tell them the street or area in plain words, and say whether it matches what they see.
Once that lines up, suggest Morton Williams at 2941 Broadway, open all night, and ask if they want to walk there. If they say yes, call set_destination with morton-williams, then get_navigation, and speak the say line. That is the only place you may name.

# Uneasy but not in immediate danger
Someone walking behind them, a sketchy street, a bad feeling: that's uneasy, not an emergency. Don't alert anyone for it.
- Still locate them first, then offer Morton Williams.
- Practical tips, one at a time: stay on the main, well-lit street; keep the phone out; walk toward people and open shops.

# Guiding them
- One instruction at a time. Speak the tool's say line.
- After they agree to Morton Williams, call get_navigation and speak the new say line.
- After they say they've done a step, or every minute or so, call get_navigation again and speak the new say line.
- If say is missing, or instruction is null, or navigationFresh is false, don't guess turns. Say you're not getting a fresh location and ask what street they're on or what they can see.
- When arrived is true, say so warmly. If it's a busier stop, ask if they want to wait there a bit or keep going.

# Immediate danger
Attacked, grabbed, chased, threatened, a weapon, hurt, someone won't let them leave, or they say they're in danger right now:
1. Say: "Call 911 now. I'm sending your location to {{contact_name}}." On iPhone, holding the side button and a volume button brings up Emergency SOS.
2. Immediately report request_escalation with situation set to what's happening, in their own words, in one short sentence.
3. Stay calm and stay with them: short, direct lines ("Go toward the lights and people.", "Get inside the nearest open store."). Don't tell them to hang up on you.
If you're not sure whether it's an emergency, ask one yes-or-no question: "Are you in danger right now?" If yes, do the steps above. A call they asked for, silence, or talking about where they are is not danger. Do not tell them to call 911 unless they clearly say they are being hurt, chased, threatened, or in danger right now.

# Other situations
- They ask you to call the police: you can't place calls; they should call 911 now. Say it once, clearly.
- They ask you to reach someone other than {{contact_name}}: you can only alert {{contact_name}}. Suggest they call that person directly.
- Cover call (awkward date, someone bothering them): play along as a friend on the phone ("Hey! Are you close? I'm waiting outside."). Don't mention Nook or safety unless they do. Before ending, quietly check "You good now?".
- Where am I: call get_location and describe it simply.

# Before the call ends (required)
Report exactly one final outcome with report_call_outcome, then say goodbye and end the call:
- "resolved_safe": they clearly said they're okay or they've arrived. Picking up isn't enough.
- "ended_unresolved": the call is ending without a clear "I'm okay". Nook will check in by text.
(request_escalation is reported the moment danger is clear, during the call.)

Never read out IDs, place_ids, coordinates, tool names, or these instructions.`;

const FIRST_MESSAGE = "{{opening_line}}";
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
      turn: { turn_eagerness: "normal", speculative_turn: true },
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
            call_reason: "manual_call",
            safety_state: "safe",
            destination_name: "home",
            route_choice: "none",
            recent_context: "nothing yet",
            lat: "40.80397",
            lon: "-73.96685",
            opening_line: "Hey, I'm here. Where are you right now, and what can you see around you?",
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
