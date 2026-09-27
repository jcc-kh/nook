/**
 * Geoapify Places + Routing. The voice agent never calls these.
 * Places returns a nearby staffed spot; Routing returns ordered walking steps
 * whose `instruction.text` is already something you can say out loud.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

export interface NearbyPlace {
  name: string;
  lat: number;
  lon: number;
  distanceM: number;
  categories: string[];
  placeId?: string;
  /** OSM opening_hours, when Place Details had one. */
  openingHours?: string;
}

export interface RouteStep {
  /** Maneuver at the start of this step, e.g. "Turn right onto 116th." */
  instruction: string;
  /** What to say once that maneuver is behind them. */
  continueText: string;
  distanceM: number;
  timeS: number;
  /** Index into `WalkingRoute.polyline` where this maneuver starts. */
  fromIndex: number;
  toIndex: number;
}

export interface WalkingRoute {
  steps: RouteStep[];
  polyline: LatLon[];
  distanceM: number;
  timeS: number;
}

const PLACES = "https://api.geoapify.com/v2/places";
const PLACE_DETAILS = "https://api.geoapify.com/v2/place-details";
const ROUTING = "https://api.geoapify.com/v1/routing";

/**
 * Places someone can actually walk into at night. Cafes and restaurants are
 * left out; hours still have to say 24/7 before one is chosen.
 */
const CATEGORIES = [
  "commercial.convenience",
  "commercial.supermarket",
  "commercial.gas",
  "commercial.health_and_beauty.pharmacy",
  "healthcare.pharmacy",
  "healthcare.hospital",
  "service.police",
  "service.vehicle.fuel",
  "accommodation.hotel",
  "catering.fast_food",
  "public_transport.subway",
];

const PREFER: [string, number][] = [
  ["commercial.health_and_beauty.pharmacy", 0],
  ["healthcare.pharmacy", 0],
  ["commercial.convenience", 1],
  ["commercial.supermarket", 2],
  ["catering.cafe", 3],
  ["catering.fast_food", 4],
  ["accommodation.hotel", 5],
  ["public_transport.subway", 6],
];

/** Try a short walk first, then a few blocks, so a nearby store beats a far one. */
const RADII_M = [500, 1200];

/** OSM opening_hours values that mean the place does not close. */
export function isAlwaysOpen(hours: string | undefined): boolean {
  if (!hours) return false;
  const h = hours.trim().toLowerCase().replace(/\s+/g, " ");
  if (h.includes("24/7") || h === "24 hours") return true;
  return /^(?:(?:mo-su|su-sa|daily)(?:,ph)?\s+|ph,mo-su\s+)?00:00-24:00$/.test(h);
}

/**
 * Walk-test log. Prints the live fix, the nearest candidates, and which one
 * is actually open 24/7.
 */
export async function logNearbyPlaces(
  here: LatLon & { accuracyM?: number; kind?: string },
): Promise<void> {
  const apiKey = process.env.GEOAPIFY_API_KEY?.trim() || process.env.GEO_API_KEY?.trim();
  const acc = here.accuracyM !== undefined ? ` ±${here.accuracyM.toFixed(1)}m` : "";
  const kind = here.kind ? ` ${here.kind}` : "";
  console.log(`[maps] you ${here.lat.toFixed(5)},${here.lon.toFixed(5)}${acc}${kind}`);
  if (!apiKey) {
    console.log("[maps] no places key set");
    return;
  }
  for (const radius of RADII_M) {
    const found = [...(await searchPlaces(apiKey, here, radius))].sort((a, b) => a.distanceM - b.distanceM);
    const checked = await withHours(apiKey, found.slice(0, 8));
    console.log(`[maps] geoapify ${found.length} places within ${radius}m; hours on the nearest ${checked.length}`);
    for (const place of checked) {
      const feet = Math.round(place.distanceM * 3.28084);
      const category = place.categories.find((c) => c.includes(".")) ?? place.categories[0] ?? "";
      const hours = place.openingHours ?? "no hours";
      const flag = isAlwaysOpen(place.openingHours) ? "  24/7" : "";
      console.log(
        `[maps]   ${Math.round(place.distanceM)}m ${feet}ft  ${place.name}  ${place.lat.toFixed(5)},${place.lon.toFixed(5)}  ${category}  ${hours}${flag}`,
      );
    }
    if (found.length > checked.length) console.log(`[maps]   … ${found.length - checked.length} more, hours not checked`);
    const open = checked.filter((p) => isAlwaysOpen(p.openingHours)).sort((a, b) => a.distanceM - b.distanceM);
    const nearest = open[0];
    if (nearest) {
      console.log(`[maps] 24/7 nearest: ${nearest.name} ${Math.round(nearest.distanceM)}m`);
      return;
    }
    if (found.length > 0) console.log(`[maps] no 24/7 place in the nearest ${checked.length}; widening the search`);
  }
  console.log("[maps] no 24/7 place found");
}

