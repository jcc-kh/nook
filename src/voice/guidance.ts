import { distanceM, distanceToPolylineM } from "../shared/geo.ts";
import {
  findNearbySafePlace,
  getWalkingRoute,
  type LatLon,
  type RouteStep,
  type WalkingRoute,
} from "./geoapify.ts";
import { guideToSafePlace } from "./safePlace.ts";

/**
 * One active walk's guide. The server owns which step is next.
 * Gemini only receives the fields in `GuidanceResult`.
 */
export interface ActiveGuidance {
  destination: { name: string; lat: number; lon: number };
  steps: RouteStep[];
  polyline: LatLon[];
  currentStep: number;
  introduced: boolean;
}

export type GuidanceResult =
  | {
      ok: true;
      status: "on_route" | "arrived";
      destination: string;
      eta_minutes: number;
      instruction: string;
      distance_m: number;
      say: string[];
    }
  | {
      ok: false;
      status: "no_place" | "no_route";
      say: string[];
    };

/** Find My on a sidewalk jitters; only reroute once they're clearly off the line. */
export const OFF_ROUTE_M = 80;
/** Close enough to the place pin to stop guiding. */
export const ARRIVE_M = 35;
/** Speak the upcoming turn once they're this close to it, so they hear it before the corner. */
export const TURN_SOON_M = 40;

const sessions = new Map<string, ActiveGuidance>();
let warnedDemo = false;

export function resetGuidance(walkId?: string): void {
  if (walkId) sessions.delete(walkId);
  else sessions.clear();
}

export async function nextGuidance(
  walkId: string,
  here: LatLon & { headingDeg?: number },
  opts?: { refresh?: boolean },
): Promise<GuidanceResult> {
  const apiKey = process.env.GEOAPIFY_API_KEY?.trim() || process.env.GEO_API_KEY?.trim();
  if (!apiKey) return demoGuide(here);

  if (opts?.refresh) {
    const previous = sessions.get(walkId)?.destination.name;
    sessions.delete(walkId);
    return startGuidance(walkId, here, apiKey, previous);
  }

  const active = sessions.get(walkId);
  if (!active) return startGuidance(walkId, here, apiKey);

  const where = locateOnRoute(active, here);
  if (where.arrived) {
    sessions.delete(walkId);
    return spoken(active, where, true);
  }
  if (where.offRoute) {
    const rerouted = await reroute(active, here, apiKey);
    if (!rerouted) return spoken(active, where, active.introduced);
    const again = locateOnRoute(active, here);
    return spoken(active, again, true);
  }
  return spoken(active, where, active.introduced);
}

/**
 * Where they are on a stored route. Advances `currentStep` and never rewinds,
 * so a noisy ping doesn't repeat a turn they already passed.
 */
export function locateOnRoute(
  state: ActiveGuidance,
  here: LatLon,
): { arrived: boolean; offRoute: boolean; instruction: string; distanceM: number; etaMinutes: number } {
  const toDest = distanceM(here.lat, here.lon, state.destination.lat, state.destination.lon);
  if (toDest <= ARRIVE_M) {
    return {
      arrived: true,
      offRoute: false,
      instruction: `You're at ${state.destination.name}.`,
      distanceM: Math.round(toDest),
      etaMinutes: 0,
    };
  }

  const hit = distanceToPolylineM(here.lat, here.lon, state.polyline);
  if (hit.distanceM > OFF_ROUTE_M) {
    const step = state.steps[state.currentStep] ?? state.steps[0];
    return {
      arrived: false,
      offRoute: true,
      instruction: step?.instruction ?? "Keep walking.",
      distanceM: Math.round(hit.distanceM),
      etaMinutes: etaMinutes(state, state.currentStep, here),
    };
  }

  let stepIndex = state.currentStep;
  while (stepIndex < state.steps.length - 1 && hit.index > (state.steps[stepIndex]?.toIndex ?? 0)) {
    stepIndex++;
  }
  state.currentStep = stepIndex;

  const step = state.steps[stepIndex] ?? state.steps[0];
  const next = state.steps[stepIndex + 1];
  const end = step ? state.polyline[step.toIndex] : undefined;
  const begin = step ? state.polyline[step.fromIndex] : undefined;
  const distToEnd = end ? distanceM(here.lat, here.lon, end.lat, end.lon) : toDest;
  const distFromBegin = begin ? distanceM(here.lat, here.lon, begin.lat, begin.lon) : 0;
  if (next && distToEnd <= TURN_SOON_M) {
    return {
      arrived: false,
      offRoute: false,
      instruction: next.instruction,
      distanceM: Math.round(distToEnd),
      etaMinutes: etaMinutes(state, stepIndex, here),
    };
  }
  const instruction =
    step && distFromBegin > 25 ? step.continueText : (step?.instruction ?? "Keep walking.");

  return {
    arrived: false,
    offRoute: false,
    instruction,
    distanceM: Math.round(distToEnd),
    etaMinutes: etaMinutes(state, stepIndex, here),
  };
}

