import type { UserSettings } from "../shared/settings.ts";

/**
 * Unified user row: Tiger columns (contact/codeword/home/…) plus Person A
 * onboarding settings (trustedContact, monitoringMode, …).
 */
export interface UserRecord extends UserSettings {
  userId: string;
  handle: string;
  /** Tiger column; kept in sync with trustedContact.phone when set. */
  contact?: string;
  /** Tiger column; kept in sync with emergencyCode.phrase when set. */
  codeword?: string;
  homeLat?: number;
  homeLon?: number;
  nightStart?: string;
  nightEnd?: string;
  tz?: string;
  displayName?: string;
  onboardedAt?: Date;
}

/** Keys present in the patch are written; `undefined` clears (e.g. removing the emergency code). */
export type UserPatch = Partial<UserSettings> & {
  onboardedAt?: Date;
  contact?: string;
  codeword?: string;
  displayName?: string;
};

export interface UserStore {
  upsertUser(handle: string): Promise<UserRecord>;
  updateUser(userId: string, patch: UserPatch): Promise<void>;
  setContact(userId: string, contactE164: string): Promise<void>;
  setCodeword(userId: string, codeword: string): Promise<void>;
  setHome(userId: string, lat: number, lon: number): Promise<void>;
  getByHandle(handle: string): Promise<UserRecord | null>;
  getById(userId: string): Promise<UserRecord | null>;
}
