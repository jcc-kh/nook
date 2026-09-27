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
import { distanceM, pathLengthM, speedMps } from "../shared/geo.ts";
import { templates, templateForTag } from "../shared/templates.ts";
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

const WINDOW_MS = 5 * 60_000;
const PROMPT_COOLDOWN_MS = 2 * 60 * 60_000;
const PROMPT_TIMEOUT_MS = 10 * 60_000;
const CHECKIN_RATE_MS = 3 * 60_000;
/** Quiet period after the user answers a check-in. */
const CHECKIN_SNOOZE_MS = 10 * 60_000;
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
type CheckinKind = "general" | "offroute" | "noupdate";

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
    offRouteSince: null,
    offRouteCells: [],
    offRouteConfirmed: false,
    noUpdateFiredFor: null,
    awayPings: 0,
    knownStopSince: null,
    knownStopCell: null,
    friendSince: null,
    pendingActions: [],
  };
}

function brainLog(deps: BrainDeps, ...parts: unknown[]) {
  if (deps.verbose) console.log("[brain]", ...parts);
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
): Action {
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
function resumeWalking(rt: UserRuntime, now: Date) {
  rt.phase = "WALKING";
  rt.checkinOpenedAt = null;
  rt.checkinKind = null;
  rt.nudged = false;
  rt.escalated = false;
  rt.suppressCheckinUntil = new Date(now.getTime() + CHECKIN_SNOOZE_MS);
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
  rt.knownStopSince = null;
  rt.friendSince = null;
  rt.awayPings = 0;

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
      brainLog(deps, `resumed ${open.walkId} (${rt.phase}) for ${userId}`);
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

  /** Final step after check-in + nudge go unanswered, per the user's choice. */
  async function escalate(rt: UserRuntime, user: UserRecord, now: Date) {
    const action = noResponseAction(user);
    const last = rt.lastPing;
    const lat = last?.lat ?? user.homeLat ?? 0;
    const lon = last?.lon ?? user.homeLon ?? 0;
    rt.escalated = true;
    if (action === "NONE") {
      // Floor: never go fully silent, but don't involve anyone.
      send(rt, user.userId, "nudge", templates.finalNudge);
    } else if (escalationSteps(action)[0] === "CONTACT_TRUSTED") {
      alert(
        rt,
        user.userId,
        rt.checkinKind === "offroute" ? templates.alertContactOffRoute : templates.alertContactQuiet,
        lat,
        lon,
      );
      rt.phase = "ALERTED";
    } else {
      rt.phase = "CALLING";
      startCall(rt, user.userId, rt.walkId!, callVars(rt, user, now));
      // TODO(L4): for CALL_THEN_CONTACT, alert the contact when the call goes unanswered.
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
      if (!rt.nudged && since >= nudgeAt) {
        send(rt, user.userId, "nudge");
        rt.nudged = true;
        await logRule(deps, user.userId, "R10", rt.walkId, { step: "nudge", kind: rt.checkinKind });
      } else if (rt.nudged && since >= escalateAt) {
        await escalate(rt, user, now);
      }
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
            ? `${rt.copy.checkin} (still out — getting worried)`
            : "Still out? Getting worried — tap 👍.",
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

  /** Stationary + known-stop tracking for the timer-driven dwell rules. */
  function trackDwell(rt: UserRuntime, prev: LocationPing | null, ping: LocationPing, now: Date) {
    if (prev) {
      const moved = distanceM(prev.lat, prev.lon, ping.lat, ping.lon);
      if (moved < STATIONARY_M) {
        if (!rt.stationarySince) rt.stationarySince = prev.time;
      } else {
        rt.stationarySince = null;
        rt.knownStopSince = null;
        rt.knownStopCell = null;
        rt.friendSince = null;
      }
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
        } else if (
          elapsedS >= 120 &&
          spd >= 0.7 &&
          spd <= 2.2 &&
          moved >= 120 &&
          distHome > AWAY_FROM_HOME_M
        ) {
          send(rt, user.userId, "prompt");
          rt.phase = "PROMPTED";
          rt.lastPromptAt = now;
          await logRule(deps, user.userId, "R2", null, {
            speed: spd,
            moved,
            distHome,
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
      const lower = event.text.trim().toLowerCase();
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

      // R4
      if (lower.includes("walk me home")) {
        if (rt.walkId) await endWalk(deps, rt, "ENDED_ELSEWHERE", now);
        const last = rt.lastPing;
        await beginWalk(
          deps,
          rt,
          user,
          now,
          "walk_me_home",
          last?.lat ?? user.homeLat ?? DEMO_FALLBACK.lat,
          last?.lon ?? user.homeLon ?? DEMO_FALLBACK.lon,
        );
        await logRule(deps, user.userId, "R4", rt.walkId);
        return rt.pendingActions;
      }

      // R9b: free text during a check-in or walk
      if (rt.phase === "CHECKING_IN" || rt.phase === "WALKING" || rt.phase === "ALERTED") {
        const parse = deps.parseReply ?? (async () => ({ status: "unclear" as const }));
        let parsed: ParsedReply;
        try {
          parsed = await parse(event.text);
        } catch {
          parsed = { status: "unclear" };
          send(rt, user.userId, "nudge", copyFor(rt, "unclear"));
          await logRule(deps, user.userId, "R9b", rt.walkId, { status: "unclear", error: true });
          return rt.pendingActions;
        }
        await logRule(deps, user.userId, "R9b", rt.walkId, { status: parsed.status });
        if (parsed.status === "ok") {
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
          if (rt.checkinKind === "offroute") {
            await confirmOffRoute(rt, user, now, parsed.placeLabel);
            resumeWalking(rt, now);
            return rt.pendingActions;
          }
          // R15: reply says they're staying somewhere else — close quietly.
          if (
            parsed.placeLabel ||
            /at .+|i'?m at|staying/i.test(event.text)
          ) {
            await endWalk(deps, rt, "ENDED_ELSEWHERE", now);
            await logRule(deps, user.userId, "R15", null, { via: "reply" });
            return rt.pendingActions;
          }
          resumeWalking(rt, now);
          return rt.pendingActions;
        }
        if (parsed.status === "help") {
          const last = rt.lastPing;
          if (!rt.walkId) {
            await beginWalk(deps, rt, user, now, "help", last?.lat ?? 0, last?.lon ?? 0);
          }
          rt.phase = "CALLING";
          startCall(rt, user.userId, rt.walkId!, callVars(rt, user, now));
          alert(
            rt,
            user.userId,
            templates.alertContactHelp,
            last?.lat ?? 0,
            last?.lon ?? 0,
          );
          await persistPhase(deps, rt);
          return rt.pendingActions;
        }
        send(rt, user.userId, "nudge", copyFor(rt, "unclear"));
        return rt.pendingActions;
      }
    }

    if (event.type === "UserReaction") {
      // R3 prompt reply
      if (rt.phase === "PROMPTED" && (event.emoji === "👍" || event.emoji === "👎")) {
        if (event.emoji === "👍") {
          const last = rt.lastPing;
          await beginWalk(
            deps,
            rt,
            user,
            now,
            "prompt",
            last?.lat ?? user.homeLat ?? 0,
            last?.lon ?? user.homeLon ?? 0,
          );
          await logRule(deps, user.userId, "R3", rt.walkId, { reply: "like" });
        } else {
          rt.phase = "IDLE";
          rt.cooldownUntil = new Date(now.getTime() + PROMPT_COOLDOWN_MS);
          await logRule(deps, user.userId, "R3", null, { reply: "dislike" });
        }
        return rt.pendingActions;
      }
      // R9a
      if ((rt.phase === "CHECKING_IN" || rt.phase === "ALERTED") && event.emoji === "👍") {
        if (rt.checkinKind === "offroute") await confirmOffRoute(rt, user, now);
        resumeWalking(rt, now);
        await persistPhase(deps, rt);
        await logRule(deps, user.userId, "R9a", rt.walkId);
        return rt.pendingActions;
      }
    }

    // Emergency word: skip check-ins and run exactly the action the user chose.
    // No acknowledgement text, so the word stays discreet.
    if (event.type === "EmergencyCode") {
      const code = user.emergencyCode;
      if (!code) {
        console.warn("[brain] EmergencyCode but no emergency word configured for", user.userId);
        return rt.pendingActions;
      }
      const last = rt.lastPing;
      const lat = last?.lat ?? user.homeLat ?? 0;
      const lon = last?.lon ?? user.homeLon ?? 0;
      const steps = escalationSteps(code.action);
      if (steps[0] === "CONTACT_TRUSTED") {
        alert(rt, user.userId, templates.alertContactHelp, lat, lon);
      } else {
        if (!rt.walkId) await beginWalk(deps, rt, user, now, "emergency", lat, lon);
        rt.phase = "CALLING";
        startCall(rt, user.userId, rt.walkId!, callVars(rt, user, now));
        // TODO(L4): for CALL_THEN_CONTACT, alert the contact when the call goes unanswered.
      }
      await logRule(deps, user.userId, "R13", rt.walkId, {
        via: "emergency_word",
        action: code.action,
      });
      return rt.pendingActions;
    }

    if (event.type === "CallEvent") {
      if (event.callType === "silent_alert") {
        const last = rt.lastPing;
        alert(
          rt,
          user.userId,
          templates.alertContactHelp,
          last?.lat ?? user.homeLat ?? 0,
          last?.lon ?? user.homeLon ?? 0,
        );
        rt.phase = "CALLING";
        await logRule(deps, user.userId, "R13", event.walkId);
        return rt.pendingActions;
      }
      if (event.callType === "ended") {
        if (rt.phase === "CALLING") rt.phase = "WALKING";
        return rt.pendingActions;
      }
      if (event.callType === "started") {
        rt.phase = "CALLING";
        rt.walkId = event.walkId;
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

  async function getLiveContext(walkId: string): Promise<LiveContext | null> {
    for (const [, rt] of states) {
      if (rt.walkId !== walkId) continue;
      const last = rt.lastPing;
      if (!last) return null;
      const minutesWalking = rt.walkStartedAt
        ? (deps.clock.now().getTime() - rt.walkStartedAt.getTime()) / 60000
        : 0;
      return {
        street: rt.lastShortAddress ?? "unknown street",
        lat: last.lat,
        lon: last.lon,
        minutesWalking,
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

  return { handle, tick, getLiveContext, getPhase, getRuntime, ensureHydrated };
}

const DEMO_FALLBACK = { lat: 40.8075, lon: -73.9626 };
