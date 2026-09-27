import { query } from "./db.ts";
import type { Destination, RouteChoice, SafetyState, WalkPhase, WalkPlan } from "../shared/types.ts";

export async function insertWalk(row: {
  walkId: string;
  userId: string;
  trigger: string;
  startedAt: Date;
  originCell?: string;
  originLat?: number;
  originLon?: number;
  status: WalkPhase;
  expectedMin?: number;
  lateMin?: number;
}): Promise<void> {
  await query(
    `INSERT INTO walks (
       walk_id, user_id, trigger, started_at, origin_cell, origin_lat, origin_lon,
       status, expected_min, late_min
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      row.walkId,
      row.userId,
      row.trigger,
      row.startedAt.toISOString(),
      row.originCell ?? null,
      row.originLat ?? null,
      row.originLon ?? null,
      row.status,
      row.expectedMin ?? null,
      row.lateMin ?? null,
    ],
  );
}

export async function updateWalkStatus(
  walkId: string,
  status: WalkPhase,
  endedAt?: Date,
): Promise<void> {
  if (endedAt) {
    await query(
      `UPDATE walks SET status = $2, ended_at = $3,
         duration_s = EXTRACT(EPOCH FROM ($3::timestamptz - started_at))::int
       WHERE walk_id = $1`,
      [walkId, status, endedAt.toISOString()],
    );
  } else {
    await query(`UPDATE walks SET status = $2 WHERE walk_id = $1`, [
      walkId,
      status,
    ]);
  }
}

/** Persisted safety fields on a walk. Keys present are written; null clears. */
export interface WalkSafetyPatch {
  safetyState?: SafetyState | null;
  routeChoice?: RouteChoice | null;
  destination?: Destination | null;
  interim?: Destination | null;
  expectedMin?: number;
  lateMin?: number;
}

export async function updateWalkSafety(walkId: string, patch: WalkSafetyPatch): Promise<void> {
  const cols: Record<string, unknown> = {};
  const has = (k: keyof WalkSafetyPatch) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("safetyState")) cols.safety_state = patch.safetyState ?? null;
  if (has("routeChoice")) cols.route_choice = patch.routeChoice ?? null;
  if (has("destination")) {
    cols.dest_name = patch.destination?.name ?? null;
    cols.dest_lat = patch.destination?.lat ?? null;
    cols.dest_lon = patch.destination?.lon ?? null;
    cols.dest_address = patch.destination?.address ?? null;
  }
  if (has("interim")) {
    cols.interim_name = patch.interim?.name ?? null;
    cols.interim_lat = patch.interim?.lat ?? null;
    cols.interim_lon = patch.interim?.lon ?? null;
  }
  if (has("expectedMin")) cols.expected_min = patch.expectedMin;
  if (has("lateMin")) cols.late_min = patch.lateMin;
  const entries = Object.entries(cols);
  if (entries.length === 0) return;
  const sets = entries.map(([c], i) => `${c} = $${i + 2}`).join(", ");
  await query(`UPDATE walks SET ${sets} WHERE walk_id = $1`, [walkId, ...entries.map(([, v]) => v)]);
}

export async function getOpenWalk(userId: string): Promise<{
  walkId: string;
  status: WalkPhase;
  startedAt: Date;
  trigger: string;
  originCell: string | null;
  originLat: number | null;
  originLon: number | null;
  expectedMin: number | null;
  lateMin: number | null;
  safetyState: SafetyState | null;
  routeChoice: RouteChoice | null;
  destination: Destination | null;
  interim: Destination | null;
} | null> {
  const res = await query<{
    walk_id: string;
    status: WalkPhase;
    started_at: Date;
    trigger: string;
    origin_cell: string | null;
    origin_lat: number | null;
    origin_lon: number | null;
    expected_min: number | null;
    late_min: number | null;
    safety_state?: string | null;
    route_choice?: string | null;
    dest_name?: string | null;
    dest_lat?: number | null;
    dest_lon?: number | null;
    dest_address?: string | null;
    interim_name?: string | null;
    interim_lat?: number | null;
    interim_lon?: number | null;
  }>(
    `SELECT * FROM walks WHERE user_id = $1 AND ended_at IS NULL
     ORDER BY started_at DESC LIMIT 1`,
    [userId],
  );
  const r = res.rows[0];
  if (!r) return null;
  const safety = r.safety_state;
  const choice = r.route_choice;
  return {
    walkId: r.walk_id,
    status: r.status,
    startedAt: new Date(r.started_at),
    trigger: r.trigger,
    originCell: r.origin_cell,
    originLat: r.origin_lat,
    originLon: r.origin_lon,
    expectedMin: r.expected_min,
    lateMin: r.late_min,
    safetyState: safety === "safe" || safety === "uneasy" || safety === "immediate_danger" ? safety : null,
    routeChoice: choice === "destination" || choice === "busier" ? choice : null,
    destination:
      r.dest_name && r.dest_lat != null && r.dest_lon != null
        ? {
            name: r.dest_name,
            lat: r.dest_lat,
            lon: r.dest_lon,
            ...(r.dest_address && { address: r.dest_address }),
            source: "stored",
          }
        : null,
    interim:
      r.interim_name && r.interim_lat != null && r.interim_lon != null
        ? { name: r.interim_name, lat: r.interim_lat, lon: r.interim_lon, source: "safe_place" }
        : null,
  };
}

export async function insertStop(row: {
  userId: string;
  walkId?: string;
  startedAt: Date;
  endedAt: Date;
  lat: number;
  lon: number;
  cell: string;
  durationS: number;
  outcome?: string;
}): Promise<void> {
  await query(
    `INSERT INTO stops (user_id, walk_id, started_at, ended_at, geom, cell, duration_s, outcome)
     VALUES (
       $1, $2, $3, $4,
       ST_SetSRID(ST_MakePoint($6, $5), 4326)::geography,
       $7, $8, $9
     )`,
    [
      row.userId,
      row.walkId ?? null,
      row.startedAt.toISOString(),
      row.endedAt.toISOString(),
      row.lat,
      row.lon,
      row.cell,
      row.durationS,
      row.outcome ?? null,
    ],
  );
}

export async function upsertPlaceLabel(row: {
  userId: string;
  cell: string;
  lat: number;
  lon: number;
  label?: string;
  kind?: string;
  okDwellMin?: number;
  source: string;
}): Promise<void> {
  await query(
    `INSERT INTO place_labels (user_id, cell, geom, label, kind, ok_dwell_min, source)
     VALUES (
       $1, $2,
       ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography,
       $5, $6, $7, $8
     )
     ON CONFLICT (user_id, cell) DO UPDATE SET
       label = COALESCE(EXCLUDED.label, place_labels.label),
       kind = COALESCE(EXCLUDED.kind, place_labels.kind),
       ok_dwell_min = COALESCE(EXCLUDED.ok_dwell_min, place_labels.ok_dwell_min),
       source = EXCLUDED.source,
       geom = EXCLUDED.geom`,
    [
      row.userId,
      row.cell,
      row.lat,
      row.lon,
      row.label ?? null,
      row.kind ?? null,
      row.okDwellMin ?? null,
      row.source,
    ],
  );
}

export async function loadWalkBaselines(
  userId: string,
  originCell: string,
): Promise<{ n: number; p50Min: number; p90Min: number } | null> {
  const res = await query<{ n: number; p50_min: number; p90_min: number }>(
    `SELECT n, p50_min, p90_min FROM walk_baselines
     WHERE user_id = $1 AND origin_cell = $2`,
    [userId, originCell],
  );
  const r = res.rows[0];
  if (!r) return null;
  return { n: r.n, p50Min: Number(r.p50_min), p90Min: Number(r.p90_min) };
}

export async function loadKnownStops(userId: string): Promise<
  {
    cell: string;
    visits: number;
    p90DwellMin: number | null;
    label: string | null;
    kind: string | null;
    okDwellMin: number | null;
  }[]
> {
  const res = await query<{
    cell: string;
    visits: number;
    p90_dwell_min: number | null;
    label: string | null;
    kind: string | null;
    ok_dwell_min: number | null;
  }>(
    `SELECT cell, visits, p90_dwell_min, label, kind, ok_dwell_min
     FROM known_stops WHERE user_id = $1`,
    [userId],
  );
  return res.rows.map((r) => ({
    cell: r.cell,
    visits: r.visits,
    p90DwellMin: r.p90_dwell_min != null ? Number(r.p90_dwell_min) : null,
    label: r.label,
    kind: r.kind,
    okDwellMin: r.ok_dwell_min,
  }));
}

export async function loadRouteCells(
  userId: string,
  originCell: string,
  limit = 5,
): Promise<string[]> {
  const walks = await query<{ walk_id: string }>(
    `SELECT walk_id FROM walks
     WHERE user_id = $1 AND origin_cell = $2 AND ended_at IS NOT NULL
     ORDER BY started_at DESC LIMIT $3`,
    [userId, originCell, limit],
  );
  if (walks.rows.length === 0) return [];
  const ids = walks.rows.map((w) => w.walk_id);
  const cells = await query<{ cell: string }>(
    `SELECT DISTINCT cell FROM location_pings
     WHERE user_id = $1 AND walk_id = ANY($2::text[])`,
    [userId, ids],
  );
  return cells.rows.map((c) => c.cell);
}

/**
 * Cells the user normally passes through: every ping cell from past walks that
 * ended at home (ARRIVED), plus cells they confirmed after an off-route check-in.
 * Walks that ended elsewhere or escalated don't define the usual route.
 */
export async function loadUsualCells(userId: string): Promise<{
  walkCount: number;
  confirmedCount: number;
  cells: string[];
}> {
  const counts = await query<{ walks: string; confirmed: string }>(
    `SELECT
       (SELECT count(*) FROM walks WHERE user_id = $1 AND status = 'ARRIVED')::text AS walks,
       (SELECT count(*) FROM confirmed_cells WHERE user_id = $1)::text AS confirmed`,
    [userId],
  );
  const cells = await query<{ cell: string }>(
    `SELECT DISTINCT p.cell
       FROM location_pings p
       JOIN walks w ON w.walk_id = p.walk_id
      WHERE p.user_id = $1 AND w.user_id = $1 AND w.status = 'ARRIVED'
     UNION
     SELECT cell FROM confirmed_cells WHERE user_id = $1`,
    [userId],
  );
  return {
    walkCount: Number(counts.rows[0]?.walks ?? 0),
    confirmedCount: Number(counts.rows[0]?.confirmed ?? 0),
    cells: cells.rows.map((c) => c.cell),
  };
}

export async function insertConfirmedCells(userId: string, cells: string[]): Promise<void> {
  if (cells.length === 0) return;
  await query(
    `INSERT INTO confirmed_cells (user_id, cell)
     SELECT $1, unnest($2::text[])
     ON CONFLICT (user_id, cell) DO NOTHING`,
    [userId, cells],
  );
}

/** Users with a walk still open in Tiger (used to resume timers after a restart). */
export async function listOpenWalkUserIds(): Promise<string[]> {
  const res = await query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM walks WHERE ended_at IS NULL`,
  );
  return res.rows.map((r) => r.user_id);
}

export function buildDefaultPlan(
  originLat: number,
  originLon: number,
  homeLat: number,
  homeLon: number,
  distFn: (a: number, b: number, c: number, d: number) => number,
): WalkPlan {
  const dist = distFn(originLat, originLon, homeLat, homeLon);
  const expectedMin = dist / 1.3 / 60;
  return {
    expectedMin,
    lateMin: expectedMin + 5,
    routeCells: [],
    bufferM: 150,
    stops: [],
  };
}
