import type {
  Action,
  Awaiting,
  CallReason,
  CallVars,
  Channel,
  ClassifierUsed,
  ClassifyContext,
  ClassifyInput,
  Clock,
  Destination,
  Event,
  InputSource,
  LiveContext,
  LocationPing,
  RouteChoice,
  RuleId,
  SafetyIntent,
  SafetyState,
  SendTextTag,
  VoiceNoteRef,
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
  withLegend,
  type ContactAlertKind,
} from "../shared/templates.ts";
import {
  buildEmergencyAlert,
  voiceNoteHeading,
  voiceNoteTrailer,
  type EmergencyStatement,
} from "../shared/alerts.ts";
import { resolveTimeouts, type NoResponseAction } from "../shared/settings.ts";
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
  updateWalkSafety,
  updateWalkStatus,
  upsertPlaceLabel,
  type WalkSafetyPatch,
} from "../store/walks.ts";
import { busierPlace, copy } from "../messenger/copy.ts";
import { parseCoordinates, parseMapsLink } from "../messenger/parse.ts";
import { query } from "../store/db.ts";
import { classifyLocal, reactionIntent } from "../llm/classify.ts";
import type { NavService, SafePlaceOption } from "../nav/index.ts";

const WINDOW_MS = 5 * 60_000;
const PROMPT_COOLDOWN_MS = 2 * 60 * 60_000;
const PROMPT_TIMEOUT_MS = 10 * 60_000;
const CHECKIN_RATE_MS = 3 * 60_000;
/** Quiet period after the user answers a check-in. */
const CHECKIN_SNOOZE_MS = 10 * 60_000;
/** Shorter quiet period after they say they're uneasy. */
const UNEASY_SNOOZE_MS = 5 * 60_000;
/** After they 👍 a linger-offer: only check location this often. */
const LONG_WATCH_MS = 20 * 60_000;
/** Still parked away from home this long after 👍'ing a dwell check-in → linger offer. */
const LINGER_AFTER_ACK_MS = 5 * 60_000;
const STATIONARY_M = 25;
const HOME_RADIUS_M = 50;
const AWAY_FROM_HOME_M = 150;
/** After they say a stop is where they wanted to be, stay quiet until they leave it. */
const SETTLED_LEAVE_M = 120;
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
/** Reply to a stop check-in that means "keep the walk going." */
const STILL_GOING_RE =
  /\b(still (on my way|going|walking|heading)|not yet|keep (going|walking)|haven'?t (got|gotten|arrived)|not there yet)\b/i;
/** "heading to Tom's", "take me to 2880 broadway": a destination by name or address. */
const DEST_TEXT_RE =
  /^(?:i'?m |im )?(?:heading|going|walking|on my way) to (.+)$|^(?:take|walk|get) me to (.+)$|^(?:my )?destination(?: is)?:? (.+)$/i;
/** Voice notes forwarded to the contact per danger window. */
const MAX_FORWARDED_NOTES = 5;
const RECENT_STATEMENTS = 5;
/** Turns (user + Nook) handed to the classifier. */
const RECENT_TURNS = 4;
/** "Keep checking in": after an unanswered check-in and follow-up, check again this much later. */
const RECHECK_MS = 10 * 60_000;
/** How long a processed message / callback id is remembered for de-duplication. */
const PROCESSED_TTL_MS = 30 * 60_000;
/** Reactions without their own id: the same emoji on the same message within this window is a repeat. */
const REACTION_DEDUP_MS = 2 * 60_000;
/** Call callbacks with the same walk, outcome and text within this window are a repeat. */
const CALL_EVENT_DEDUP_MS = 60_000;

export interface BrainDeps {
  clock: Clock;
  getUser: (userId: string) => Promise<UserRecord | null>;
  classify?: ClassifyInput;
  writeMessages?: WriteMessages;
  nav?: NavService;
  /** False when no call transport is configured: "call me" gets a text reply instead. */
  callsEnabled?: () => boolean;
  persist?: boolean;
  /** Read learned walk history (baselines, route cells, stops) from Tiger. Default true, even when persist is false. */
  history?: boolean;
  /** Log rule firings and outbound copy to console. */
  verbose?: boolean;
}

/** Why the open check-in was sent; decides confirm/escalation handling. */
type CheckinKind = "general" | "offroute" | "noupdate" | "linger" | "stopped" | "danger_confirm" | "post_call";

interface Statement {
  text: string;
  source: InputSource;
  at: Date;
  voiceNote?: VoiceNoteRef;
}

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
  destNearCount: number;
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
  /**
   * They answered a stop check-in as "I'm where I want to be."
   * No new evening ask or movement watch until they leave this spot.
   */
  settledAt: { lat: number; lon: number } | null;
  knownStopSince: Date | null;
  knownStopCell: string | null;
  friendSince: Date | null;
  lastShortAddress?: string;
  /**
   * Open walk was resumed past its late window (e.g. server restart).
   * Next tick/ping sends a soft rejoin and resets the late clock
   * instead of firing a worried R7 check-in.
   */
  softRejoinPending: boolean;
  /** This walk already texted the trusted contact (no-reply alert). */
  contactAlerted: boolean;

  // --- safety model ---
  safety: SafetyState;
  channel: Channel;
  routeChoice: RouteChoice | null;
  /** Shared trip destination; null = home. */
  destination: Destination | null;
  /** Busier stop picked while uneasy; routed to before the destination. */
  interim: Destination | null;
  awaitingRouteChoice: boolean;
  /** Busier places offered by text, answered with 1-3. */
  offeredPlaces: SafePlaceOption[] | null;
  /** Ambiguous danger waiting on "are you in immediate danger right now?". */
  dangerConfirm: Statement | null;
  /** Open from confirmed danger until they're safe or the walk ends. */
  dangerWindow: { openedAt: Date; forwarded: Set<string> } | null;
  emergencyAlerted: boolean;
  /** The "text call me" offer is made once per walk. */
  callOffered: boolean;
  callReason: CallReason | null;
  callAnswered: boolean;
  /** Last few things the user said. Memory only; also written to the events table. */
  recentStatements: Statement[];
  /** Last few turns either way, for classifying short replies. Memory only. */
  recentTurns: { from: "user" | "nook"; text: string }[];
  /** Message / callback keys already applied → when. Duplicate deliveries are dropped. */
  processed: Map<string, number>;
  /** "Keep checking in" setting: when to check again after an unanswered check-in. */
  recheckAt: Date | null;
  /** Rotates the "somewhere busier" wording. */
  busierTurn: number;
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
    destNearCount: 0,
    suppressCheckinUntil: null,
    stationarySince: null,
    stationaryAnchor: null,
    stationaryAckedAt: null,
    offRouteSince: null,
    offRouteCells: [],
    offRouteConfirmed: false,
    noUpdateFiredFor: null,
    awayPings: 0,
    settledAt: null,
    knownStopSince: null,
    knownStopCell: null,
    friendSince: null,
    softRejoinPending: false,
    contactAlerted: false,
    safety: "safe",
    channel: "text",
    routeChoice: null,
    destination: null,
    interim: null,
    awaitingRouteChoice: false,
    offeredPlaces: null,
    dangerConfirm: null,
    dangerWindow: null,
    emergencyAlerted: false,
    callOffered: false,
    callReason: null,
    callAnswered: false,
    recentStatements: [],
    recentTurns: [],
    processed: new Map(),
    recheckAt: null,
    busierTurn: 0,
    pendingActions: [],
  };
}

