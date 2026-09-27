/**
 * Deterministic demo-recording scenes. Each step mocks only the inputs
 * (past walks, location pings, their timestamps) and lets the real brain and
 * messenger produce everything the user sees.
 *
 * Route: familiar walks run down Broadway from W 116th St (Columbia) to home at
 * W 108th St, with a usual corner-store stop at W 112th St. The unfamiliar
 * stop is W 131st St & 12th Ave.
 */
import type { DemoHooks } from "../brain/engine.ts";
import { toCell } from "../shared/cell.ts";
import type { Action, Event, LocationPing } from "../shared/types.ts";
import { query } from "../store/db.ts";
import { insertStop, upsertPlaceLabel } from "../store/walks.ts";

type Point = { lat: number; lon: number };

const HOME: Point = { lat: 40.80327, lon: -73.96781 };
const COLUMBIA: Point = { lat: 40.80831, lon: -73.96413 };
const CORNER_STORE: Point = { lat: 40.8058, lon: -73.96597 };
const UNFAMILIAR_APPROACH: Point = { lat: 40.8181, lon: -73.9606 };
const UNFAMILIAR_STOP: Point = { lat: 40.819, lon: -73.96 };

const SEED_PREFIX = "demo-seed-";
const SEED_NIGHTS = 14;
/** After a scene, stop further check-ins so nothing unscripted reaches the phone between takes. */
const HUSH_AFTER_MS = 4 * 60_000;
const FAMILIAR_HUSH_AFTER_MS = 2 * 60_000;

export const DEMO_STEPS = [
  "setup",
  "restore",
  "reset",
  "start-walk",
  "familiar-stop",
  "safe-arrival",
  "unfamiliar-stop",
  "danger-prep",
  "notify-contact",
  "status",
] as const;
export type DemoStep = (typeof DEMO_STEPS)[number];

export interface DemoDeps {
  hooks: DemoHooks;
  dispatch: (event: Event) => Promise<void>;
  tick: (now: Date) => Promise<Action[]>;
  runActions: (actions: Action[]) => Promise<void>;
  forgetOnboarding: (userId: string) => void;
  resetOther: (userId: string) => Promise<void>;
  getPhase: (userId: string) => string;
}

