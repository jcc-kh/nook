/**
 * One-shot smoke: feed a UserText through the selected brain and stub messenger.
 *   BRAIN_MODE=echo bun run smoke
 */
import { SystemClock } from "./shared/clock.ts";
import { createBrain } from "./brain/index.ts";
import { createEchoBrain } from "./brain/stubEcho.ts";
import { createMessenger } from "./messenger/index.ts";
import type { Brain, UserText } from "./shared/types.ts";

const brainMode = (process.env.BRAIN_MODE ?? "echo").toLowerCase();
const clock = new SystemClock();
const brain: Brain =
  brainMode === "echo" ? createEchoBrain() : createBrain({ clock });
const messenger = createMessenger();

const event: UserText = {
  type: "UserText",
  userId: "smoke-user",
  messageId: "smoke-msg-1",
  text: "hello nook",
  time: clock.now(),
};

const actions = await brain.handle(event);
console.log("[smoke] actions:", actions);

for (const action of actions) {
  const result = await messenger.execute(action);
  console.log("[smoke] execute result:", result);
}

if (brainMode === "echo" && actions.length !== 1) {
  console.error("[smoke] expected 1 action in echo mode");
  process.exit(1);
}

if (brainMode === "stub" && actions.length !== 0) {
  console.error("[smoke] expected 0 actions in stub mode");
  process.exit(1);
}

console.log("[smoke] ok");
