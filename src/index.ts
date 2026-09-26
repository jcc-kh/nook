import { SystemClock } from "./shared/clock.ts";
import { createBrain } from "./brain/index.ts";
import { createEchoBrain } from "./brain/stubEcho.ts";
import { createMessenger } from "./messenger/index.ts";
import { createMemoryUserStore } from "./store/index.ts";
import type { Brain } from "./shared/types.ts";

const port = Number(process.env.PORT ?? 3000);
const brainMode = (process.env.BRAIN_MODE ?? "stub").toLowerCase();

const clock = new SystemClock();
const brain: Brain =
  brainMode === "echo" ? createEchoBrain() : createBrain({ clock });
const messenger = createMessenger();
const users = createMemoryUserStore();

console.log(
  `[nook] scaffold ready  PROVIDER=${process.env.PROVIDER ?? "terminal"}  BRAIN_MODE=${brainMode}  PORT=${port}`,
);

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, brainMode });
    }
    return new Response("nook scaffold — see CONTEXT.md / TEAM.md", {
      status: 404,
    });
  },
});

console.log(`[nook] HTTP listening on http://localhost:${server.port}`);

// Re-export for Person A/B wiring and smoke tests
export { brain, messenger, users, clock };
