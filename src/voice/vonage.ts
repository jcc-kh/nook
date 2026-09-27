import { createSign, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ServerWebSocket } from "bun";
import type { CallOutcome, StartCall } from "../shared/types.ts";
import { callVariables, type VoiceConfig } from "./index.ts";

/**
 * Phone calls through the Vonage Voice API, bridged to the ElevenLabs agent.
 *
 * Vonage dials the user and streams the call audio over a WebSocket to
 * /vonage/ws/<token>; we relay it to the agent's conversation WebSocket and
 * play the agent's audio back. Both sides speak 16 kHz 16-bit PCM
 * (`pcm_16000` on the agent, `audio/l16;rate=16000` on Vonage), so no
 * resampling. Vonage call status arrives at /vonage/event/<token>.
 *
 * A trial Vonage account can only call the number it was registered with, and
 * uses the test caller ID 123456789.
 */

const VONAGE_API = "https://api.nexmo.com/v1/calls";
const ELEVEN_API = "https://api.elevenlabs.io/v1/convai";
/** 20 ms of 16 kHz 16-bit mono audio: the frame size Vonage expects. */
const FRAME_BYTES = 640;
const SESSION_TTL_MS = 30 * 60_000;
const NOT_ANSWERED = new Set(["busy", "timeout", "unanswered", "cancelled", "machine"]);
/** Vonage itself refused the call (e.g. a trial account calling an unregistered number). */
const NOT_PLACED = new Set(["failed", "rejected"]);

export interface VonageConfig {
  applicationId: string;
  privateKey: string;
  /** Caller ID; trial accounts must use "123456789". */
  from: string;
}

export function vonageConfigFromEnv(): VonageConfig | null {
  const applicationId = process.env.VONAGE_APPLICATION_ID?.trim();
  const inline = process.env.VONAGE_PRIVATE_KEY?.trim().replace(/\\n/g, "\n");
  const path = process.env.VONAGE_PRIVATE_KEY_PATH?.trim();
  if (!applicationId || (!inline && !path)) return null;
  const privateKey = inline || readFileSync(path!, "utf8");
  const from = (process.env.VONAGE_FROM_NUMBER?.trim() || "123456789").replace(/^\+/, "");
  return { applicationId, privateKey, from };
}

interface Session {
  userId: string;
  walkId: string;
  vars: Record<string, string | number>;
  action: StartCall;
  contactName?: string;
  createdAt: number;
  answered: boolean;
  settled: boolean;
}

interface Bridge {
  token: string;
  agent?: WebSocket;
  /** Caller audio that arrived before the agent socket opened. */
  pending: string[];
  closed: boolean;
}

export type BridgeSocket = ServerWebSocket<{ bridge: Bridge }>;

export interface VonageCalls {
  /** Throws if Vonage rejects the call so the caller can fall back. */
  start(action: StartCall, toNumber: string, contactName?: string): Promise<void>;
  noteOutcome(walkId: string, outcome: CallOutcome): void;
  /** Vonage call status webhooks. */
  handleEvent(req: Request, url: URL): Promise<Response>;
  /** Returns the WebSocket upgrade data for /vonage/ws/<token>, or null if the token is unknown. */
  upgradeData(url: URL): { bridge: Bridge } | null;
  websocket: {
    open(ws: BridgeSocket): void;
    message(ws: BridgeSocket, message: string | Buffer): void;
    close(ws: BridgeSocket): void;
  };
}

