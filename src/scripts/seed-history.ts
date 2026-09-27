import { toCell } from "../shared/cell.ts";
import { closePool, query } from "../store/db.ts";
import { upsertDemoUser } from "../store/users.ts";
import { insertStop, upsertPlaceLabel } from "../store/walks.ts";
import { DEMO, DEMO_BODEGA, DEMO_FRIEND, DEMO_ORIGIN } from "../sim/demo.ts";

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

async function seedWalk(opts: {
  walkId: string;
  startedAt: Date;
  durationMin: number;
  viaBodega: boolean;
  viaFriend: boolean;
}) {
  const endedAt = new Date(opts.startedAt.getTime() + opts.durationMin * 60_000);
  const originCell = toCell(DEMO_ORIGIN.lat, DEMO_ORIGIN.lon);

  await query(
    `INSERT INTO walks (walk_id, user_id, trigger, started_at, ended_at, origin_cell,
      origin_lat, origin_lon, duration_s, status, expected_min, late_min)
     VALUES ($1,$2,'prompt',$3,$4,$5,$6,$7,$8,'ARRIVED',$9,$10)
     ON CONFLICT (walk_id) DO NOTHING`,
    [
      opts.walkId,
      DEMO.userId,
      opts.startedAt.toISOString(),
      endedAt.toISOString(),
      originCell,
      DEMO_ORIGIN.lat,
      DEMO_ORIGIN.lon,
      Math.round(opts.durationMin * 60),
      opts.durationMin,
      opts.durationMin + 5,
    ],
  );

  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    let lat = lerp(DEMO_ORIGIN.lat, DEMO.homeLat, t);
    let lon = lerp(DEMO_ORIGIN.lon, DEMO.homeLon, t);
    if (opts.viaBodega && t > 0.3 && t < 0.45) {
      lat = DEMO_BODEGA.lat;
      lon = DEMO_BODEGA.lon;
    }
    if (opts.viaFriend && t > 0.5 && t < 0.65) {
      lat = DEMO_FRIEND.lat;
      lon = DEMO_FRIEND.lon;
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
      [
        time.toISOString(),
        DEMO.userId,
        lat,
        lon,
        toCell(lat, lon),
        opts.walkId,
      ],
    );
  }

  if (opts.viaBodega) {
    const start = new Date(opts.startedAt.getTime() + 0.35 * opts.durationMin * 60_000);
    const end = new Date(start.getTime() + 8 * 60_000);
    await insertStop({
      userId: DEMO.userId,
      walkId: opts.walkId,
      startedAt: start,
      endedAt: end,
      lat: DEMO_BODEGA.lat,
      lon: DEMO_BODEGA.lon,
      cell: toCell(DEMO_BODEGA.lat, DEMO_BODEGA.lon),
      durationS: 8 * 60,
      outcome: "ok",
    });
  }
  if (opts.viaFriend) {
    const start = new Date(opts.startedAt.getTime() + 0.55 * opts.durationMin * 60_000);
    const end = new Date(start.getTime() + 12 * 60_000);
    await insertStop({
      userId: DEMO.userId,
      walkId: opts.walkId,
      startedAt: start,
      endedAt: end,
      lat: DEMO_FRIEND.lat,
      lon: DEMO_FRIEND.lon,
      cell: toCell(DEMO_FRIEND.lat, DEMO_FRIEND.lon),
      durationS: 12 * 60,
      outcome: "ok",
    });
  }
}

async function main() {
  await upsertDemoUser({ ...DEMO });

  await upsertPlaceLabel({
    userId: DEMO.userId,
    cell: toCell(DEMO_BODEGA.lat, DEMO_BODEGA.lon),
    lat: DEMO_BODEGA.lat,
    lon: DEMO_BODEGA.lon,
    label: DEMO_BODEGA.label,
    kind: DEMO_BODEGA.kind,
    okDwellMin: 12,
    source: "seed",
  });
  await upsertPlaceLabel({
    userId: DEMO.userId,
    cell: toCell(DEMO_FRIEND.lat, DEMO_FRIEND.lon),
    lat: DEMO_FRIEND.lat,
    lon: DEMO_FRIEND.lon,
    label: DEMO_FRIEND.label,
    kind: DEMO_FRIEND.kind,
    okDwellMin: 45,
    source: "seed",
  });

  const now = Date.now();
  for (let d = 14; d >= 1; d--) {
    const day = new Date(now - d * 24 * 60 * 60_000);
    day.setHours(22, 30, 0, 0);
    const viaBodega = d % 2 === 0;
    const viaFriend = d % 3 === 0;
    await seedWalk({
      walkId: `seed-walk-${d}`,
      startedAt: day,
      durationMin: 12 + (d % 5),
      viaBodega,
      viaFriend,
    });
  }

  const walks = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM walks WHERE user_id = $1 AND ended_at IS NOT NULL`,
    [DEMO.userId],
  );
  console.log("[seed:history] completed walks:", walks.rows[0]?.n);
  await closePool();
}

main().catch((err) => {
  console.error("[seed:history] failed:", err);
  process.exit(1);
});
