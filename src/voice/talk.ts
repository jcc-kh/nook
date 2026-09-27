import type { CallOutcome, StartCall } from "../shared/types.ts";
import { callVariables, conversationToken, type VoiceConfig } from "./index.ts";

/**
 * "Tap to talk": instead of a phone call, the user gets a link to /talk/<token>
 * that opens a voice conversation with the same ElevenLabs agent in the browser.
 *
 * Opening the conversation counts as `started`. A link nobody taps within
 * UNANSWERED_MS, or a conversation that ends without a final outcome from the
 * agent, counts as `ended_unresolved`, same as an unanswered or dropped call.
 */

const UNANSWERED_MS = 3 * 60_000;
const LINK_TTL_MS = 30 * 60_000;
const ELEVENLABS_CLIENT = "https://esm.sh/@elevenlabs/client@1.25.0";

interface Link {
  userId: string;
  walkId: string;
  vars: Record<string, string | number>;
  createdAt: number;
  opened: boolean;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export interface TalkLinks {
  create(action: StartCall, contactName?: string): string;
  noteOutcome(walkId: string, outcome: CallOutcome): void;
  handle(req: Request, url: URL): Promise<Response>;
}

export function createTalkLinks(opts: {
  cfg: VoiceConfig & { publicUrl: string };
  report: (userId: string, walkId: string, outcome: CallOutcome) => Promise<void>;
}): TalkLinks {
  const { cfg, report } = opts;
  const links = new Map<string, Link>();

  function settle(token: string, link: Link, outcome: CallOutcome | null) {
    if (link.settled) return;
    link.settled = true;
    clearTimeout(link.timer);
    if (outcome) void report(link.userId, link.walkId, outcome);
  }

  function create(action: StartCall, contactName?: string): string {
    for (const [t, l] of links) {
      if (Date.now() - l.createdAt > LINK_TTL_MS) links.delete(t);
      else if (l.walkId === action.walkId) settle(t, l, null);
    }
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
    const link: Link = {
      userId: action.userId,
      walkId: action.walkId,
      vars: callVariables(action, contactName),
      createdAt: Date.now(),
      opened: false,
      settled: false,
      timer: setTimeout(() => {
        const l = links.get(token);
        if (l && !l.opened) {
          console.log(`[talk] link for ${l.userId} not opened in time`);
          settle(token, l, "ended_unresolved");
        }
      }, UNANSWERED_MS),
    };
    links.set(token, link);
    return `${cfg.publicUrl}/talk/${token}`;
  }

  function noteOutcome(walkId: string, outcome: CallOutcome) {
    if (outcome !== "resolved_safe" && outcome !== "ended_unresolved") return;
    for (const [t, l] of links) if (l.walkId === walkId) settle(t, l, null);
  }

  async function handle(req: Request, url: URL): Promise<Response> {
    const [, , token, step] = url.pathname.split("/");
    const link = token ? links.get(token) : undefined;
    const live = link && !link.settled && Date.now() - link.createdAt <= LINK_TTL_MS;

    if (!step && req.method === "GET") {
      return new Response(page(token ?? "", Boolean(live)), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (!link || !live) return Response.json({ ok: false, error: "this link has expired" }, { status: 410 });

    if (step === "session") {
      try {
        const conversation = await conversationToken(cfg);
        if (!link.opened) {
          link.opened = true;
          clearTimeout(link.timer);
          console.log(`[talk] ${link.userId} opened the talk link (walk ${link.walkId})`);
          void report(link.userId, link.walkId, "started");
        }
        return Response.json({ ok: true, conversationToken: conversation, dynamicVariables: link.vars });
      } catch (err) {
        console.error("[talk] could not start a conversation", err);
        return Response.json({ ok: false, error: "couldn't connect, try again" }, { status: 502 });
      }
    }
    if (step === "end") {
      console.log(`[talk] ${link.userId} left the conversation (walk ${link.walkId})`);
      settle(token!, link, "ended_unresolved");
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }

  return { create, noteOutcome, handle };
}

function page(token: string, live: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta property="og:title" content="Talk to Nook">
<meta property="og:description" content="Tap to start a voice check-in.">
<title>Talk to Nook</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 28px; font: 17px -apple-system, system-ui, sans-serif; background: #0e1020; color: #f2f2f7; text-align: center; padding: 24px; box-sizing: border-box; }
  h1 { font-size: 26px; margin: 0; font-weight: 600; }
  #status { color: #a1a1b5; min-height: 1.4em; }
  button { border: 0; border-radius: 999px; font: 600 19px -apple-system, system-ui, sans-serif; cursor: pointer; }
  #talk { width: 180px; height: 180px; background: #34c759; color: #fff; box-shadow: 0 0 0 0 rgba(52,199,89,.6); }
  #talk.live { background: #5e5ce6; animation: pulse 1.6s infinite; }
  #talk.speaking { animation-duration: .8s; }
  #talk:disabled { opacity: .5; }
  #end { padding: 14px 32px; background: #ff3b30; color: #fff; display: none; }
  @keyframes pulse { 70% { box-shadow: 0 0 0 28px rgba(94,92,230,0); } 100% { box-shadow: 0 0 0 0 rgba(94,92,230,0); } }
</style>
</head>
<body>
<h1>🌙 Nook</h1>
<button id="talk"${live ? "" : " disabled"}>${live ? "Tap to talk" : "Expired"}</button>
<div id="status">${live ? "Nook will ask how you're doing. Allow the microphone when asked." : "This link has expired. Text Nook 'call me' for a new one."}</div>
<button id="end">End</button>
<script type="module">
  const token = ${JSON.stringify(token)};
  const talk = document.getElementById("talk"), end = document.getElementById("end"), status = document.getElementById("status");
  let conversation = null, ended = false;
  const say = (t) => { status.textContent = t; };
  function finish(message) {
    if (ended) return;
    ended = true;
    navigator.sendBeacon("/talk/" + token + "/end");
    talk.className = ""; talk.textContent = "Done"; talk.disabled = true; end.style.display = "none";
    say(message);
  }
  talk.addEventListener("click", async () => {
    if (conversation || ended) return;
    talk.disabled = true; say("Connecting…");
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const { Conversation } = await import(${JSON.stringify(ELEVENLABS_CLIENT)});
      const res = await fetch("/talk/" + token + "/session", { method: "POST" });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error || "couldn't connect");
      conversation = await Conversation.startSession({
        conversationToken: body.conversationToken,
        connectionType: "webrtc",
        dynamicVariables: body.dynamicVariables,
        onConnect: () => { talk.className = "live"; talk.textContent = "Listening"; end.style.display = "inline-block"; say("You're talking to Nook."); },
        onModeChange: ({ mode }) => { talk.classList.toggle("speaking", mode === "speaking"); talk.textContent = mode === "speaking" ? "Nook" : "Listening"; },
        onDisconnect: () => finish("Call ended. Nook is still watching your trip."),
        onError: (e) => say("Connection problem: " + (e?.message || e)),
      });
    } catch (err) {
      conversation = null; talk.disabled = false;
      say((err && err.name === "NotAllowedError") ? "Nook needs the microphone. Allow it and tap again." : "Couldn't connect: " + (err?.message || err) + ". Tap to retry.");
    }
  });
  end.addEventListener("click", async () => { try { await conversation?.endSession(); } finally { finish("Call ended. Nook is still watching your trip."); } });
  addEventListener("pagehide", () => { if (conversation && !ended) finish(""); });
</script>
</body>
</html>`;
}
