/**
 * Clears a user's onboarding (name, contact, monitoring, escalation, timing, home) so
 * their next text starts setup from the welcome. Walk / ping history is kept.
 * Restart the server afterwards so in-memory onboarding and brain state is dropped.
 *
 *   bun run user:reset +16465551234
 */
import { closePool, getPool } from "../store/db.ts";
import { toE164 } from "../messenger/parse.ts";

async function main() {
  const raw = process.argv[2];
  const handle = raw ? toE164(raw) ?? raw : undefined;
  if (!handle) {
    console.error("usage: bun run user:reset <phone>");
    process.exit(1);
  }
  const res = await getPool().query(
    `UPDATE users SET
       display_name = NULL, contact = NULL, trusted_name = NULL, monitoring_mode = NULL,
       escalation_on_no_response = NULL, nudge_after_sec = NULL,
       escalate_after_sec = NULL, no_update_min = NULL, home = NULL, onboarded_at = NULL
     WHERE handle = $1
     RETURNING user_id`,
    [handle],
  );
  if (res.rowCount === 0) console.error(`[user:reset] no user for ${handle}`);
  else console.log(`[user:reset] ${handle} (${res.rows[0].user_id}) cleared; restart the server, then text Nook`);
  await closePool();
}

main().catch((err) => {
  console.error("[user:reset] failed:", err);
  process.exit(1);
});
