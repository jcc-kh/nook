/**
 * What the brain did for one user, straight from Tiger.
 *
 *   bun run events:tail +13325550123            # last 30 min
 *   bun run events:tail +13325550123 --min 90
 *   bun run events:tail +13325550123 --follow   # keep printing new events
 */
import { closePool, query } from "../store/db.ts";
import { createTigerUserStore } from "../store/users.ts";
import { toE164 } from "../messenger/parse.ts";
import { resolveTimeouts } from "../shared/settings.ts";

const args = process.argv.slice(2);
const raw = args.find((a) => !a.startsWith("--")) ?? process.env.SIM_HANDLE;
const minIdx = args.indexOf("--min");
const minutes = minIdx >= 0 ? Number(args[minIdx + 1] ?? 30) : 30;
const follow = args.includes("--follow");

if (!raw) {
  console.log("usage: bun run events:tail <handle> [--min 30] [--follow]");
  process.exit(1);
}

const handle = toE164(raw) ?? raw;
const user = await createTigerUserStore().getByHandle(handle);
if (!user) {
  console.error(`no user with handle ${handle}`);
  await closePool();
  process.exit(1);
}

const tz = user.tz ?? "America/New_York";
const fmt = (d: Date) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);

type EventRow = { time: Date; walk_id: string | null; rule_id: string | null; detail: unknown };

function printEvents(rows: EventRow[]) {
  for (const r of rows) {
    const detail = JSON.stringify(r.detail);
    console.log(
      `${fmt(new Date(r.time))}  ${(r.rule_id ?? "-").padEnd(4)}  ${(r.walk_id ?? "").padEnd(13)}  ${detail === "{}" ? "" : detail}`,
    );
  }
}

async function summary() {
  const t = resolveTimeouts(user!.timeouts);
  console.log(
    `${user!.userId} ${handle}  monitoring=${user!.monitoringMode ?? "-"}  escalation=${user!.escalation?.onNoTextResponse ?? "-"}  timeouts=${t.nudgeAfterSec}s/${t.escalateAfterSec}s/${t.noUpdateMin}min  home=${user!.homeLat != null ? "saved" : "none"}`,
  );
  const walks = await query<{ walk_id: string; trigger: string; status: string; started_at: Date; ended_at: Date | null }>(
    `SELECT walk_id, trigger, status, started_at, ended_at FROM walks
     WHERE user_id = $1 AND (ended_at IS NULL OR started_at >= now() - ($2 || ' minutes')::interval)
     ORDER BY started_at DESC LIMIT 10`,
    [user!.userId, String(minutes)],
  );
  console.log("\nwalks:");
  if (walks.rows.length === 0) console.log("  (none)");
  for (const w of walks.rows) {
    const end = w.ended_at ? `ended ${fmt(new Date(w.ended_at))}` : "OPEN";
    console.log(`  ${w.walk_id}  ${w.trigger.padEnd(12)}  ${w.status.padEnd(15)}  started ${fmt(new Date(w.started_at))}  ${end}`);
  }
  const pings = await query<{ n: string; last: Date | null }>(
    `SELECT count(*)::text AS n, max(time) AS last FROM location_pings
     WHERE user_id = $1 AND time >= now() - ($2 || ' minutes')::interval`,
    [user!.userId, String(minutes)],
  );
  const cells = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM confirmed_cells WHERE user_id = $1`,
    [user!.userId],
  );
  const p = pings.rows[0];
  console.log(
    `\npings (last ${minutes} min): ${p?.n ?? 0}${p?.last ? `, latest ${fmt(new Date(p.last))}` : ""}   confirmed_cells: ${cells.rows[0]?.n ?? 0}`,
  );
}

await summary();
const initial = await query<EventRow>(
  `SELECT time, walk_id, rule_id, detail FROM events
   WHERE user_id = $1 AND time >= now() - ($2 || ' minutes')::interval
   ORDER BY time ASC`,
  [user.userId, String(minutes)],
);
console.log(`\nevents (last ${minutes} min):`);
if (initial.rows.length === 0) console.log("  (none)");
printEvents(initial.rows);

if (follow) {
  let since = initial.rows.length ? new Date(initial.rows[initial.rows.length - 1]!.time) : new Date();
  console.log("\nfollowing… (Ctrl-C to stop)");
  for (;;) {
    await Bun.sleep(3000);
    const res = await query<EventRow>(
      `SELECT time, walk_id, rule_id, detail FROM events
       WHERE user_id = $1 AND time > $2 ORDER BY time ASC`,
      [user.userId, since.toISOString()],
    );
    if (res.rows.length) {
      printEvents(res.rows);
      since = new Date(res.rows[res.rows.length - 1]!.time);
    }
  }
}

await closePool();
