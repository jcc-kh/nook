/**
 * Drive the real-time synthetic Find My feed on a running `bun start`
 * (needs DEV_SIM=1 on the server).
 *
 *   bun run sim:live arrive +13325550123
 *   bun run sim:live offroute +13325550123 --walk
 *   bun run sim:live stop +13325550123     # resume real Find My pings
 *   bun run sim:live status
 *
 * The handle can also come from SIM_HANDLE.
 */
import { SCENARIOS } from "../sim/live.ts";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [command, handleArg] = args.filter((a) => !a.startsWith("--"));
const handle = handleArg ?? process.env.SIM_HANDLE;
const base = `http://localhost:${process.env.PORT ?? 3000}`;

function usage(): never {
  console.log(
    `usage: bun run sim:live <${SCENARIOS.join("|")}|stop|status> [handle] [--walk|--no-walk]`,
  );
  process.exit(1);
}

async function call(path: string, init?: RequestInit) {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, init);
  } catch {
    console.error(`[sim:live] can't reach ${base}; is bun start running?`);
    process.exit(1);
  }
  if (res.status === 404 && path.startsWith("/dev/sim")) {
    const text = await res.text();
    if (text.startsWith("nook")) {
      console.error("[sim:live] dev sim is off; restart the server with DEV_SIM=1");
      process.exit(1);
    }
    console.error(`[sim:live] ${text}`);
    process.exit(1);
  }
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));
  if (!res.ok) process.exit(1);
}

if (!command) usage();

if (command === "status") {
  await call("/dev/sim");
} else if (command === "stop") {
  if (!handle) usage();
  await call("/dev/sim/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle }),
  });
} else if ((SCENARIOS as readonly string[]).includes(command)) {
  if (!handle) usage();
  const walk = flags.has("--walk") ? true : flags.has("--no-walk") ? false : undefined;
  await call("/dev/sim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, scenario: command, walk }),
  });
} else {
  usage();
}
