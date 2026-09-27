import { bearingDeg, distanceM } from "../shared/geo.ts";

/**
 * One real store, written down for the demo. Morton Williams at 2941 Broadway
 * (115th St) is open 24 hours. Distance and the turn are computed from the
 * live fix; the place itself is not looked up. Used only when GEOAPIFY_API_KEY is unset.
 */
export const SAFE_PLACE = {
  name: "Morton Williams",
  lat: 40.80765,
  lon: -73.96453,
  open: "24 hours",
} as const;

/** Comfortable walking pace, meters per minute. */
const M_PER_MIN = 80;

export interface SafePlaceGuide {
  place_name: string;
  open: string;
  distance_m: number;
  minutes_away: number;
  /** Read aloud in order, after saying the lookup line. */
  say: string[];
}

export function guideToSafePlace(lat: number, lon: number, headingDeg?: number): SafePlaceGuide {
  const meters = distanceM(lat, lon, SAFE_PLACE.lat, SAFE_PLACE.lon);
  const minutes = Math.max(1, Math.round(meters / M_PER_MIN));
  const minuteWord = minutes === 1 ? "minute" : "minutes";

  if (meters < 35) {
    return {
      place_name: SAFE_PLACE.name,
      open: SAFE_PLACE.open,
      distance_m: Math.round(meters),
      minutes_away: 1,
      say: ["You're right by Morton Williams.", "Go inside. I'll stay on the line."],
    };
  }

  const target = bearingDeg(lat, lon, SAFE_PLACE.lat, SAFE_PLACE.lon);
  const then = meters < 120 ? "It's just ahead of you." : "Walk one block down.";
  return {
    place_name: SAFE_PLACE.name,
    open: SAFE_PLACE.open,
    distance_m: Math.round(meters),
    minutes_away: minutes,
    say: [
      `There is a Morton Williams about ${minutes} ${minuteWord} away from you.`,
      turnLine(headingDeg, target),
      then,
    ],
  };
}

/** Positive relative bearing means the place is to the right of the way they are facing. */
function turnLine(headingDeg: number | undefined, targetBearing: number): string {
  if (headingDeg === undefined) return `Head ${compassWord(targetBearing)} from where you're standing.`;
  const rel = (targetBearing - headingDeg + 540) % 360 - 180;
  if (Math.abs(rel) < 30) return "Keep straight here.";
  if (Math.abs(rel) > 150) return "Turn around here.";
  return rel > 0 ? "Turn right here." : "Turn left here.";
}

function compassWord(bearing: number): string {
  const dirs = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"] as const;
  return dirs[Math.round(bearing / 45) % 8]!;
}
