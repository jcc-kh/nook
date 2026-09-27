import { closePool } from "../store/db.ts";
import { upsertDemoUser } from "../store/users.ts";
import { DEMO } from "../sim/demo.ts";

async function main() {
  await upsertDemoUser({ ...DEMO });
  console.log("[seed:user] upserted", DEMO.userId, "home", DEMO.homeLat, DEMO.homeLon);
  await closePool();
}

main().catch((err) => {
  console.error("[seed:user] failed:", err);
  process.exit(1);
});
