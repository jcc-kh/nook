import type {
  Action,
  Clock,
  Event,
  LiveContext,
  LocationPing,
  ParsedReply,
  RuleId,
  SendTextTag,
  WalkPhase,
  WalkPlan,
  WriteMessages,
} from "../shared/types.ts";
import { toCell } from "../shared/cell.ts";
import { bearingDeg, distanceM, pathLengthM, speedMps } from "../shared/geo.ts";
import {
  contactAlert,
  nextStepLine,
  templates,
  templateForTag,
  type ContactAlertKind,
} from "../shared/templates.ts";
import {
  escalationSteps,
  resolveTimeouts,
  type NoResponseAction,
} from "../shared/settings.ts";
import type { UserRecord } from "../store/types.ts";
import {
  insertEvent,
  insertLocationPing,
  loadRecentPings,
} from "../store/users.ts";
import {
  buildDefaultPlan,
  getOpenWalk,
  insertConfirmedCells,
  insertWalk,
  listOpenWalkUserIds,
  loadKnownStops,
  loadUsualCells,
  loadWalkBaselines,
  updateWalkStatus,
  upsertPlaceLabel,
} from "../store/walks.ts";
import { copy } from "../messenger/copy.ts";
import { query } from "../store/db.ts";
import { voiceConfigFromEnv } from "../voice/index.ts";

const WINDOW_MS = 5 * 60_000;
const PROMPT_COOLDOWN_MS = 2 * 60 * 60_000;
const PROMPT_TIMEOUT_MS = 10 * 60_000;
const CHECKIN_RATE_MS = 3 * 60_000;
/** Quiet period after the user answers a check-in. */
const CHECKIN_SNOOZE_MS = 10 * 60_000;
/** After they 👍 a linger-offer: only check location this often. */
const LONG_WATCH_MS = 20 * 60_000;
/** Still parked away from home this long after 👍'ing a dwell check-in → linger offer. */
const LINGER_AFTER_ACK_MS = 5 * 60_000;
const STATIONARY_M = 25;
const HOME_RADIUS_M = 50;
const AWAY_FROM_HOME_M = 150;
/** Distance from every usual cell centre that counts as off-route (≈ one-cell buffer). */
const OFF_ROUTE_M = 200;
const OFF_ROUTE_MS = 2 * 60_000;
const MIN_WALKS_FOR_ROUTE = 3;
const USUAL_CELLS_TTL_MS = 10 * 60_000;
const FRIEND_END_MIN = 15;
/** How far back to look for the last ping when resuming after a restart. */
const HYDRATE_LOOKBACK_MS = 60 * 60_000;
/** Open walks older than this are closed on resume instead of watched again. */
const STALE_WALK_MS = 6 * 60 * 60_000;
/** Ways to say "I'm heading out" that start a walk when none is open (R4). */
const TRIP_START_RE =
  /\b(walking home|heading (home|out|back)|on my way( home)?|going home|leaving now|start(ing)? (a |my )?(trip|walk))\b/;
/** An answered call with a pending contact step escalates if no outcome arrives by then. */
const CALL_OUTCOME_GUARD_MS = 15 * 60_000;

export type ParseReplyFn = (text: string) => Promise<ParsedReply>;

export interface BrainDeps {
  clock: Clock;
  getUser: (userId: string) => Promise<UserRecord | null>;
  parseReply?: ParseReplyFn;
  writeMessages?: WriteMessages;
  persist?: boolean;
  /** Log rule firings and outbound copy to console. */
  verbose?: boolean;
}

/** Why the open check-in was sent; decides confirm/escalation handling. */
type CheckinKind = "general" | "offroute" | "noupdate" | "linger";

interface UserRuntime {
  phase: WalkPhase;
  walkId: string | null;
  walkStartedAt: Date | null;
  /** "walk_me_home" | "prompt" | "watch" | ... — "watch" walks skip dwell/late rules. */
  walkTrigger: string | null;
  plan: WalkPlan | null;
  /** Crafted copy from writeMessages (templates if LLM off). */
  copy: Record<string, string> | null;
  pings: LocationPing[];
  /** Survives window trimming so the no-update rule can measure the gap. */
  lastPing: LocationPing | null;
  lastPromptAt: Date | null;
  lastPromptMessageId: string | null;
  cooldownUntil: Date | null;
  lastCheckinAt: Date | null;
  lastCheckinTag: SendTextTag | null;
  checkinOpenedAt: Date | null;
  checkinKind: CheckinKind | null;
  nudged: boolean;
  escalated: boolean;
  homeNearCount: number;
  suppressCheckinUntil: Date | null;
  stationarySince: Date | null;
  /** First ping of the current possible stop. */
  stationaryAnchor: LocationPing | null;
  /**
   * They 👍'd a dwell check-in while still parked away from home.
   * After LINGER_AFTER_ACK_MS of continued stillness we offer to back off.
   */
  stationaryAckedAt: Date | null;
  offRouteSince: Date | null;
  /** Cells seen during the current off-route stretch (saved on confirm). */
  offRouteCells: string[];
  /** User confirmed this trip's detour; keep saving its cells, no more R6. */
  offRouteConfirmed: boolean;
  /** Time (ms) of the ping whose silence already triggered R8. */
  noUpdateFiredFor: number | null;
  /** Consecutive pings away from home while watching and not on a walk. */
  awayPings: number;
  knownStopSince: Date | null;
  knownStopCell: string | null;
  friendSince: Date | null;
  lastShortAddress?: string;
  /**
   * CALL_THEN_CONTACT: alert the contact at `at` unless the call resolves safe.
   * Picking up only pushes `at` out to a guard for a lost end-of-call event.
   * A 👍 / ok reply also cancels it.
   */
  contactAfterCall: { at: Date; rule: "R10" | "R11"; kind: ContactAlertKind } | null;
  /**
   * Open walk was resumed past its late window (e.g. server restart).
   * Next tick/ping sends a soft "i'll walk you home" and resets the late clock
   * instead of firing a worried R7 check-in.
   */
  softRejoinPending: boolean;
  /** This walk already texted the trusted contact. Later steps must not text them again. */
  contactAlerted: boolean;
  pendingActions: Action[];
}

function emptyRuntime(): UserRuntime {
  return {
    phase: "IDLE",
    walkId: null,
    walkStartedAt: null,
    walkTrigger: null,
    plan: null,
    copy: null,
    pings: [],
    lastPing: null,
    lastPromptAt: null,
    lastPromptMessageId: null,
    cooldownUntil: null,
    lastCheckinAt: null,
    lastCheckinTag: null,
    checkinOpenedAt: null,
    checkinKind: null,
    nudged: false,
    escalated: false,
    homeNearCount: 0,
    suppressCheckinUntil: null,
    stationarySince: null,
    stationaryAnchor: null,
    stationaryAckedAt: null,
    offRouteSince: null,
    offRouteCells: [],
    offRouteConfirmed: false,
    noUpdateFiredFor: null,
    awayPings: 0,
    knownStopSince: null,
    knownStopCell: null,
    friendSince: null,
    contactAfterCall: null,
    softRejoinPending: false,
    contactAlerted: false,
    pendingActions: [],
  };
}

function brainLog(deps: BrainDeps, ...parts: unknown[]) {
  if (deps.verbose) console.log("[brain]", ...parts);
}

function isGreeting(text: string): boolean {
  return /^(hi|hey|hello|yo|sup)([!.?\s]*)$/i.test(text.trim());
}

function isAffirmativeText(text: string): boolean {
  return /^(ok|okay|fine|good|i'?m (good|fine|ok|okay)|all good|yes)([!.?\s]*)$/i.test(
    text.trim(),
  );
}

