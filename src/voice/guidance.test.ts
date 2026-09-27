import { describe, expect, test } from "bun:test";
import { distanceM } from "../shared/geo.ts";
import { choosePlace, isAlwaysOpen, parseWalkingRoute, type NearbyPlace } from "./geoapify.ts";
import { locateOnRoute, OFF_ROUTE_M, type ActiveGuidance } from "./guidance.ts";

/** ~meters north of a lat, at this latitude. */
function north(lat: number, meters: number): number {
  return lat + meters / 111_320;
}

const start = { lat: 40.807, lon: -73.964 };

function fixture(): ActiveGuidance {
  const polyline = [
    start,
    { lat: north(start.lat, 50), lon: start.lon },
    { lat: north(start.lat, 100), lon: start.lon },
    { lat: north(start.lat, 100), lon: start.lon + 50 / 84_000 },
    { lat: north(start.lat, 100), lon: start.lon + 100 / 84_000 },
  ];
  return {
    destination: { name: "CVS Pharmacy", ...polyline[4]! },
    polyline,
    currentStep: 0,
    introduced: true,
    steps: [
      {
        instruction: "Walk north on Broadway.",
        continueText: "Continue on Broadway.",
        distanceM: 100,
        timeS: 80,
        fromIndex: 0,
        toIndex: 2,
      },
      {
        instruction: "Turn right onto 116th.",
        continueText: "Continue on 116th.",
        distanceM: 100,
        timeS: 80,
        fromIndex: 2,
        toIndex: 4,
      },
    ],
  };
}

describe("locateOnRoute", () => {
  test("starts on the first instruction", () => {
    const state = fixture();
    const where = locateOnRoute(state, start);
    expect(where.offRoute).toBe(false);
    expect(where.arrived).toBe(false);
    expect(where.instruction).toBe("Walk north on Broadway.");
    expect(state.currentStep).toBe(0);
  });

  test("speaks the next turn once the corner is close", () => {
    const state = fixture();
    const corner = { lat: north(start.lat, 70), lon: start.lon };
    const where = locateOnRoute(state, corner);
    expect(where.instruction).toBe("Turn right onto 116th.");
    expect(where.distanceM).toBeLessThan(40);
  });

  test("does not rewind after the turn", () => {
    const state = fixture();
    const past = state.polyline[3]!;
    locateOnRoute(state, past);
    expect(state.currentStep).toBe(1);
    locateOnRoute(state, state.polyline[2]!);
    expect(state.currentStep).toBe(1);
    expect(locateOnRoute(state, state.polyline[2]!).instruction).not.toBe("Walk north on Broadway.");
  });

  test("flags a clear deviation", () => {
    const state = fixture();
    const off = { lat: start.lat, lon: start.lon + (OFF_ROUTE_M + 40) / 84_000 };
    expect(distanceM(start.lat, start.lon, off.lat, off.lon)).toBeGreaterThan(OFF_ROUTE_M);
    const where = locateOnRoute(state, off);
    expect(where.offRoute).toBe(true);
    expect(state.currentStep).toBe(0);
  });

  test("arrives at the destination pin", () => {
    const state = fixture();
    const where = locateOnRoute(state, state.destination);
    expect(where.arrived).toBe(true);
    expect(where.instruction).toContain("CVS Pharmacy");
  });
});

describe("isAlwaysOpen", () => {
  test("accepts all-night hours and rejects a closing time", () => {
    expect(isAlwaysOpen("24/7")).toBe(true);
    expect(isAlwaysOpen("Mo-Su 00:00-24:00")).toBe(true);
    expect(isAlwaysOpen("Mo-Fr 07:00-23:00")).toBe(false);
    expect(isAlwaysOpen(undefined)).toBe(false);
  });
});

describe("geoapify parsing", () => {
  test("reads ordered step text and indexes into the leg line", () => {
    const route = parseWalkingRoute({
      features: [
        {
          geometry: {
            type: "MultiLineString",
            coordinates: [
              [
                [-73.964, 40.807],
                [-73.964, 40.808],
                [-73.963, 40.808],
              ],
            ],
          },
          properties: {
            distance: 180,
            time: 140,
            legs: [
              {
                steps: [
                  { from_index: 0, to_index: 1, distance: 100, time: 80, instruction: { text: "Walk north on Broadway." } },
                  { from_index: 1, to_index: 2, distance: 80, time: 60, instruction: { text: "Turn right onto 116th." } },
                ],
              },
            ],
          },
        },
      ],
    });
    expect(route?.steps.map((s) => s.instruction)).toEqual([
      "Walk north on Broadway.",
      "Turn right onto 116th.",
    ]);
    expect(route?.steps[1]?.fromIndex).toBe(1);
    expect(route?.polyline[2]).toEqual({ lon: -73.963, lat: 40.808 });
  });

  test("prefers a pharmacy when it is about as close as a station", () => {
    const places: NearbyPlace[] = [
      { name: "116th St Station", lat: 1, lon: 1, distanceM: 90, categories: ["public_transport.subway"] },
      { name: "CVS", lat: 1, lon: 1, distanceM: 120, categories: ["commercial.health_and_beauty.pharmacy"] },
    ];
    expect(choosePlace(places)?.name).toBe("CVS");
    expect(choosePlace(places, "CVS")?.name).toBe("116th St Station");
  });
});
