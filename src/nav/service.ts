import { distanceM } from "../shared/geo.ts";
import type { Destination } from "../shared/types.ts";
import { locateOnRoute, roundDistance, walkMinutes } from "./geometry.ts";
import type { GeocodeResult, LatLon, NavProvider, NavSource, Place, PlaceCategory, Route } from "./types.ts";

export interface NavConfig {
  /** Turn-by-turn needs a fix at most this old. */
  staleSec: number;
  /** Describing where they are / alerts can use a fix this old. */
  contextFreshSec: number;
  /** Further than this from the route line counts as off route. */
  offRouteM: number;
  /** Minimum gap between reroutes. */
  rerouteCooldownSec: number;
}

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function navConfigFromEnv(): NavConfig {
  return {
    staleSec: envNumber("NAV_STALE_SECONDS", 30),
    contextFreshSec: 90,
    offRouteM: envNumber("NAV_OFF_ROUTE_METERS", 60),
    rerouteCooldownSec: envNumber("NAV_REROUTE_COOLDOWN_SECONDS", 20),
  };
}

export interface SafePlaceOption {
  rank: number;
  id: string;
  name: string;
  category: PlaceCategory;
  address?: string;
  lat: number;
  lon: number;
  openNow: boolean | null;
  hours?: string;
  distanceM: number;
  walkMin: number;
  source: NavSource;
}

export interface Position extends LatLon {
  time: Date;
  accuracyM?: number;
  street?: string;
}

export interface NavigationUpdate {
  location: {
    lat: number;
    lon: number;
    street: string | null;
    updatedAt: string;
    ageSec: number;
    accuracyM?: number;
  };
  navigationFresh: boolean;
  contextFresh: boolean;
  destination: { name: string; lat: number; lon: number } | null;
  remaining: { distanceM: number; minutes: number } | null;
  /** One short instruction for right now; null when the fix is too old to steer by. */
  instruction: string | null;
  nextTurn: { instruction: string; inM: number } | null;
  upcomingLandmark: string | null;
  onRoute: boolean | null;
  offRouteM: number | null;
  rerouted: boolean;
  arrived: boolean;
  routeSource: NavSource | null;
  note?: string;
}

export interface NavService {
  readonly providerName: NavSource;
  readonly config: NavConfig;
  findSafeDestinations(from: LatLon, opts?: { limit?: number }): Promise<SafePlaceOption[]>;
  navigationUpdate(input: { key: string; position: Position; destination: Destination | null; now: Date }): Promise<NavigationUpdate>;
  route(from: LatLon, to: Destination): Promise<Route | null>;
  geocode(query: string, near?: LatLon): Promise<GeocodeResult | null>;
  reverseGeocode(p: LatLon): Promise<string | null>;
  /** Drop the cached route for a walk. */
  forget(key: string): void;
}

/** Lower is better: where you'd most want to wait at night. */
const CATEGORY_PENALTY_MIN: Record<PlaceCategory, number> = {
  security: 0,
  pharmacy: 1,
  grocery: 1,
  convenience: 1,
  restaurant: 2,
  transit: 2,
  cafe: 2,
  bar: 3,
  other: 4,
};
/** Streets aren't straight lines: rough walking detour over crow-flies distance. */
const DETOUR = 1.25;
const ARRIVED_M = 30;
const TURN_NOW_M = 25;