/** User wants Nook to stop watching / stop check-ins for this trip. */
function isDismissText(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (
    /^(stop|dismiss|enough|cancel|never ?mind|leave me alone|go away|not tonight)([!.?\s]*)$/i.test(
      t,
    )
  ) {
    return true;
  }
  return /\b(stop (checking|watching|texting|asking|bugging|hovering|tracking)|don'?t (need|want) (you|nook)|you can (stop|go|stand down)|end (the )?(walk|trip)|wrap(ping)? up|i'?m (good|fine|ok|okay|safe).{0,20}\bstop\b)\b/i.test(
    t,
  );
}

function isNight(now: Date, user: UserRecord): boolean {
  const tz = user.tz ?? "America/New_York";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const mins = hour * 60 + minute;
  const [nsH, nsM] = (user.nightStart ?? "22:00").split(":").map(Number);
  const [neH, neM] = (user.nightEnd ?? "06:00").split(":").map(Number);
  const start = (nsH ?? 22) * 60 + (nsM ?? 0);
  const end = (neH ?? 6) * 60 + (neM ?? 0);
  if (start === end) return true;
  if (start < end) return mins >= start && mins < end;
  return mins >= start || mins < end;
}

function localHour(now: Date, tz: string): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  return Number(hour.find((p) => p.type === "hour")?.value ?? 0);
}

function distFromHome(user: UserRecord, p: { lat: number; lon: number }): number | null {
  if (user.homeLat == null || user.homeLon == null) return null;
  return distanceM(p.lat, p.lon, user.homeLat, user.homeLon);
}

function awayFromHome(user: UserRecord, p: { lat: number; lon: number } | null): boolean {
  if (!p) return false;
  const d = distFromHome(user, p);
  return d != null && d > AWAY_FROM_HOME_M;
}

/**
 * Monitoring gate for everything outside an explicit walk (R2 prompts, passive
 * off-route and no-update checks). Explicit walks are always watched.
 */
function isWatching(user: UserRecord, now: Date, lastPing: LocationPing | null): boolean {
  switch (user.monitoringMode) {
    case "MANUAL":
      return false;
    case "AWAY_FROM_HOME":
      return awayFromHome(user, lastPing);
    case "EVENINGS":
    default:
      return isNight(now, user);
  }
}

function noResponseAction(user: UserRecord): NoResponseAction {
  if (user.escalation) return user.escalation.onNoTextResponse;
  return user.trustedContact || user.contact ? "CONTACT_TRUSTED" : "NONE";
}

/** How the trusted contact knows who the alert is about: their name, when we have one. */
function userLabel(user: UserRecord): string {
  const name = user.displayName?.trim();
  if (name && !/^\+?\d[\d\s().-]{5,}\d$/.test(name) && !/^change my name$/i.test(name)) return name;
  return prettyPhone(user.handle);
}

/** "+16463220667" → "+1 646-322-0667"; other handles unchanged. */
function prettyPhone(handle: string): string {
  const m = handle.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `+1 ${m[1]}-${m[2]}-${m[3]}` : handle;
}

function cellCenter(cell: string): { lat: number; lon: number } | null {
  const [lat, lon] = cell.split(",").map(Number);
  if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return { lat, lon };
}

function trimWindow(rt: UserRuntime, now: Date) {
  const cutoff = now.getTime() - WINDOW_MS;
  rt.pings = rt.pings.filter((p) => p.time.getTime() >= cutoff);
}

function pushPing(rt: UserRuntime, ping: LocationPing) {
  rt.pings.push(ping);
  rt.lastPing = ping;
  if (ping.shortAddress) rt.lastShortAddress = ping.shortAddress;
  trimWindow(rt, ping.time);
}

async function logRule(
  deps: BrainDeps,
  userId: string,
  ruleId: RuleId,
  walkId: string | null,
  detail: Record<string, unknown> = {},
) {
  brainLog(deps, `rule ${ruleId}`, detail, walkId ? `(walk ${walkId})` : "");
  if (deps.persist === false) return;
  try {
    await insertEvent({
      time: deps.clock.now(),
      userId,
      walkId,
      ruleId,
      detail,
    });
  } catch (err) {
    console.warn("[brain] insertEvent failed", err);
  }
}

async function persistPhase(deps: BrainDeps, rt: UserRuntime) {
  if (!rt.walkId || deps.persist === false) return;
  try {
    await updateWalkStatus(rt.walkId, rt.phase);
  } catch {
    /* ignore */
  }
}

function copyFor(rt: UserRuntime, tag: SendTextTag | "unclear"): string {
  const fromBank = rt.copy?.[tag];
  if (fromBank) return fromBank;
  if (tag === "unclear") return templates.unclear;
  return templateForTag(tag);
}

function send(
  rt: UserRuntime,
  userId: string,
  tag: SendTextTag,
  text?: string,
): Action {
  const action: Action = {
    type: "SendText",
    userId,
    text: text ?? copyFor(rt, tag),
    tag,
  };
  rt.pendingActions.push(action);
  return action;
}

function alert(
  rt: UserRuntime,
  userId: string,
  text: string,
  lat: number,
  lon: number,
  force = false,
): Action | null {
  if (rt.contactAlerted && !force) {
    console.log(`[brain] skip duplicate contact alert for ${userId}`);
    return null;
  }
  rt.contactAlerted = true;
  const action: Action = { type: "AlertContact", userId, text, lat, lon };
  rt.pendingActions.push(action);
  return action;
}

function startCall(
  rt: UserRuntime,
  userId: string,
  walkId: string,
  vars: {
    displayName: string;
    street: string;
    minutesWalking: number;
    walkId: string;
  },
): Action {
  const action: Action = { type: "StartCall", userId, walkId, vars };
  rt.pendingActions.push(action);
  return action;
}

function callVars(rt: UserRuntime, user: UserRecord, now: Date) {
  return {
    displayName: user.displayName ?? "friend",
    street: rt.lastShortAddress ?? "nearby",
    minutesWalking: rt.walkStartedAt
      ? (now.getTime() - rt.walkStartedAt.getTime()) / 60000
      : 0,
    walkId: rt.walkId!,
  };
}

function canCheckin(rt: UserRuntime, now: Date): boolean {
  if (rt.phase === "CALLING") return false;
  if (rt.suppressCheckinUntil && now < rt.suppressCheckinUntil) return false;
  if (rt.lastCheckinAt && now.getTime() - rt.lastCheckinAt.getTime() < CHECKIN_RATE_MS) {
    return false;
  }
  return true;
}

/**
 * CALLING because a check-in went unanswered (not ‼️ / "call me"): a 👍 or
 * "ok" reply still counts as the user responding.
 */
function awaitingCallReply(rt: UserRuntime): boolean {
  return rt.phase === "CALLING" && rt.escalated;
}

function openCheckin(
  rt: UserRuntime,
  userId: string,
  now: Date,
  tag: SendTextTag,
  text?: string,
  kind: CheckinKind = "general",
): boolean {
  if (!canCheckin(rt, now)) return false;
  send(rt, userId, tag, text);
  rt.phase = "CHECKING_IN";
  rt.lastCheckinAt = now;
  rt.lastCheckinTag = tag;
  rt.checkinOpenedAt = now;
  rt.checkinKind = kind;
  rt.nudged = false;
  rt.escalated = false;
  return true;
}

/** User answered a check-in (👍 or an "ok" reply). */
function resumeWalking(rt: UserRuntime, now: Date, snoozeMs = CHECKIN_SNOOZE_MS) {
  rt.phase = "WALKING";
  rt.checkinOpenedAt = null;
  rt.checkinKind = null;
  rt.nudged = false;
  rt.escalated = false;
  rt.contactAfterCall = null;
  rt.suppressCheckinUntil = new Date(now.getTime() + snoozeMs);
}

