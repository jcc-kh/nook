import { SystemClock } from "./shared/clock.ts";
import { createBrain } from "./brain/index.ts";
import { createEchoBrain } from "./brain/stubEcho.ts";
import { createLocations } from "./locations/index.ts";
import { copy } from "./messenger/copy.ts";
import { createInboundRouter } from "./messenger/onboarding.ts";
import { createSpectrumMessenger, type Provider } from "./messenger/spectrum.ts";
import { toE164 } from "./messenger/parse.ts";
import { createUserStore } from "./store/index.ts";
import { callMode, voiceConfigFromEnv } from "./voice/index.ts";
import { createVoiceNoteIngest } from "./voice/notes.ts";
import { phraseForVoice } from "./llm/phrase.ts";
import { nextGuidance } from "./voice/guidance.ts";
import { createTalkLinks } from "./voice/talk.ts";
import { transcriberFromEnv } from "./voice/transcribe.ts";
import { createVonageCalls, type BridgeSocket } from "./voice/vonage.ts";
import { createLiveSim, SCENARIOS, type ScenarioName } from "./sim/live.ts";
import { CALL_OUTCOMES, type Action, type Brain, type CallOutcome, type Event, type LocationPing } from "./shared/types.ts";

const port = Number(process.env.PORT ?? 3000);
const brainMode = (process.env.BRAIN_MODE ?? "live").toLowerCase();
const provider: Provider = process.env.PROVIDER === "imessage" ? "imessage" : "terminal";
const projectId = process.env.SPECTRUM_PROJECT_ID;
const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;

const clock = new SystemClock();
const users = createUserStore();

let brain: Brain;
if (brainMode === "echo") {
  brain = createEchoBrain();
} else if (brainMode === "stub") {
  const { createBrain: createStub } = await import("./brain/stubEmpty.ts");
  brain = createStub({ clock });
} else {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("BRAIN_MODE=live needs DATABASE_URL (Tiger). Use BRAIN_MODE=echo to test without a database.");
  }
  // Same store as onboarding so the brain sees trustedContact / escalation / monitoringMode.
  brain = createBrain({
    clock,
    getUser: (userId) => users.getById(userId),
    verbose: process.env.BRAIN_LOG !== "0",
  });
}

const voice = voiceConfigFromEnv();
const reportCall = (userId: string, walkId: string, outcome: CallOutcome) =>
  dispatch({ type: "CallEvent", userId, walkId, callType: outcome, time: clock.now() });
const talkLinks =
  voice?.publicUrl && callMode(voice) !== "phone"
    ? createTalkLinks({ cfg: { ...voice, publicUrl: voice.publicUrl }, report: reportCall })
    : undefined;
const vonageCalls =
  voice?.publicUrl && voice.vonage && callMode(voice) === "vonage"
    ? createVonageCalls({
        voice: { ...voice, publicUrl: voice.publicUrl },
        vonage: voice.vonage,
        report: reportCall,
        onFailed: async (action, contactName) => {
          if (!talkLinks) return reportCall(action.userId, action.walkId, "ended_unresolved");
          console.log(`[vonage] call to ${action.userId} couldn't be placed, sending a tap-to-talk link instead`);
          await messenger.sendToUser(action.userId, copy.talkLink(talkLinks.create(action, contactName)));
        },
      })
    : undefined;

const messenger = await createSpectrumMessenger({
  provider,
  users,
  projectId,
  projectSecret,
  ...(talkLinks && { talkLinks }),
  ...(vonageCalls && { vonageCalls }),
});

/** One failed action never drops the rest. A call that can't be placed counts as unresolved. */
async function runActions(actions: Action[]): Promise<void> {
  for (const action of actions) {
    try {
      if (action.type === "SendText") {
        console.log(`[nook] → user ${action.userId} [${action.tag}] ${action.text}`);
      } else if (action.type === "AlertContact") {
        console.log(
          `[nook] → trusted contact for ${action.userId}: ${action.text} @ ${action.lat.toFixed(5)},${action.lon.toFixed(5)}`,
        );
      } else if (action.type === "StartCall") {
        console.log(`[nook] → StartCall ${action.userId} walk=${action.walkId}`);
      }
      await messenger.execute(action);
      // Twilio calls give us no answer signal and the agent no longer reports "started".
      if (action.type === "StartCall" && callMode(voice) === "phone") {
        await reportCall(action.userId, action.walkId, "started");
      }
    } catch (err) {
      console.error(`[nook] ${action.type} failed`, err);
      // The brain answers ended_unresolved with a text check-in (never a contact alert).
      if (action.type === "StartCall") {
        await dispatch({
          type: "CallEvent",
          userId: action.userId,
          walkId: action.walkId,
          callType: "ended_unresolved",
          time: clock.now(),
        });
      }
    }
  }
}

