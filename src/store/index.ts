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
  loadFamiliarCells,
  buildDefaultPlan,
} from "./walks.ts";

function applyPatch(row: UserRecord, patch: UserPatch): void {
  Object.assign(row, patch);
  if (patch.trustedContact?.phone) row.contact = patch.trustedContact.phone;
  if (patch.emergencyCode?.phrase) row.codeword = patch.emergencyCode.phrase;
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

    async setCodeword(userId: string, codeword: string): Promise<void> {
      const r = row(userId);
      r.codeword = codeword;
      if (r.emergencyCode) r.emergencyCode = { ...r.emergencyCode, phrase: codeword };
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

/**
 * Tiger-backed store with an in-process overlay for Person A settings fields
 * that are not yet columns in `users` (monitoringMode, escalation, …).
 * contact/codeword stay synced to Tiger.
 */
function wrapTigerWithSettings(tiger: UserStore): UserStore {
  const settings = new Map<string, Partial<UserRecord>>();

  function merge(base: UserRecord | null): UserRecord | null {
    if (!base) return null;
    const overlay = settings.get(base.userId);
    if (!overlay) return base;
    return { ...base, ...overlay };
  }

  return {
    async upsertUser(handle: string) {
      return merge(await tiger.upsertUser(handle))!;
    },

    async updateUser(userId: string, patch: UserPatch) {
      const prev = settings.get(userId) ?? {};
      const next: Partial<UserRecord> = { ...prev };
      applyPatch(next as UserRecord, patch);
      settings.set(userId, next);

      if (patch.trustedContact?.phone || patch.contact) {
        await tiger.setContact(userId, patch.trustedContact?.phone ?? patch.contact!);
      }
      if (patch.emergencyCode?.phrase || patch.codeword) {
        await tiger.setCodeword(
          userId,
          patch.emergencyCode?.phrase ?? patch.codeword!,
        );
      }
      if (patch.displayName !== undefined) {
        // display_name is Tiger-only via upsertDemoUser for now; keep in overlay
      }
    },

    async setContact(userId: string, contactE164: string) {
      await tiger.setContact(userId, contactE164);
      const prev = settings.get(userId) ?? {};
      settings.set(userId, {
        ...prev,
        contact: contactE164,
        trustedContact: {
          ...(prev.trustedContact ?? { phone: contactE164 }),
          phone: contactE164,
        },
      });
    },

    async setCodeword(userId: string, codeword: string) {
      await tiger.setCodeword(userId, codeword);
      const prev = settings.get(userId) ?? {};
      settings.set(userId, { ...prev, codeword });
    },

    async setHome(userId: string, lat: number, lon: number) {
      await tiger.setHome(userId, lat, lon);
    },

    async getByHandle(handle: string) {
      return merge(await tiger.getByHandle(handle));
    },

    async getById(userId: string) {
      return merge(await tiger.getById(userId));
    },
  };
}

export function createUserStore(): UserStore {
  if (process.env.DATABASE_URL?.trim()) {
    return wrapTigerWithSettings(createTigerUserStore());
  }
  return createMemoryUserStore();
}
