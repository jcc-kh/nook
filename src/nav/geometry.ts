import { distanceM } from "../shared/geo.ts";
import type { LatLon, Route } from "./types.ts";

const M_PER_DEG = 111_320;

/** Planar metres relative to `origin` (fine at walking scale). */
function toXY(p: LatLon, origin: LatLon): { x: number; y: number } {
  return {
    x: (p.lon - origin.lon) * M_PER_DEG * Math.cos((origin.lat * Math.PI) / 180),
    y: (p.lat - origin.lat) * M_PER_DEG,
  };
}

/** Distance from `p` to segment ab, and how far along ab (0..1) the closest point is. */
export function segmentProjection(p: LatLon, a: LatLon, b: LatLon): { distM: number; t: number } {
  const A = toXY(a, p);
  const B = toXY(b, p);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(A.x * dx + A.y * dy) / len2));
  const cx = A.x + t * dx;
  const cy = A.y + t * dy;
  return { distM: Math.hypot(cx, cy), t };
}

export function pathLength(path: LatLon[]): number {
  let sum = 0;
  for (let i = 1; i < path.length; i++) sum += distanceM(path[i - 1]!.lat, path[i - 1]!.lon, path[i]!.lat, path[i]!.lon);
  return sum;
}

export interface RoutePosition {
  /** Distance from the route line. */
  offRouteM: number;
  stepIndex: number;
  /** Metres left in the current step. */
  remainingInStepM: number;
  /** Metres left to the end of the route. */
  remainingM: number;
  /** Segment within the step (index of its end point) and how far along it. */
  segIndex: number;
  t: number;
  /** Closest point on the route line. */
  snapped: LatLon;
}

/** Where `p` sits along `route`: nearest step/segment, metres off the line and left to go. */
export function locateOnRoute(route: Route, p: LatLon): RoutePosition | null {
  let best: { distM: number; step: number; seg: number; t: number } | null = null;
  route.steps.forEach((step, si) => {
    for (let i = 1; i < step.path.length; i++) {
      const pr = segmentProjection(p, step.path[i - 1]!, step.path[i]!);
      if (!best || pr.distM < best.distM) best = { distM: pr.distM, step: si, seg: i, t: pr.t };
    }
  });
  if (!best) return null;
  const { distM, step, seg, t } = best as { distM: number; step: number; seg: number; t: number };
  const path = route.steps[step]!.path;
  const a = path[seg - 1]!;
  const b = path[seg]!;
  const segLen = distanceM(a.lat, a.lon, b.lat, b.lon);
  let inStep = segLen * (1 - t);
  for (let i = seg + 1; i < path.length; i++) inStep += distanceM(path[i - 1]!.lat, path[i - 1]!.lon, path[i]!.lat, path[i]!.lon);
  let remaining = inStep;
  for (let s = step + 1; s < route.steps.length; s++) remaining += route.steps[s]!.distanceM;
  return {
    offRouteM: distM,
    stepIndex: step,
    remainingInStepM: inStep,
    remainingM: remaining,
    segIndex: seg,
    t,
    snapped: { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t },
  };
}

const CARDINALS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

export function cardinal(from: LatLon, to: LatLon): string {
  const y = Math.sin(((to.lon - from.lon) * Math.PI) / 180) * Math.cos((to.lat * Math.PI) / 180);
  const x =
    Math.cos((from.lat * Math.PI) / 180) * Math.sin((to.lat * Math.PI) / 180) -
    Math.sin((from.lat * Math.PI) / 180) * Math.cos((to.lat * Math.PI) / 180) * Math.cos(((to.lon - from.lon) * Math.PI) / 180);
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return CARDINALS[Math.round(deg / 45) % 8]!;
}

/** 1.3 m/s: an unhurried walk. */
export function walkMinutes(distanceM: number): number {
  return distanceM / 1.3 / 60;
}

/** Last-resort route: one step pointing straight at the destination. */
export function straightLineRoute(from: LatLon, to: LatLon & { name?: string }): Route {
  const d = distanceM(from.lat, from.lon, to.lat, to.lon);
  return {
    distanceM: d,
    durationMin: walkMinutes(d),
    source: "straight_line",
    steps: [
      {
        instruction: `Head ${cardinal(from, to)} toward ${to.name ?? "your destination"} (about ${roundDistance(d)}, no street directions available)`,
        distanceM: d,
        path: [
          { lat: from.lat, lon: from.lon },
          { lat: to.lat, lon: to.lon },
        ],
      },
    ],
  };
}

export function roundDistance(m: number): string {
  if (m < 60) return "a few steps";
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1)} km`;
}
