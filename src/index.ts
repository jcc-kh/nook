import { SystemClock } from "./shared/clock.ts";
import { createBrain } from "./brain/index.ts";
import { createEchoBrain } from "./brain/stubEcho.ts";
import { createLocations } from "./locations/index.ts";
import { createInboundRouter } from "./messenger/onboarding.ts";
import { createSpectrumMessenger, type Provider } from "./messenger/spectrum.ts";
import { createUserStore } from "./store/index.ts";
import type { Brain, Event, LocationPing } from "./shared/types.ts";

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
  // Same store as onboarding so the brain sees trustedContact / emergencyCode / monitoringMode.
  brain = createBrain({ clock, getUser: (userId) => users.getById(userId) });
}

const messenger = await createSpectrumMessenger({
  provider,
  users,
  projectId,
  projectSecret,
});

async function dispatch(event: Event): Promise<void> {
  try {
    const actions = await brain.handle(event);
    for (const action of actions) {
      await messenger.execute(action);
    }
  } catch (err) {
    console.error(`[nook] failed handling ${event.type} for ${event.userId}`, err);
  }
}

let router: ReturnType<typeof createInboundRouter> | undefined;

async function onPing(ping: LocationPing): Promise<void> {
  console.log(
    `[locations] ${ping.userId} ${ping.lat.toFixed(5)},${ping.lon.toFixed(5)}`,
    ping.shortAddress ?? "",
  );
  await router?.onFix(ping.userId).catch((err) => console.error("[nook] onFix failed", err));
  await dispatch(ping);
}

const locations = await createLocations({
  users,
  clock,
  onPing,
  ...(provider === "imessage" && projectId && projectSecret
    ? { findMy: { projectId, projectSecret } }
    : {}),
});

router = createInboundRouter({ messenger, locations, users, clock, dispatch });
const { route } = router;

console.log(
  `[nook] ready  PROVIDER=${provider}  BRAIN_MODE=${brainMode}  PORT=${port}  DB=${process.env.DATABASE_URL ? "yes" : "no"}  GEMINI=${process.env.USE_GEMINI === "0" || !process.env.GEMINI_API_KEY ? "off" : "on"}`,
);

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
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
});

console.log(`[nook] HTTP listening on http://localhost:${server.port}`);

async function shutdown() {
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
