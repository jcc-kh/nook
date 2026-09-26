import type { UserSettings } from "../shared/settings.ts";

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
      Object.assign(row(userId), patch);
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

export function notImplementedStore(): never {
  throw new Error("TODO: Person B — Tiger UserStore (src/store)");
}
