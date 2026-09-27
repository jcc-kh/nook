import { toCell } from "../shared/cell.ts";
import type { LocationPing, RuleId } from "../shared/types.ts";
import { normalizeNoResponseAction, type CheckinTimeouts, type MonitoringMode } from "../shared/settings.ts";
import { query } from "./db.ts";
import type { UserPatch, UserRecord, UserStore } from "./types.ts";

export type { UserPatch, UserRecord, UserStore } from "./types.ts";

type UserRow = {
  user_id: string;
  handle: string;
  contact: string | null;
  home_lat: number | null;
  home_lon: number | null;
  night_start: string;
  night_end: string;
  tz: string;
  display_name: string | null;
  trusted_name: string | null;
  monitoring_mode: string | null;
  escalation_on_no_response: string | null;
  nudge_after_sec: number | null;
  escalate_after_sec: number | null;
  no_update_min: number | null;
  onboarded_at: Date | null;
};

function rowToUser(r: UserRow): UserRecord {
  const onNoTextResponse = normalizeNoResponseAction(r.escalation_on_no_response);
  const timeouts: CheckinTimeouts = {
    ...(r.nudge_after_sec != null ? { nudgeAfterSec: r.nudge_after_sec } : {}),
    ...(r.escalate_after_sec != null ? { escalateAfterSec: r.escalate_after_sec } : {}),
    ...(r.no_update_min != null ? { noUpdateMin: r.no_update_min } : {}),
  };
  return {
    userId: r.user_id,
    handle: r.handle,
    contact: r.contact ?? undefined,
    homeLat: r.home_lat ?? undefined,
    homeLon: r.home_lon ?? undefined,
    nightStart: String(r.night_start).slice(0, 5),
    nightEnd: String(r.night_end).slice(0, 5),
    tz: r.tz,
    displayName: r.display_name ?? undefined,
    onboardedAt: r.onboarded_at ? new Date(r.onboarded_at) : undefined,
    trustedContact: r.contact
      ? { phone: r.contact, ...(r.trusted_name ? { name: r.trusted_name } : {}) }
      : undefined,
    monitoringMode: (r.monitoring_mode as MonitoringMode | null) ?? undefined,
    escalation: onNoTextResponse ? { initialAction: "TEXT_USER", onNoTextResponse } : undefined,
    timeouts: Object.keys(timeouts).length ? timeouts : undefined,
  };
}

const USER_SELECT = `
  SELECT user_id, handle, contact,
    ST_Y(home::geometry) AS home_lat,
    ST_X(home::geometry) AS home_lon,
    night_start::text, night_end::text, tz, display_name,
    trusted_name, monitoring_mode, escalation_on_no_response,
    nudge_after_sec, escalate_after_sec, no_update_min, onboarded_at
  FROM users
`;

/** Column values for the keys present in `patch` (present-but-undefined clears). */
function patchColumns(patch: UserPatch): Record<string, unknown> {
  const has = (k: keyof UserPatch) => Object.prototype.hasOwnProperty.call(patch, k);
  const cols: Record<string, unknown> = {};
  if (has("displayName")) cols.display_name = patch.displayName ?? null;
  if (has("trustedContact")) {
    cols.contact = patch.trustedContact?.phone ?? null;
    cols.trusted_name = patch.trustedContact?.name ?? null;
  }
  if (has("monitoringMode")) cols.monitoring_mode = patch.monitoringMode ?? null;
  if (has("escalation")) {
    cols.escalation_on_no_response = patch.escalation?.onNoTextResponse ?? null;
  }
  if (has("timeouts")) {
    cols.nudge_after_sec = patch.timeouts?.nudgeAfterSec ?? null;
    cols.escalate_after_sec = patch.timeouts?.escalateAfterSec ?? null;
    cols.no_update_min = patch.timeouts?.noUpdateMin ?? null;
  }
  if (has("onboardedAt")) cols.onboarded_at = patch.onboardedAt?.toISOString() ?? null;
  // Raw column, when given explicitly, wins over trustedContact above.
  if (has("contact")) cols.contact = patch.contact ?? null;
  return cols;
}

