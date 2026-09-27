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
