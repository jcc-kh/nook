/**
 * Real-time synthetic Find My feed for live iMessage testing.
 *
 * Scenarios are built relative to the user's saved home, using the same
 * geometry as `seed:history --handle` (usual route = straight line from a
 * point ~390 m south of home). Pings are fed at wall-clock pace into the same
 * path real Find My pings take, so ticks, Tiger writes and iMessage replies
 * all behave as they would on a real walk.
 */
import type { Event, LocationPing } from "../shared/types.ts";
import { walkingPoints, type RoutePoint } from "./playback.ts";

export const SCENARIOS = [
  "arrive",
  "stall",
  "silent",
  "offroute",
  "offroute2",
  "prompt",
  "vehicle",
] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Scenario {
  name: ScenarioName;
  points: RoutePoint[];
  /** Start an explicit walk (as if the user texted "walk me home") after the first ping. */
  startWalk: boolean;
  description: string;
}

const INTERVAL_S = 15;
const WALK_MPS = 1.3;

/** Degrees of latitude per meter, and longitude per meter at `lat`. */
function offset(p: LatLon, northM: number, eastM: number): LatLon {
  const dLat = northM / 111_320;
  const dLon = eastM / (111_320 * Math.cos((p.lat * Math.PI) / 180));
  return { lat: p.lat + dLat, lon: p.lon + dLon };
}

/** Where seeded "usual" walks start: ~390 m south of home. */
export function routineOrigin(home: LatLon): LatLon {
  return offset(home, -390, 0);
}

function shift(points: RoutePoint[], byMs: number): RoutePoint[] {
  return points.map((p) => ({ ...p, tOffsetMs: p.tOffsetMs + byMs }));
}

function stayAt(at: LatLon, fromMs: number, durationMs: number): RoutePoint[] {
  const out: RoutePoint[] = [];
  for (let t = INTERVAL_S * 1000; t <= durationMs; t += INTERVAL_S * 1000) {
    // Small jitter (<5 m) so it looks like a phone, but stays "stationary".
    const j = offset(at, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6);
    out.push({ tOffsetMs: fromMs + t, lat: j.lat, lon: j.lon });
  }
  return out;
}

function walkFor(from: LatLon, northM: number, eastM: number, speed = WALK_MPS) {
  const to = offset(from, northM, eastM);
  return { to, points: walkingPoints(from, to, { speedMps: speed, intervalS: INTERVAL_S }) };
}

function last(points: RoutePoint[]): RoutePoint {
  return points[points.length - 1]!;
}

export function buildScenario(name: ScenarioName, home: LatLon): Scenario {
  const origin = routineOrigin(home);
  switch (name) {
    case "arrive": {
      const walk = walkingPoints(origin, home, { speedMps: WALK_MPS, intervalS: INTERVAL_S });
      const end = last(walk).tOffsetMs;
      return {
        name,
        startWalk: true,
        points: [...walk, ...stayAt(home, end, 30_000)],
        description: "walk the usual route home (~5 min), then two pings at home",
      };
    }
    case "stall": {
      const leg = walkFor(origin, 2 * 60 * WALK_MPS, 0);
      const end = last(leg.points).tOffsetMs;
      return {
        name,
        startWalk: true,
        points: [...leg.points, ...stayAt(leg.to, end, 5 * 60_000)],
        description: "walk 2 min toward home, then stand still for 5 min",
      };
    }
    case "silent": {
      const leg = walkFor(origin, 60 * WALK_MPS, 0);
      return {
        name,
        startWalk: true,
        points: leg.points,
        description: "walk 1 min toward home, then no more location updates",
      };
    }
    case "offroute":
    case "offroute2": {
      // offroute heads east, offroute2 west, so one can be confirmed and the other ignored.
      const eastM = name === "offroute" ? 450 : -450;
      const onRoute = walkFor(origin, 60 * WALK_MPS, 0);
      const t1 = last(onRoute.points).tOffsetMs;
      const off = walkFor(onRoute.to, 0, eastM);
      const t2 = t1 + last(off.points).tOffsetMs;
      return {
        name,
        startWalk: false,
        points: [
          ...onRoute.points,
          ...shift(off.points.slice(1), t1),
          ...stayAt(off.to, t2, 3 * 60_000),
        ],
        description: `1 min on the usual route, then ~6 min heading 450 m ${eastM > 0 ? "east" : "west"}, then linger`,
      };
    }
    case "prompt": {
      const start = offset(home, -300, 0);
      const leg = walkFor(start, -3 * 60 * WALK_MPS, 0);
      return {
        name,
        startWalk: false,
        points: leg.points,
        description: "walk steadily for 3 min, >150 m from home (should get 'Heading home?')",
      };
    }
    case "vehicle": {
      const start = offset(home, -300, 0);
      const leg = walkFor(start, -8 * 120, 0, 8);
      return {
        name,
        startWalk: false,
        points: leg.points,
        description: "move at ~8 m/s for 2 min (car/train; should stay quiet)",
      };
    }
  }
}