export function createTigerUserStore(): UserStore {
  return {
    async upsertUser(handle: string): Promise<UserRecord> {
      const existing = await query<UserRow>(`${USER_SELECT} WHERE handle = $1`, [
        handle,
      ]);
      if (existing.rows[0]) return rowToUser(existing.rows[0]);

      const userId = `user-${crypto.randomUUID().slice(0, 8)}`;
      await query(
        `INSERT INTO users (user_id, handle, night_start, night_end, tz)
         VALUES ($1, $2, '22:00', '06:00', 'America/New_York')`,
        [userId, handle],
      );
      const created = await query<UserRow>(`${USER_SELECT} WHERE user_id = $1`, [
        userId,
      ]);
      return rowToUser(created.rows[0]!);
    },

    async updateUser(userId: string, patch: UserPatch): Promise<void> {
      const cols = Object.entries(patchColumns(patch));
      if (cols.length === 0) return;
      const sets = cols.map(([col], i) => `${col} = $${i + 2}`).join(", ");
      const res = await query(`UPDATE users SET ${sets} WHERE user_id = $1`, [
        userId,
        ...cols.map(([, v]) => v),
      ]);
      if (res.rowCount === 0) throw new Error(`unknown user ${userId}`);
    },

    async setContact(userId: string, contactE164: string): Promise<void> {
      const res = await query(`UPDATE users SET contact = $2 WHERE user_id = $1`, [
        userId,
        contactE164,
      ]);
      if (res.rowCount === 0) throw new Error(`unknown user ${userId}`);
    },

    async setHome(userId: string, lat: number, lon: number): Promise<void> {
      const res = await query(
        `UPDATE users SET home = ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography
         WHERE user_id = $1`,
        [userId, lat, lon],
      );
      if (res.rowCount === 0) throw new Error(`unknown user ${userId}`);
    },

    async getByHandle(handle: string): Promise<UserRecord | null> {
      const res = await query<UserRow>(`${USER_SELECT} WHERE handle = $1`, [
        handle,
      ]);
      return res.rows[0] ? rowToUser(res.rows[0]) : null;
    },

    async getById(userId: string): Promise<UserRecord | null> {
      const res = await query<UserRow>(`${USER_SELECT} WHERE user_id = $1`, [
        userId,
      ]);
      return res.rows[0] ? rowToUser(res.rows[0]) : null;
    },
  };
}

/** Upsert a fully specified demo user (seed scripts). */
export async function upsertDemoUser(user: {
  userId: string;
  handle: string;
  contact: string;
  homeLat: number;
  homeLon: number;
  nightStart?: string;
  nightEnd?: string;
  tz?: string;
  displayName?: string;
}): Promise<void> {
  await query(
    `INSERT INTO users (user_id, handle, contact, home, night_start, night_end, tz, display_name)
     VALUES (
       $1, $2, $3,
       ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography,
       $6::time, $7::time, $8, $9
     )
     ON CONFLICT (user_id) DO UPDATE SET
       handle = EXCLUDED.handle,
       contact = EXCLUDED.contact,
       home = EXCLUDED.home,
       night_start = EXCLUDED.night_start,
       night_end = EXCLUDED.night_end,
       tz = EXCLUDED.tz,
       display_name = EXCLUDED.display_name`,
    [
      user.userId,
      user.handle,
      user.contact,
      user.homeLat,
      user.homeLon,
      user.nightStart ?? "22:00",
      user.nightEnd ?? "06:00",
      user.tz ?? "America/New_York",
      user.displayName ?? "Alex",
    ],
  );
}

export async function insertLocationPing(
  ping: LocationPing,
  walkId?: string | null,
): Promise<void> {
  const cell = toCell(ping.lat, ping.lon);
  await query(
    `INSERT INTO location_pings (time, user_id, lat, lon, accuracy_m, geom, cell, walk_id, short_address)
     VALUES (
       $1, $2, $3, $4, $5,
       ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography,
       $6, $7, $8
     )`,
    [
      ping.time.toISOString(),
      ping.userId,
      ping.lat,
      ping.lon,
      ping.accuracyM ?? null,
      cell,
      walkId ?? null,
      ping.shortAddress ?? null,
    ],
  );
}

export async function insertEvent(opts: {
  time: Date;
  userId: string;
  walkId?: string | null;
  type?: string;
  ruleId?: RuleId | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO events (time, user_id, walk_id, type, rule_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      opts.time.toISOString(),
      opts.userId,
      opts.walkId ?? null,
      opts.type ?? "rule_fired",
      opts.ruleId ?? null,
      JSON.stringify(opts.detail ?? {}),
    ],
  );
}

export async function countPings(userId: string): Promise<number> {
  const res = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM location_pings WHERE user_id = $1`,
    [userId],
  );
  return Number(res.rows[0]?.n ?? 0);
}

export async function loadRecentPings(
  userId: string,
  since: Date,
): Promise<LocationPing[]> {
  const res = await query<{
    time: Date;
    user_id: string;
    lat: number;
    lon: number;
    accuracy_m: number | null;
    short_address: string | null;
  }>(
    `SELECT time, user_id, lat, lon, accuracy_m, short_address
     FROM location_pings
     WHERE user_id = $1 AND time >= $2
     ORDER BY time ASC`,
    [userId, since.toISOString()],
  );
  return res.rows.map((r) => ({
    type: "LocationPing" as const,
    userId: r.user_id,
    time: new Date(r.time),
    lat: r.lat,
    lon: r.lon,
    accuracyM: r.accuracy_m ?? undefined,
    shortAddress: r.short_address ?? undefined,
  }));
}