export function createVonageCalls(opts: {
  voice: VoiceConfig & { publicUrl: string };
  vonage: VonageConfig;
  report: (userId: string, walkId: string, outcome: CallOutcome) => Promise<void>;
  /** A call Vonage couldn't place at all (not a missed call): offer another way to talk. */
  onFailed: (action: StartCall, contactName?: string) => Promise<void>;
}): VonageCalls {
  const { voice, vonage, report, onFailed } = opts;
  const sessions = new Map<string, Session>();

  function settle(session: Session, outcome: CallOutcome | null) {
    if (session.settled) return;
    session.settled = true;
    if (outcome) void report(session.userId, session.walkId, outcome);
  }

  function jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
      application_id: vonage.applicationId,
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
    })}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(vonage.privateKey).toString("base64url");
    return `${unsigned}.${signature}`;
  }

  async function start(action: StartCall, toNumber: string, contactName?: string): Promise<void> {
    for (const [t, s] of sessions) {
      if (Date.now() - s.createdAt > SESSION_TTL_MS) sessions.delete(t);
      else if (s.walkId === action.walkId) settle(s, null);
    }
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
    const wss = voice.publicUrl.replace(/^http/, "ws");
    const res = await fetch(VONAGE_API, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt()}`, "content-type": "application/json" },
      body: JSON.stringify({
        to: [{ type: "phone", number: toNumber.replace(/^\+/, "") }],
        from: { type: "phone", number: vonage.from },
        ncco: [
          {
            action: "connect",
            endpoint: [
              { type: "websocket", uri: `${wss}/vonage/ws/${token}`, "content-type": "audio/l16;rate=16000" },
            ],
          },
        ],
        event_url: [`${voice.publicUrl}/vonage/event/${token}`],
        ringing_timer: 45,
        machine_detection: "hangup",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { uuid?: string; title?: string; detail?: string };
    if (!res.ok) {
      throw new Error(`Vonage call failed (${res.status}): ${body.title ?? ""} ${body.detail ?? res.statusText}`.trim());
    }
    sessions.set(token, {
      userId: action.userId,
      walkId: action.walkId,
      vars: callVariables(action, contactName),
      action,
      ...(contactName && { contactName }),
      createdAt: Date.now(),
      answered: false,
      settled: false,
    });
    console.log(`[vonage] calling ${toNumber} (walk ${action.walkId}, call ${body.uuid ?? "?"})`);
  }

  function noteOutcome(walkId: string, outcome: CallOutcome) {
    if (outcome !== "resolved_safe" && outcome !== "ended_unresolved") return;
    for (const s of sessions.values()) if (s.walkId === walkId) settle(s, null);
  }

  async function handleEvent(req: Request, url: URL): Promise<Response> {
    const token = url.pathname.split("/")[3];
    const session = token ? sessions.get(token) : undefined;
    const event = (await req.json().catch(() => ({}))) as { status?: string; detail?: string };
    if (!session || !event.status) return Response.json({ ok: true });
    console.log(`[vonage] ${session.userId} call ${event.status}${event.detail ? ` (${event.detail})` : ""}`);
    if (event.status === "answered") session.answered = true;
    else if (NOT_PLACED.has(event.status) && !session.answered && !session.settled) {
      session.settled = true;
      await onFailed(session.action, session.contactName).catch((err) =>
        console.error("[vonage] fallback after failed call also failed", err),
      );
    } else if (NOT_ANSWERED.has(event.status) || event.status === "completed") {
      settle(session, "ended_unresolved");
    }
    return Response.json({ ok: true });
  }

  function upgradeData(url: URL): { bridge: Bridge } | null {
    const token = url.pathname.split("/")[3];
    const session = token ? sessions.get(token) : undefined;
    if (!token || !session || session.settled) return null;
    return { bridge: { token, pending: [], closed: false } };
  }

  async function signedUrl(): Promise<string> {
    const res = await fetch(`${ELEVEN_API}/conversation/get-signed-url?agent_id=${encodeURIComponent(voice.agentId)}`, {
      headers: { "xi-api-key": voice.apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { signed_url?: string };
    if (!res.ok || !body.signed_url) throw new Error(`ElevenLabs signed URL failed (${res.status})`);
    return body.signed_url;
  }

  function sendAudio(ws: BridgeSocket, base64: string) {
    const pcm = Buffer.from(base64, "base64");
    for (let i = 0; i < pcm.length; i += FRAME_BYTES) {
      const frame = pcm.subarray(i, i + FRAME_BYTES);
      ws.sendBinary(frame.length === FRAME_BYTES ? frame : Buffer.concat([frame, Buffer.alloc(FRAME_BYTES - frame.length)]));
    }
  }

  function close(ws: BridgeSocket) {
    const { bridge } = ws.data;
    if (bridge.closed) return;
    bridge.closed = true;
    bridge.agent?.close();
    try {
      ws.close();
    } catch {}
  }

  const websocket: VonageCalls["websocket"] = {
    open(ws) {
      const { bridge } = ws.data;
      const session = sessions.get(bridge.token);
      if (!session) return close(ws);
      signedUrl()
        .then((signed) => {
          if (bridge.closed) return;
          const agent = new WebSocket(signed);
          bridge.agent = agent;
          agent.onopen = () => {
            agent.send(JSON.stringify({ type: "conversation_initiation_client_data", dynamic_variables: session.vars }));
            for (const chunk of bridge.pending.splice(0)) agent.send(JSON.stringify({ user_audio_chunk: chunk }));
          };
          agent.onmessage = (e) => {
            const msg = JSON.parse(String(e.data)) as {
              type?: string;
              audio_event?: { audio_base_64?: string };
              ping_event?: { event_id: number };
            };
            if (msg.type === "audio" && msg.audio_event?.audio_base_64) sendAudio(ws, msg.audio_event.audio_base_64);
            else if (msg.type === "interruption") ws.sendText(JSON.stringify({ action: "clear" }));
            else if (msg.type === "ping" && msg.ping_event) {
              agent.send(JSON.stringify({ type: "pong", event_id: msg.ping_event.event_id }));
            }
          };
          agent.onclose = () => close(ws);
          agent.onerror = (err) => {
            console.error("[vonage] agent socket error", err);
            close(ws);
          };
        })
        .catch((err) => {
          console.error("[vonage] could not connect the call to the agent", err);
          close(ws);
        });
    },
    message(ws, message) {
      if (typeof message === "string") return;
      const chunk = Buffer.from(message).toString("base64");
      const { agent, pending } = ws.data.bridge;
      if (agent?.readyState === WebSocket.OPEN) agent.send(JSON.stringify({ user_audio_chunk: chunk }));
      else if (pending.length < 250) pending.push(chunk);
    },
    close,
  };

  return { start, noteOutcome, handleEvent, upgradeData, websocket };
}
