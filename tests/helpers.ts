import { createBrainEngine } from "../src/brain/engine.ts";
import { classifyFallback } from "../src/llm/fallback.ts";
import { createFixtureProvider, createNavService, type NavConfig } from "../src/nav/index.ts";
import { SimClock } from "../src/shared/clock.ts";
import type { Action, AlertContact, CallOutcome, ClassifyInput, SendText, StartCall, VoiceNoteRef } from "../src/shared/types.ts";
import type { UserRecord } from "../src/store/types.ts";

export const HOME = { lat: 40.807501, lon: -73.962595 };
/** Amsterdam Ave near 110th, start of the fixture "amsterdam-home" route. */
export const START = { lat: 40.802751, lon: -73.963944 };

export const NAV_CONFIG: NavConfig = { staleSec: 30, contextFreshSec: 90, offRouteM: 60, rerouteCooldownSec: 20 };

export function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    userId: "u-test",
    handle: "+15555550199",
    contact: "+15555550100",
    trustedContact: { phone: "+15555550100", name: "Sam" },
    homeLat: HOME.lat,
    homeLon: HOME.lon,
    nightStart: "22:00",
    nightEnd: "06:00",
    tz: "America/New_York",
    displayName: "Alex",
    monitoringMode: "MANUAL",
    escalation: { initialAction: "TEXT_USER", onNoTextResponse: "CONTACT_TRUSTED" },
    onboardedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** 10:30pm New York. */
export const NIGHT = new Date("2026-04-14T02:30:00.000Z");

export function harness(opts: { user?: Partial<UserRecord>; classify?: ClassifyInput; callsEnabled?: boolean; at?: Date } = {}) {
  const clock = new SimClock(opts.at ?? NIGHT);
  let user = makeUser(opts.user);
  const nav = createNavService(createFixtureProvider(), NAV_CONFIG);
  const brain = createBrainEngine({
    clock,
    getUser: async () => user,
    classify: opts.classify ?? classifyFallback,
    nav,
    callsEnabled: () => opts.callsEnabled ?? true,
    persist: false,
    history: false,
    verbose: false,
  });
  let msg = 0;
  const h = {
    clock,
    brain,
    nav,
    get user() {
      return user;
    },
    setUser(patch: Partial<UserRecord>) {
      user = { ...user, ...patch };
    },
    ping(p: { lat: number; lon: number } = START, extra: { shortAddress?: string; accuracyM?: number } = {}) {
      return brain.handle({ type: "LocationPing", userId: user.userId, time: clock.now(), ...p, ...extra });
    },
    text(text: string) {
      return brain.handle({ type: "UserText", userId: user.userId, messageId: `m${++msg}`, text, time: clock.now() });
    },
    voiceNote(transcript: string, ref: Partial<VoiceNoteRef> = {}) {
      const id = ref.id ?? `vn${++msg}`;
      return brain.handle({
        type: "UserText",
        userId: user.userId,
        messageId: id,
        text: transcript,
        time: clock.now(),
        voiceNote: { id, path: `/tmp/${id}.caf`, mimeType: "audio/x-caf", transcribed: true, ...ref },
      });
    },
    react(emoji: string) {
      return brain.handle({ type: "UserReaction", userId: user.userId, emoji, targetMessageId: "t", time: clock.now() });
    },
    call(callType: CallOutcome, situation?: string, walkId?: string) {
      return brain.handle({
        type: "CallEvent",
        userId: user.userId,
        walkId: walkId ?? h.walkId() ?? "none",
        callType,
        time: clock.now(),
        ...(situation && { situation }),
      });
    },
    tick() {
      return brain.tick(clock.now());
    },
    rt() {
      return brain.getRuntime(user.userId) as {
        walkId: string | null;
        safety: string;
        phase: string;
        routeChoice: string | null;
        interim: { name: string } | null;
        destination: { name: string } | null;
        dangerWindow: unknown;
      };
    },
    walkId() {
      return h.rt().walkId;
    },
    phase() {
      return brain.getPhase(user.userId);
    },
    /** Starts a walk from START so there's a fix and an open trip. */
    async startWalk() {
      await h.ping(START, { shortAddress: "Amsterdam Ave" });
      return h.text("walk me home");
    },
  };
  return h;
}

export const texts = (actions: Action[]): string[] =>
  actions.filter((a): a is SendText => a.type === "SendText").map((a) => a.text);
export const alerts = (actions: Action[]): AlertContact[] =>
  actions.filter((a): a is AlertContact => a.type === "AlertContact");
export const calls = (actions: Action[]): StartCall[] =>
  actions.filter((a): a is StartCall => a.type === "StartCall");
export const allText = (actions: Action[]) => texts(actions).join("\n");
