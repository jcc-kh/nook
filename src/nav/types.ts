export interface LatLon {
  lat: number;
  lon: number;
}

export type NavSource = "fixture" | "geoapify" | "straight_line";

export type PlaceCategory =
  | "security"
  | "pharmacy"
  | "grocery"
  | "convenience"
  | "restaurant"
  | "cafe"
  | "bar"
  | "transit"
  | "other";

export interface Place extends LatLon {
  id: string;
  name: string;
  category: PlaceCategory;
  address?: string;
  /** null when the data can't say. */
  openNow: boolean | null;
  hours?: string;
  source: NavSource;
}

export interface RouteStep {
  instruction: string;
  street?: string;
  distanceM: number;
  landmark?: string;
  /** Polyline for this step, first point = where the step starts. */
  path: LatLon[];
}

export interface Route {
  distanceM: number;
  durationMin: number;
  steps: RouteStep[];
  source: NavSource;
}

export interface GeocodeResult extends LatLon {
  name: string;
  address?: string;
  source: NavSource;
}

/** Everything navigation needs from a data source. Swappable: fixture (demo) or Geoapify. */
export interface NavProvider {
  readonly name: NavSource;
  findPlaces(near: LatLon, opts?: { radiusM?: number; categories?: PlaceCategory[] }): Promise<Place[]>;
  route(from: LatLon, to: LatLon & { name?: string; id?: string }): Promise<Route | null>;
  reverseGeocode(p: LatLon): Promise<string | null>;
  geocode(query: string, near?: LatLon): Promise<GeocodeResult | null>;
}