async function dispatch(event: Event): Promise<void> {
  let actions: Action[];
  try {
    actions = await brain.handle(event);
  } catch (err) {
    console.error(`[nook] failed handling ${event.type} for ${event.userId}`, err);
    return;
  }
  await runActions(actions);
}

let router: ReturnType<typeof createInboundRouter> | undefined;

async function feedPing(ping: LocationPing): Promise<void> {
  console.log(
    `[locations] ${ping.userId} ${ping.lat.toFixed(5)},${ping.lon.toFixed(5)}`,
    ping.shortAddress ?? "",
  );
  await router?.onFix(ping.userId).catch((err) => console.error("[nook] onFix failed", err));
  await dispatch(ping);
}

const devSim = process.env.DEV_SIM === "1";
const sim = createLiveSim({ now: () => clock.now(), feed: feedPing, dispatch });

async function onPing(ping: LocationPing): Promise<void> {
  if (sim.isActive(ping.userId)) return;
  await feedPing(ping);
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function handleDevSim(req: Request, url: URL): Promise<Response> {
  if (req.method === "GET") return Response.json({ ok: true, running: sim.status() });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const body = (await req.json().catch(() => ({}))) as {
    handle?: string;
    scenario?: string;
    walk?: boolean;
  };
  const handle = body.handle ? toE164(body.handle) ?? body.handle : undefined;
  if (!handle) return Response.json({ ok: false, error: "handle required" }, { status: 400 });
  const user = await users.getByHandle(handle);
  if (!user) return Response.json({ ok: false, error: `no user for ${handle}` }, { status: 404 });

  if (url.pathname === "/dev/sim/stop") {
    const stopped = sim.stop(user.userId);
    // Synthetic positions must not linger (e.g. "away from home") once real pings resume.
    await brain.resetUser?.(user.userId);
    return Response.json({ ok: true, userId: user.userId, stopped, reset: Boolean(brain.resetUser) });
  }

  const scenario = body.scenario as ScenarioName | undefined;
  if (!scenario || !SCENARIOS.includes(scenario)) {
    return Response.json(
      { ok: false, error: `scenario must be one of: ${SCENARIOS.join(", ")}` },
      { status: 400 },
    );
  }
  if (user.homeLat == null || user.homeLon == null) {
    return Response.json({ ok: false, error: "user has no home saved (text HOME first)" }, { status: 400 });
  }
  sim.stop(user.userId);
  await brain.resetUser?.(user.userId);
  const started = sim.start(
    user.userId,
    { lat: user.homeLat, lon: user.homeLon },
    scenario,
    body.walk === undefined ? {} : { startWalk: body.walk },
  );
  return Response.json({ ok: true, userId: user.userId, ...started });
}

/** POST /dev/call {handle}: place a check-in call (or link) outside any walk, to test the voice path. */
async function handleDevCall(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const body = (await req.json().catch(() => ({}))) as { handle?: string };
  const handle = body.handle ? toE164(body.handle) ?? body.handle : undefined;
  const user = handle ? await users.getByHandle(handle) : null;
  if (!user) return Response.json({ ok: false, error: `no user for ${body.handle ?? "(missing handle)"}` }, { status: 404 });
  const walkId = `test-call-${Date.now()}`;
  await runActions([
    {
      type: "StartCall",
      userId: user.userId,
      walkId,
      vars: {
        displayName: user.displayName ?? "friend",
        street: "your street",
        minutesWalking: 0,
        walkId,
        callReason: "manual_call",
        safetyState: "safe",
      },
    },
  ]);
  return Response.json({ ok: true, userId: user.userId, walkId, mode: callMode(voice) });
}

/** Attach a spoken line. Gemini phrases the map facts; the fallback line is used if it drifts. */
async function withSay(data: unknown): Promise<unknown> {
  if (!data || typeof data !== "object") return data;
  const say = await phraseForVoice(data);
  return say ? { ...(data as Record<string, unknown>), say } : data;
}

/**
 * ElevenLabs agent webhook tools. Parameters may arrive flat or under
 * `parameters`; `user_id` / `walk_id` come from the call's dynamic variables.
 */
async function handleTool(req: Request, url: URL): Promise<Response> {
  const secret = process.env.TOOLS_SECRET?.trim();
  if (!secret || req.headers.get("x-tools-secret") !== secret) {
    return new Response("unauthorized", { status: 401 });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const params = (typeof raw.parameters === "object" && raw.parameters ? raw.parameters : raw) as Record<
    string,
    unknown
  >;
  const walkId = typeof params.walk_id === "string" ? params.walk_id : undefined;
  const userId = typeof params.user_id === "string" ? params.user_id : undefined;
  if (!walkId) return Response.json({ ok: false, error: "walk_id required" }, { status: 400 });

  if (url.pathname === "/tools/location") {
    const ctx = await brain.getLiveContext(walkId);
    if (!ctx) return Response.json({ ok: false, error: "no live location" }, { status: 404 });
    return Response.json({
      ...ctx,
      note: ctx.contextFresh
        ? undefined
        : `Location is ${Math.round(ctx.ageSec)} seconds old. Don't describe it as where they are right now.`,
    });
  }

  if (url.pathname === "/tools/safe-destinations") {
    const result = await brain.safeDestinations?.(walkId);
    return Response.json(await withSay(result ?? { ok: false, error: "navigation not available" }));
  }

  if (url.pathname === "/tools/set-destination") {
    const choice = typeof params.choice === "string" ? params.choice.trim() : "";
    if (!choice) return Response.json({ ok: false, error: "choice required (home, trip, or a place_id)" }, { status: 400 });
    const result = await brain.setDestination?.(walkId, choice);
    return Response.json(await withSay(result ?? { ok: false, error: "navigation not available" }));
  }

  if (url.pathname === "/tools/navigation") {
    const result = await brain.navigation?.(walkId);
    return Response.json(await withSay(result ?? { ok: false, error: "navigation not available" }));
  }

  if (url.pathname === "/tools/safe-place" || url.pathname === "/tools/guidance") {
    const ctx = await brain.getLiveContext(walkId);
    if (!ctx) {
      return Response.json({
        ok: false,
        status: "no_location",
        say: ["I don't have a fresh location yet. Take a few steps and I'll look again."],
      });
    }
    const refresh = params.refresh === true || params.refresh === "true";
    const guide = await nextGuidance(walkId, { lat: ctx.lat, lon: ctx.lon, headingDeg: ctx.headingDeg }, { refresh });
    console.log(
      `[voice] guidance for walk ${walkId}: ${guide.ok ? `${guide.status} ${guide.destination} — ${guide.instruction}` : guide.status}`,
    );
    return Response.json({ street: ctx.street, ...guide });
  }

  if (url.pathname === "/tools/call-outcome") {
    const outcome = params.outcome as CallOutcome | undefined;
    if (!outcome || !CALL_OUTCOMES.includes(outcome)) {
      return Response.json({ ok: false, error: `outcome must be one of: ${CALL_OUTCOMES.join(", ")}` }, { status: 400 });
    }
    if (!userId || !(await users.getById(userId))) {
      return Response.json({ ok: false, error: "unknown user_id" }, { status: 404 });
    }
    const situation =
      typeof params.situation === "string" && params.situation.trim()
        ? params.situation.trim().slice(0, 300)
        : undefined;
    console.log(`[voice] ${userId} walk ${walkId}: ${outcome}${situation ? ` (${situation})` : ""}`);
    talkLinks?.noteOutcome(walkId, outcome);
    vonageCalls?.noteOutcome(walkId, outcome);
    const before = Date.now();
    await dispatch({
      type: "CallEvent",
      userId,
      walkId,
      callType: outcome,
      time: clock.now(),
      ...(situation && { situation }),
    });
    const alert = messenger.lastContactAlert(userId);
    if (outcome !== "request_escalation") return Response.json({ ok: true });
    if (alert && alert.at >= before) {
      return Response.json({
        ok: true,
        contact_alerted: alert.ok,
        contact_name: alert.name ?? "their trusted contact",
        note: alert.ok
          ? "The trusted contact was just texted the caller's location and what they said. Keep telling them to call 911."
          : "The text to the trusted contact FAILED. Tell the caller honestly and have them call 911 or their contact themselves.",
      });
    }
    return Response.json({
      ok: true,
      contact_alerted: alert?.ok ?? false,
      note: alert?.ok
        ? "The trusted contact was already texted earlier in this trip."
        : "No text reached a trusted contact. Tell the caller honestly and have them call someone or 911 themselves.",
    });
  }

  return new Response("not found", { status: 404 });
}

const locations = await createLocations({
  users,
  clock,
  onPing,
  ...(provider === "imessage" && projectId && projectSecret
    ? { findMy: { projectId, projectSecret } }
    : {}),
});

const transcriber = transcriberFromEnv();
const ingestVoiceNote = createVoiceNoteIngest({ transcribe: transcriber, persist: brainMode === "live" });
router = createInboundRouter({ messenger, locations, users, clock, dispatch, ingestVoiceNote });
const { route } = router;

const TICK_MS = 30_000;
let ticking = false;
const ticker = setInterval(async () => {
  if (!brain.tick || ticking) return;
  ticking = true;
  try {
    await runActions(await brain.tick(clock.now()));
  } catch (err) {
    console.error("[nook] tick failed", err);
  } finally {
    ticking = false;
  }
}, TICK_MS);

console.log(
  `[nook] ready  PROVIDER=${provider}  BRAIN_MODE=${brainMode}  PORT=${port}  DB=${process.env.DATABASE_URL ? "yes" : "no"}  GEMINI=${process.env.USE_GEMINI === "0" || !process.env.GEMINI_API_KEY ? "off" : "on"}  CALLS=${callMode(voice)}  STT=${process.env.ELEVENLABS_API_KEY ? "on" : "off"}  DEV_SIM=${devSim ? "on" : "off"}`,
);

const server = Bun.serve<BridgeSocket["data"], never>({
  port,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (vonageCalls && url.pathname.startsWith("/vonage/ws/")) {
      const data = vonageCalls.upgradeData(url);
      if (!data) {
        console.log("[vonage] audio connection rejected");
        return new Response("not found", { status: 404 });
      }
      console.log("[vonage] audio connection opened");
      return srv.upgrade(req, { data }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (vonageCalls && url.pathname.startsWith("/vonage/event/")) return vonageCalls.handleEvent(req, url);
    if (devSim && url.pathname.startsWith("/dev/")) {
      if (!isLoopback(srv.requestIP(req)?.address)) {
        return new Response("forbidden", { status: 403 });
      }
      if (url.pathname === "/dev/call") return handleDevCall(req);
      if (url.pathname.startsWith("/dev/sim")) return handleDevSim(req, url);
    }
    if (url.pathname.startsWith("/tools/")) return handleTool(req, url);
    if (talkLinks && url.pathname.startsWith("/talk/")) return talkLinks.handle(req, url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        provider,
        brainMode,
        db: Boolean(process.env.DATABASE_URL),
        gemini: Boolean(process.env.GEMINI_API_KEY) && process.env.USE_GEMINI !== "0",
      });
    }
    return new Response("nook — see CONTEXT.md / TEAM.md", { status: 404 });
  },
  websocket: {
    open: (ws) => vonageCalls?.websocket.open(ws),
    message: (ws, message) => vonageCalls?.websocket.message(ws, message),
    close: (ws) => vonageCalls?.websocket.close(ws),
  },
});

console.log(`[nook] HTTP listening on http://localhost:${server.port}`);

async function shutdown() {
  clearInterval(ticker);
  await locations.stop();
  await messenger.stop();
  server.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Sequential so one user's onboarding answers can't race each other.
for await (const msg of messenger.inbound()) {
  try {
    await route(msg);
  } catch (err) {
    console.error("[nook] inbound route failed", err);
  }
}

export { brain, messenger, users, clock };