interface Running {
  userId: string;
  scenario: ScenarioName;
  startedAt: Date;
  total: number;
  sent: number;
  cancelled: boolean;
}

export interface LiveSimDeps {
  now: () => Date;
  /** Feed a ping through the normal location path (router + brain). */
  feed: (ping: LocationPing) => Promise<void>;
  /** Send a synthetic event straight to the brain (e.g. "walk me home"). */
  dispatch: (event: Event) => Promise<void>;
}

/**
 * Tracks which users are on a synthetic feed. While a user is in `active`,
 * real Find My pings for them should be dropped so the two streams don't mix.
 * A user stays active after the last point (so "silent" stays silent) until
 * `stop` or the next `start`.
 */
export function createLiveSim(deps: LiveSimDeps) {
  const runs = new Map<string, Running>();
  const active = new Set<string>();

  function stop(userId: string): boolean {
    const run = runs.get(userId);
    if (run) run.cancelled = true;
    runs.delete(userId);
    return active.delete(userId);
  }

  async function play(run: Running, scenario: Scenario) {
    const t0 = run.startedAt.getTime();
    for (const [i, p] of scenario.points.entries()) {
      const wait = t0 + p.tOffsetMs - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      if (run.cancelled) return;
      await deps.feed({
        type: "LocationPing",
        userId: run.userId,
        time: deps.now(),
        lat: p.lat,
        lon: p.lon,
        accuracyM: p.accuracyM ?? 10,
        shortAddress: "Synthetic route",
      });
      run.sent += 1;
      if (i === 0 && scenario.startWalk) {
        await deps.dispatch({
          type: "UserText",
          userId: run.userId,
          messageId: `sim-${crypto.randomUUID().slice(0, 8)}`,
          text: "walk me home",
          time: deps.now(),
        });
      }
    }
    console.log(`[sim] ${run.userId} ${run.scenario} finished (${run.sent} pings); real pings still paused`);
  }

  function start(
    userId: string,
    home: LatLon,
    name: ScenarioName,
    opts: { startWalk?: boolean } = {},
  ) {
    stop(userId);
    const built = buildScenario(name, home);
    const scenario = { ...built, startWalk: opts.startWalk ?? built.startWalk };
    const run: Running = {
      userId,
      scenario: name,
      startedAt: new Date(),
      total: scenario.points.length,
      sent: 0,
      cancelled: false,
    };
    runs.set(userId, run);
    active.add(userId);
    console.log(`[sim] ${userId} ${name}: ${scenario.description} (${run.total} pings)`);
    void play(run, scenario).catch((err) => console.error("[sim] playback failed", err));
    return {
      scenario: name,
      description: scenario.description,
      points: run.total,
      durationSec: Math.round(last(scenario.points).tOffsetMs / 1000),
      startWalk: scenario.startWalk,
    };
  }

  function status() {
    return [...active].map((userId) => {
      const run = runs.get(userId);
      return run
        ? { userId, scenario: run.scenario, sent: run.sent, total: run.total, done: run.sent >= run.total }
        : { userId, scenario: null, done: true };
    });
  }

  return { start, stop, status, isActive: (userId: string) => active.has(userId) };
}
