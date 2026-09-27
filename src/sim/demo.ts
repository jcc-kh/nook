/** Demo user constants shared by seed + sim. */
export const DEMO = {
  userId: "demo-alex",
  handle: "+15555550199",
  contact: "+15555550100",
  // Near Columbia / Morningside (home)
  homeLat: 40.8075,
  homeLon: -73.9626,
  nightStart: "22:00",
  nightEnd: "06:00",
  tz: "America/New_York",
  displayName: "Alex",
} as const;

/** Origin ~400 m south of home — typical walk start. */
export const DEMO_ORIGIN = {
  lat: 40.8040,
  lon: -73.9626,
} as const;

/** Bodega stop along the walk. */
export const DEMO_BODEGA = {
  lat: 40.8055,
  lon: -73.9626,
  label: "corner bodega",
  kind: "bodega",
} as const;

/** Friend place slightly off the home route. */
export const DEMO_FRIEND = {
  lat: 40.8060,
  lon: -73.9600,
  label: "Sam's",
  kind: "friend",
} as const;
