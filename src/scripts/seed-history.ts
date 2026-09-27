/**
 * Seed 14 nights of past walks so baselines, known stops and the usual-route
 * cells (R6) have data.
 *
 *   bun run seed:history                     # demo user (demo-alex)
 *   bun run seed:history --handle +1332...   # a real onboarded user (needs HOME saved)
 *
 * For a real user the walks are laid out relative to their saved home, on the
 * same line `bun run sim:live` uses (from ~390 m south of home, straight home).
 */
import { toCell } from "../shared/cell.ts";
import { closePool, query } from "../store/db.ts";
import { createTigerUserStore, upsertDemoUser } from "../store/users.ts";
import { insertStop, upsertPlaceLabel } from "../store/walks.ts";
import { DEMO, DEMO_BODEGA, DEMO_FRIEND, DEMO_ORIGIN } from "../sim/demo.ts";
import { routineOrigin } from "../sim/live.ts";
import { toE164 } from "../messenger/parse.ts";

interface Place {
  lat: number;
  lon: number;
  label: string;
  kind: string;
}

interface Target {
  userId: string;
  home: { lat: number; lon: number };
  origin: { lat: number; lon: number };
  bodega: Place;
  /** Only the demo user gets a friend stop (it sits off the route). */
  friend?: Place;
  walkIdPrefix: string;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

async function seedWalk(
  target: Target,
  opts: {
    walkId: string;
    startedAt: Date;
    durationMin: number;
    viaBodega: boolean;
    viaFriend: boolean;
  },
) {
  const { origin, home, bodega, friend } = target;
  const endedAt = new Date(opts.startedAt.getTime() + opts.durationMin * 60_000);
  const originCell = toCell(origin.lat, origin.lon);

  const inserted = await query(
    `INSERT INTO walks (walk_id, user_id, trigger, started_at, ended_at, origin_cell,
      origin_lat, origin_lon, duration_s, status, expected_min, late_min)
     VALUES ($1,$2,'prompt',$3,$4,$5,$6,$7,$8,'ARRIVED',$9,$10)
     ON CONFLICT (walk_id) DO NOTHING`,
    [
      opts.walkId,
      target.userId,
      opts.startedAt.toISOString(),
      endedAt.toISOString(),
      originCell,
      origin.lat,
      origin.lon,
      Math.round(opts.durationMin * 60),
      opts.durationMin,
      opts.durationMin + 5,
    ],
  );
  // Re-running the seed shouldn't duplicate pings/stops for walks that already exist.
  if (inserted.rowCount === 0) return;

  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    let lat = lerp(origin.lat, home.lat, t);
    let lon = lerp(origin.lon, home.lon, t);
    if (opts.viaBodega && t > 0.3 && t < 0.45) {
      lat = bodega.lat;
      lon = bodega.lon;
    }
    if (friend && opts.viaFriend && t > 0.5 && t < 0.65) {
      lat = friend.lat;
      lon = friend.lon;
    }
    const time = new Date(
      opts.startedAt.getTime() + t * opts.durationMin * 60_000,
    );
    await query(
      `INSERT INTO location_pings (time, user_id, lat, lon, accuracy_m, geom, cell, walk_id)
       VALUES (
         $1, $2, $3, $4, 10,
         ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography,
         $5, $6
       )`,
      [time.toISOString(), target.userId, lat, lon, toCell(lat, lon), opts.walkId],
    );
  }

  if (opts.viaBodega) {
    const start = new Date(opts.startedAt.getTime() + 0.35 * opts.durationMin * 60_000);
    const end = new Date(start.getTime() + 8 * 60_000);
    await insertStop({
      userId: target.userId,
      walkId: opts.walkId,
      startedAt: start,
      endedAt: end,
      lat: bodega.lat,
      lon: bodega.lon,
      cell: toCell(bodega.lat, bodega.lon),
      durationS: 8 * 60,
      outcome: "ok",
    });
  }
  if (friend && opts.viaFriend) {
    const start = new Date(opts.startedAt.getTime() + 0.55 * opts.durationMin * 60_000);
    const end = new Date(start.getTime() + 12 * 60_000);
    await insertStop({
      userId: target.userId,
      walkId: opts.walkId,
      startedAt: start,
      endedAt: end,
      lat: friend.lat,
      lon: friend.lon,
      cell: toCell(friend.lat, friend.lon),
      durationS: 12 * 60,
      outcome: "ok",
    });
  }
}

async function demoTarget(): Promise<Target> {
  await upsertDemoUser({ ...DEMO });
  return {
    userId: DEMO.userId,
    home: { lat: DEMO.homeLat, lon: DEMO.homeLon },
    origin: DEMO_ORIGIN,
    bodega: DEMO_BODEGA,
    friend: DEMO_FRIEND,
    walkIdPrefix: "seed-walk",
  };
}

async function handleTarget(raw: string): Promise<Target> {
  const handle = toE164(raw) ?? raw;
  const user = await createTigerUserStore().getByHandle(handle);
  if (!user) throw new Error(`no user with handle ${handle} (onboard first)`);
  if (user.homeLat == null || user.homeLon == null) {
    throw new Error(`${handle} has no home saved (text HOME first)`);
  }
  const home = { lat: user.homeLat, lon: user.homeLon };
  const origin = routineOrigin(home);
  return {
    userId: user.userId,
    home,
    origin,
    bodega: {
      lat: lerp(origin.lat, home.lat, 0.4),
      lon: lerp(origin.lon, home.lon, 0.4),
      label: "corner bodega",
      kind: "bodega",
    },
    walkIdPrefix: `seed-${user.userId}`,
  };
}

async function main() {
  const i = process.argv.indexOf("--handle");
  const target = i >= 0 ? await handleTarget(process.argv[i + 1] ?? "") : await demoTarget();

  const places = [target.bodega, ...(target.friend ? [target.friend] : [])];
  for (const place of places) {
    await upsertPlaceLabel({
      userId: target.userId,
      cell: toCell(place.lat, place.lon),
      lat: place.lat,
      lon: place.lon,
      label: place.label,
      kind: place.kind,
      okDwellMin: place.kind === "friend" ? 45 : 12,
      source: "seed",
    });
  }

  const now = Date.now();
  for (let d = 14; d >= 1; d--) {
    const day = new Date(now - d * 24 * 60 * 60_000);
    day.setHours(22, 30, 0, 0);
    await seedWalk(target, {
      walkId: `${target.walkIdPrefix}-${d}`,
      startedAt: day,
      durationMin: 12 + (d % 5),
      viaBodega: d % 2 === 0,
      viaFriend: d % 3 === 0,
    });
  }

  const walks = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM walks WHERE user_id = $1 AND ended_at IS NOT NULL`,
    [target.userId],
  );
  console.log(`[seed:history] ${target.userId} completed walks:`, walks.rows[0]?.n);
  await closePool();
}

main().catch(async (err) => {
  console.error("[seed:history] failed:", err instanceof Error ? err.message : err);
  await closePool().catch(() => {});
  process.exit(1);
});
