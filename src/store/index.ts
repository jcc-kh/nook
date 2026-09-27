import type { UserStore } from "./types.ts";
import { createTigerUserStore } from "./users.ts";

/**
 * Store layer — Tiger-backed by default; memory store kept for Person A offline.
 */
export type { UserRecord, UserStore } from "./types.ts";
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
  buildDefaultPlan,
} from "./walks.ts";

/** In-memory fallback (hour-0 / no DATABASE_URL). */
export function createMemoryUserStore(): UserStore {
  const byId = new Map<
    string,
    {
      userId: string;
      handle: string;
      contact?: string;
      codeword?: string;
      homeLat?: number;
      homeLon?: number;
      nightStart?: string;
      nightEnd?: string;
      tz?: string;
    }
  >();
  const handleToId = new Map<string, string>();
  let seq = 0;

  return {
    async upsertUser(handle: string) {
      const existingId = handleToId.get(handle);
      if (existingId) {
        const row = byId.get(existingId);
        if (row) return row;
      }
      seq += 1;
      const userId = `user-${seq}`;
      const row = {
        userId,
        handle,
        nightStart: "22:00",
        nightEnd: "06:00",
        tz: "America/New_York",
      };
      byId.set(userId, row);
      handleToId.set(handle, userId);
      return row;
    },
    async setContact(userId, contactE164) {
      const row = byId.get(userId);
      if (!row) throw new Error(`unknown user ${userId}`);
      row.contact = contactE164;
    },
    async setCodeword(userId, codeword) {
      const row = byId.get(userId);
      if (!row) throw new Error(`unknown user ${userId}`);
      row.codeword = codeword;
    },
    async setHome(userId, lat, lon) {
      const row = byId.get(userId);
      if (!row) throw new Error(`unknown user ${userId}`);
      row.homeLat = lat;
      row.homeLon = lon;
    },
    async getByHandle(handle) {
      const id = handleToId.get(handle);
      if (!id) return null;
      return byId.get(id) ?? null;
    },
    async getById(userId) {
      return byId.get(userId) ?? null;
    },
  };
}

export function createUserStore(): UserStore {
  if (process.env.DATABASE_URL?.trim()) {
    return createTigerUserStore();
  }
  return createMemoryUserStore();
}
