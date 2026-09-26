/**
 * Onboarding writes Person A needs. Hour-0: in-memory no-op.
 * Person B replaces with Tiger-backed store in L1.
 */

export interface UserRecord {
  userId: string;
  handle: string; // E.164 or email used on iMessage
  contact?: string;
  codeword?: string;
  homeLat?: number;
  homeLon?: number;
  nightStart?: string; // "22:00"
  nightEnd?: string; // "06:00"
  tz?: string;
}

export interface UserStore {
  upsertUser(handle: string): Promise<UserRecord>;
  setContact(userId: string, contactE164: string): Promise<void>;
  setCodeword(userId: string, codeword: string): Promise<void>;
  setHome(userId: string, lat: number, lon: number): Promise<void>;
  getByHandle(handle: string): Promise<UserRecord | null>;
  getById(userId: string): Promise<UserRecord | null>;
}

export function createMemoryUserStore(): UserStore {
  const byId = new Map<string, UserRecord>();
  const handleToId = new Map<string, string>();
  let seq = 0;

  return {
    async upsertUser(handle: string): Promise<UserRecord> {
      const existingId = handleToId.get(handle);
      if (existingId) {
        const row = byId.get(existingId);
        if (row) return row;
      }
      seq += 1;
      const userId = `user-${seq}`;
      const row: UserRecord = {
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

    async setContact(userId: string, contactE164: string): Promise<void> {
      const row = byId.get(userId);
      if (!row) throw new Error(`unknown user ${userId}`);
      row.contact = contactE164;
    },

    async setCodeword(userId: string, codeword: string): Promise<void> {
      const row = byId.get(userId);
      if (!row) throw new Error(`unknown user ${userId}`);
      row.codeword = codeword;
    },

    async setHome(userId: string, lat: number, lon: number): Promise<void> {
      const row = byId.get(userId);
      if (!row) throw new Error(`unknown user ${userId}`);
      row.homeLat = lat;
      row.homeLon = lon;
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
