/** Haversine distance in meters (WGS84). */
export function distanceM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Degrees clockwise from north, in 0–360. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

/** Speed m/s between two timed points. */
export function speedMps(
  lat1: number,
  lon1: number,
  t1: Date,
  lat2: number,
  lon2: number,
  t2: Date,
): number {
  const dt = (t2.getTime() - t1.getTime()) / 1000;
  if (dt <= 0) return 0;
  return distanceM(lat1, lon1, lat2, lon2) / dt;
}

export interface PolylineHit {
  distanceM: number;
  /** Index of the nearer endpoint of the closest segment. */
  index: number;
}

/** Meters from a point to the nearest segment of an ordered path. */
export function distanceToPolylineM(
  lat: number,
  lon: number,
  points: { lat: number; lon: number }[],
): PolylineHit {
  if (points.length === 0) return { distanceM: Infinity, index: 0 };
  const first = points[0]!;
  if (points.length === 1) return { distanceM: distanceM(lat, lon, first.lat, first.lon), index: 0 };

  let best = Infinity;
  let bestIndex = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const hit = distanceToSegmentM(lat, lon, points[i]!, points[i + 1]!);
    if (hit.distanceM < best) {
      best = hit.distanceM;
      bestIndex = hit.t >= 0.5 ? i + 1 : i;
    }
  }
  return { distanceM: best, index: bestIndex };
}

function distanceToSegmentM(
  lat: number,
  lon: number,
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): { distanceM: number; t: number } {
  const lat0 = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos(lat0);
  const bx = (b.lon - a.lon) * mPerDegLon;
  const by = (b.lat - a.lat) * mPerDegLat;
  const px = (lon - a.lon) * mPerDegLon;
  const py = (lat - a.lat) * mPerDegLat;
  const len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return { distanceM: Math.hypot(px - t * bx, py - t * by), t };
}

/** Bearing-agnostic path length along ordered points. */
export function pathLengthM(
  points: { lat: number; lon: number }[],
): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    sum += distanceM(a.lat, a.lon, b.lat, b.lon);
  }
  return sum;
}
