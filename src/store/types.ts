export interface UserRecord {
  userId: string;
  handle: string;
  contact?: string;
  codeword?: string;
  homeLat?: number;
  homeLon?: number;
  nightStart?: string;
  nightEnd?: string;
  tz?: string;
  displayName?: string;
}

export interface UserStore {
  upsertUser(handle: string): Promise<UserRecord>;
  setContact(userId: string, contactE164: string): Promise<void>;
  setCodeword(userId: string, codeword: string): Promise<void>;
  setHome(userId: string, lat: number, lon: number): Promise<void>;
  getByHandle(handle: string): Promise<UserRecord | null>;
  getById(userId: string): Promise<UserRecord | null>;
}
