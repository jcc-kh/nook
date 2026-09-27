import { distanceM } from "../shared/geo.ts";
import { walkMinutes } from "./geometry.ts";
import type { GeocodeResult, LatLon, NavProvider, Place, PlaceCategory, Route, RouteStep } from "./types.ts";

/**
 * Geoapify (OpenStreetMap data): Places for open spots nearby, walking routes
 * with turn instructions, and (reverse) geocoding. Open-now is only reported
 * when OSM hours say "24/7"; otherwise it's unknown rather than guessed.
 */

const API = "https://api.geoapify.com";
const TIMEOUT_MS = 6_000;

const CATEGORY_QUERY: Record<Exclude<PlaceCategory, "other">, string> = {
  security: "service.police",
  pharmacy: "healthcare.pharmacy",
  grocery: "commercial.supermarket",
  convenience: "commercial.convenience",
  restaurant: "catering.restaurant,catering.fast_food",
  cafe: "catering.cafe",
  bar: "catering.bar,catering.pub",
  transit: "public_transport.subway",
};

function categoryOf(cats: string[]): PlaceCategory {
  const has = (prefix: string) => cats.some((c) => c.startsWith(prefix));
  if (has("service.police")) return "security";
  if (has("healthcare.pharmacy")) return "pharmacy";
  if (has("commercial.supermarket")) return "grocery";
  if (has("commercial.convenience")) return "convenience";
  if (has("catering.cafe")) return "cafe";
  if (has("catering.bar") || has("catering.pub")) return "bar";
  if (has("catering")) return "restaurant";
  if (has("public_transport")) return "transit";
  return "other";
}

interface GeoFeature {
  properties: Record<string, unknown> & {
    name?: string;
    formatted?: string;
    address_line1?: string;
    address_line2?: string;
    street?: string;
    lat?: number;
    lon?: number;
    place_id?: string;
    categories?: string[];
    opening_hours?: string;
    datasource?: { raw?: { opening_hours?: string } };
  };
  geometry?: { type: string; coordinates: unknown };
}

export function createGeoapifyProvider(apiKey: string): NavProvider {
  async function get(path: string, params: Record<string, string>): Promise<{ features?: GeoFeature[] }> {
    const qs = new URLSearchParams({ ...params, apiKey });
    const res = await fetch(`${API}${path}?${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Geoapify ${path} → ${res.status}`);
    return (await res.json()) as { features?: GeoFeature[] };
  }

  return {
    name: "geoapify",

    async findPlaces(near, opts) {
      const cats = (opts?.categories ?? (Object.keys(CATEGORY_QUERY) as (keyof typeof CATEGORY_QUERY)[]))
        .filter((c): c is keyof typeof CATEGORY_QUERY => c in CATEGORY_QUERY)
        .map((c) => CATEGORY_QUERY[c])
        .join(",");
      const radius = Math.round(opts?.radiusM ?? 800);
      const body = await get("/v2/places", {
        categories: cats,
        filter: `circle:${near.lon},${near.lat},${radius}`,
        bias: `proximity:${near.lon},${near.lat}`,
        limit: "30",
      });
      const out: Place[] = [];
      for (const f of body.features ?? []) {
        const p = f.properties;
        if (!p.name || p.lat == null || p.lon == null) continue;
        const hours = p.opening_hours ?? p.datasource?.raw?.opening_hours;
        out.push({
          id: p.place_id ?? `${p.lat},${p.lon}`,
          name: p.name,
          category: categoryOf(p.categories ?? []),
          ...(p.address_line2 || p.formatted ? { address: (p.address_line2 ?? p.formatted)! } : {}),
          lat: p.lat,
          lon: p.lon,
          openNow: hours === "24/7" ? true : null,
          ...(hours && { hours }),
          source: "geoapify",
        });
      }
      return out.sort(
        (a, b) => distanceM(near.lat, near.lon, a.lat, a.lon) - distanceM(near.lat, near.lon, b.lat, b.lon),
      );
    },

    async route(from, to) {
      const body = await get("/v1/routing", {
        waypoints: `${from.lat},${from.lon}|${to.lat},${to.lon}`,
        mode: "walk",
        details: "instruction_details",
      });
      const f = body.features?.[0];
      if (!f) return null;
      const props = f.properties as {
        distance?: number;
        time?: number;
        legs?: { steps?: { from_index: number; to_index: number; distance: number; instruction?: { text?: string }; name?: string }[] }[];
      };
      const coords = (f.geometry?.coordinates as [number, number][][] | undefined)?.[0] ?? [];
      const line: LatLon[] = coords.map(([lon, lat]) => ({ lat, lon }));
      const steps: RouteStep[] = (props.legs?.[0]?.steps ?? []).map((s) => ({
        instruction: s.instruction?.text ?? "Continue",
        ...(s.name && { street: s.name }),
        distanceM: s.distance,
        path: line.slice(s.from_index, Math.max(s.to_index, s.from_index + 1) + 1),
      }));
      const distance = props.distance ?? steps.reduce((sum, s) => sum + s.distanceM, 0);
      const route: Route = {
        distanceM: distance,
        durationMin: props.time ? props.time / 60 : walkMinutes(distance),
        steps,
        source: "geoapify",
      };
      return steps.length ? route : null;
    },

    async reverseGeocode(p) {
      const body = await get("/v1/geocode/reverse", { lat: String(p.lat), lon: String(p.lon) });
      const props = body.features?.[0]?.properties;
      return props?.address_line1 ?? props?.formatted ?? null;
    },

    async geocode(query, near): Promise<GeocodeResult | null> {
      const body = await get("/v1/geocode/search", {
        text: query,
        limit: "1",
        ...(near && { bias: `proximity:${near.lon},${near.lat}` }),
      });
      const p = body.features?.[0]?.properties;
      if (!p || p.lat == null || p.lon == null) return null;
      return {
        name: p.name ?? p.address_line1 ?? query,
        lat: p.lat,
        lon: p.lon,
        ...(p.formatted && { address: p.formatted }),
        source: "geoapify",
      };
    },
  };
}
