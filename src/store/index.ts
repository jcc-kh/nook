import type { UserSettings } from "../shared/settings.ts";

import type { UserStore } from "./types.ts";
import { createTigerUserStore } from "./users.ts";

/**
 * Onboarding writes Person A needs. Hour-0: in-memory no-op.
 * Person B replaces with Tiger-backed store in L1.
 */

export interface UserRecord extends UserSettings {
  userId: string;
  handle: string; // E.164 or email used on iMessage
  homeLat?: number;
  homeLon?: number;
  nightStart?: string; // "22:00", the EVENINGS monitoring window
  nightEnd?: string; // "06:00"
  tz?: string;
  onboardedAt?: Date;
}

/** Keys present in the patch are written; `undefined` clears (e.g. removing the emergency code). */
export type UserPatch = Partial<UserSettings> & { onboardedAt?: Date };

export interface UserStore {
  upsertUser(handle: string): Promise<UserRecord>;
  updateUser(userId: string, patch: UserPatch): Promise<void>;
  setHome(userId: string, lat: number, lon: number): Promise<void>;
  getByHandle(handle: string): Promise<UserRecord | null>;
  getById(userId: string): Promise<UserRecord | null>;
}

export function createMemoryUserStore(): UserStore {
  const byId = new Map<string, UserRecord>();
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

  function row(userId: string): UserRecord {
    const found = byId.get(userId);
    if (!found) throw new Error(`unknown user ${userId}`);
    return found;
  }

  return {
    async upsertUser(handle: string) {
      const existingId = handleToId.get(handle);
      if (existingId) {
        const existing = byId.get(existingId);
        if (existing) return existing;
      }
      seq += 1;
      const userId = `user-${seq}`;
      const created: UserRecord = {
      const row = {
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
      Object.assign(row(userId), patch);
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

    async setHome(userId: string, lat: number, lon: number): Promise<void> {
      const r = row(userId);
      r.homeLat = lat;
      r.homeLon = lon;
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
