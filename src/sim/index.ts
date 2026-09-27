/** Person B: GPS route playback, SimClock harness, seed + scenarios. */

export { playRoute, walkingPoints } from "./playback.ts";
export { DEMO, DEMO_ORIGIN, DEMO_BODEGA, DEMO_FRIEND } from "./demo.ts";

export function notImplementedSim(): never {
  throw new Error("Use bun run sim:l1 | sim:l2 | sim:l3 | sim:l4");
}