async function buildPlan(
  user: UserRecord,
  originLat: number,
  originLon: number,
): Promise<WalkPlan> {
  const homeLat = user.homeLat ?? originLat;
  const homeLon = user.homeLon ?? originLon;
  const originCell = toCell(originLat, originLon);
  let plan = buildDefaultPlan(
    originLat,
    originLon,
    homeLat,
    homeLon,
    distanceM,
  );

  try {
    const baseline = await loadWalkBaselines(user.userId, originCell);
    if (baseline && baseline.n >= 3) {
      plan.expectedMin = baseline.p50Min;
      plan.lateMin = Math.max(baseline.p90Min * 1.25, plan.expectedMin + 5);
    }

    const stops = await loadKnownStops(user.userId);
    plan.stops = stops.map((s) => {
      const p90 = s.p90DwellMin ?? 0;
      const ok = s.okDwellMin ?? 0;
      let allowed = Math.max(ok, p90 + 2, 10);
      const cap = s.kind === "friend" ? 60 : 30;
      allowed = Math.min(allowed, cap);
      return {
        cell: s.cell,
        label: s.label ?? undefined,
        kind: s.kind ?? undefined,
        allowedDwellMin: allowed,
      };
    });
  } catch {
    // DB optional during early sim — keep default plan
  }
  return plan;
}

async function beginWalk(
  deps: BrainDeps,
  rt: UserRuntime,
  user: UserRecord,
  now: Date,
  trigger: string,
  originLat: number,
  originLon: number,
) {
  const walkId = `walk-${crypto.randomUUID().slice(0, 8)}`;
  const plan = await buildPlan(user, originLat, originLon);
  rt.walkId = walkId;
  rt.walkStartedAt = now;
  rt.walkTrigger = trigger;
  rt.plan = plan;
  rt.phase = "WALKING";
  rt.homeNearCount = 0;
  rt.checkinOpenedAt = null;
  rt.checkinKind = null;
  rt.nudged = false;
  rt.escalated = false;
  rt.stationarySince = null;
  rt.stationaryAnchor = null;
  rt.stationaryAckedAt = null;
  rt.knownStopSince = null;
  rt.friendSince = null;
  rt.awayPings = 0;
  rt.contactAlerted = false;

  if (deps.writeMessages) {
    try {
      rt.copy = await deps.writeMessages(plan);
      brainLog(deps, "writeMessages ready", Object.keys(rt.copy));
    } catch (err) {
      console.warn("[brain] writeMessages failed", err);
      rt.copy = null;
    }
  } else {
    rt.copy = null;
  }

  brainLog(
    deps,
    `beginWalk ${walkId} trigger=${trigger} expected=${plan.expectedMin.toFixed(0)}m late=${plan.lateMin.toFixed(0)}m`,
  );

  if (deps.persist !== false) {
    try {
      await insertWalk({
        walkId,
        userId: user.userId,
        trigger,
        startedAt: now,
        originCell: toCell(originLat, originLon),
        originLat,
        originLon,
        status: "WALKING",
        expectedMin: plan.expectedMin,
        lateMin: plan.lateMin,
      });
    } catch (err) {
      console.warn("[brain] insertWalk failed", err);
    }
  }
}

async function endWalk(
  deps: BrainDeps,
  rt: UserRuntime,
  status: WalkPhase,
  now: Date,
) {
  const walkId = rt.walkId;
  rt.phase = "IDLE";
  brainLog(deps, `endWalk ${walkId} → ${status}`);
  if (walkId && deps.persist !== false) {
    try {
      await updateWalkStatus(walkId, status, now);
    } catch (err) {
      console.warn("[brain] updateWalkStatus failed", err);
    }
  }
  rt.walkId = null;
  rt.walkStartedAt = null;
  rt.walkTrigger = null;
  rt.plan = null;
  rt.copy = null;
  rt.homeNearCount = 0;
  rt.checkinOpenedAt = null;
  rt.checkinKind = null;
  rt.nudged = false;
  rt.escalated = false;
  rt.offRouteSince = null;
  rt.offRouteCells = [];
  rt.offRouteConfirmed = false;
  rt.awayPings = 0;
  rt.stationaryAckedAt = null;
  rt.contactAfterCall = null;
  rt.softRejoinPending = false;
  rt.contactAlerted = false;
}

interface UsualCells {
  loadedAt: number;
  enabled: boolean;
  cells: Set<string>;
  points: { lat: number; lon: number }[];
}

