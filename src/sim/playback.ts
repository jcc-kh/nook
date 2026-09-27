import type { Clock } from "../shared/types.ts";
import type { LocationPing } from "../shared/types.ts";

export interface RoutePoint {
  /** Offset from scenario start (ms). */
  tOffsetMs: number;
  lat: number;
  lon: number;
  accuracyM?: number;
  shortAddress?: string;
}

/** Advance clock and emit LocationPings along a route. */
export async function playRoute(opts: {
  clock: Clock & { set(t: Date): void; advance(ms: number): void };
  start: Date;
  userId: string;
  points: RoutePoint[];
  onPing: (ping: LocationPing) => Promise<void>;
}): Promise<void> {
  opts.clock.set(opts.start);
  let lastOffset = 0;
  for (const p of opts.points) {
    const delta = p.tOffsetMs - lastOffset;
    if (delta > 0) opts.clock.advance(delta);
    lastOffset = p.tOffsetMs;
    const ping: LocationPing = {
      type: "LocationPing",
      userId: opts.userId,
      time: opts.clock.now(),
      lat: p.lat,
      lon: p.lon,
      accuracyM: p.accuracyM ?? 10,
      shortAddress: p.shortAddress,
    };
    await opts.onPing(ping);
  }
}

/** Build evenly spaced walking points (~1.3 m/s). */
export function walkingPoints(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  opts?: { speedMps?: number; intervalS?: number },
): RoutePoint[] {
  const speed = opts?.speedMps ?? 1.3;
  const intervalS = opts?.intervalS ?? 20;
  // rough degree deltas
  const R = 6371000;
  const dLat = ((to.lat - from.lat) * Math.PI) / 180;
  const dLon = ((to.lon - from.lon) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((from.lat * Math.PI) / 180) *
      Math.cos((to.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  const dist = 2 * R * Math.asin(Math.sqrt(a));
  const durationS = Math.max(dist / speed, intervalS);
  const steps = Math.max(2, Math.ceil(durationS / intervalS));
  const points: RoutePoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push({
      tOffsetMs: Math.round(t * durationS * 1000),
      lat: from.lat + (to.lat - from.lat) * t,
      lon: from.lon + (to.lon - from.lon) * t,
    });
  }
  return points;
}