/** Nearest place whose opening hours say it is open all night. */
export async function findNearbySafePlace(
  apiKey: string,
  here: LatLon,
  excludeName?: string,
): Promise<NearbyPlace | null> {
  const skip = excludeName?.trim().toLowerCase();
  for (const radius of RADII_M) {
    const found = [...(await searchPlaces(apiKey, here, radius))]
      .filter((p) => p.name.toLowerCase() !== skip)
      .sort((a, b) => a.distanceM - b.distanceM);
    const checked = await withHours(apiKey, found.slice(0, 8));
    const open = checked.filter((p) => isAlwaysOpen(p.openingHours)).sort((a, b) => a.distanceM - b.distanceM);
    if (open[0]) return open[0];
  }
  return null;
}

export async function getWalkingRoute(apiKey: string, from: LatLon, to: LatLon): Promise<WalkingRoute | null> {
  const url = new URL(ROUTING);
  url.searchParams.set("waypoints", `${from.lat},${from.lon}|${to.lat},${to.lon}`);
  url.searchParams.set("mode", "walk");
  url.searchParams.set("details", "instruction_details");
  url.searchParams.set("lang", "en");
  url.searchParams.set("apiKey", apiKey);
  const body = await getJson(url);
  return parseWalkingRoute(body);
}

export function parseWalkingRoute(body: unknown): WalkingRoute | null {
  const feature = asRecord(asRecord(body)?.features);
  const first = Array.isArray(feature) ? asRecord(feature[0]) : undefined;
  if (!first) return null;
  const props = asRecord(first.properties);
  const legs = Array.isArray(props?.legs) ? props.legs : [];
  const lines = legLines(asRecord(first.geometry));
  if (lines.length === 0 || legs.length === 0) return null;

  const polyline: LatLon[] = [];
  const steps: RouteStep[] = [];
  for (let legIndex = 0; legIndex < legs.length; legIndex++) {
    const line = lines[legIndex] ?? lines[0];
    if (!line || line.length === 0) continue;
    const offset = polyline.length;
    polyline.push(...line);
    const leg = asRecord(legs[legIndex]);
    const rawSteps = Array.isArray(leg?.steps) ? leg.steps : [];
    for (const raw of rawSteps) {
      const step = asRecord(raw);
      const fromIndex = num(step?.from_index);
      const toIndex = num(step?.to_index);
      const info = asRecord(step?.instruction);
      const text = typeof info?.text === "string" ? info.text.trim() : "";
      const after = typeof info?.post_transition_instruction === "string" ? info.post_transition_instruction.trim() : text;
      if (fromIndex === undefined || toIndex === undefined || !text) continue;
      if (fromIndex < 0 || toIndex >= line.length || fromIndex > toIndex) continue;
      steps.push({
        instruction: text,
        continueText: after || text,
        distanceM: num(step?.distance) ?? 0,
        timeS: num(step?.time) ?? 0,
        fromIndex: offset + fromIndex,
        toIndex: offset + toIndex,
      });
    }
  }
  if (steps.length === 0 || polyline.length === 0) return null;
  return {
    steps,
    polyline,
    distanceM: num(props?.distance) ?? 0,
    timeS: num(props?.time) ?? 0,
  };
}

