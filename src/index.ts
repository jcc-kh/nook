import { SystemClock } from "./shared/clock.ts";
import { createBrain } from "./brain/index.ts";
import { createEchoBrain } from "./brain/stubEcho.ts";
import { createMessenger } from "./messenger/index.ts";
import { createUserStore } from "./store/index.ts";
import type { Brain } from "./shared/types.ts";

const port = Number(process.env.PORT ?? 3000);
const brainMode = (process.env.BRAIN_MODE ?? "stub").toLowerCase();

const clock = new SystemClock();
const users = createUserStore();

let brain: Brain;
if (brainMode === "echo") {
  brain = createEchoBrain();
} else if (brainMode === "stub") {
  // Empty log-only brain (hour-0). Use BRAIN_MODE=live for real rules.
  const { createBrain: createStub } = await import("./brain/stubEmpty.ts");
  brain = createStub({ clock });
} else {
  brain = createBrain({ clock });
}

const messenger = createMessenger();

console.log(
  `[nook] ready  PROVIDER=${process.env.PROVIDER ?? "terminal"}  BRAIN_MODE=${brainMode}  PORT=${port}  DB=${process.env.DATABASE_URL ? "yes" : "no"}`,
);

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        brainMode,
        db: Boolean(process.env.DATABASE_URL),
      });
    }
    return new Response("nook — see CONTEXT.md / TEAM.md", { status: 404 });
  },
});

console.log(`[nook] HTTP listening on http://localhost:${server.port}`);

export { brain, messenger, users, clock };