function lerp(a: Point, b: Point, t: number): Point {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

/** Street label along the Broadway leg, W 116th (t=0) to W 108th (t=1). */
function broadwayAt(t: number): string {
  return `Broadway & W ${Math.round(116 - 8 * t)}th St`;
}

function ago(now: Date, sec: number): Date {
  return new Date(now.getTime() - sec * 1000);
}

export function createDemo(deps: DemoDeps) {
  const held = new Set<string>();
  const hushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const log = (...args: unknown[]) => console.log("[demo]", ...args);

  function holds(userId: string): boolean {
    return held.has(userId);
  }

  function armHush(userId: string, afterMs: number) {
    clearTimeout(hushTimers.get(userId));
    hushTimers.set(
      userId,
      setTimeout(() => {
        hushTimers.delete(userId);
        void deps.hooks.hush(userId, new Date(Date.now() + 2 * 60 * 60_000));
        log(`hushed ${userId}`);
      }, afterMs),
    );
  }

  async function ping(userId: string, time: Date, p: Point, shortAddress: string) {
    const event: LocationPing = { type: "LocationPing", userId, time, lat: p.lat, lon: p.lon, accuracyM: 8, shortAddress };
    await deps.dispatch(event);
  }

  /** Leave only the seeded history, so every take starts from the same place. */
  async function wipeTakes(userId: string) {
    await query(`DELETE FROM stops WHERE user_id = $1 AND (walk_id IS NULL OR walk_id NOT LIKE $2)`, [userId, `${SEED_PREFIX}%`]);
    await query(`DELETE FROM location_pings WHERE user_id = $1 AND (walk_id IS NULL OR walk_id NOT LIKE $2)`, [userId, `${SEED_PREFIX}%`]);
    await query(`DELETE FROM walks WHERE user_id = $1 AND walk_id NOT LIKE $2`, [userId, `${SEED_PREFIX}%`]);
    await query(`DELETE FROM place_labels WHERE user_id = $1 AND source <> 'seed'`, [userId]);
    await query(`DELETE FROM confirmed_cells WHERE user_id = $1`, [userId]);
  }

  async function reset(userId: string) {
    clearTimeout(hushTimers.get(userId));
    hushTimers.delete(userId);
    held.add(userId);
    await deps.hooks.reset(userId);
    await wipeTakes(userId);
  }

  async function seedHistory(userId: string) {
    await query(`DELETE FROM stops WHERE user_id = $1`, [userId]);
    await query(`DELETE FROM location_pings WHERE user_id = $1`, [userId]);
    await query(`DELETE FROM walks WHERE user_id = $1`, [userId]);
    await query(`DELETE FROM place_labels WHERE user_id = $1`, [userId]);
    await query(`DELETE FROM confirmed_cells WHERE user_id = $1`, [userId]);

    const storeCell = toCell(CORNER_STORE.lat, CORNER_STORE.lon);
    await upsertPlaceLabel({
      userId,
      cell: storeCell,
      ...CORNER_STORE,
      label: "corner store",
      kind: "bodega",
      okDwellMin: 12,
      source: "seed",
    });

    for (let d = SEED_NIGHTS; d >= 1; d--) {
      const startedAt = new Date(Date.now() - d * 24 * 60 * 60_000);
      startedAt.setHours(22, 30, 0, 0);
      const viaStore = d % 2 === 0;
      const durationMin = 10 + (d % 4) + (viaStore ? 8 : 0);
      const endedAt = new Date(startedAt.getTime() + durationMin * 60_000);
      const walkId = `${SEED_PREFIX}${d}`;
      await query(
        `INSERT INTO walks (walk_id, user_id, trigger, started_at, ended_at, origin_cell,
           origin_lat, origin_lon, duration_s, status, expected_min, late_min)
         VALUES ($1,$2,'prompt',$3,$4,$5,$6,$7,$8,'ARRIVED',$9,$10)`,
        [
          walkId,
          userId,
          startedAt.toISOString(),
          endedAt.toISOString(),
          toCell(COLUMBIA.lat, COLUMBIA.lon),
          COLUMBIA.lat,
          COLUMBIA.lon,
          durationMin * 60,
          durationMin,
          durationMin + 5,
        ],
      );
      const steps = 12;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const p = lerp(COLUMBIA, HOME, t);
        const time = new Date(startedAt.getTime() + t * durationMin * 60_000);
        await query(
          `INSERT INTO location_pings (time, user_id, lat, lon, accuracy_m, geom, cell, walk_id, short_address)
           VALUES ($1, $2, $3, $4, 10, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, $5, $6, $7)`,
          [time.toISOString(), userId, p.lat, p.lon, toCell(p.lat, p.lon), walkId, broadwayAt(t)],
        );
      }
      if (viaStore) {
        const start = new Date(startedAt.getTime() + 0.45 * durationMin * 60_000);
        await insertStop({
          userId,
          walkId,
          startedAt: start,
          endedAt: new Date(start.getTime() + 8 * 60_000),
          ...CORNER_STORE,
          cell: storeCell,
          durationS: 8 * 60,
          outcome: "ok",
        });
      }
    }
  }

  /** Onboarded, home saved, always inside the evening window, slowest reply timers. */
  async function setup(userId: string, otherUserId?: string) {
    await query(
      `UPDATE users SET
         home = ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography,
         onboarded_at = COALESCE(onboarded_at, now()),
         monitoring_mode = 'EVENINGS',
         night_start = '00:00', night_end = '00:00',
         nudge_after_sec = 600, escalate_after_sec = 600, no_update_min = 15
       WHERE user_id = $1`,
      [userId, HOME.lat, HOME.lon],
    );
    deps.forgetOnboarding(userId);
    await reset(userId);
    await seedHistory(userId);
    if (otherUserId) {
      await deps.resetOther(otherUserId);
      await query(
        `UPDATE walks SET status = 'ENDED_ELSEWHERE', ended_at = now()
         WHERE user_id = $1 AND ended_at IS NULL`,
        [otherUserId],
      );
    }
  }

  async function restore(userId: string) {
    await reset(userId);
    held.delete(userId);
    await query(
      `UPDATE users SET night_start = '22:00', night_end = '06:00',
         nudge_after_sec = NULL, escalate_after_sec = NULL, no_update_min = NULL
       WHERE user_id = $1`,
      [userId],
    );
  }

  /** Scene 1: two and a half minutes walking down Broadway at night → "Heading home?". */
  async function startWalk(userId: string) {
    await reset(userId);
    const now = new Date();
    for (let i = 0; i <= 5; i++) {
      const t = 0.25 * (i / 5);
      await ping(userId, ago(now, 150 - i * 30), lerp(COLUMBIA, HOME, t), broadwayAt(t));
    }
    armHush(userId, HUSH_AFTER_MS);
  }

  /** Scene 2: nine minutes into the usual walk, five and a half of them at the corner store. Nothing is sent. */
  async function familiarStop(userId: string) {
    await reset(userId);
    const now = new Date();
    await deps.hooks.startWalk(userId, ago(now, 540), COLUMBIA.lat, COLUMBIA.lon);
    for (let i = 0; i <= 7; i++) {
      const t = 0.45 * (i / 7);
      await ping(userId, ago(now, 540 - i * 30), lerp(COLUMBIA, HOME, t), broadwayAt(t));
    }
    for (let i = 0; i <= 10; i++) {
      const jitter = (i % 3) * 0.00001;
      await ping(userId, ago(now, 300 - i * 30), { lat: CORNER_STORE.lat + jitter, lon: CORNER_STORE.lon - jitter }, broadwayAt(0.5));
    }
    const actions = await deps.tick(new Date());
    await deps.runActions(actions);
    armHush(userId, FAMILIAR_HUSH_AFTER_MS);
    return { sent: actions.length };
  }

  /** Scene 3: the usual walk, last two fixes at home → "Looks like you made it home 👍". */
  async function safeArrival(userId: string) {
    await reset(userId);
    const now = new Date();
    await deps.hooks.startWalk(userId, ago(now, 450), COLUMBIA.lat, COLUMBIA.lon);
    for (let k = 0; k <= 15; k++) {
      const t = k / 15;
      await ping(userId, ago(now, 450 - k * 30), lerp(COLUMBIA, HOME, t), broadwayAt(t));
    }
  }

  /**
   * Scene 4: a new walk up 12th Ave that stops at W 131st St for four minutes → the stopped check-in.
   * The fixes span under two minutes so the off-route rule stays quiet; the stop rule speaks.
   */
  async function unfamiliarStop(userId: string) {
    await reset(userId);
    const now = new Date();
    await deps.hooks.startWalk(userId, ago(now, 288), UNFAMILIAR_APPROACH.lat, UNFAMILIAR_APPROACH.lon);
    await ping(userId, ago(now, 288), UNFAMILIAR_APPROACH, "12th Ave & W 130th St");
    await ping(userId, ago(now, 264), lerp(UNFAMILIAR_APPROACH, UNFAMILIAR_STOP, 0.5), "12th Ave & W 130th St");
    await ping(userId, ago(now, 240), lerp(UNFAMILIAR_APPROACH, UNFAMILIAR_STOP, 0.85), "W 131st St & 12th Ave");
    await ping(userId, ago(now, 216), UNFAMILIAR_STOP, "W 131st St & 12th Ave");
    await ping(userId, ago(now, 204), { lat: UNFAMILIAR_STOP.lat + 0.00001, lon: UNFAMILIAR_STOP.lon }, "W 131st St & 12th Ave");
    await deps.runActions(await deps.tick(new Date()));
    armHush(userId, HUSH_AFTER_MS);
  }

  /** Scene 7 setup: walking up 12th Ave to W 131st St. Nothing is sent; the user's ‼️ does the rest. */
  async function dangerPrep(userId: string) {
    await reset(userId);
    const now = new Date();
    await deps.hooks.startWalk(userId, ago(now, 90), UNFAMILIAR_APPROACH.lat, UNFAMILIAR_APPROACH.lon);
    await ping(userId, ago(now, 90), UNFAMILIAR_APPROACH, "12th Ave & W 130th St");
    await ping(userId, ago(now, 45), lerp(UNFAMILIAR_APPROACH, UNFAMILIAR_STOP, 0.5), "12th Ave & W 130th St");
    await ping(userId, now, UNFAMILIAR_STOP, "W 131st St & 12th Ave");
    armHush(userId, HUSH_AFTER_MS);
  }

  /** Scene 8: the same walk plus a ‼️ tapback → 911 guidance and the trusted-contact alert. */
  async function notifyContact(userId: string) {
    await dangerPrep(userId);
    await deps.dispatch({
      type: "UserReaction",
      userId,
      emoji: "‼️",
      targetMessageId: "demo",
      messageId: `demo-${Date.now()}`,
      time: new Date(),
    });
  }

  async function run(step: DemoStep, userId: string, otherUserId?: string): Promise<Record<string, unknown>> {
    const started = Date.now();
    let extra: Record<string, unknown> = {};
    switch (step) {
      case "setup":
        await setup(userId, otherUserId);
        break;
      case "restore":
        await restore(userId);
        break;
      case "reset":
        await reset(userId);
        break;
      case "start-walk":
        await startWalk(userId);
        break;
      case "familiar-stop":
        extra = await familiarStop(userId);
        break;
      case "safe-arrival":
        await safeArrival(userId);
        break;
      case "unfamiliar-stop":
        await unfamiliarStop(userId);
        break;
      case "danger-prep":
        await dangerPrep(userId);
        break;
      case "notify-contact":
        await notifyContact(userId);
        break;
      case "status":
        break;
    }
    const result = { step, userId, phase: deps.getPhase(userId), held: held.has(userId), ms: Date.now() - started, ...extra };
    log(result);
    return result;
  }

  return { run, holds };
}
