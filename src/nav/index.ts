import { createFixtureProvider } from "./fixture.ts";
import { createGeoapifyProvider } from "./geoapify.ts";
import type { NavProvider } from "./types.ts";

export * from "./types.ts";
export { createFixtureProvider } from "./fixture.ts";
export { createNavService, navConfigFromEnv, type NavConfig, type NavService, type NavigationUpdate, type SafePlaceOption } from "./service.ts";

/** Per-request fallback: a failing Geoapify call is answered from the fixture instead. */
function withFallback(primary: NavProvider, fallback: NavProvider): NavProvider {
  async function attempt<T>(what: string, run: (p: NavProvider) => Promise<T>): Promise<T> {
    try {
      return await run(primary);
    } catch (err) {
      console.warn(`[nav] ${primary.name} ${what} failed, using ${fallback.name}: ${err instanceof Error ? err.message : err}`);
      return run(fallback);
    }
  }
  return {
    name: primary.name,
    findPlaces: (near, opts) => attempt("findPlaces", (p) => p.findPlaces(near, opts)),
    route: (from, to) => attempt("route", (p) => p.route(from, to)),
    reverseGeocode: (pt) => attempt("reverseGeocode", (p) => p.reverseGeocode(pt)),
    geocode: (q, near) => attempt("geocode", (p) => p.geocode(q, near)),
  };
}

/**
 * NAV_PROVIDER=fixture forces the demo set. Otherwise a Geoapify key
 * (GEOAPIFY_API_KEY or GEO_API_KEY) uses live places and walking routes.
 */
export function navProviderFromEnv(): NavProvider {
  const choice = (process.env.NAV_PROVIDER ?? "").trim().toLowerCase();
  const fixture = createFixtureProvider();
  const key = process.env.GEOAPIFY_API_KEY?.trim() || process.env.GEO_API_KEY?.trim();
  if (choice === "fixture") return fixture;
  if (choice && choice !== "geoapify") {
    console.warn(`[nav] unknown NAV_PROVIDER=${choice}, using fixture`);
    return fixture;
  }
  if (!key) {
    if (choice === "geoapify") console.warn("[nav] NAV_PROVIDER=geoapify but no API key, using fixture");
    return fixture;
  }
  return withFallback(createGeoapifyProvider(key), fixture);
}
