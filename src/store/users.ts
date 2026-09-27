import { toCell } from "../shared/cell.ts";
import type { LocationPing, RuleId } from "../shared/types.ts";
import { query } from "./db.ts";
import type { UserRecord, UserStore } from "./types.ts";

export type { UserRecord, UserStore } from "./types.ts";

type UserRow = {
  user_id: string;
  handle: string;
  contact: string | null;
  codeword: string | null;
  home_lat: number | null;
  home_lon: number | null;
  night_start: string;
  night_end: string;
  tz: string;
  display_name: string | null;
};

function rowToUser(r: UserRow): UserRecord {
  return {
    userId: r.user_id,
    handle: r.handle,
    contact: r.contact ?? undefined,
    codeword: r.codeword ?? undefined,
    homeLat: r.home_lat ?? undefined,
    homeLon: r.home_lon ?? undefined,
    nightStart: String(r.night_start).slice(0, 5),
    nightEnd: String(r.night_end).slice(0, 5),
    tz: r.tz,
    displayName: r.display_name ?? undefined,
  };
}

const USER_SELECT = `
  SELECT user_id, handle, contact, codeword,
    ST_Y(home::geometry) AS home_lat,
    ST_X(home::geometry) AS home_lon,
    night_start::text, night_end::text, tz, display_name
  FROM users
`;

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

    async setContact(userId: string, contactE164: string): Promise<void> {
      const res = await query(`UPDATE users SET contact = $2 WHERE user_id = $1`, [
        userId,
        contactE164,
      ]);
      if (res.rowCount === 0) throw new Error(`unknown user ${userId}`);
    },

    async setCodeword(userId: string, codeword: string): Promise<void> {
      const res = await query(`UPDATE users SET codeword = $2 WHERE user_id = $1`, [
        userId,
        codeword,
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
  codeword: string;
  homeLat: number;
  homeLon: number;
  nightStart?: string;
  nightEnd?: string;
  tz?: string;
  displayName?: string;
}): Promise<void> {
  await query(
    `INSERT INTO users (user_id, handle, contact, codeword, home, night_start, night_end, tz, display_name)
     VALUES (
       $1, $2, $3, $4,
       ST_SetSRID(ST_MakePoint($6, $5), 4326)::geography,
       $7::time, $8::time, $9, $10
     )
     ON CONFLICT (user_id) DO UPDATE SET
       handle = EXCLUDED.handle,
       contact = EXCLUDED.contact,
       codeword = EXCLUDED.codeword,
       home = EXCLUDED.home,
       night_start = EXCLUDED.night_start,
       night_end = EXCLUDED.night_end,
       tz = EXCLUDED.tz,
       display_name = EXCLUDED.display_name`,
    [
      user.userId,
      user.handle,
      user.contact,
      user.codeword,
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