/** Per-walk safety fields reset at walk start and end. */
function resetTripSafety(rt: UserRuntime) {
  rt.safety = "safe";
  rt.channel = "text";
  rt.routeChoice = null;
  rt.destination = null;
  rt.interim = null;
  rt.awaitingRouteChoice = false;
  rt.offeredPlaces = null;
  rt.dangerConfirm = null;
  rt.dangerWindow = null;
  rt.emergencyAlerted = false;
  rt.callOffered = false;
  rt.callReason = null;
  rt.callAnswered = false;
  rt.destNearCount = 0;
  rt.recheckAt = null;
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

function windowMotion(rt: UserRuntime): { elapsedS: number; moved: number; spd: number } | null {
  if (rt.pings.length < 2) return null;
  const first = rt.pings[0]!;
  const last = rt.pings[rt.pings.length - 1]!;
  const elapsedS = (last.time.getTime() - first.time.getTime()) / 1000;
  if (elapsedS <= 0) return null;
  return {
    elapsedS,
    moved: pathLengthM(rt.pings),
    spd: speedMps(first.lat, first.lon, first.time, last.lat, last.lon, last.time),
  };
}

/** Walking for ~2 min, not a vehicle and not a few steps. */
function walkingPace(m: { elapsedS: number; moved: number; spd: number }): boolean {
  return m.elapsedS >= 120 && m.spd >= 0.7 && m.spd <= 2.2 && m.moved >= 120;
}

/** True while they stay at the place they already said they reached. Clears once they leave. */
function parkedAtSettled(rt: UserRuntime, ping: { lat: number; lon: number }): boolean {
  if (!rt.settledAt) return false;
  if (distanceM(rt.settledAt.lat, rt.settledAt.lon, ping.lat, ping.lon) > SETTLED_LEAVE_M) {
    rt.settledAt = null;
    return false;
  }
  return true;
}

function markSettled(rt: UserRuntime) {
  const p = rt.lastPing;
  if (p) rt.settledAt = { lat: p.lat, lon: p.lon };
}

/**
 * Monitoring gate for everything outside an explicit walk.
 * EVENINGS: night and not home — then we ask, we don't auto-start.
 * AWAY_FROM_HOME: sitting still is assumed safe, so this gate stays closed.
 * Movement arms a quiet watch separately. Explicit walks are always watched.
 */
function isWatching(user: UserRecord, now: Date, lastPing: LocationPing | null): boolean {
  switch (user.monitoringMode) {
    case "MANUAL":
    case "AWAY_FROM_HOME":
      return false;
    case "EVENINGS":
    default:
      return isNight(now, user) && awayFromHome(user, lastPing);
  }
}

function noResponseAction(user: UserRecord): NoResponseAction {
  if (user.escalation) return user.escalation.onNoTextResponse;
  return user.trustedContact || user.contact ? "CONTACT_TRUSTED" : "NONE";
}

function realName(user: UserRecord): string | undefined {
  const name = user.displayName?.trim();
  if (name && !/^\+?\d[\d\s().-]{5,}\d$/.test(name) && !/^change my name$/i.test(name)) return name;
  return undefined;
}

/** How the trusted contact knows who the alert is about: name and number. */
function userLabel(user: UserRecord): string {
  const name = realName(user);
  return name ? `${name} (${prettyPhone(user.handle)})` : prettyPhone(user.handle);
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
  rt.lastShortAddress = ping.shortAddress;
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

async function persistSafety(deps: BrainDeps, rt: UserRuntime, patch: WalkSafetyPatch) {
  if (!rt.walkId || deps.persist === false) return;
  try {
    await updateWalkSafety(rt.walkId, patch);
  } catch (err) {
    console.warn("[brain] updateWalkSafety failed (run db:migrate?)", err instanceof Error ? err.message : err);
  }
}

/** Gemini-written copy for the plain lines; the follow-up nudge and "didn't get that" are fixed. */
function copyFor(rt: UserRuntime, tag: SendTextTag): string {
  if (tag === "nudge") return templates.nudge;
  return rt.copy?.[tag] || templateForTag(tag);
}

function pushTurn(rt: UserRuntime, from: "user" | "nook", text: string) {
  rt.recentTurns.push({ from, text: text.slice(0, 200) });
  if (rt.recentTurns.length > RECENT_TURNS) rt.recentTurns.shift();
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
  pushTurn(rt, "nook", action.text);
  return action;
}

/** True if `key` was already applied; otherwise remembers it. `windowMs` limits how long it counts as a repeat. */
function seenBefore(rt: UserRuntime, key: string, now: Date, windowMs = PROCESSED_TTL_MS): boolean {
  const at = rt.processed.get(key);
  if (at != null && now.getTime() - at < windowMs) return true;
  rt.processed.set(key, now.getTime());
  if (rt.processed.size > 200) {
    for (const [k, t] of rt.processed) if (now.getTime() - t > PROCESSED_TTL_MS) rt.processed.delete(k);
  }
  return false;
}

/** The question Nook is waiting on; decides what a bare "yes" / "no" means. */
function awaitingOf(rt: UserRuntime): Awaiting {
  if (rt.dangerConfirm) return "danger_confirmation";
  if (rt.offeredPlaces) return "place_choice";
  if (rt.awaitingRouteChoice) return "route_choice";
  if (rt.phase === "CHECKING_IN") return "checkin";
  return null;
}

/** Non-emergency alert (a check-in went unanswered). One per walk. */
function alert(
  rt: UserRuntime,
  userId: string,
  text: string,
  lat: number,
  lon: number,
): Action | null {
  if (rt.contactAlerted || rt.emergencyAlerted) {
    console.log(`[brain] skip duplicate contact alert for ${userId}`);
    return null;
  }
  rt.contactAlerted = true;
  const action: Action = { type: "AlertContact", userId, text, lat, lon };
  rt.pendingActions.push(action);
  return action;
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
  opts: { legend?: boolean; force?: boolean } = {},
): boolean {
  if (!opts.force && !canCheckin(rt, now)) return false;
  const body = text ?? copyFor(rt, tag);
  send(rt, userId, tag, opts.legend === false ? body : withLegend(body));
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
  rt.suppressCheckinUntil = new Date(now.getTime() + snoozeMs);
}

function homeDestination(user: UserRecord): Destination | null {
  if (user.homeLat == null || user.homeLon == null) return null;
  return { name: "home", lat: user.homeLat, lon: user.homeLon, source: "home" };
}

/** Where Nook is guiding them right now: a busier stop, the shared destination, or home. */
function activeTarget(rt: UserRuntime, user: UserRecord): Destination | null {
  return rt.interim ?? rt.destination ?? homeDestination(user);
}

function tripDestinationName(rt: UserRuntime): string {
  return rt.destination?.name ?? "home";
}

function placeLine(p: SafePlaceOption): string {
  const hours = p.openNow === true ? (p.hours ? `, ${p.hours}` : "") : ", hours unknown";
  return `${p.rank}. ${p.name} (${p.category}, about ${p.walkMin} min walk${hours})`;
}

/**
 * First thing the voice agent says. Nook never starts a call once immediate
 * danger is established, so the danger line only matters for a call that was
 * already being set up.
 */
function openingLine(
  name: string | undefined,
  reason: CallReason,
  rt: UserRuntime,
  contactName?: string,
): string {
  const hey = name ? `Hey ${name}` : "Hey";
  const dest = tripDestinationName(rt);
  const toDest = dest === "home" ? "home" : `to ${dest}`;
  const towardDest = dest === "home" ? "home" : `toward ${dest}`;
  if (rt.safety === "immediate_danger") {
    const who = contactName ?? "your trusted contact";
    return `${name ? `${name}, call` : "Call"} 911 now if you can. I'm sending ${who} your latest location and what you told me.`;
  }
  switch (reason) {
    case "uneasy_companion":
    case "hands_free_guidance":
      if (rt.routeChoice === "busier" && rt.interim) return `${hey}. I've got the route to ${rt.interim.name}. Let me check what's next.`;
      if (rt.routeChoice === "destination") return `${hey}. I've got the route. Keep heading ${towardDest} for now.`;
      return `${hey}. Do you want to keep heading ${toDest}, or get somewhere with more people around first?`;
    case "lost":
    case "navigation_help":
      return `${hey}. Let me check where you are.`;
    case "manual_call":
    default:
      return `${hey}, it's Nook. What do you need?`;
  }
}

function ageLabel(at: Date, now: Date): string {
  const min = Math.round((now.getTime() - at.getTime()) / 60_000);
  return min <= 0 ? "just now" : `${min} min ago`;
}

function recentContext(rt: UserRuntime, now: Date): string {
  if (rt.recentStatements.length === 0) return "nothing yet";
  return rt.recentStatements
    .slice(-3)
    .map((s) =>
      s.source === "reaction"
        ? `${s.text} (${ageLabel(s.at, now)})`
        : `said "${s.text.slice(0, 120)}" by ${s.source === "voice_note" ? "voice message" : s.source === "voice_call" ? "call" : "text"} (${ageLabel(s.at, now)})`,
    )
    .join("; ");
}

async function buildPlan(
  deps: BrainDeps,
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
  if (deps.history === false) return plan;

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
  const plan = await buildPlan(deps, user, originLat, originLon);
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
  resetTripSafety(rt);

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
  if (walkId) deps.nav?.forget(walkId);
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
  rt.softRejoinPending = false;
  rt.contactAlerted = false;
  resetTripSafety(rt);
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
  const classify: ClassifyInput = deps.classify ?? (async (text, ctx) => classifyLocal(text, ctx));
  const callsEnabled = deps.callsEnabled ?? (() => true);

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
      // A call can't survive a restart.
      if (rt.phase === "CALLING") rt.phase = "WALKING";
      rt.safety = open.safetyState ?? "safe";
      rt.routeChoice = open.routeChoice;
      rt.destination = open.destination;
      rt.interim = open.interim;
      // The emergency alert went out before the restart; don't send a second one.
      rt.emergencyAlerted = rt.safety === "immediate_danger";
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

  function lastLatLon(rt: UserRuntime, user: UserRecord): { lat: number; lon: number } {
    const last = rt.lastPing;
    return {
      lat: last?.lat ?? user.homeLat ?? DEMO_FALLBACK.lat,
      lon: last?.lon ?? user.homeLon ?? DEMO_FALLBACK.lon,
    };
  }

  async function ensureWalk(rt: UserRuntime, user: UserRecord, now: Date, trigger: string) {
    if (rt.walkId) return;
    const { lat, lon } = lastLatLon(rt, user);
    await beginWalk(deps, rt, user, now, trigger, lat, lon);
  }

  /**
   * After the check-in and its one follow-up go unanswered, per the user's
   * choice. Never a call, and never a more urgent-sounding reminder: "keep
   * checking in" just checks again later.
   */
  async function escalate(rt: UserRuntime, user: UserRecord, now: Date) {
    const action = noResponseAction(user);
    const { lat, lon } = lastLatLon(rt, user);
    const kind: ContactAlertKind =
      rt.checkinKind === "offroute" ? "offroute" : rt.checkinKind === "danger_confirm" ? "unconfirmed" : "quiet";
    rt.escalated = true;
    if (action === "NONE" || !user.trustedContact) {
      resumeWalking(rt, now, RECHECK_MS);
      rt.recheckAt = new Date(now.getTime() + RECHECK_MS);
    } else {
      alert(rt, user.userId, contactAlert(kind, userLabel(user), rt.dangerConfirm?.text), lat, lon);
      rt.phase = "ALERTED";
    }
    await persistPhase(deps, rt);
    await logRule(deps, user.userId, "R10", rt.walkId, {
      step: "escalate",
      action,
      kind: rt.checkinKind,
      at: now.toISOString(),
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
      send(rt, user.userId, "started", copy.softRejoin);
      brainLog(deps, "soft-rejoin (tracking, no check-in)");
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
        const next = user.trustedContact
          ? nextStepLine(noResponseAction(user), timeouts.escalateAfterSec, user.trustedContact.name)
          : "";
        const lead = rt.checkinKind === "danger_confirm" ? copy.dangerConfirmNudge : templates.nudge;
        send(rt, user.userId, "nudge", [lead, next].filter(Boolean).join(" "));
        rt.nudged = true;
        await logRule(deps, user.userId, "R10", rt.walkId, { step: "nudge", kind: rt.checkinKind });
      } else if (rt.nudged && since >= escalateAt) {
        await escalate(rt, user, now);
      }
    }

    // "Keep checking in": a plain check-in again, at the slower cadence.
    if (rt.recheckAt && now >= rt.recheckAt && rt.phase === "WALKING" && rt.walkId) {
      rt.recheckAt = null;
      const confirming = rt.dangerConfirm != null;
      openCheckin(
        rt,
        user.userId,
        now,
        "checkin",
        confirming ? copy.dangerConfirmNudge : templates.checkinAgain,
        confirming ? "danger_confirm" : "general",
        { force: true, ...(confirming && { legend: false }) },
      );
      await logRule(deps, user.userId, "R10", rt.walkId, { step: "recheck" });
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
        openCheckin(rt, user.userId, now, "checkin", templates.checkinDwell);
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
        openCheckin(rt, user.userId, now, "checkin", templates.stoppedCheckin, "stopped");
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
        openCheckin(rt, user.userId, now, "checkin", templates.lingerOffer, "linger", { legend: false });
        await logRule(deps, user.userId, "R5b", rt.walkId, {
          step: "linger_offer",
          dwellMin,
        });
        brainLog(deps, "linger offer — still parked after dwell 👍");
      }
    }

    // Movement watches only check in on a stop. No "you're late" clock.
    if (rt.walkTrigger === "moving") return;

    // R7 late
    if (rt.phase === "WALKING" && rt.plan && rt.walkStartedAt) {
      const elapsedMin = (now.getTime() - rt.walkStartedAt.getTime()) / 60000;
      if (elapsedMin > rt.plan.lateMin + 10 && canCheckin(rt, now)) {
        openCheckin(rt, user.userId, now, "checkin", templates.checkinLate);
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
    // A shared destination or a busier stop explains the detour.
    if (rt.destination || rt.interim) return;
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

  /** Arrival at a busier stop or a shared destination (two pings within range). */
  async function checkDestinationArrival(rt: UserRuntime, user: UserRecord, ping: LocationPing, now: Date): Promise<boolean> {
    const target = rt.interim ?? rt.destination;
    if (!target || !rt.walkId) {
      rt.destNearCount = 0;
      return false;
    }
    if (distanceM(ping.lat, ping.lon, target.lat, target.lon) > HOME_RADIUS_M) {
      rt.destNearCount = 0;
      return false;
    }
    rt.destNearCount += 1;
    if (rt.destNearCount < 2) return false;
    rt.destNearCount = 0;
    if (rt.interim) {
      const stop = rt.interim;
      rt.interim = null;
      rt.routeChoice = null;
      rt.stationaryAckedAt = now;
      resumeWalking(rt, now, LONG_WATCH_MS);
      send(rt, user.userId, "checkin", copy.interimArrived(stop.name, tripDestinationName(rt)));
      await persistSafety(deps, rt, { interim: null, routeChoice: null });
      await logRule(deps, user.userId, "R17", rt.walkId, { step: "interim_arrived", name: stop.name });
      return true;
    }
    send(rt, user.userId, "arrived", copy.arrivedAt(target.name));
    await logRule(deps, user.userId, "R14", rt.walkId, { via: "destination", name: target.name });
    await endWalk(deps, rt, "ARRIVED", now);
    return true;
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

    if (onWalk && (await checkDestinationArrival(rt, user, event, now))) return;

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
      const settled = parkedAtSettled(rt, event);
      const cooling = rt.cooldownUntil != null && now < rt.cooldownUntil;
      const promptedRecently =
        rt.lastPromptAt != null && now.getTime() - rt.lastPromptAt.getTime() < PROMPT_COOLDOWN_MS;
      const motion = windowMotion(rt);
      const away = distHome != null && distHome > AWAY_FROM_HOME_M;

      if (user.monitoringMode === "AWAY_FROM_HOME") {
        // Quiet until they've actually been walking. A stop later is the check-in.
        if (!cooling && !settled && away && motion) {
          if (motion.spd > 3) {
            await logRule(deps, user.userId, "R2x", null, { speed: motion.spd });
            brainLog(deps, "R2x skip movement watch — vehicle speed", motion.spd);
          } else if (walkingPace(motion)) {
            await beginWalk(deps, rt, user, now, "moving", event.lat, event.lon);
            brainLog(deps, "R2 away+moving → quiet watch");
            await logRule(deps, user.userId, "R2", rt.walkId, {
              speed: motion.spd,
              moved: motion.moved,
              distHome,
              movingWatch: true,
            });
          }
        }
      } else if (!watching || cooling || promptedRecently || settled) {
        /* home, daytime, manual, cooldown, or already at a place they chose */
      } else if (motion && motion.elapsedS >= 120) {
        // Evenings and not home: ask. Standing still still counts; a car does not.
        if (motion.spd > 3) {
          await logRule(deps, user.userId, "R2x", null, { speed: motion.spd });
          brainLog(deps, "R2x skip prompt — vehicle speed", motion.spd);
        } else {
          rt.phase = "PROMPTED";
          rt.lastPromptAt = now;
          send(rt, user.userId, "prompt", withLegend(templates.prompt));
          brainLog(deps, "R2 evening+away → ask heading home");
          await logRule(deps, user.userId, "R2", null, {
            speed: motion.spd,
            moved: motion.moved,
            distHome,
            asked: true,
          });
        }
      }
    }

    if (onWalk || (rt.walkTrigger === "moving" && rt.phase === "WALKING")) trackDwell(rt, prev, event, now);

    const motionNow = windowMotion(rt);
    const passive =
      rt.phase === "IDLE" &&
      watching &&
      distHome != null &&
      distHome > AWAY_FROM_HOME_M &&
      motionNow != null &&
      walkingPace(motionNow);
    if (
      (rt.phase === "WALKING" && rt.walkId != null && rt.walkTrigger !== "moving") ||
      passive ||
      (onWalk && rt.offRouteConfirmed && rt.walkTrigger !== "moving")
    ) {
      await trackOffRoute(rt, user, now, event, passive);
    }

    await evaluateTimers(rt, user, now);
  }

  // --- safety intents -------------------------------------------------------

  function recordStatement(rt: UserRuntime, s: Statement) {
    pushTurn(rt, "user", s.text);
    rt.recentStatements.push(s);
    if (rt.recentStatements.length > RECENT_STATEMENTS) rt.recentStatements.shift();
  }

  function callVars(rt: UserRuntime, user: UserRecord, now: Date, reason: CallReason): CallVars {
    const last = rt.lastPing;
    const target = activeTarget(rt, user);
    return {
      displayName: realName(user) ?? "friend",
      street: last?.shortAddress ?? "unknown",
      minutesWalking: rt.walkStartedAt ? (now.getTime() - rt.walkStartedAt.getTime()) / 60000 : 0,
      walkId: rt.walkId!,
      callReason: reason,
      safetyState: rt.safety,
      destinationName: target?.name ?? "not set",
      routeChoice: rt.routeChoice ?? "none",
      recentContext: recentContext(rt, now),
      ...(last && { lat: last.lat, lon: last.lon }),
      openingLine: openingLine(realName(user), reason, rt, user.trustedContact?.name),
    };
  }

  function startCall(rt: UserRuntime, user: UserRecord, now: Date, reason: CallReason) {
    rt.phase = "CALLING";
    rt.channel = "voice";
    rt.callReason = reason;
    rt.callAnswered = false;
    rt.checkinOpenedAt = null;
    rt.checkinKind = null;
    rt.nudged = false;
    rt.escalated = false;
    rt.pendingActions.push({
      type: "StartCall",
      userId: user.userId,
      walkId: rt.walkId!,
      vars: callVars(rt, user, now, reason),
    });
  }

  async function setSafety(rt: UserRuntime, safety: SafetyState) {
    if (rt.safety === safety) return;
    rt.safety = safety;
    await persistSafety(deps, rt, { safetyState: safety });
  }

  /** Best street/address we have for the alert. Never blocks the alert for long. */
  async function addressFor(rt: UserRuntime): Promise<string | undefined> {
    const last = rt.lastPing;
    if (!last) return undefined;
    if (last.shortAddress) return last.shortAddress;
    if (!deps.nav) return undefined;
    try {
      return (await deps.nav.reverseGeocode(last)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  async function sendEmergencyAlert(
    rt: UserRuntime,
    user: UserRecord,
    now: Date,
    via: InputSource,
    statements: Statement[],
    nookAction: string,
    confirmation?: string,
  ) {
    const last = rt.lastPing;
    const notes = statements.map((s) => s.voiceNote).filter((n): n is VoiceNoteRef => n != null);
    const emergencyStatements: EmergencyStatement[] = statements.map((s) => ({
      text: s.text,
      source: s.source,
      ...(s.source === "voice_note" && s.voiceNote && !s.voiceNote.transcribed && { transcriptUnavailable: true }),
    }));
    const target = activeTarget(rt, user);
    const text = buildEmergencyAlert({
      who: userLabel(user),
      firstName: realName(user) ?? "them",
      confirmedAt: now,
      confirmedVia: via,
      tz: user.tz ?? "America/New_York",
      location: last
        ? { lat: last.lat, lon: last.lon, updatedAt: last.time, ...(await addressFor(rt).then((a) => (a ? { address: a } : {}))) }
        : null,
      statements: emergencyStatements,
      ...(confirmation && { confirmation }),
      nookAction,
      trip: {
        ...(rt.walkStartedAt && { minutesWalking: (now.getTime() - rt.walkStartedAt.getTime()) / 60000 }),
        ...(target && { destination: target.name }),
        onRoute: rt.offRouteSince ? false : null,
      },
      voiceNoteAttached: notes.length > 0,
    });
    const { lat, lon } = lastLatLon(rt, user);
    for (const n of notes) rt.dangerWindow?.forwarded.add(n.id);
    rt.emergencyAlerted = true;
    rt.contactAlerted = true;
    rt.pendingActions.push({
      type: "AlertContact",
      userId: user.userId,
      text,
      lat,
      lon,
      emergency: true,
      ...(notes.length && {
        attachments: notes.map((n) => ({ path: n.path, mimeType: n.mimeType })),
        voiceNoteIds: notes.map((n) => n.id),
      }),
    });
  }

  function forwardVoiceNote(rt: UserRuntime, user: UserRecord, note: VoiceNoteRef, transcript: string, now: Date) {
    const w = rt.dangerWindow;
    if (!w || !user.trustedContact) return;
    if (w.forwarded.has(note.id)) return;
    if (w.forwarded.size >= MAX_FORWARDED_NOTES) {
      brainLog(deps, `voice note ${note.id} not forwarded: window cap reached`);
      return;
    }
    w.forwarded.add(note.id);
    const { lat, lon } = lastLatLon(rt, user);
    rt.pendingActions.push({
      type: "AlertContact",
      userId: user.userId,
      text: voiceNoteHeading(realName(user) ?? "them", now, user.tz),
      lat,
      lon,
      emergency: true,
      followUp: true,
      attachments: [{ path: note.path, mimeType: note.mimeType }],
      trailer: voiceNoteTrailer(note.transcribed ? transcript : undefined),
      voiceNoteIds: [note.id],
    });
  }

  /** Safe, or safe somewhere named (`placeLabel`: "I'm at Sam's"). */
  async function onSafe(rt: UserRuntime, user: UserRecord, placeLabel: string | undefined, s: Statement, now: Date) {
    const wasDanger = rt.safety === "immediate_danger" || rt.dangerWindow != null;
    const alertedContact = rt.contactAlerted || rt.emergencyAlerted;
    rt.dangerConfirm = null;
    rt.awaitingRouteChoice = false;
    if (wasDanger || rt.safety === "uneasy") {
      rt.dangerWindow = null;
      await setSafety(rt, "safe");
    }
    if (wasDanger) send(rt, user.userId, "checkin", copy.dangerResolved);
    if (alertedContact && user.trustedContact && (rt.phase === "ALERTED" || wasDanger)) {
      const { lat, lon } = lastLatLon(rt, user);
      rt.pendingActions.push({
        type: "AlertContact",
        userId: user.userId,
        text: copy.contactUpdateSafe(realName(user) ?? prettyPhone(user.handle)),
        lat,
        lon,
        followUp: true,
      });
      rt.contactAlerted = false;
      rt.emergencyAlerted = false;
    }

    const fromText = s.source === "text" || s.source === "voice_note";
    if (rt.phase === "CHECKING_IN" || rt.phase === "ALERTED" || rt.phase === "CALLING") {
      await logRule(deps, user.userId, "R9a", rt.walkId, { via: s.source, kind: rt.checkinKind });
      if (placeLabel && rt.lastPing && deps.persist !== false) {
        try {
          await upsertPlaceLabel({
            userId: user.userId,
            cell: toCell(rt.lastPing.lat, rt.lastPing.lon),
            lat: rt.lastPing.lat,
            lon: rt.lastPing.lon,
            label: placeLabel,
            source: "user",
          });
        } catch {
          /* ignore */
        }
      }
      if (rt.checkinKind === "stopped") {
        markSettled(rt);
        send(rt, user.userId, "ended", templates.stoppedDone);
        await endWalk(deps, rt, "ENDED_ELSEWHERE", now);
        brainLog(deps, "stop ack → settled, walk ended");
        return;
      }
      if (rt.checkinKind === "linger") {
        rt.stationaryAckedAt = null;
        resumeWalking(rt, now, LONG_WATCH_MS);
        brainLog(deps, "linger accept → long watch 20m");
        await persistPhase(deps, rt);
        return;
      }
      if (rt.checkinKind === "offroute") {
        await confirmOffRoute(rt, user, now, placeLabel);
        resumeWalking(rt, now);
        await persistPhase(deps, rt);
        return;
      }
      if (fromText && placeLabel) {
        markSettled(rt);
        await endWalk(deps, rt, "ENDED_ELSEWHERE", now);
        await logRule(deps, user.userId, "R15", null, { via: "reply" });
        return;
      }
      const wasDwell = rt.checkinKind === "general" || rt.checkinKind === null;
      if (wasDwell && rt.stationarySince && awayFromHome(user, rt.lastPing)) {
        rt.stationaryAckedAt = now;
      }
      resumeWalking(rt, now);
      rt.channel = "text";
      await persistPhase(deps, rt);
      return;
    }
    if (rt.phase === "WALKING") {
      if (fromText && placeLabel) {
        markSettled(rt);
        await endWalk(deps, rt, "ENDED_ELSEWHERE", now);
        await logRule(deps, user.userId, "R15", null, { via: "reply" });
      }
      return;
    }
    if (rt.phase === "IDLE" && fromText && !wasDanger) send(rt, user.userId, "prompt", copy.greetingIdle);
  }

  async function navInstruction(rt: UserRuntime, user: UserRecord, now: Date): Promise<string | undefined> {
    const last = rt.lastPing;
    const target = activeTarget(rt, user);
    if (!deps.nav || !last || !target || !rt.walkId) return undefined;
    try {
      const u = await deps.nav.navigationUpdate({
        key: rt.walkId,
        position: { lat: last.lat, lon: last.lon, time: last.time, ...(last.accuracyM != null && { accuracyM: last.accuracyM }) },
        destination: target,
        now,
      });
      if (!u.navigationFresh) return copy.navNoFix(rt.stationarySince == null);
      return u.instruction || undefined;
    } catch (err) {
      console.warn("[brain] navigation failed", err);
      return undefined;
    }
  }

  async function offerBusierPlaces(rt: UserRuntime, user: UserRecord): Promise<string> {
    const last = rt.lastPing;
    // Asked again before picking: same list, no second lookup.
    if (rt.offeredPlaces?.length) return copy.busierOptions(rt.offeredPlaces.map(placeLine));
    if (!deps.nav || !last) return copy.busierNone;
    try {
      const options = await deps.nav.findSafeDestinations(last);
      if (options.length === 0) return copy.busierNone;
      rt.offeredPlaces = options;
      return copy.busierOptions(options.map(placeLine));
    } catch (err) {
      console.warn("[brain] findSafeDestinations failed", err);
      return copy.busierNone;
    }
  }

  async function applyRouteChoice(rt: UserRuntime, user: UserRecord, choice: RouteChoice, now: Date): Promise<string> {
    rt.routeChoice = choice;
    rt.awaitingRouteChoice = false;
    if (choice === "destination") {
      rt.interim = null;
      rt.offeredPlaces = null;
      await persistSafety(deps, rt, { routeChoice: choice, interim: null });
      return copy.uneasyKeepGoing(tripDestinationName(rt), await navInstruction(rt, user, now));
    }
    await persistSafety(deps, rt, { routeChoice: choice });
    return offerBusierPlaces(rt, user);
  }

  /** The "I can call and guide you" line, at most once per trip and only if calls work. */
  function withCallOffer(rt: UserRuntime, text: string): string {
    if (rt.callOffered || rt.phase === "CALLING" || !callsEnabled()) return text;
    rt.callOffered = true;
    return `${text}\n\n${copy.callOffer}`;
  }

  /** Uneasy: no contact, no call, no escalation. Ask which way unless they already said. */
  async function onUneasy(rt: UserRuntime, user: UserRecord, intent: Extract<SafetyIntent, { kind: "uneasy" }>, s: Statement, now: Date) {
    rt.dangerConfirm = null;
    await ensureWalk(rt, user, now, "uneasy");
    if (rt.phase === "CHECKING_IN" || rt.phase === "ALERTED") resumeWalking(rt, now, UNEASY_SNOOZE_MS);
    if (rt.safety === "immediate_danger") {
      send(rt, user.userId, "checkin", copy.dangerStill(user.trustedContact?.name));
      return;
    }
    await setSafety(rt, "uneasy");
    await persistPhase(deps, rt);
    await logRule(deps, user.userId, "R9b", rt.walkId, { intent: "uneasy", via: s.source, wants: intent.wants ?? null });

    if (intent.wants) {
      send(rt, user.userId, "checkin", withCallOffer(rt, await applyRouteChoice(rt, user, intent.wants, now)));
      return;
    }
    if (rt.routeChoice || rt.awaitingRouteChoice) {
      // Still uncomfortable after the question: offer all three ways at once.
      rt.awaitingRouteChoice = true;
      if (callsEnabled()) rt.callOffered = true;
      send(rt, user.userId, "checkin", copy.stillUneasy(callsEnabled()));
      return;
    }
    rt.awaitingRouteChoice = true;
    const where = intent.lost ? await navInstruction(rt, user, now) : undefined;
    const ask = copy.uneasyAsk(tripDestinationName(rt), busierPlace(intent.detail, rt.busierTurn++));
    send(rt, user.userId, "checkin", withCallOffer(rt, [where, ask].filter(Boolean).join("\n\n")));
  }

  async function onRouteChoiceIntent(rt: UserRuntime, user: UserRecord, choice: RouteChoice, s: Statement, now: Date) {
    if (!rt.walkId) return onUnclear(rt, user, s);
    if (rt.phase === "CHECKING_IN") resumeWalking(rt, now, UNEASY_SNOOZE_MS);
    await logRule(deps, user.userId, "R9b", rt.walkId, { intent: "route_choice", choice, via: s.source });
    send(rt, user.userId, "checkin", await applyRouteChoice(rt, user, choice, now));
  }

  async function pickOfferedPlace(rt: UserRuntime, user: UserRecord, option: SafePlaceOption, now: Date) {
    rt.interim = { name: option.name, lat: option.lat, lon: option.lon, ...(option.address && { address: option.address }), source: "safe_place" };
    rt.routeChoice = "busier";
    rt.offeredPlaces = null;
    rt.destNearCount = 0;
    await persistSafety(deps, rt, { interim: rt.interim, routeChoice: "busier" });
    await logRule(deps, user.userId, "R17", rt.walkId, { step: "interim", name: option.name });
    send(rt, user.userId, "checkin", copy.busierPicked(option.name, await navInstruction(rt, user, now)));
  }

  /** Call request: a channel change, not a safety change. Never during immediate danger. */
  async function onCall(rt: UserRuntime, user: UserRecord, intent: Extract<SafetyIntent, { kind: "call" }>, s: Statement, now: Date) {
    if (rt.safety === "immediate_danger") {
      // 911 takes precedence; Nook doesn't start a call once danger is established.
      if (rt.phase !== "CALLING") send(rt, user.userId, "checkin", copy.dangerStill(user.trustedContact?.name));
      await logRule(deps, user.userId, "R11", rt.walkId, { via: s.source, call: "refused_in_danger" });
      return;
    }
    await ensureWalk(rt, user, now, "call_me");
    const uneasy = intent.uneasy === true || intent.reason === "uneasy_companion";
    if (uneasy && rt.safety === "safe") await setSafety(rt, "uneasy");
    const reason: CallReason =
      intent.reason && intent.reason !== "manual_call"
        ? intent.reason
        : rt.safety === "uneasy"
          ? "uneasy_companion"
          : "manual_call";
    rt.dangerConfirm = null;
    rt.awaitingRouteChoice = false;
    if (rt.phase === "CALLING") {
      await logRule(deps, user.userId, "R11", rt.walkId, { via: s.source, reason, call: "already_calling" });
      return;
    }
    if (!callsEnabled()) {
      if (rt.phase === "CHECKING_IN") resumeWalking(rt, now, UNEASY_SNOOZE_MS);
      send(rt, user.userId, "checkin", copy.callsUnavailable);
      await logRule(deps, user.userId, "R11", rt.walkId, { via: s.source, reason, calls: "off" });
      return;
    }
    startCall(rt, user, now, reason);
    await logRule(deps, user.userId, "R11", rt.walkId, { via: s.source, reason });
    await persistPhase(deps, rt);
  }

  async function onDanger(rt: UserRuntime, user: UserRecord, intent: Extract<SafetyIntent, { kind: "danger" }>, s: Statement, now: Date) {
    await ensureWalk(rt, user, now, "danger");
    if (!intent.clear && rt.safety !== "immediate_danger") {
      // Ambiguous: ask before alerting anyone. Silence is handled like any check-in.
      rt.dangerConfirm = s;
      rt.awaitingRouteChoice = false;
      openCheckin(rt, user.userId, now, "checkin", copy.dangerConfirm, "danger_confirm", { legend: false, force: true });
      await persistPhase(deps, rt);
      await logRule(deps, user.userId, "R11", rt.walkId, { step: "danger_confirm", via: s.source });
      return;
    }
    const statements: Statement[] = rt.dangerConfirm ? [rt.dangerConfirm] : [s];
    const confirmation = rt.dangerConfirm
      ? s.source === "reaction"
        ? "tapped ‼️ when Nook asked if they're in immediate danger"
        : `answered "${s.text.slice(0, 80)}" when Nook asked if they're in immediate danger`
      : undefined;
    if (rt.dangerConfirm && s.voiceNote) statements.push(s);
    rt.dangerConfirm = null;
    rt.awaitingRouteChoice = false;
    rt.offeredPlaces = null;
    const firstTime = rt.safety !== "immediate_danger" || !rt.emergencyAlerted;
    await setSafety(rt, "immediate_danger");
    rt.dangerWindow ??= { openedAt: now, forwarded: new Set() };
    // An existing call carries on; Nook never starts one here.
    const onCall = rt.phase === "CALLING";
    if (!onCall) {
      rt.phase = "ALERTED";
      rt.checkinOpenedAt = null;
      rt.checkinKind = null;
      rt.nudged = false;
    }
    await persistPhase(deps, rt);

    if (!firstTime) {
      if (s.source !== "voice_call") send(rt, user.userId, "checkin", copy.dangerStill(user.trustedContact?.name));
      await logRule(deps, user.userId, "R11", rt.walkId, { step: "danger_repeat", via: s.source });
      return;
    }
    if (s.source !== "voice_call") {
      send(rt, user.userId, "checkin", copy.dangerGuidance(user.trustedContact?.name, intent.wantsCall === true));
    }
    if (user.trustedContact) {
      await sendEmergencyAlert(
        rt,
        user,
        now,
        s.source,
        statements,
        s.source === "voice_call" ? "told them on the call to call 911 now" : "told them to call 911 now",
        confirmation,
      );
    }
    await logRule(deps, user.userId, "R11", rt.walkId, {
      step: "danger",
      via: s.source,
      contact: Boolean(user.trustedContact),
    });
  }

  /** Stop checking in / tracking this trip. Not while immediate danger is open. */
  async function onStop(rt: UserRuntime, user: UserRecord, now: Date) {
    if (rt.safety === "immediate_danger") {
      send(rt, user.userId, "checkin", copy.dangerStill(user.trustedContact?.name));
      return;
    }
    const hadTrip =
      rt.walkId != null ||
      rt.phase === "PROMPTED" ||
      rt.phase === "CHECKING_IN" ||
      rt.phase === "CALLING" ||
      rt.phase === "ALERTED";
    const walkId = rt.walkId;
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
  }

  async function onUnclear(rt: UserRuntime, user: UserRecord, s: Statement) {
    if (rt.dangerConfirm) {
      send(rt, user.userId, "checkin", copy.dangerConfirm);
      return;
    }
    if (rt.phase === "PROMPTED") {
      send(rt, user.userId, "prompt", copy.greetingPrompted);
      return;
    }
    if (rt.awaitingRouteChoice || rt.offeredPlaces) {
      send(
        rt,
        user.userId,
        "checkin",
        rt.offeredPlaces
          ? copy.busierOptions(rt.offeredPlaces.map(placeLine))
          : copy.uneasyAsk(tripDestinationName(rt), busierPlace(undefined, rt.busierTurn++)),
      );
      return;
    }
    const inWalk =
      rt.phase === "CHECKING_IN" || rt.phase === "WALKING" || rt.phase === "ALERTED" || rt.phase === "CALLING";
    if (inWalk) {
      send(rt, user.userId, "nudge", templates.unclear);
      await logRule(deps, user.userId, "R9b", rt.walkId, { status: "unclear", via: s.source });
      return;
    }
    if (rt.phase === "IDLE") send(rt, user.userId, "prompt", copy.idleUnclear);
  }

  /**
   * The one place a classified message changes state, for 👍 👎 ❓ ‼️, typed
   * text, voice-note transcripts and call reports alike. The classifier only
   * names the intent; everything below decides what happens.
   */
  async function applyIntent(
    rt: UserRuntime,
    user: UserRecord,
    intent: SafetyIntent,
    s: Statement,
    now: Date,
    meta: { messageId?: string; classifier: ClassifierUsed },
  ) {
    if (s.source !== "reaction" || intent.kind !== "safe") recordStatement(rt, s);
    rt.recheckAt = null;
    const before = rt.safety;
    const firstAction = rt.pendingActions.length;
    switch (intent.kind) {
      case "safe":
        await onSafe(rt, user, undefined, s, now);
        break;
      case "place":
        await onSafe(rt, user, intent.label, s, now);
        break;
      case "uneasy":
        await onUneasy(rt, user, intent, s, now);
        break;
      case "route_choice":
        await onRouteChoiceIntent(rt, user, intent.choice, s, now);
        break;
      case "call":
        await onCall(rt, user, intent, s, now);
        break;
      case "danger":
        await onDanger(rt, user, intent, s, now);
        break;
      case "stop":
        await onStop(rt, user, now);
        break;
      case "unclear":
        await onUnclear(rt, user, s);
        break;
    }
    const effects = rt.pendingActions.slice(firstAction).map((a) =>
      a.type === "AlertContact" ? (a.emergency ? (a.followUp ? "ForwardVoiceNote" : "EmergencyAlert") : "ContactAlert") : a.type,
    );
    const label = `${intent.kind}${intent.kind === "danger" ? (intent.clear ? "(clear)" : "(ambiguous)") : ""}`;
    brainLog(
      deps,
      `intent msg=${meta.messageId ?? "-"} source=${s.source} classifier=${meta.classifier} intent=${label} safety=${before}→${rt.safety} effects=[${effects.join(",")}]`,
    );
    // The one record of what they said; other logs carry only the intent.
    await logRule(deps, user.userId, "R9b", rt.walkId, {
      step: "statement",
      messageId: meta.messageId ?? null,
      source: s.source,
      classifier: meta.classifier,
      intent: intent.kind,
      ...(intent.kind === "danger" && { clear: intent.clear }),
      safetyBefore: before,
      safetyAfter: rt.safety,
      effects,
      ...(s.source !== "reaction" && { text: s.text.slice(0, 280) }),
      ...(s.voiceNote && { voiceNoteId: s.voiceNote.id }),
    });
  }

  async function setDestinationFrom(rt: UserRuntime, user: UserRecord, dest: Destination, now: Date) {
    const startedNow = !rt.walkId;
    await ensureWalk(rt, user, now, "destination");
    rt.destination = dest;
    rt.interim = null;
    rt.destNearCount = 0;
    const patch: WalkSafetyPatch = { destination: dest, interim: null };
    const from = rt.lastPing;
    if (deps.nav && from && rt.plan) {
      try {
        const route = await deps.nav.route(from, dest);
        if (route) {
          rt.plan.expectedMin = route.durationMin;
          rt.plan.lateMin = route.durationMin * 1.25 + 5;
          patch.expectedMin = rt.plan.expectedMin;
          patch.lateMin = rt.plan.lateMin;
        }
      } catch (err) {
        console.warn("[brain] route for destination failed", err);
      }
    }
    await persistSafety(deps, rt, patch);
    await logRule(deps, user.userId, "R17", rt.walkId, { step: "destination", name: dest.name, source: dest.source });
    send(rt, user.userId, "started", startedNow ? `${copy.destinationSet(dest.name)}\n\n${copy.started}` : copy.destinationSet(dest.name));
  }

  /** An Apple Maps link / shared place, dropped pin, or "heading to <place>". Null = not a destination. */
  async function destinationFromText(rt: UserRuntime, raw: string): Promise<Destination | "unreadable" | null> {
    const near = rt.lastPing ?? undefined;
    const link = parseMapsLink(raw);
    if (link) {
      if (link.short) return "unreadable";
      const name = link.name ?? link.address ?? "your destination";
      if (link.lat != null && link.lon != null) {
        return { name, lat: link.lat, lon: link.lon, ...(link.address && { address: link.address }), source: "apple_maps" };
      }
      const found = deps.nav ? await deps.nav.geocode(link.address ?? name, near).catch(() => null) : null;
      return found
        ? { name: link.name ?? found.name, lat: found.lat, lon: found.lon, ...(found.address && { address: found.address }), source: "apple_maps" }
        : "unreadable";
    }
    if (/^\s*-?\d{1,2}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}\s*$/.test(raw)) {
      const p = parseCoordinates(raw);
      if (p) return { name: "the pin you sent", lat: p.lat, lon: p.lon, source: "coordinates" };
    }
    const m = raw.trim().match(DEST_TEXT_RE);
    const place = (m?.[1] ?? m?.[2] ?? m?.[3])?.replace(/[.!]+$/, "").trim();
    // "i'm going to call 911" must never be geocoded into a destination.
    const plain = classifyLocal(raw).intent.kind;
    const safeToGeocode = plain === "unclear" || plain === "safe" || plain === "route_choice" || plain === "place";
    if (place && safeToGeocode && !/^(home|my place|my apartment|bed)$/i.test(place) && deps.nav) {
      const found = await deps.nav.geocode(place, near).catch(() => null);
      if (found) return { name: found.name, lat: found.lat, lon: found.lon, ...(found.address && { address: found.address }), source: "text" };
    }
    return null;
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

    if (event.type === "UserReaction") {
      const intent = reactionIntent(event.emoji);
      if (!intent) return rt.pendingActions;
      const repeat = event.messageId
        ? seenBefore(rt, `reaction:${event.messageId}`, now)
        : seenBefore(rt, `reaction:${event.emoji}:${event.targetMessageId}`, now, REACTION_DEDUP_MS);
      if (repeat) {
        brainLog(deps, `duplicate reaction ${event.messageId ?? event.targetMessageId} ignored`);
        return rt.pendingActions;
      }
      // Legacy R2 prompt: 👍 starts the walk, 👎 declines it.
      if (rt.phase === "PROMPTED" && (intent.kind === "safe" || intent.kind === "uneasy")) {
        if (intent.kind === "safe") {
          const { lat, lon } = lastLatLon(rt, user);
          await beginWalk(deps, rt, user, now, "prompt", lat, lon);
          send(rt, user.userId, "started", copy.started);
          await logRule(deps, user.userId, "R3", rt.walkId, { reply: "like" });
          await noticeIfUnfamiliar(rt, user, now, lat, lon);
        } else {
          rt.phase = "IDLE";
          rt.cooldownUntil = new Date(now.getTime() + PROMPT_COOLDOWN_MS);
          send(rt, user.userId, "ended", copy.dismissed);
          await logRule(deps, user.userId, "R3", null, { reply: "dislike" });
        }
        return rt.pendingActions;
      }
      // A stray 👍 with nothing open is just a like.
      if (intent.kind === "safe" && rt.phase === "IDLE" && !rt.dangerConfirm) return rt.pendingActions;
      const label: Partial<Record<SafetyIntent["kind"], string>> = {
        safe: 'tapped 👍 ("I\'m good")',
        uneasy: 'tapped 👎 ("Something feels off")',
        call: 'tapped ❓ ("Call me")',
        danger: 'tapped ‼️ ("I need help now")',
      };
      await applyIntent(rt, user, intent, {
        text: label[intent.kind] ?? event.emoji,
        source: "reaction",
        at: now,
      }, now, { classifier: "reaction", ...(event.messageId && { messageId: event.messageId }) });
      return rt.pendingActions;
    }

    if (event.type === "UserText") {
      if (seenBefore(rt, `msg:${event.messageId}`, now)) {
        brainLog(deps, `duplicate message ${event.messageId} ignored`);
        return rt.pendingActions;
      }
      const raw = event.text.trim();
      const lower = raw.toLowerCase();
      const note = event.voiceNote;
      const source: InputSource = note ? "voice_note" : "text";
      const statement: Statement = { text: raw, source, at: now, ...(note && { voiceNote: note }) };
      brainLog(deps, `${source} msg=${event.messageId} phase=${rt.phase} chars=${raw.length}`);

      // During an open emergency every voice note goes to the contact, transcribed or not.
      if (note && rt.dangerWindow) forwardVoiceNote(rt, user, note, raw, now);

      if (note && !raw) {
        if (!rt.dangerWindow) {
          send(rt, user.userId, "nudge", rt.dangerConfirm ? `${copy.voiceNoteUnclear} ${copy.dangerConfirm}` : copy.voiceNoteUnclear);
        }
        return rt.pendingActions;
      }

      // Shared destination (Apple Maps link / place, pin, "heading to …")
      const dest = await destinationFromText(rt, raw);
      if (dest === "unreadable") {
        send(rt, user.userId, "nudge", copy.destinationUnreadable);
        return rt.pendingActions;
      }
      if (dest) {
        await setDestinationFrom(rt, user, dest, now);
        return rt.pendingActions;
      }

      // Busier place picked by number
      if (rt.offeredPlaces) {
        const n = raw.match(/^\s*(?:option |number |#)?([1-9])\s*[.!]?\s*$/i)?.[1];
        const option = n ? rt.offeredPlaces[Number(n) - 1] : undefined;
        if (option) {
          pushTurn(rt, "user", raw);
          await pickOfferedPlace(rt, user, option, now);
          return rt.pendingActions;
        }
      }

      // Greeting — never a check-in
      if (isGreeting(raw)) {
        brainLog(deps, "intent=greeting skip R9b");
        if (rt.phase === "PROMPTED") {
          send(rt, user.userId, "prompt", copy.greetingPrompted);
        } else if (rt.phase === "WALKING" || rt.phase === "CHECKING_IN") {
          send(rt, user.userId, "nudge", copy.greetingWalking);
        } else {
          send(rt, user.userId, "prompt", copy.greetingIdle);
        }
        return rt.pendingActions;
      }

      if (rt.phase === "CHECKING_IN" && rt.checkinKind === "stopped" && STILL_GOING_RE.test(raw)) {
        resumeWalking(rt, now);
        send(rt, user.userId, "checkin", templates.stillGoing);
        brainLog(deps, "stop check-in → still on the way");
        await persistPhase(deps, rt);
        return rt.pendingActions;
      }

      // R4 start intent — even while standing still
      if (lower.includes("walk me home") || (!rt.walkId && TRIP_START_RE.test(lower))) {
        if (rt.walkId) await endWalk(deps, rt, "ENDED_ELSEWHERE", now);
        const { lat, lon } = lastLatLon(rt, user);
        await beginWalk(deps, rt, user, now, "walk_me_home", lat, lon);
        send(rt, user.userId, "started", copy.started);
        await logRule(deps, user.userId, "R4", rt.walkId);
        await noticeIfUnfamiliar(rt, user, now, lat, lon);
        return rt.pendingActions;
      }

      if (isAffirmativeText(raw) && rt.phase === "PROMPTED") {
        brainLog(deps, "intent=ok (affirmative text) PROMPTED");
        const { lat, lon } = lastLatLon(rt, user);
        await beginWalk(deps, rt, user, now, "prompt", lat, lon);
        send(rt, user.userId, "started", copy.started);
        await logRule(deps, user.userId, "R3", rt.walkId, { reply: "text_ok" });
        await noticeIfUnfamiliar(rt, user, now, lat, lon);
        return rt.pendingActions;
      }

      const ctx: ClassifyContext = {
        safetyState: rt.safety,
        awaiting: awaitingOf(rt),
        ...(rt.walkId && { destination: tripDestinationName(rt) }),
        recent: rt.recentTurns.slice(-RECENT_TURNS),
      };
      let result: { intent: SafetyIntent; classifier: ClassifierUsed };
      try {
        result = await classify(raw, ctx);
      } catch {
        result = { ...classifyLocal(raw, ctx), classifier: "fallback" };
      }
      let intent = result.intent;
      // "keep going" / "busier" only mean something on a trip.
      if (intent.kind === "route_choice" && !rt.walkId) intent = { kind: "unclear" };
      await applyIntent(rt, user, intent, statement, now, { messageId: event.messageId, classifier: result.classifier });
      return rt.pendingActions;
    }

    if (event.type === "CallEvent") {
      const callKey = `call:${event.walkId}:${event.callType}:${event.situation?.trim() ?? ""}`;
      if (seenBefore(rt, callKey, now, CALL_EVENT_DEDUP_MS)) {
        brainLog(deps, `duplicate call event ${event.callType} for ${event.walkId} ignored`);
        return rt.pendingActions;
      }
      const sameWalk = rt.walkId === event.walkId;
      const call: Statement = { text: event.situation?.trim() || "", source: "voice_call", at: now };
      if (event.callType === "request_escalation") {
        // Safety first: act even if the call isn't tied to the current walk.
        const text = call.text || "asked on the call for their trusted contact to be reached";
        await applyIntent(rt, user, { kind: "danger", clear: true, quote: text }, { ...call, text }, now, {
          classifier: "deterministic",
        });
        return rt.pendingActions;
      }
      if (!sameWalk) {
        brainLog(deps, `call ${event.callType} for ${event.walkId} (current walk ${rt.walkId ?? "none"}), ignored`);
        return rt.pendingActions;
      }
      if (event.callType === "started") {
        rt.phase = "CALLING";
        rt.channel = "voice";
        rt.callAnswered = true;
        await persistPhase(deps, rt);
        return rt.pendingActions;
      }
      if (event.callType === "resolved_safe") {
        await applyIntent(rt, user, { kind: "safe" }, { ...call, text: call.text || "said on the call they're okay" }, now, {
          classifier: "deterministic",
        });
        rt.channel = "text";
        return rt.pendingActions;
      }
      if (event.callType === "ended_unresolved") {
        const answered = rt.callAnswered;
        rt.channel = "text";
        rt.callAnswered = false;
        if (rt.phase !== "CALLING") return rt.pendingActions;
        if (rt.safety === "immediate_danger") {
          rt.phase = "ALERTED";
          send(rt, user.userId, "checkin", copy.dangerStill(user.trustedContact?.name));
        } else {
          rt.phase = "WALKING";
          // A plain text check-in with the normal timers; the call itself never alerts anyone.
          openCheckin(rt, user.userId, now, "checkin", answered ? copy.callEnded : copy.callMissed, "post_call", {
            legend: false,
            force: true,
          });
        }
        await persistPhase(deps, rt);
        await logRule(deps, user.userId, "R11", rt.walkId, { step: "call_ended_unresolved", answered });
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

  function byWalk(walkId: string): { userId: string; rt: UserRuntime } | null {
    for (const [userId, rt] of states) if (rt.walkId === walkId) return { userId, rt };
    return null;
  }

  async function getLiveContext(walkId: string): Promise<LiveContext | null> {
    const found = byWalk(walkId);
    const last = found?.rt.lastPing;
    if (!found || !last) return null;
    const { rt, userId } = found;
    const now = deps.clock.now();
    const ageSec = Math.max(0, Math.round((now.getTime() - last.time.getTime()) / 1000));
    const staleSec = deps.nav?.config.staleSec ?? 30;
    let street = last.shortAddress;
    if (!street && deps.nav) street = (await deps.nav.reverseGeocode(last).catch(() => null)) ?? undefined;
    const user = await deps.getUser(userId);
    const target = user ? activeTarget(rt, user) : null;
    const headingDeg = travelHeading(rt.pings, last);
    return {
      street: street ?? "unknown street",
      lat: last.lat,
      lon: last.lon,
      minutesWalking: rt.walkStartedAt ? (now.getTime() - rt.walkStartedAt.getTime()) / 60000 : 0,
      ...(headingDeg !== undefined && { headingDeg }),
      updatedAt: last.time.toISOString(),
      ageSec,
      ...(last.accuracyM != null && { accuracyM: last.accuracyM }),
      navigationFresh: ageSec <= staleSec,
      contextFresh: ageSec <= (deps.nav?.config.contextFreshSec ?? 90),
      safetyState: rt.safety,
      ...(target && { destination: target.name }),
    };
  }

  /** Voice tool: places open all night near the caller. Remembered so set-destination can pick by id. */
  function safeDestinations(walkId: string): Promise<unknown> {
    return serialize(async () => {
      const found = byWalk(walkId);
      const last = found?.rt.lastPing;
      if (!found || !last) return { ok: false, error: "no live location for this walk" };
      if (!deps.nav) return { ok: false, error: "navigation isn't configured" };
      const places = await deps.nav.findSafeDestinations(last);
      found.rt.offeredPlaces = places.length ? places : null;
      return {
        ok: true,
        source: deps.nav.providerName,
        places: places.map((p) => ({
          place_id: p.id,
          rank: p.rank,
          name: p.name,
          category: p.category,
          address: p.address ?? null,
          open_now: p.openNow,
          hours: p.hours ?? null,
          walk_minutes: p.walkMin,
          distance_m: p.distanceM,
        })),
        note: places.length
          ? "These places are marked open all night in the map data. Offer at most the top two by name."
          : "No place open all night was found nearby. Suggest staying on main, well-lit streets.",
      };
    });
  }

  /** Voice tool: "home", "trip" (the shared destination), or a place_id from safeDestinations. */
  function setDestination(walkId: string, choice: string): Promise<unknown> {
    return serialize(async () => {
      const found = byWalk(walkId);
      if (!found) return { ok: false, error: "no active walk" };
      const { rt, userId } = found;
      const user = await deps.getUser(userId);
      if (!user) return { ok: false, error: "unknown user" };
      const now = deps.clock.now();
      const c = choice.trim().toLowerCase();
      if (c === "home" || c === "trip" || c === "destination") {
        if (c === "home") rt.destination = null;
        rt.interim = null;
        rt.routeChoice = "destination";
        await persistSafety(deps, rt, { interim: null, routeChoice: "destination", ...(c === "home" && { destination: null }) });
      } else {
        const option = rt.offeredPlaces?.find((p) => p.id.toLowerCase() === c || p.name.toLowerCase() === c || String(p.rank) === c);
        if (!option) return { ok: false, error: "unknown place_id; call get_safe_destinations first" };
        rt.interim = { name: option.name, lat: option.lat, lon: option.lon, ...(option.address && { address: option.address }), source: "tool" };
        rt.routeChoice = "busier";
        rt.offeredPlaces = null;
        rt.destNearCount = 0;
        await persistSafety(deps, rt, { interim: rt.interim, routeChoice: "busier" });
      }
      rt.awaitingRouteChoice = false;
      await logRule(deps, userId, "R17", rt.walkId, { step: "set_destination", via: "voice_call", choice });
      const target = activeTarget(rt, user);
      return { ok: true, destination: target?.name ?? null, navigation: await navigationFor(rt, user, now) };
    });
  }

  async function navigationFor(rt: UserRuntime, user: UserRecord, now: Date) {
    const last = rt.lastPing;
    if (!deps.nav || !last || !rt.walkId) return { ok: false, error: "no live location" };
    return deps.nav.navigationUpdate({
      key: rt.walkId,
      position: {
        lat: last.lat,
        lon: last.lon,
        time: last.time,
        ...(last.accuracyM != null && { accuracyM: last.accuracyM }),
        ...(last.shortAddress && { street: last.shortAddress }),
      },
      destination: activeTarget(rt, user),
      now,
    });
  }

  /** Voice tool: next instruction, distance left, and whether the fix is fresh enough to steer by. */
  function navigation(walkId: string): Promise<unknown> {
    return serialize(async () => {
      const found = byWalk(walkId);
      if (!found) return { ok: false, error: "no active walk" };
      const user = await deps.getUser(found.userId);
      if (!user) return { ok: false, error: "unknown user" };
      return navigationFor(found.rt, user, deps.clock.now());
    });
  }

  /** Demo recording: forget everything in memory, prompt cooldown included. */
  function demoReset(userId: string): Promise<void> {
    return serialize(async () => {
      await ensureHydrated(userId);
      const rt = rtFor(userId);
      if (rt.walkId) await endWalk(deps, rt, "ENDED_ELSEWHERE", deps.clock.now());
      states.set(userId, emptyRuntime());
      usualCache.delete(userId);
      brainLog(deps, `demo reset ${userId}`);
    });
  }

  /** Demo recording: open a walk as if they'd said yes at `at`, without sending anything. */
  function demoStartWalk(userId: string, at: Date, lat: number, lon: number): Promise<void> {
    return serialize(async () => {
      await ensureHydrated(userId);
      const user = await deps.getUser(userId);
      if (!user) throw new Error(`unknown user ${userId}`);
      await beginWalk(deps, rtFor(userId), user, at, "prompt", lat, lon);
    });
  }

  /** Demo recording: no more check-ins or nudges until `until`; the walk, call and danger state stay. */
  function demoHush(userId: string, until: Date): Promise<void> {
    return serialize(async () => {
      const rt = rtFor(userId);
      rt.suppressCheckinUntil = until;
      rt.checkinOpenedAt = null;
    });
  }

  function getPhase(userId: string): WalkPhase {
    return rtFor(userId).phase;
  }

  function getRuntime(userId: string): UserRuntime {
    return rtFor(userId);
  }

  return {
    handle,
    tick,
    resetUser,
    getLiveContext,
    safeDestinations,
    setDestination,
    navigation,
    getPhase,
    getRuntime,
    ensureHydrated,
    demo: { reset: demoReset, startWalk: demoStartWalk, hush: demoHush },
  };
}

export type DemoHooks = ReturnType<typeof createBrainEngine>["demo"];

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