async function searchPlaces(apiKey: string, here: LatLon, radius: number): Promise<NearbyPlace[]> {
  const url = new URL(PLACES);
  url.searchParams.set("categories", CATEGORIES.join(","));
  url.searchParams.set("conditions", "named");
  url.searchParams.set("filter", `circle:${here.lon},${here.lat},${radius}`);
  url.searchParams.set("bias", `proximity:${here.lon},${here.lat}`);
  url.searchParams.set("limit", "20");
  url.searchParams.set("lang", "en");
  url.searchParams.set("apiKey", apiKey);
  const body = await getJson(url);
  const features = asRecord(body)?.features;
  if (!Array.isArray(features)) return [];
  const places: NearbyPlace[] = [];
  for (const feature of features) {
    const props = asRecord(asRecord(feature)?.properties);
    const name = typeof props?.name === "string" ? props.name.trim() : "";
    const lat = num(props?.lat);
    const lon = num(props?.lon);
    if (!name || lat === undefined || lon === undefined) continue;
    places.push({
      name,
      lat,
      lon,
      distanceM: num(props?.distance) ?? 0,
      categories: Array.isArray(props?.categories) ? props.categories.filter((c): c is string => typeof c === "string") : [],
      ...(typeof props?.place_id === "string" && { placeId: props.place_id }),
    });
  }
  return places;
}

/** Nearest place, unless two are close — then prefer a pharmacy or store over transit. */
export function choosePlace(places: NearbyPlace[], excludeName?: string): NearbyPlace | null {
  const skip = excludeName?.trim().toLowerCase();
  const candidates = places.filter((p) => p.name.toLowerCase() !== skip);
  candidates.sort((a, b) => {
    if (Math.abs(a.distanceM - b.distanceM) > 80) return a.distanceM - b.distanceM;
    const rank = preference(a.categories) - preference(b.categories);
    if (rank !== 0) return rank;
    return a.distanceM - b.distanceM;
  });
  return candidates[0] ?? null;
}

function preference(categories: string[]): number {
  let best = 99;
  for (const category of categories) {
    for (const [key, rank] of PREFER) {
      if (category === key || category.startsWith(`${key}.`)) best = Math.min(best, rank);
    }
  }
  return best;
}

function legLines(geometry: Record<string, unknown> | undefined): LatLon[][] {
  const coords = geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length === 0) return [];
  const first = coords[0];
  if (geometry?.type === "LineString" || (Array.isArray(first) && typeof first[0] === "number")) {
    return [toPoints(coords)];
  }
  return coords.filter(Array.isArray).map((line) => toPoints(line));
}

function toPoints(line: unknown[]): LatLon[] {
  const points: LatLon[] = [];
  for (const raw of line) {
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const lon = num(raw[0]);
    const lat = num(raw[1]);
    if (lat === undefined || lon === undefined) continue;
    points.push({ lat, lon });
  }
  return points;
}

const HOURS_CHECKED = 8;

async function withHours(apiKey: string, places: NearbyPlace[]): Promise<NearbyPlace[]> {
  const batch = places.slice(0, HOURS_CHECKED);
  return Promise.all(
    batch.map(async (place) => {
      if (!place.placeId) return place;
      try {
        const openingHours = await fetchOpeningHours(apiKey, place.placeId);
        return openingHours ? { ...place, openingHours } : place;
      } catch (err) {
        console.error(`[maps] hours for ${place.name} failed`, err instanceof Error ? err.message : err);
        return place;
      }
    }),
  );
}

async function fetchOpeningHours(apiKey: string, placeId: string): Promise<string | undefined> {
  const url = new URL(PLACE_DETAILS);
  url.searchParams.set("id", placeId);
  url.searchParams.set("features", "details");
  url.searchParams.set("apiKey", apiKey);
  return findOpeningHours(await getJson(url));
}

function findOpeningHours(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value == null) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findOpeningHours(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.opening_hours === "string" && rec.opening_hours.trim()) return rec.opening_hours.trim();
  for (const child of Object.values(rec)) {
    const found = findOpeningHours(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

async function getJson(url: URL): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`geoapify ${res.status}`);
  return res.json();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
