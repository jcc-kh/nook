/**
 * Seed home + usual midtown corridor for live test user +16463220667.
 * Home = James A. Farley / ZIP 10000 placeholder (40.74754, -73.98336).
 * Usual route stays midtown so Morningside live pings look unfamiliar.
 */
import { toCell } from "../shared/cell.ts";
import { closePool, query } from "../store/db.ts";

const USER_ID = "user-f16234ba";
const HOME = { lat: 40.74754, lon: -73.98336 };
/** ~350 m south of home — typical walk start. */
const ORIGIN = { lat: 40.7445, lon: -73.98336 };

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

async function seedWalk(walkId: string, dayOffset: number, lonJitter: number) {
  const startedAt = new Date(Date.UTC(2026, 8, 10 + dayOffset, 2, 30, 0));
  const durationMin = 12;
  const endedAt = new Date(startedAt.getTime() + durationMin * 60_000);
  const originLat = ORIGIN.lat;
  const originLon = ORIGIN.lon + lonJitter;
  const homeLon = HOME.lon + lonJitter;
  const originCell = toCell(originLat, originLon);

  await query(
    `INSERT INTO walks (walk_id, user_id, trigger, started_at, ended_at, origin_cell,
      origin_lat, origin_lon, duration_s, status, expected_min, late_min)
     VALUES ($1,$2,'prompt',$3,$4,$5,$6,$7,$8,'ARRIVED',$9,$10)
     ON CONFLICT (walk_id) DO NOTHING`,
    [
      walkId,
      USER_ID,
      startedAt.toISOString(),
      endedAt.toISOString(),
      originCell,
      originLat,
      originLon,
      Math.round(durationMin * 60),
      durationMin,
      durationMin + 5,
    ],
  );

  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const lat = lerp(originLat, HOME.lat, t);
    const lon = lerp(originLon, homeLon, t);
    const time = new Date(startedAt.getTime() + t * durationMin * 60_000);
    await query(
      `INSERT INTO location_pings (time, user_id, lat, lon, accuracy_m, geom, cell, walk_id)
       VALUES (
         $1, $2, $3, $4, 10,
         ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography,
         $5, $6
       )`,
      [time.toISOString(), USER_ID, lat, lon, toCell(lat, lon), walkId],
    );
  }
}

async function main() {
  const user = await query(`SELECT user_id FROM users WHERE user_id = $1`, [USER_ID]);
  if (!user.rows[0]) {
    throw new Error(`user ${USER_ID} not found — onboard +16463220667 first`);
  }

  await query(
    `UPDATE users SET home = ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography
     WHERE user_id = $1`,
    [USER_ID, HOME.lat, HOME.lon],
  );
  console.log(`[seed] home → ${HOME.lat},${HOME.lon}`);

  for (let i = 0; i < 3; i++) {
    const walkId = `seed-f162-${i + 1}`;
    await seedWalk(walkId, i * 2, (i - 1) * 0.001);
    console.log(`[seed] walk ${walkId}`);
  }

  const cells = await query<{ n: string }>(
    `SELECT count(DISTINCT lp.cell)::text AS n
     FROM location_pings lp
     JOIN walks w ON w.walk_id = lp.walk_id
     WHERE lp.user_id = $1 AND w.walk_id LIKE 'seed-f162-%'`,
    [USER_ID],
  );
  console.log(`[seed] familiar cells: ${cells.rows[0]?.n ?? 0}`);
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
