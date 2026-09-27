import type { UserPatch, UserRecord, UserStore } from "./types.ts";
import { createTigerUserStore } from "./users.ts";

export type { UserPatch, UserRecord, UserStore } from "./types.ts";
export { getPool, getDatabaseUrl, closePool, query, withClient } from "./db.ts";
export {
  createTigerUserStore,
  upsertDemoUser,
  insertLocationPing,
  insertEvent,
  countPings,
  loadRecentPings,
} from "./users.ts";
export {
  insertWalk,
  updateWalkStatus,
  getOpenWalk,
  insertStop,
  upsertPlaceLabel,
  loadWalkBaselines,
  loadKnownStops,
  loadRouteCells,
  loadUsualCells,
  insertConfirmedCells,
  listOpenWalkUserIds,
  buildDefaultPlan,
} from "./walks.ts";

function applyPatch(row: UserRecord, patch: UserPatch): void {
  Object.assign(row, patch);
  if ("trustedContact" in patch) row.contact = patch.trustedContact?.phone;
}

/** In-memory fallback (no DATABASE_URL / offline). */
export function createMemoryUserStore(): UserStore {
  const byId = new Map<string, UserRecord>();
  const handleToId = new Map<string, string>();
  let seq = 0;

  function row(userId: string): UserRecord {
    const found = byId.get(userId);
    if (!found) throw new Error(`unknown user ${userId}`);
    return found;
  }

  return {
    async upsertUser(handle: string): Promise<UserRecord> {
      const existingId = handleToId.get(handle);
      if (existingId) {
        const existing = byId.get(existingId);
        if (existing) return existing;
      }
      seq += 1;
      const userId = `user-${seq}`;
      const created: UserRecord = {
        userId,
        handle,
        nightStart: "22:00",
        nightEnd: "06:00",
        tz: "America/New_York",
      };
      byId.set(userId, created);
      handleToId.set(handle, userId);
      return created;
    },

    async updateUser(userId: string, patch: UserPatch): Promise<void> {
      applyPatch(row(userId), patch);
    },

    async setContact(userId: string, contactE164: string): Promise<void> {
      const r = row(userId);
      r.contact = contactE164;
      r.trustedContact = { ...(r.trustedContact ?? { phone: contactE164 }), phone: contactE164 };
    },

    async setHome(userId: string, lat: number, lon: number): Promise<void> {
      const r = row(userId);
      r.homeLat = lat;
      r.homeLon = lon;
    },

    async getByHandle(handle: string): Promise<UserRecord | null> {
      const id = handleToId.get(handle);
      if (!id) return null;
      return byId.get(id) ?? null;
    },

    async getById(userId: string): Promise<UserRecord | null> {
      return byId.get(userId) ?? null;
    },
  };
}

/** Tiger when DATABASE_URL is set (settings are real columns), otherwise in-memory. */
export function createUserStore(): UserStore {
  if (process.env.DATABASE_URL?.trim()) return createTigerUserStore();
  return createMemoryUserStore();
}
