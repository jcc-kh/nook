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
 * NAV_PROVIDER picks the data source explicitly: "fixture" (default, demo data)
 * or "geoapify" (needs GEOAPIFY_API_KEY). A key alone never changes the demo.
 */
export function navProviderFromEnv(): NavProvider {
  const choice = (process.env.NAV_PROVIDER ?? "fixture").trim().toLowerCase();
  const fixture = createFixtureProvider();
  if (choice === "fixture" || choice === "") return fixture;
  if (choice !== "geoapify") {
    console.warn(`[nav] unknown NAV_PROVIDER=${choice}, using fixture`);
    return fixture;
  }
  const key = process.env.GEOAPIFY_API_KEY?.trim();
  if (!key) {
    console.warn("[nav] NAV_PROVIDER=geoapify but GEOAPIFY_API_KEY is missing, using fixture");
    return fixture;
  }
  return withFallback(createGeoapifyProvider(key), fixture);
}