export function createBrainEngine(deps: BrainDeps) {
  const states = new Map<string, UserRuntime>();
  const hydrated = new Set<string>();
  const usualCache = new Map<string, UsualCells>();
  let bootHydrated = false;

  // handle() and tick() share per-user runtime; run them one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  }

  function rtFor(userId: string): UserRuntime {
    let rt = states.get(userId);
    if (!rt) {
      rt = emptyRuntime();
      states.set(userId, rt);
    }
    return rt;
  }

  async function ensureHydrated(userId: string) {
    const rt = rtFor(userId);
    if (hydrated.has(userId) || deps.persist === false) return;
    hydrated.add(userId);
    if (rt.walkId) return;
    try {
      const open = await getOpenWalk(userId);
      if (!open) return;
      const now = deps.clock.now();
      if (now.getTime() - open.startedAt.getTime() > STALE_WALK_MS) {
        await updateWalkStatus(open.walkId, "ENDED_ELSEWHERE", now);
        brainLog(deps, `closed stale ${open.walkId} for ${userId} (started ${open.startedAt.toISOString()})`);
        return;
      }
      const recent = (
        await loadRecentPings(userId, new Date(now.getTime() - HYDRATE_LOOKBACK_MS))
      ).filter((p) => p.time <= now);
      rt.lastPing = recent[recent.length - 1] ?? null;
      rt.pings = recent.filter((p) => p.time.getTime() >= now.getTime() - WINDOW_MS);

      rt.walkId = open.walkId;
      rt.walkStartedAt = open.startedAt;
      rt.walkTrigger = open.trigger;
      rt.phase = open.status === "ARRIVED" || open.status === "ENDED_ELSEWHERE"
        ? "IDLE"
        : open.status;
      // Reply timers restart from the resume point.
      if (rt.phase === "CHECKING_IN") {
        rt.checkinOpenedAt = now;
        rt.checkinKind = "general";
      }
      if (open.expectedMin != null && open.lateMin != null) {
        rt.plan = {
          expectedMin: open.expectedMin,
          lateMin: open.lateMin,
          routeCells: [],
          bufferM: 150,
          stops: [],
        };
      }

      // Already past the late window (common after a restart mid-trip): soft-rejoin
      // instead of immediately firing "Still out? Getting worried".
      const lateMin = open.lateMin ?? 30;
      const elapsedMin = (now.getTime() - open.startedAt.getTime()) / 60_000;
      if (rt.phase !== "IDLE" && elapsedMin > lateMin) {
        rt.phase = "WALKING";
        rt.walkStartedAt = now;
        rt.checkinOpenedAt = null;
        rt.checkinKind = null;
        rt.nudged = false;
        rt.escalated = false;
        rt.suppressCheckinUntil = new Date(now.getTime() + CHECKIN_SNOOZE_MS);
        let alreadyRejoined = false;
        try {
          const prev = await query(
            `SELECT 1 FROM events WHERE walk_id = $1 AND detail->>'step' = 'soft_rejoin' LIMIT 1`,
            [open.walkId],
          );
          alreadyRejoined = prev.rows.length > 0;
        } catch {
          /* a failed lookup still sends the one rejoin text */
        }
        rt.softRejoinPending = !alreadyRejoined;
        brainLog(
          deps,
          alreadyRejoined
            ? `soft-rejoin ${open.walkId} for ${userId} already sent; resuming quietly`
            : `soft-rejoin ${open.walkId} for ${userId} (was ${elapsedMin.toFixed(0)}m / late=${lateMin}m)`,
        );
      } else {
        brainLog(deps, `resumed ${open.walkId} (${rt.phase}) for ${userId}`);
      }
    } catch (err) {
      console.warn("[brain] hydrate failed", err);
    }
  }

  async function usualCellsFor(userId: string, now: Date): Promise<UsualCells | null> {
    const cached = usualCache.get(userId);
    if (cached && now.getTime() - cached.loadedAt < USUAL_CELLS_TTL_MS) return cached;
    if (deps.persist === false) return null;
    try {
      const res = await loadUsualCells(userId);
      const cells = new Set(res.cells);
      const entry: UsualCells = {
        loadedAt: now.getTime(),
        enabled: res.walkCount >= MIN_WALKS_FOR_ROUTE || res.confirmedCount > 0,
        cells,
        points: [...cells].map(cellCenter).filter((p): p is { lat: number; lon: number } => p != null),
      };
      usualCache.set(userId, entry);
      return entry;
    } catch (err) {
      console.warn("[brain] loadUsualCells failed", err);
      return null;
    }
  }

  /** Unfamiliar-area notice without opening CHECKING_IN (R5b can still fire). */
  async function noticeIfUnfamiliar(
    rt: UserRuntime,
    user: UserRecord,
    now: Date,
    originLat: number,
    originLon: number,
  ): Promise<boolean> {
    const cell = toCell(originLat, originLon);
    const usual = await usualCellsFor(user.userId, now);
    if (!usual?.enabled) {
      brainLog(deps, "unfamiliar skipped — usual route not enabled yet");
      return false;
    }
    if (usual.cells.has(cell) || nearestUsualM(usual, { lat: originLat, lon: originLon }) <= OFF_ROUTE_M) {
      brainLog(deps, `familiar cell ${cell} (${usual.cells.size} usual cells)`);
      return false;
    }
    send(rt, user.userId, "checkin", copy.unfamiliarArea);
    brainLog(deps, `unfamiliar notice cell=${cell} usual=${usual.cells.size}`);
    return true;
  }

  function nearestUsualM(usual: UsualCells, p: { lat: number; lon: number }): number {
    let best = Infinity;
    for (const c of usual.points) {
      const d = distanceM(p.lat, p.lon, c.lat, c.lon);
      if (d < best) best = d;
    }
    return best;
  }

  async function saveConfirmedCells(userId: string, cells: string[], now: Date) {
    const fresh = [...new Set(cells)];
    if (fresh.length === 0) return;
    const usual = usualCache.get(userId);
    if (usual) {
      for (const cell of fresh) {
        if (usual.cells.has(cell)) continue;
        usual.cells.add(cell);
        const c = cellCenter(cell);
        if (c) usual.points.push(c);
      }
      usual.enabled = true;
    }
    if (deps.persist === false) return;
    try {
      await insertConfirmedCells(userId, fresh);
    } catch (err) {
      console.warn("[brain] insertConfirmedCells failed", err);
    }
    brainLog(deps, `confirmed ${fresh.length} cells for ${userId} at ${now.toISOString()}`);
  }

  /** Off-route confirmed by 👍 or an "ok" reply: add this stretch to the usual route. */
  async function confirmOffRoute(rt: UserRuntime, user: UserRecord, now: Date, placeLabel?: string) {
    const cells = [...rt.offRouteCells];
    if (rt.lastPing) cells.push(toCell(rt.lastPing.lat, rt.lastPing.lon));
    await saveConfirmedCells(user.userId, cells, now);
    rt.offRouteConfirmed = true;
    rt.offRouteSince = null;
    rt.offRouteCells = [];
    await logRule(deps, user.userId, "R6", rt.walkId, {
      step: "confirmed",
      cells: new Set(cells).size,
      ...(placeLabel ? { placeLabel } : {}),
    });
  }

  /**
   * The "then contact" step of CALL_THEN_CONTACT. `onCall`: the call is still
   * up (user asked for escalation mid-call), so stay CALLING.
   */
  async function contactAfterCallNow(
    rt: UserRuntime,
    user: UserRecord,
    reason: "timeout" | "ended_unresolved" | "request_escalation",
    onCall: boolean,
  ) {
    const pending = rt.contactAfterCall;
    if (!pending) return;
    rt.contactAfterCall = null;
    const last = rt.lastPing;
    alert(
      rt,
      user.userId,
      contactAlert(reason === "request_escalation" ? "help" : pending.kind, userLabel(user)),
      last?.lat ?? user.homeLat ?? 0,
      last?.lon ?? user.homeLon ?? 0,
    );
    rt.phase = onCall ? "CALLING" : "ALERTED";
    await persistPhase(deps, rt);
    await logRule(deps, user.userId, pending.rule, rt.walkId, { step: "contact_after_call", reason });
  }

  /** Final step after check-in + nudge go unanswered, per the user's choice. */
  async function escalate(rt: UserRuntime, user: UserRecord, now: Date) {
    const action = noResponseAction(user);
    const steps = escalationSteps(action);
    const last = rt.lastPing;
    const lat = last?.lat ?? user.homeLat ?? 0;
    const lon = last?.lon ?? user.homeLon ?? 0;
    const kind: ContactAlertKind = rt.checkinKind === "offroute" ? "offroute" : "quiet";
    rt.escalated = true;
    if (action === "NONE") {
      // Floor: never go fully silent, but don't involve anyone.
      send(rt, user.userId, "nudge", templates.finalNudge);
    } else if (steps[0] === "CONTACT_TRUSTED") {
      alert(rt, user.userId, contactAlert(kind, userLabel(user)), lat, lon);
      rt.phase = "ALERTED";
    } else {
      rt.phase = "CALLING";
      startCall(rt, user.userId, rt.walkId!, callVars(rt, user, now));
      if (steps.includes("CONTACT_TRUSTED")) {
        const waitMs = resolveTimeouts(user.timeouts).escalateAfterSec * 1000;
        rt.contactAfterCall = { at: new Date(now.getTime() + waitMs), rule: "R10", kind };
      }
    }
    await persistPhase(deps, rt);
    await logRule(deps, user.userId, "R10", rt.walkId, {
      step: "escalate",
      action,
      kind: rt.checkinKind,
    });
  }

  /**
   * Every rule that depends on elapsed time rather than a new ping. Runs on
   * each ping and on the 30 s tick, so silence alone can still trigger it.
   */
  async function evaluateTimers(rt: UserRuntime, user: UserRecord, now: Date) {
    const timeouts = resolveTimeouts(user.timeouts);

    // Soft rejoin after resuming an overdue walk (server restart mid-trip).
    if (rt.softRejoinPending && rt.walkId) {
      rt.softRejoinPending = false;
      send(rt, user.userId, "started", copy.nightOut);
      brainLog(deps, "soft-rejoin → nightOut (tracking, no check-in)");
      await logRule(deps, user.userId, "R7a", rt.walkId, { step: "soft_rejoin" });
    }

    // R3 timeout: PROMPTED + 10 min
    if (rt.phase === "PROMPTED" && rt.lastPromptAt) {
      if (now.getTime() - rt.lastPromptAt.getTime() >= PROMPT_TIMEOUT_MS) {
        rt.phase = "IDLE";
        rt.cooldownUntil = new Date(now.getTime() + 60 * 60_000);
        await logRule(deps, user.userId, "R3", null, { reply: "timeout" });
      }
    }

    // R10: nudge, then the escalation policy
    if (rt.phase === "CHECKING_IN" && rt.checkinOpenedAt && !rt.escalated && rt.walkId) {
      const since = now.getTime() - rt.checkinOpenedAt.getTime();
      const nudgeAt = timeouts.nudgeAfterSec * 1000;
      const escalateAt = nudgeAt + timeouts.escalateAfterSec * 1000;

      // Linger offer: silence means "assume you're good" — wrap up, don't escalate.
      if (rt.checkinKind === "linger") {
        if (since >= escalateAt) {
          send(rt, user.userId, "ended", templates.lingerDrop);
          await endWalk(deps, rt, "ENDED_ELSEWHERE", now);
          await logRule(deps, user.userId, "R5b", null, { step: "linger_drop" });
        }
      } else if (!rt.nudged && since >= nudgeAt) {
        const next = nextStepLine(noResponseAction(user), timeouts.escalateAfterSec, user.trustedContact?.name);
        send(rt, user.userId, "nudge", [copyFor(rt, "nudge"), next].filter(Boolean).join(" "));
        rt.nudged = true;
        await logRule(deps, user.userId, "R10", rt.walkId, { step: "nudge", kind: rt.checkinKind });
      } else if (rt.nudged && since >= escalateAt) {
        await escalate(rt, user, now);
      }
    }

    // CALL_THEN_CONTACT: no safe outcome from the call in time, so reach the contact.
    if (rt.contactAfterCall && now >= rt.contactAfterCall.at) {
      await contactAfterCallNow(rt, user, "timeout", false);
    }

    // R8: no location update for noUpdateMin (walks, or away from home while watching)
    const last = rt.lastPing;
    if (last && rt.noUpdateFiredFor !== last.time.getTime()) {
      const gapMs = now.getTime() - last.time.getTime();
      if (gapMs >= timeouts.noUpdateMin * 60_000) {
        const walking = rt.phase === "WALKING" && rt.walkId != null;
        const passive =
          rt.phase === "IDLE" && isWatching(user, now, last) && awayFromHome(user, last);
        if ((walking || passive) && canCheckin(rt, now)) {
          if (passive) await beginWalk(deps, rt, user, now, "watch", last.lat, last.lon);
          openCheckin(rt, user.userId, now, "checkin", templates.checkinNoUpdate, "noupdate");
          rt.noUpdateFiredFor = last.time.getTime();
          await logRule(deps, user.userId, "R8", rt.walkId, {
            gapMin: Math.round(gapMs / 6000) / 10,
            passive,
          });
        }
      }
    }

    if (rt.phase !== "WALKING" || !rt.walkId || rt.walkTrigger === "watch") return;

    // R5a / R15: dwell at a known stop
    const known = rt.knownStopCell
      ? rt.plan?.stops.find((s) => s.cell === rt.knownStopCell)
      : undefined;
    if (known && rt.knownStopSince) {
      const dwellMin = (now.getTime() - rt.knownStopSince.getTime()) / 60000;
      if (known.kind === "friend" && rt.friendSince) {
        const friendMin = (now.getTime() - rt.friendSince.getTime()) / 60000;
        if (friendMin > FRIEND_END_MIN) {
          await logRule(deps, user.userId, "R15", rt.walkId, { friendMin });
          await endWalk(deps, rt, "ENDED_ELSEWHERE", now);
          return;
        }
      }
      // Silent until the allowed dwell, then a check-in.
      if (dwellMin > known.allowedDwellMin && canCheckin(rt, now)) {
        openCheckin(rt, user.userId, now, "checkin");
        await logRule(deps, user.userId, "R5a", rt.walkId, {
          dwellMin,
          allowed: known.allowedDwellMin,
        });
      }
    } else if (rt.stationarySince) {
      // R5b: 3 min stationary (2 min after midnight)
      const afterMidnight = localHour(now, user.tz ?? "America/New_York") < 6;
      const thresholdMin = afterMidnight ? 2 : 3;
      const dwellMin = (now.getTime() - rt.stationarySince.getTime()) / 60000;
      if (dwellMin >= thresholdMin && canCheckin(rt, now)) {
        openCheckin(rt, user.userId, now, "checkin");
        await logRule(deps, user.userId, "R5b", rt.walkId, {
          dwellMin,
          thresholdMin,
        });
      }

      // Still parked away from home after they already 👍'd a dwell check-in → linger offer
      if (
        rt.phase === "WALKING" &&
        rt.stationaryAckedAt &&
        awayFromHome(user, rt.lastPing) &&
        now.getTime() - rt.stationaryAckedAt.getTime() >= LINGER_AFTER_ACK_MS &&
        canCheckin(rt, now)
      ) {
        openCheckin(rt, user.userId, now, "checkin", templates.lingerOffer, "linger");
        await logRule(deps, user.userId, "R5b", rt.walkId, {
          step: "linger_offer",
          dwellMin,
        });
        brainLog(deps, "linger offer — still parked after dwell 👍");
      }
    }

    // R7 late
    if (rt.phase === "WALKING" && rt.plan && rt.walkStartedAt) {
      const elapsedMin = (now.getTime() - rt.walkStartedAt.getTime()) / 60000;
      if (elapsedMin > rt.plan.lateMin + 10 && canCheckin(rt, now)) {
        openCheckin(
          rt,
          user.userId,
          now,
          "checkin",
          rt.copy?.checkin
            ? `${rt.copy.checkin} (still out, getting worried)`
            : "still out? getting worried. tap 👍.",
        );
        await logRule(deps, user.userId, "R7b", rt.walkId, { elapsedMin });
      } else if (elapsedMin > rt.plan.lateMin && canCheckin(rt, now)) {
        openCheckin(rt, user.userId, now, "checkin");
        await logRule(deps, user.userId, "R7a", rt.walkId, { elapsedMin });
      }
    }
  }

  /** R6: compare against usual cells while on a walk, or while watching away from home. */
  async function trackOffRoute(
    rt: UserRuntime,
    user: UserRecord,
    now: Date,
    ping: LocationPing,
    passive: boolean,
  ) {
    const usual = await usualCellsFor(user.userId, now);
    if (!usual?.enabled || usual.points.length === 0) return;
    const cell = toCell(ping.lat, ping.lon);
    const distM = nearestUsualM(usual, ping);
    if (distM <= OFF_ROUTE_M) {
      rt.offRouteSince = null;
      rt.offRouteCells = [];
      return;
    }
    if (rt.offRouteConfirmed) {
      // Confirmed detour: the rest of this trip becomes part of the usual route.
      await saveConfirmedCells(user.userId, [cell], now);
      return;
    }
    if (!rt.offRouteSince) rt.offRouteSince = now;
    if (!rt.offRouteCells.includes(cell)) rt.offRouteCells.push(cell);
    if (now.getTime() - rt.offRouteSince.getTime() < OFF_ROUTE_MS) return;
    if (!canCheckin(rt, now)) return;
    if (passive) await beginWalk(deps, rt, user, now, "watch", ping.lat, ping.lon);
    openCheckin(rt, user.userId, now, "checkin", templates.checkinOffRoute, "offroute");
    await logRule(deps, user.userId, "R6", rt.walkId, {
      distM: Math.round(distM),
      offMin: Math.round((now.getTime() - rt.offRouteSince.getTime()) / 6000) / 10,
      passive,
    });
  }

  /**
   * Stationary + known-stop tracking for the timer-driven dwell rules.
   * Distance is measured from where the user stopped, not from the previous
   * ping: frequent pings on a slow walk are each < STATIONARY_M apart.
   */
  function trackDwell(rt: UserRuntime, prev: LocationPing | null, ping: LocationPing, now: Date) {
    if (!rt.stationaryAnchor) rt.stationaryAnchor = prev ?? ping;
    const anchor = rt.stationaryAnchor;
    if (distanceM(anchor.lat, anchor.lon, ping.lat, ping.lon) < STATIONARY_M) {
      if (!rt.stationarySince && anchor !== ping) rt.stationarySince = anchor.time;
    } else {
      rt.stationaryAnchor = ping;
      rt.stationarySince = null;
      rt.stationaryAckedAt = null;
      rt.knownStopSince = null;
      rt.knownStopCell = null;
      rt.friendSince = null;
    }
    const cell = toCell(ping.lat, ping.lon);
    const known = rt.plan?.stops.find((s) => s.cell === cell);
    if (known) {
      if (rt.knownStopCell !== cell) {
        rt.knownStopCell = cell;
        rt.knownStopSince = now;
        rt.friendSince = known.kind === "friend" ? now : null;
      }
      if (!rt.stationarySince) rt.stationarySince = rt.knownStopSince ?? now;
    } else {
      rt.knownStopCell = null;
      rt.knownStopSince = null;
      rt.friendSince = null;
    }
  }

  async function onLocationPing(rt: UserRuntime, user: UserRecord, event: LocationPing, now: Date) {
    const prev = rt.lastPing;
    pushPing(rt, event);
    if (deps.persist !== false) {
      try {
        await insertLocationPing(event, rt.walkId);
      } catch (err) {
        console.warn("[brain] insertLocationPing failed", err);
      }
    }

    // R1: outside the monitoring mode, pings are only stored.
    const watching = isWatching(user, now, event);
    const distHome = distFromHome(user, event);
    const onWalk =
      rt.walkId != null &&
      (rt.phase === "WALKING" ||
        rt.phase === "CHECKING_IN" ||
        rt.phase === "ALERTED" ||
        rt.phase === "CALLING");

    // R14: two pings within 50 m of home
    if (distHome != null && distHome <= HOME_RADIUS_M) {
      rt.homeNearCount += 1;
      if (rt.homeNearCount >= 2 && (onWalk || (rt.phase === "IDLE" && rt.awayPings >= 2))) {
        send(rt, user.userId, "arrived", templates.arrived);
        await logRule(deps, user.userId, "R14", rt.walkId, { via: onWalk ? "walk" : "watch" });
        if (onWalk) await endWalk(deps, rt, "ARRIVED", now);
        rt.awayPings = 0;
        rt.homeNearCount = 0;
        return;
      }
    } else {
      rt.homeNearCount = 0;
    }

    if (rt.phase === "IDLE") {
      if (watching && distHome != null && distHome > AWAY_FROM_HOME_M) rt.awayPings += 1;

      // R2 prompt
      if (!watching) {
        /* R1 */
      } else if (rt.cooldownUntil && now < rt.cooldownUntil) {
        /* cool */
      } else if (
        rt.lastPromptAt &&
        now.getTime() - rt.lastPromptAt.getTime() < PROMPT_COOLDOWN_MS
      ) {
        /* already prompted */
      } else if (distHome != null && rt.pings.length >= 2) {
        const win = rt.pings;
        const first = win[0]!;
        const last = win[win.length - 1]!;
        const elapsedS = (last.time.getTime() - first.time.getTime()) / 1000;
        const moved = pathLengthM(win);
        const spd = speedMps(first.lat, first.lon, first.time, last.lat, last.lon, last.time);
        if (spd > 3) {
          await logRule(deps, user.userId, "R2x", null, { speed: spd });
          brainLog(deps, "R2x skip prompt — vehicle speed", spd);
        } else if (
          elapsedS >= 120 &&
          spd >= 0.7 &&
          spd <= 2.2 &&
          moved >= 120 &&
          distHome > AWAY_FROM_HOME_M
        ) {
          const usual = await usualCellsFor(user.userId, now);
          const cell = toCell(last.lat, last.lon);
          const unfamiliar =
            !!usual?.enabled &&
            !usual.cells.has(cell) &&
            nearestUsualM(usual, last) > OFF_ROUTE_M;
          await beginWalk(deps, rt, user, now, unfamiliar ? "night_unfamiliar" : "night", last.lat, last.lon);
          send(
            rt,
            user.userId,
            "started",
            unfamiliar ? copy.nightOutUnfamiliar : copy.nightOut,
          );
          brainLog(
            deps,
            `R2 night → beginWalk cell=${cell} unfamiliar=${unfamiliar} usual=${usual?.cells.size ?? 0}`,
          );
          await logRule(deps, user.userId, "R2", rt.walkId, {
            speed: spd,
            moved,
            distHome,
            unfamiliar,
            autoStart: true,
          });
        }
      }
    }

    if (onWalk) trackDwell(rt, prev, event, now);

    const passive = rt.phase === "IDLE" && watching && distHome != null && distHome > AWAY_FROM_HOME_M;
    if ((rt.phase === "WALKING" && rt.walkId) || passive || (onWalk && rt.offRouteConfirmed)) {
      await trackOffRoute(rt, user, now, event, passive);
    }

    await evaluateTimers(rt, user, now);
  }

  async function handleEvent(event: Event): Promise<Action[]> {
    await ensureHydrated(event.userId);
    const rt = rtFor(event.userId);
    rt.pendingActions = [];
    const user = await deps.getUser(event.userId);
    if (!user) {
      console.warn("[brain] unknown user", event.userId);
      return [];
    }
    const now = event.type === "LocationPing" ? event.time : deps.clock.now();

    // --- R11 / call me / help floors first on text/reaction ---
    if (event.type === "UserReaction" && event.emoji === "‼️") {
      if (rt.phase === "WALKING" || rt.phase === "CHECKING_IN" || rt.phase === "IDLE") {
        if (!rt.walkId) {
          const last = rt.lastPing;
          await beginWalk(
            deps,
            rt,
            user,
            now,
            "call_me",
            last?.lat ?? user.homeLat ?? 0,
            last?.lon ?? user.homeLon ?? 0,
          );
        }
        rt.phase = "CALLING";
        startCall(rt, user.userId, rt.walkId!, callVars(rt, user, now));
        await logRule(deps, user.userId, "R11", rt.walkId, { via: "reaction" });
        await persistPhase(deps, rt);
        return rt.pendingActions;
      }
    }

    if (event.type === "UserText") {
      const raw = event.text.trim();
      const lower = raw.toLowerCase();
      brainLog(deps, `text phase=${rt.phase}`, JSON.stringify(raw.slice(0, 80)));

      if (lower === "call me" || lower.includes("call me")) {
        if (!rt.walkId) {
          const last = rt.lastPing;
          await beginWalk(
            deps,
            rt,
            user,
            now,
            "call_me",
            last?.lat ?? user.homeLat ?? 0,
            last?.lon ?? user.homeLon ?? 0,
          );
        }
        rt.phase = "CALLING";
        startCall(rt, user.userId, rt.walkId!, callVars(rt, user, now));
        await logRule(deps, user.userId, "R11", rt.walkId, { via: "text" });
        await persistPhase(deps, rt);
        return rt.pendingActions;
      }

      // Dismiss: stop watching / stop check-ins for this trip
      if (isDismissText(raw)) {
        brainLog(deps, "intent=dismiss");
        const hadTrip =
          rt.walkId != null ||
          rt.phase === "PROMPTED" ||
          rt.phase === "CHECKING_IN" ||
          rt.phase === "CALLING" ||
          rt.phase === "ALERTED";
        const walkId = rt.walkId;
        rt.contactAfterCall = null;
        if (rt.walkId) await endWalk(deps, rt, "ENDED_ELSEWHERE", now);
        else {
          rt.phase = "IDLE";
          rt.checkinOpenedAt = null;
          rt.checkinKind = null;
          rt.nudged = false;
          rt.escalated = false;
        }
        rt.cooldownUntil = new Date(now.getTime() + PROMPT_COOLDOWN_MS);
        send(rt, user.userId, "ended", hadTrip ? copy.dismissed : copy.dismissedIdle);
        await logRule(deps, user.userId, "R3", walkId, { reply: "dismiss" });
        return rt.pendingActions;
      }

      // Greeting — never a check-in
      if (isGreeting(raw)) {
        brainLog(deps, "intent=greeting skip R9b");
        if (rt.phase === "PROMPTED") {
          send(rt, user.userId, "prompt", copy.greetingPrompted);
        } else if (
          rt.phase === "WALKING" ||
          rt.phase === "CHECKING_IN" ||
          rt.phase === "ALERTED" ||
          rt.phase === "CALLING"
        ) {
          send(rt, user.userId, "nudge", copy.greetingWalking);
        } else {
          send(rt, user.userId, "prompt", copy.greetingIdle);
        }
        return rt.pendingActions;
      }

      // R4 start intent — even while standing still
      if (lower.includes("walk me home") || (!rt.walkId && TRIP_START_RE.test(lower))) {
        if (rt.walkId) await endWalk(deps, rt, "ENDED_ELSEWHERE", now);
        const last = rt.lastPing;
        const originLat = last?.lat ?? user.homeLat ?? DEMO_FALLBACK.lat;
        const originLon = last?.lon ?? user.homeLon ?? DEMO_FALLBACK.lon;
        await beginWalk(deps, rt, user, now, "walk_me_home", originLat, originLon);
        send(rt, user.userId, "started", templates.started);
        await logRule(deps, user.userId, "R4", rt.walkId);
        await noticeIfUnfamiliar(rt, user, now, originLat, originLon);
        return rt.pendingActions;
      }

      // Affirmative text only resolves check-in / prompt
      if (isAffirmativeText(raw) && rt.phase === "PROMPTED") {
        brainLog(deps, "intent=ok (affirmative text) PROMPTED");
        const last = rt.lastPing;
        const originLat = last?.lat ?? user.homeLat ?? 0;
        const originLon = last?.lon ?? user.homeLon ?? 0;
        await beginWalk(deps, rt, user, now, "prompt", originLat, originLon);
        send(rt, user.userId, "started", templates.started);
        await logRule(deps, user.userId, "R3", rt.walkId, { reply: "text_ok" });
        await noticeIfUnfamiliar(rt, user, now, originLat, originLon);
        return rt.pendingActions;
      }
      if (isAffirmativeText(raw) && rt.phase === "CHECKING_IN") {
        brainLog(deps, "intent=ok (affirmative text) CHECKING_IN");
        if (rt.checkinKind === "offroute") await confirmOffRoute(rt, user, now);
        if (rt.checkinKind === "linger") {
          rt.stationaryAckedAt = null;
          resumeWalking(rt, now, LONG_WATCH_MS);
          brainLog(deps, "linger accept → long watch 20m");
          await persistPhase(deps, rt);
          await logRule(deps, user.userId, "R9a", rt.walkId, { lingerLongWatch: true });
          return rt.pendingActions;
        }
        const wasDwell = rt.checkinKind === "general" || rt.checkinKind === null;
        if (wasDwell && rt.stationarySince && awayFromHome(user, rt.lastPing)) {
          rt.stationaryAckedAt = now;
        }
        resumeWalking(rt, now);
        await persistPhase(deps, rt);
        await logRule(deps, user.userId, "R9a", rt.walkId, { via: "text" });
        return rt.pendingActions;
      }
      if (isAffirmativeText(raw) && rt.phase === "IDLE") {
        brainLog(deps, "intent=ok ignored in IDLE → greeting");
        send(rt, user.userId, "prompt", copy.greetingIdle);
        return rt.pendingActions;
      }

      // Help / ok / unclear via parseReply — help from any phase including IDLE
      const inWalkReply =
        rt.phase === "CHECKING_IN" ||
        rt.phase === "WALKING" ||
        rt.phase === "ALERTED" ||
        awaitingCallReply(rt);
      const parse = deps.parseReply ?? (async () => ({ status: "unclear" as const }));
      let parsed: ParsedReply;
      try {
        parsed = await parse(raw);
      } catch {
        parsed = { status: "unclear" };
        brainLog(deps, "parseReply error → unclear");
      }
      brainLog(deps, `parseReply → ${parsed.status}`, parsed.placeLabel ?? "");

      if (parsed.status === "help") {
        const last = rt.lastPing;
        if (!rt.walkId) {
          await beginWalk(
            deps,
            rt,
            user,
            now,
            "help",
            last?.lat ?? user.homeLat ?? DEMO_FALLBACK.lat,
            last?.lon ?? user.homeLon ?? DEMO_FALLBACK.lon,
          );
        }
        rt.phase = "CALLING";
        rt.contactAfterCall = null;
        rt.checkinOpenedAt = null;
        rt.nudged = false;
        rt.escalated = true;
        // Help always texts the trusted contact. Only place a call when voice is configured —
        // otherwise StartCall used to fail and stack callFailed + a second contact attempt.
        if (voiceConfigFromEnv()) {
          startCall(rt, user.userId, rt.walkId!, callVars(rt, user, now));
        } else {
          rt.phase = "ALERTED";
          brainLog(deps, "help: calls off → contact only");
        }
        alert(
          rt,
          user.userId,
          contactAlert("help", userLabel(user)),
          last?.lat ?? user.homeLat ?? 0,
          last?.lon ?? user.homeLon ?? 0,
          true,
        );
        brainLog(deps, "parseReply → help escalate=contact");
        await logRule(deps, user.userId, "R9b", rt.walkId, {
          status: "help",
          escalate: "contact",
        });
        await persistPhase(deps, rt);
        return rt.pendingActions;
      }

      if (parsed.status === "ok" && inWalkReply) {
        await logRule(deps, user.userId, "R9b", rt.walkId, { status: "ok" });
        const last = rt.lastPing;
        if (parsed.placeLabel && last && deps.persist !== false) {
          try {
            await upsertPlaceLabel({
              userId: user.userId,
              cell: toCell(last.lat, last.lon),
              lat: last.lat,
              lon: last.lon,
              label: parsed.placeLabel,
              source: "user",
            });
          } catch {
            /* ignore */
          }
        }
        if (rt.checkinKind === "linger") {
          rt.stationaryAckedAt = null;
          resumeWalking(rt, now, LONG_WATCH_MS);
          brainLog(deps, "linger accept (text) → long watch 20m");
          return rt.pendingActions;
        }
        if (rt.checkinKind === "offroute") {
          await confirmOffRoute(rt, user, now, parsed.placeLabel);
          resumeWalking(rt, now);
          return rt.pendingActions;
        }
        if (parsed.placeLabel || /at .+|i'?m at|staying/i.test(raw)) {
          await endWalk(deps, rt, "ENDED_ELSEWHERE", now);
          await logRule(deps, user.userId, "R15", null, { via: "reply" });
          return rt.pendingActions;
        }
        if (
          (rt.checkinKind === "general" || rt.checkinKind === null) &&
          rt.stationarySince &&
          awayFromHome(user, rt.lastPing)
        ) {
          rt.stationaryAckedAt = now;
        }
        resumeWalking(rt, now);
        return rt.pendingActions;
      }

      // Unclear by phase
      brainLog(deps, `intent=unclear phase=${rt.phase}`);
      if (rt.phase === "PROMPTED") {
        send(rt, user.userId, "prompt", copy.greetingPrompted);
        return rt.pendingActions;
      }
      if (inWalkReply) {
        send(rt, user.userId, "nudge", copyFor(rt, "unclear"));
        await logRule(deps, user.userId, "R9b", rt.walkId, { status: "unclear" });
        return rt.pendingActions;
      }
      if (rt.phase === "IDLE") {
        send(rt, user.userId, "prompt", copy.idleUnclear);
      }
      return rt.pendingActions;
    }

    if (event.type === "UserReaction") {
      // R3 prompt reply
      if (rt.phase === "PROMPTED" && (event.emoji === "👍" || event.emoji === "👎")) {
        if (event.emoji === "👍") {
          const last = rt.lastPing;
          const originLat = last?.lat ?? user.homeLat ?? 0;
          const originLon = last?.lon ?? user.homeLon ?? 0;
          await beginWalk(
            deps,
            rt,
            user,
            now,
            "prompt",
            originLat,
            originLon,
          );
          send(rt, user.userId, "started", templates.started);
          await logRule(deps, user.userId, "R3", rt.walkId, { reply: "like" });
          await noticeIfUnfamiliar(rt, user, now, originLat, originLon);
        } else {
          rt.phase = "IDLE";
          rt.cooldownUntil = new Date(now.getTime() + PROMPT_COOLDOWN_MS);
          send(rt, user.userId, "ended", copy.dismissed);
          await logRule(deps, user.userId, "R3", null, { reply: "dislike" });
        }
        return rt.pendingActions;
      }
      // 👎 on a check-in = dismiss the whole trip (stop asking)
      if (
        (rt.phase === "CHECKING_IN" || rt.phase === "ALERTED" || awaitingCallReply(rt)) &&
        event.emoji === "👎"
      ) {
        brainLog(deps, "intent=dismiss (👎)");
        rt.contactAfterCall = null;
        if (rt.walkId) await endWalk(deps, rt, "ENDED_ELSEWHERE", now);
        else rt.phase = "IDLE";
        rt.cooldownUntil = new Date(now.getTime() + PROMPT_COOLDOWN_MS);
        send(rt, user.userId, "ended", copy.dismissed);
        await logRule(deps, user.userId, "R9a", null, { reply: "dismiss" });
        await persistPhase(deps, rt);
        return rt.pendingActions;
      }
      // R9a
      if (
        (rt.phase === "CHECKING_IN" || rt.phase === "ALERTED" || awaitingCallReply(rt)) &&
        event.emoji === "👍"
      ) {
        if (rt.checkinKind === "offroute") await confirmOffRoute(rt, user, now);
        if (rt.checkinKind === "linger") {
          rt.stationaryAckedAt = null;
          resumeWalking(rt, now, LONG_WATCH_MS);
          brainLog(deps, "linger accept → long watch 20m");
          await persistPhase(deps, rt);
          await logRule(deps, user.userId, "R9a", rt.walkId, { lingerLongWatch: true });
          return rt.pendingActions;
        }
        const wasDwell = rt.checkinKind === "general" || rt.checkinKind === null;
        if (wasDwell && rt.stationarySince && awayFromHome(user, rt.lastPing)) {
          rt.stationaryAckedAt = now;
        }
        resumeWalking(rt, now);
        await persistPhase(deps, rt);
        await logRule(deps, user.userId, "R9a", rt.walkId);
        return rt.pendingActions;
      }
    }

    if (event.type === "CallEvent") {
      if (event.callType === "started") {
        rt.phase = "CALLING";
        rt.walkId = event.walkId;
        // Answering isn't the same as being safe: keep the contact step until an outcome.
        if (rt.contactAfterCall) {
          rt.contactAfterCall.at = new Date(now.getTime() + CALL_OUTCOME_GUARD_MS);
        }
        return rt.pendingActions;
      }
      if (event.callType === "resolved_safe") {
        const cancelled = rt.contactAfterCall;
        rt.contactAfterCall = null;
        if (rt.walkId) resumeWalking(rt, now);
        await persistPhase(deps, rt);
        if (cancelled) {
          await logRule(deps, user.userId, cancelled.rule, rt.walkId, { step: "contact_cancelled", reason: "resolved_safe" });
        }
        return rt.pendingActions;
      }
      if (event.callType === "request_escalation") {
        // No contact step queued (‼️, "call me", CALL_USER): they asked, so reach the contact anyway.
        rt.contactAfterCall ??= { at: now, rule: "R11", kind: "help" };
        await contactAfterCallNow(rt, user, "request_escalation", true);
        return rt.pendingActions;
      }
      if (event.callType === "ended_unresolved") {
        if (rt.contactAfterCall) {
          await contactAfterCallNow(rt, user, "ended_unresolved", false);
        } else if (rt.phase === "CALLING") {
          rt.phase = "WALKING";
          await persistPhase(deps, rt);
        }
        return rt.pendingActions;
      }
    }

    if (event.type === "LocationPing") {
      await onLocationPing(rt, user, event, now);
      return rt.pendingActions;
    }

    return rt.pendingActions;
  }

  async function hydrateOpenWalks() {
    if (bootHydrated || deps.persist === false) return;
    bootHydrated = true;
    try {
      for (const userId of await listOpenWalkUserIds()) await ensureHydrated(userId);
    } catch (err) {
      console.warn("[brain] resume open walks failed", err);
    }
  }

  async function runTick(now: Date): Promise<Action[]> {
    await hydrateOpenWalks();
    const out: Action[] = [];
    for (const [userId, rt] of states) {
      if (rt.phase === "IDLE" && !rt.lastPing) continue;
      const user = await deps.getUser(userId);
      if (!user) continue;
      rt.pendingActions = [];
      await evaluateTimers(rt, user, now);
      out.push(...rt.pendingActions);
      rt.pendingActions = [];
    }
    return out;
  }

  function handle(event: Event): Promise<Action[]> {
    return serialize(() => handleEvent(event));
  }

  function tick(now: Date): Promise<Action[]> {
    return serialize(() => runTick(now));
  }

  function resetUser(userId: string): Promise<void> {
    return serialize(async () => {
      await ensureHydrated(userId);
      const rt = rtFor(userId);
      if (rt.walkId) await endWalk(deps, rt, "ENDED_ELSEWHERE", deps.clock.now());
      const fresh = emptyRuntime();
      fresh.cooldownUntil = rt.cooldownUntil;
      fresh.lastPromptAt = rt.lastPromptAt;
      states.set(userId, fresh);
      brainLog(deps, `reset ${userId}`);
    });
  }

  async function getLiveContext(walkId: string): Promise<LiveContext | null> {
    for (const [, rt] of states) {
      if (rt.walkId !== walkId) continue;
      const last = rt.lastPing;
      if (!last) return null;
      const minutesWalking = rt.walkStartedAt
        ? (deps.clock.now().getTime() - rt.walkStartedAt.getTime()) / 60000
        : 0;
      const headingDeg = travelHeading(rt.pings, last);
      return {
        street: rt.lastShortAddress ?? "unknown street",
        lat: last.lat,
        lon: last.lon,
        minutesWalking,
        ...(headingDeg !== undefined && { headingDeg }),
      };
    }
    return null;
  }

  function getPhase(userId: string): WalkPhase {
    return rtFor(userId).phase;
  }

  function getRuntime(userId: string): UserRuntime {
    return rtFor(userId);
  }

  return { handle, tick, resetUser, getLiveContext, getPhase, getRuntime, ensureHydrated };
}

const DEMO_FALLBACK = { lat: 40.8075, lon: -73.9626 };

/** Heading from an earlier ping, once the phone has moved enough that Find My noise won't flip left and right. */
function travelHeading(pings: LocationPing[], last: LocationPing): number | undefined {
  for (let i = pings.length - 1; i >= 0; i--) {
    const prev = pings[i]!;
    if (prev.time.getTime() === last.time.getTime() && prev.lat === last.lat && prev.lon === last.lon) continue;
    if (distanceM(prev.lat, prev.lon, last.lat, last.lon) >= 15) {
      return bearingDeg(prev.lat, prev.lon, last.lat, last.lon);
    }
  }
  return undefined;
}
