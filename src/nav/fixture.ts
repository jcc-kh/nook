import { distanceM } from "../shared/geo.ts";
import data from "./fixtures.json";
import {
  cardinal,
  locateOnRoute,
  pathLength,
  segmentProjection,
  straightLineRoute,
  walkMinutes,
} from "./geometry.ts";
import type { GeocodeResult, LatLon, NavProvider, Place, PlaceCategory, Route, RouteStep } from "./types.ts";

/**
 * Deterministic demo data from fixtures.json (Columbia / Morningside Heights):
 * a handful of places with fixed open status and hand-written 2-4 step walking
 * routes with real street names. Destinations or starting points the file
 * doesn't cover fall back to a straight-line route, labelled as such.
 */

interface FixtureStep {
  instruction: string;
  street?: string;
  landmark?: string;
  path: LatLon[];
}

interface FixtureRoute {
  id: string;
  to: string;
  steps: FixtureStep[];
}

interface FixtureData {
  home: LatLon & { name: string };
  places: (Omit<Place, "source" | "category"> & { category: string })[];
  routes: FixtureRoute[];
}

const fixture = data as unknown as FixtureData;
/** A route is used when the walker is within this distance of its line. */
const ROUTE_JOIN_M = 400;
/** A destination matches a route's end within this distance. */
const DEST_MATCH_M = 80;
/** Further off the line than this, a "head to <street>" step is prepended. */
const JOIN_STEP_M = 40;

function toPlace(p: FixtureData["places"][number]): Place {
  return { ...p, category: p.category as PlaceCategory, source: "fixture" };
}

function endOf(route: FixtureRoute): LatLon {
  const last = route.steps[route.steps.length - 1]!;
  return last.path[last.path.length - 1]!;
}

function asRoute(steps: FixtureStep[]): Route {
  const out: RouteStep[] = steps.map((s) => ({
    instruction: s.instruction,
    ...(s.street && { street: s.street }),
    ...(s.landmark && { landmark: s.landmark }),
    distanceM: pathLength(s.path),
    path: s.path,
  }));
  const distanceM = out.reduce((sum, s) => sum + s.distanceM, 0);
  return { distanceM, durationMin: walkMinutes(distanceM), steps: out, source: "fixture" };
}

export function createFixtureProvider(): NavProvider {
  const places = fixture.places.map(toPlace);

  function routesTo(to: LatLon & { id?: string }): FixtureRoute[] {
    return fixture.routes.filter((r) => {
      if (to.id && r.to === to.id) return true;
      const end = endOf(r);
      return distanceM(end.lat, end.lon, to.lat, to.lon) <= DEST_MATCH_M;
    });
  }

  return {
    name: "fixture",

    async findPlaces(near, opts) {
      const radius = opts?.radiusM ?? 1500;
      return places
        .filter((p) => !opts?.categories || opts.categories.includes(p.category))
        .map((p) => ({ p, d: distanceM(near.lat, near.lon, p.lat, p.lon) }))
        .filter(({ d }) => d <= radius)
        .sort((a, b) => a.d - b.d)
        .map(({ p }) => p);
    },

    async route(from, to) {
      let best: { route: FixtureRoute; pos: NonNullable<ReturnType<typeof locateOnRoute>> } | null = null;
      for (const r of routesTo(to)) {
        const pos = locateOnRoute(asRoute(r.steps), from);
        if (pos && pos.offRouteM <= ROUTE_JOIN_M && (!best || pos.offRouteM < best.pos.offRouteM)) best = { route: r, pos };
      }
      if (!best) return straightLineRoute(from, to);

      const { route, pos } = best;
      const current = route.steps[pos.stepIndex]!;
      const steps: FixtureStep[] = [
        { ...current, path: [pos.snapped, ...current.path.slice(pos.segIndex)] },
        ...route.steps.slice(pos.stepIndex + 1),
      ];
      if (pos.offRouteM > JOIN_STEP_M) {
        steps.unshift({
          instruction: `Head ${cardinal(from, pos.snapped)} to ${current.street ?? "the route"}`,
          ...(current.street && { street: current.street }),
          path: [{ lat: from.lat, lon: from.lon }, pos.snapped],
        });
      }
      return asRoute(steps);
    },

    async reverseGeocode(p) {
      let best: { street: string; d: number } | null = null;
      for (const r of fixture.routes) {
        for (const s of r.steps) {
          if (!s.street) continue;
          for (let i = 1; i < s.path.length; i++) {
            const d = segmentProjection(p, s.path[i - 1]!, s.path[i]!).distM;
            if (d <= 60 && (!best || d < best.d)) best = { street: s.street, d };
          }
        }
      }
      return best ? `${best.street}, New York` : null;
    },

    async geocode(query, near): Promise<GeocodeResult | null> {
      const q = query.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
      if (!q) return null;
      if (q === "home") return { ...fixture.home, source: "fixture" };
      const scored = places
        .map((p) => {
          const hay = `${p.name} ${p.address ?? ""}`.toLowerCase().replace(/[^a-z0-9 ]+/g, " ");
          const words = q.split(" ").filter((w) => w.length > 2);
          const hits = words.filter((w) => hay.includes(w)).length;
          return { p, score: words.length ? hits / words.length : 0 };
        })
        .filter((x) => x.score >= 0.5)
        .sort((a, b) =>
          b.score - a.score ||
          (near ? distanceM(near.lat, near.lon, a.p.lat, a.p.lon) - distanceM(near.lat, near.lon, b.p.lat, b.p.lon) : 0),
        );
      const hit = scored[0]?.p;
      return hit ? { name: hit.name, lat: hit.lat, lon: hit.lon, ...(hit.address && { address: hit.address }), source: "fixture" } : null;
    },
  };
}