function decap(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function destKey(d: Destination): string {
  return `${d.name}@${d.lat.toFixed(5)},${d.lon.toFixed(5)}`;
}

export function createNavService(provider: NavProvider, config: NavConfig = navConfigFromEnv()): NavService {
  const routes = new Map<string, { destKey: string; route: Route; computedAt: number }>();

  async function findSafeDestinations(from: LatLon, opts?: { limit?: number }): Promise<SafePlaceOption[]> {
    const places: Place[] = await provider.findPlaces(from, { radiusM: 1200 });
    return places
      .filter((p) => p.openNow !== false)
      .map((p) => {
        const d = distanceM(from.lat, from.lon, p.lat, p.lon) * DETOUR;
        const walkMin = walkMinutes(d);
        return { p, d, walkMin, score: walkMin + CATEGORY_PENALTY_MIN[p.category] };
      })
      .sort((a, b) => a.score - b.score)
      .slice(0, opts?.limit ?? 3)
      .map(({ p, d, walkMin }, i) => ({
        rank: i + 1,
        id: p.id,
        name: p.name,
        category: p.category,
        ...(p.address && { address: p.address }),
        lat: p.lat,
        lon: p.lon,
        openNow: p.openNow,
        ...(p.hours && { hours: p.hours }),
        distanceM: Math.round(d),
        walkMin: Math.max(1, Math.round(walkMin)),
        source: p.source,
      }));
  }

  async function routeTo(from: LatLon, to: Destination): Promise<Route | null> {
    return provider.route(from, { lat: to.lat, lon: to.lon, name: to.name });
  }

  async function navigationUpdate(input: {
    key: string;
    position: Position;
    destination: Destination | null;
    now: Date;
  }): Promise<NavigationUpdate> {
    const { key, position, destination, now } = input;
    const ageSec = Math.max(0, Math.round((now.getTime() - position.time.getTime()) / 1000));
    const navigationFresh = ageSec <= config.staleSec;
    const contextFresh = ageSec <= config.contextFreshSec;
    const base: NavigationUpdate = {
      location: {
        lat: position.lat,
        lon: position.lon,
        street: position.street ?? null,
        updatedAt: position.time.toISOString(),
        ageSec,
        ...(position.accuracyM != null && { accuracyM: position.accuracyM }),
      },
      navigationFresh,
      contextFresh,
      destination: destination ? { name: destination.name, lat: destination.lat, lon: destination.lon } : null,
      remaining: null,
      instruction: null,
      nextTurn: null,
      upcomingLandmark: null,
      onRoute: null,
      offRouteM: null,
      rerouted: false,
      arrived: false,
      routeSource: null,
    };
    if (!destination) return { ...base, note: "No destination is set for this trip." };

    const dk = destKey(destination);
    let cached = routes.get(key);
    if (!cached || cached.destKey !== dk) {
      const route = await routeTo(position, destination);
      if (!route) return { ...base, note: "No route data for this destination." };
      cached = { destKey: dk, route, computedAt: now.getTime() };
      routes.set(key, cached);
    }
    let pos = locateOnRoute(cached.route, position);
    let rerouted = false;
    const off = pos != null && pos.offRouteM > config.offRouteM;
    if (off && navigationFresh && now.getTime() - cached.computedAt >= config.rerouteCooldownSec * 1000) {
      const route = await routeTo(position, destination);
      if (route) {
        cached = { destKey: dk, route, computedAt: now.getTime() };
        routes.set(key, cached);
        pos = locateOnRoute(route, position);
        rerouted = true;
      }
    }
    const route = cached.route;
    const direct = distanceM(position.lat, position.lon, destination.lat, destination.lon);
    const remainingM = pos ? pos.remainingM : direct;
    const arrived = direct <= ARRIVED_M || (pos != null && pos.offRouteM <= config.offRouteM && pos.remainingM <= ARRIVED_M);
    const onRoute = pos ? pos.offRouteM <= config.offRouteM : null;
    const out: NavigationUpdate = {
      ...base,
      remaining: { distanceM: Math.round(remainingM), minutes: Math.max(0, Math.round(walkMinutes(remainingM))) },
      onRoute,
      offRouteM: pos ? Math.round(pos.offRouteM) : null,
      rerouted,
      arrived,
      routeSource: route.source,
    };

    if (!navigationFresh) {
      return {
        ...out,
        note: `Location is ${ageSec} seconds old, too old for turn directions. Don't tell them to turn; say you're waiting for their location to update.`,
      };
    }
    if (arrived) return { ...out, instruction: `You're at ${destination.name}.` };
    if (!pos) return out;

    const step = route.steps[pos.stepIndex]!;
    const next = route.steps[pos.stepIndex + 1];
    const landmark = step.landmark ?? next?.landmark ?? null;
    let instruction: string;
    let nextTurn: NavigationUpdate["nextTurn"] = null;
    if (next && pos.remainingInStepM <= TURN_NOW_M) {
      instruction = next.instruction;
    } else if (next) {
      instruction = `${step.instruction}. In about ${roundDistance(pos.remainingInStepM)}, ${decap(next.instruction)}.`;
      nextTurn = { instruction: next.instruction, inM: Math.round(pos.remainingInStepM) };
    } else {
      instruction = `${step.instruction}. About ${roundDistance(pos.remainingInStepM)} to go.`;
    }
    if (!onRoute) instruction = `You're about ${roundDistance(pos.offRouteM)} off the route. ${instruction}`;
    return { ...out, instruction, nextTurn, upcomingLandmark: landmark };
  }

  return {
    providerName: provider.name,
    config,
    findSafeDestinations,
    navigationUpdate,
    route: routeTo,
    geocode: (q, near) => provider.geocode(q, near),
    reverseGeocode: (p) => provider.reverseGeocode(p),
    forget: (key) => void routes.delete(key),
  };
}