async function startGuidance(
  walkId: string,
  here: LatLon,
  apiKey: string,
  excludeName?: string,
): Promise<GuidanceResult> {
  let place;
  try {
    place = await findNearbySafePlace(apiKey, here, excludeName);
  } catch (err) {
    console.error("[guidance] places failed", err instanceof Error ? err.message : err);
    return { ok: false, status: "no_place", say: ["I couldn't look that up just now. Walk a little and I'll try again."] };
  }
  if (!place) {
    return {
      ok: false,
      status: "no_place",
      say: ["I couldn't find a place open all night from here. Walk another block and I'll look again."],
    };
  }

  let route: WalkingRoute | null;
  try {
    route = await getWalkingRoute(apiKey, here, place);
  } catch (err) {
    console.error("[guidance] route failed", err instanceof Error ? err.message : err);
    route = null;
  }
  if (!route) {
    return {
      ok: false,
      status: "no_route",
      say: [`I found ${place.name}, but I couldn't get walking directions. Stay on this street and I'll try again.`],
    };
  }

  const state: ActiveGuidance = {
    destination: { name: place.name, lat: place.lat, lon: place.lon },
    steps: route.steps,
    polyline: route.polyline,
    currentStep: 0,
    introduced: false,
  };
  sessions.set(walkId, state);
  const where = locateOnRoute(state, here);
  console.log(
    `[guidance] ${walkId}: ${place.name} ${Math.round(place.distanceM)}m, ${route.steps.length} steps, ${Math.round(route.distanceM)}m walk`,
  );
  return spoken(state, where, false);
}

async function reroute(state: ActiveGuidance, here: LatLon, apiKey: string): Promise<boolean> {
  try {
    const route = await getWalkingRoute(apiKey, here, state.destination);
    if (!route) return false;
    state.steps = route.steps;
    state.polyline = route.polyline;
    state.currentStep = 0;
    console.log(`[guidance] rerouted to ${state.destination.name}, ${route.steps.length} steps`);
    return true;
  } catch (err) {
    console.error("[guidance] reroute failed", err instanceof Error ? err.message : err);
    return false;
  }
}

function spoken(
  state: ActiveGuidance,
  where: { arrived: boolean; instruction: string; distanceM: number; etaMinutes: number },
  alreadyIntroduced: boolean,
): GuidanceResult {
  const destination = state.destination.name;
  if (where.arrived) {
    state.introduced = true;
    return {
      ok: true,
      status: "arrived",
      destination,
      eta_minutes: 0,
      instruction: where.instruction,
      distance_m: where.distanceM,
      say: [`You're at ${destination}.`, "Go inside. I'll stay on the line."],
    };
  }

  const say = alreadyIntroduced
    ? [where.instruction]
    : [`There's a ${destination} open all night, about ${minutesPhrase(where.etaMinutes)} away.`, where.instruction];
  state.introduced = true;
  return {
    ok: true,
    status: "on_route",
    destination,
    eta_minutes: where.etaMinutes,
    instruction: where.instruction,
    distance_m: where.distanceM,
    say,
  };
}

function etaMinutes(state: ActiveGuidance, stepIndex: number, here: LatLon): number {
  const step = state.steps[stepIndex];
  if (!step) return 1;
  let remain = 0;
  for (let i = stepIndex; i < state.steps.length; i++) remain += state.steps[i]?.timeS ?? 0;
  const span = Math.max(1, step.toIndex - step.fromIndex);
  const slice = state.polyline.slice(step.fromIndex, step.toIndex + 1);
  const along = slice.length > 0 ? distanceToPolylineM(here.lat, here.lon, slice).index / span : 0;
  remain -= step.timeS * Math.min(1, Math.max(0, along));
  return Math.max(1, Math.round(remain / 60));
}

function minutesPhrase(n: number): string {
  return n === 1 ? "1 minute" : `${n} minutes`;
}

/** No Geoapify key: the one demo store, same response shape as a live guide. */
function demoGuide(here: LatLon & { headingDeg?: number }): GuidanceResult {
  if (!warnedDemo) {
    warnedDemo = true;
    console.log("[guidance] GEOAPIFY_API_KEY unset — using the demo store");
  }
  const guide = guideToSafePlace(here.lat, here.lon, here.headingDeg);
  const arrived = guide.distance_m < ARRIVE_M;
  return {
    ok: true,
    status: arrived ? "arrived" : "on_route",
    destination: guide.place_name,
    eta_minutes: guide.minutes_away,
    instruction: guide.say[1] ?? guide.say[0] ?? "Keep walking.",
    distance_m: guide.distance_m,
    say: [...guide.say],
  };
}
