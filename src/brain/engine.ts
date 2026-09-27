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
import type { UserRecord } from "../store/types.ts";
import {
  insertEvent,
  insertLocationPing,
  loadRecentPings,
} from "../store/users.ts";
import {
  buildDefaultPlan,
  getOpenWalk,
  insertWalk,
  loadFamiliarCells,
  loadKnownStops,
  loadRouteCells,
  loadWalkBaselines,
  updateWalkStatus,
  upsertPlaceLabel,
} from "../store/walks.ts";
import { copy } from "../messenger/copy.ts";

const WINDOW_MS = 5 * 60_000;
const PROMPT_COOLDOWN_MS = 2 * 60 * 60_000;
const CHECKIN_RATE_MS = 3 * 60_000;
const STATIONARY_M = 25;
const DEMO_FALLBACK = { lat: 40.8075, lon: -73.9626 };

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

interface UserRuntime {
  phase: WalkPhase;
  walkId: string | null;
  walkStartedAt: Date | null;
  plan: WalkPlan | null;
  /** Crafted copy from writeMessages (templates if LLM off). */
  copy: Record<string, string> | null;
  pings: LocationPing[];
  lastPromptAt: Date | null;
  lastPromptMessageId: string | null;
  cooldownUntil: Date | null;
  lastCheckinAt: Date | null;
  lastCheckinTag: SendTextTag | null;
  checkinOpenedAt: Date | null;
  nudged: boolean;
  homeNearCount: number;
  suppressCheckinUntil: Date | null;
  stationarySince: Date | null;
  offRouteSince: Date | null;
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
    plan: null,
    copy: null,
    pings: [],
    lastPromptAt: null,
    lastPromptMessageId: null,
    cooldownUntil: null,
    lastCheckinAt: null,
    lastCheckinTag: null,
    checkinOpenedAt: null,
    nudged: false,
    homeNearCount: 0,
    suppressCheckinUntil: null,
    stationarySince: null,
    offRouteSince: null,
    knownStopSince: null,
    knownStopCell: null,
    friendSince: null,
    pendingActions: [],
  };
}

function brainLog(deps: BrainDeps, ...parts: unknown[]) {
  if (deps.verbose) console.log("[brain]", ...parts);
}

function isGreeting(text: string): boolean {
  return /^(hi|hey|hello|yo|sup)([!.?\s]*)$/i.test(text.trim());
}

function isStartIntent(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    t.includes("walk me home") ||
    /\bheading (out|home)\b/.test(t) ||
    /\bwalking home\b/.test(t) ||
    /\bon my way home\b/.test(t)
  );
}

function isAffirmativeText(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(ok|okay|fine|good|i'?m (good|fine|ok|okay)|all good|yes)([!.?\s]*)$/i.test(t);
}

/** Unfamiliar-area notice without opening CHECKING_IN (R5b can still fire). */
async function noticeIfUnfamiliar(
  deps: BrainDeps,
  rt: UserRuntime,
  user: UserRecord,
  originLat: number,
  originLon: number,
): Promise<boolean> {
  const cell = toCell(originLat, originLon);
  let familiar: string[] = [];
  try {
    familiar = await loadFamiliarCells(user.userId);
  } catch (err) {
    brainLog(deps, "loadFamiliarCells failed", err);
    return false;
  }
  if (familiar.length === 0) {
    brainLog(deps, "unfamiliar skipped — no ended-walk cells yet");
    return false;
  }
  if (familiar.includes(cell)) {
    brainLog(deps, `familiar cell ${cell} (${familiar.length} usual cells)`);
    return false;
  }
  send(rt, user.userId, "checkin", copy.unfamiliarArea);
  brainLog(deps, `unfamiliar notice cell=${cell} usual=${familiar.length}`);
  return true;
}

async function escalateHelp(
  deps: BrainDeps,
  rt: UserRuntime,
  user: UserRecord,
  now: Date,
  source: string,
) {
  if (!rt.walkId) {
    const last = rt.pings[rt.pings.length - 1];
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
  const last = rt.pings[rt.pings.length - 1];
  startCall(rt, user.userId, rt.walkId!, {
    displayName: user.displayName ?? "friend",
    street: rt.lastShortAddress ?? "nearby",
    minutesWalking: rt.walkStartedAt
      ? (now.getTime() - rt.walkStartedAt.getTime()) / 60000
      : 0,
    walkId: rt.walkId!,
  });
  alert(
    rt,
    user.userId,
    templates.alertContactHelp,
    last?.lat ?? user.homeLat ?? 0,
    last?.lon ?? user.homeLon ?? 0,
  );
  brainLog(deps, `parseReply → help escalate=contact source=${source}`);
  await logRule(deps, user.userId, "R9b", rt.walkId, {
    status: "help",
    escalate: "contact",
    source,
  });
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

function trimWindow(rt: UserRuntime, now: Date) {
  const cutoff = now.getTime() - WINDOW_MS;
  rt.pings = rt.pings.filter((p) => p.time.getTime() >= cutoff);
}

function pushPing(rt: UserRuntime, ping: LocationPing) {
  rt.pings.push(ping);
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
) {
  if (!canCheckin(rt, now)) return;
  send(rt, userId, tag, text);
  rt.phase = "CHECKING_IN";
  rt.lastCheckinAt = now;
  rt.lastCheckinTag = tag;
  rt.checkinOpenedAt = now;
  rt.nudged = false;
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
    const routeCells = await loadRouteCells(user.userId, originCell);
    if (routeCells.length > 0) plan.routeCells = routeCells;

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
  rt.plan = plan;
  rt.phase = "WALKING";
  rt.homeNearCount = 0;
  rt.checkinOpenedAt = null;
  rt.nudged = false;
  rt.stationarySince = null;
  rt.offRouteSince = null;
  rt.knownStopSince = null;
  rt.friendSince = null;

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
  rt.plan = null;
  rt.copy = null;
  rt.homeNearCount = 0;
  rt.checkinOpenedAt = null;
}

export function createBrainEngine(deps: BrainDeps) {
  const states = new Map<string, UserRuntime>();

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
    if (rt.walkId || deps.persist === false) return;
    try {
      const open = await getOpenWalk(userId);
      if (!open) return;
      rt.walkId = open.walkId;
      rt.walkStartedAt = open.startedAt;
      rt.phase = open.status === "ARRIVED" || open.status === "ENDED_ELSEWHERE"
        ? "IDLE"
        : open.status;
      if (open.expectedMin != null && open.lateMin != null) {
        rt.plan = {
          expectedMin: open.expectedMin,
          lateMin: open.lateMin,
          routeCells: [],
          bufferM: 150,
          stops: [],
        };
      }
      const since = new Date(deps.clock.now().getTime() - WINDOW_MS);
      rt.pings = await loadRecentPings(userId, since);
    } catch (err) {
      console.warn("[brain] hydrate failed", err);
    }
  }

  async function handle(event: Event): Promise<Action[]> {
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
          const last = rt.pings[rt.pings.length - 1];
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
        startCall(rt, user.userId, rt.walkId!, {
          displayName: user.displayName ?? "friend",
          street: rt.lastShortAddress ?? "nearby",
          minutesWalking: rt.walkStartedAt
            ? (now.getTime() - rt.walkStartedAt.getTime()) / 60000
            : 0,
          walkId: rt.walkId!,
        });
        await logRule(deps, user.userId, "R11", rt.walkId, { via: "reaction" });
        if (deps.persist !== false && rt.walkId) {
          try {
            await updateWalkStatus(rt.walkId, "CALLING");
          } catch {
            /* ignore */
          }
        }
        return rt.pendingActions;
      }
    }

    if (event.type === "UserText") {
      const raw = event.text.trim();
      const lower = raw.toLowerCase();
      brainLog(deps, `text phase=${rt.phase}`, JSON.stringify(raw.slice(0, 80)));

      // Floors: call me (does not text contact unless also classified help)
      if (lower === "call me" || lower.includes("call me")) {
        if (!rt.walkId) {
          const last = rt.pings[rt.pings.length - 1];
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
        startCall(rt, user.userId, rt.walkId!, {
          displayName: user.displayName ?? "friend",
          street: rt.lastShortAddress ?? "nearby",
          minutesWalking: rt.walkStartedAt
            ? (now.getTime() - rt.walkStartedAt.getTime()) / 60000
            : 0,
          walkId: rt.walkId!,
        });
        await logRule(deps, user.userId, "R11", rt.walkId, { via: "text" });
        return rt.pendingActions;
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

      // Start intent (R4) — even while standing still
      if (isStartIntent(raw)) {
        const last = rt.pings[rt.pings.length - 1];
        const originLat = last?.lat ?? user.homeLat ?? DEMO_FALLBACK.lat;
        const originLon = last?.lon ?? user.homeLon ?? DEMO_FALLBACK.lon;
        await beginWalk(deps, rt, user, now, "walk_me_home", originLat, originLon);
        await logRule(deps, user.userId, "R4", rt.walkId);
        await noticeIfUnfamiliar(deps, rt, user, originLat, originLon);
        return rt.pendingActions;
      }

      // Affirmative text only resolves check-in / prompt (👍 path for text)
      if (isAffirmativeText(raw) && (rt.phase === "CHECKING_IN" || rt.phase === "PROMPTED")) {
        brainLog(deps, "intent=ok (affirmative text)");
        if (rt.phase === "PROMPTED") {
          const last = rt.pings[rt.pings.length - 1];
          const originLat = last?.lat ?? user.homeLat ?? 0;
          const originLon = last?.lon ?? user.homeLon ?? 0;
          await beginWalk(deps, rt, user, now, "prompt", originLat, originLon);
          await logRule(deps, user.userId, "R3", rt.walkId, { reply: "text_ok" });
          await noticeIfUnfamiliar(deps, rt, user, originLat, originLon);
          return rt.pendingActions;
        }
        rt.phase = "WALKING";
        rt.checkinOpenedAt = null;
        rt.suppressCheckinUntil = new Date(now.getTime() + 10 * 60_000);
        await logRule(deps, user.userId, "R9a", rt.walkId, { via: "text" });
        return rt.pendingActions;
      }

      if (isAffirmativeText(raw) && rt.phase === "IDLE") {
        brainLog(deps, "intent=ok ignored in IDLE → greeting");
        send(rt, user.userId, "prompt", copy.greetingIdle);
        return rt.pendingActions;
      }

      // Help / ok / unclear via parseReply (any phase for help)
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
        await escalateHelp(deps, rt, user, now, "parseReply");
        return rt.pendingActions;
      }

      if (
        parsed.status === "ok" &&
        (rt.phase === "CHECKING_IN" || rt.phase === "WALKING")
      ) {
        await logRule(deps, user.userId, "R9b", rt.walkId, { status: "ok" });
        if (parsed.placeLabel && rt.pings.length) {
          const last = rt.pings[rt.pings.length - 1]!;
          if (deps.persist !== false) {
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
        }
        if (parsed.placeLabel || /at .+|i'?m at|staying/i.test(raw)) {
          const last = rt.pings[rt.pings.length - 1];
          alert(
            rt,
            user.userId,
            templates.alertContactElsewhere,
            last?.lat ?? user.homeLat ?? 0,
            last?.lon ?? user.homeLon ?? 0,
          );
          await endWalk(deps, rt, "ENDED_ELSEWHERE", now);
          await logRule(deps, user.userId, "R15", null, { via: "reply" });
          return rt.pendingActions;
        }
        if (rt.phase === "CHECKING_IN") {
          rt.phase = "WALKING";
          rt.checkinOpenedAt = null;
          rt.suppressCheckinUntil = new Date(now.getTime() + 10 * 60_000);
        }
        return rt.pendingActions;
      }

      // Unclear by phase
      brainLog(deps, `intent=unclear phase=${rt.phase}`);
      if (rt.phase === "PROMPTED") {
        send(rt, user.userId, "prompt", copy.greetingPrompted);
        return rt.pendingActions;
      }
      if (rt.phase === "WALKING" || rt.phase === "CHECKING_IN") {
        send(rt, user.userId, "nudge", copyFor(rt, "unclear"));
        await logRule(deps, user.userId, "R9b", rt.walkId, { status: "unclear" });
        return rt.pendingActions;
      }
      // IDLE / ALERTED / CALLING
      if (rt.phase === "IDLE") {
        send(rt, user.userId, "prompt", copy.idleUnclear);
      }
      return rt.pendingActions;
    }

    if (event.type === "UserReaction") {
      // R3 prompt reply
      if (rt.phase === "PROMPTED" && (event.emoji === "👍" || event.emoji === "👎")) {
        if (event.emoji === "👍") {
          const last = rt.pings[rt.pings.length - 1];
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
          await logRule(deps, user.userId, "R3", rt.walkId, { reply: "like" });
          await noticeIfUnfamiliar(deps, rt, user, originLat, originLon);
        } else {
          rt.phase = "IDLE";
          rt.cooldownUntil = new Date(now.getTime() + PROMPT_COOLDOWN_MS);
          await logRule(deps, user.userId, "R3", null, { reply: "dislike" });
        }
        return rt.pendingActions;
      }
      // R9a
      if (rt.phase === "CHECKING_IN" && event.emoji === "👍") {
        rt.phase = "WALKING";
        rt.checkinOpenedAt = null;
        rt.suppressCheckinUntil = new Date(now.getTime() + 10 * 60_000);
        await logRule(deps, user.userId, "R9a", rt.walkId);
        return rt.pendingActions;
      }
    }

    if (event.type === "CallEvent") {
      if (event.callType === "silent_alert") {
        const last = rt.pings[rt.pings.length - 1];
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
      pushPing(rt, event);
      if (deps.persist !== false) {
        try {
          await insertLocationPing(event, rt.walkId);
        } catch (err) {
          console.warn("[brain] insertLocationPing failed", err);
        }
      }

      // R1: outside night — store only (already stored), no prompts/check-ins
      const night = isNight(now, user);

      // R3 timeout: PROMPTED + 10 min
      if (rt.phase === "PROMPTED" && rt.lastPromptAt) {
        if (now.getTime() - rt.lastPromptAt.getTime() >= 10 * 60_000) {
          rt.phase = "IDLE";
          rt.cooldownUntil = new Date(now.getTime() + 60 * 60_000);
          await logRule(deps, user.userId, "R3", null, { reply: "timeout" });
        }
      }

      // R2 prompt
      if (rt.phase === "IDLE" && night) {
        if (rt.cooldownUntil && now < rt.cooldownUntil) {
          /* cool */
        } else if (
          rt.lastPromptAt &&
          now.getTime() - rt.lastPromptAt.getTime() < PROMPT_COOLDOWN_MS
        ) {
          /* already prompted */
        } else if (user.homeLat != null && user.homeLon != null) {
          const win = rt.pings;
          if (win.length >= 2) {
            const first = win[0]!;
            const last = win[win.length - 1]!;
            const elapsedS = (last.time.getTime() - first.time.getTime()) / 1000;
            const moved = pathLengthM(win);
            const distHome = distanceM(
              last.lat,
              last.lon,
              user.homeLat,
              user.homeLon,
            );
            const spd = speedMps(
              first.lat,
              first.lon,
              first.time,
              last.lat,
              last.lon,
              last.time,
            );
            if (spd > 3) {
              await logRule(deps, user.userId, "R2x", null, { speed: spd });
              brainLog(deps, "R2x skip prompt — vehicle speed", spd);
            } else if (
              elapsedS >= 120 &&
              spd >= 0.7 &&
              spd <= 2.2 &&
              moved >= 120 &&
              distHome > 150
            ) {
              const originLat = last.lat;
              const originLon = last.lon;
              let familiar: string[] = [];
              try {
                familiar = await loadFamiliarCells(user.userId);
              } catch {
                /* ignore */
              }
              const cell = toCell(originLat, originLon);
              const unfamiliar =
                familiar.length > 0 && !familiar.includes(cell);
              if (unfamiliar) {
                await beginWalk(
                  deps,
                  rt,
                  user,
                  now,
                  "night_unfamiliar",
                  originLat,
                  originLon,
                );
                send(rt, user.userId, "checkin", copy.unfamiliarArea);
                brainLog(
                  deps,
                  `R2 unfamiliar → beginWalk cell=${cell} usual=${familiar.length}`,
                );
                await logRule(deps, user.userId, "R2", rt.walkId, {
                  speed: spd,
                  moved,
                  distHome,
                  unfamiliar: true,
                });
              } else {
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
        }
      }

      // Walking / checking-in rules
      if (
        (rt.phase === "WALKING" ||
          rt.phase === "CHECKING_IN" ||
          rt.phase === "ALERTED") &&
        rt.walkId
      ) {
        const last = event;
        const prev = rt.pings.length >= 2 ? rt.pings[rt.pings.length - 2] : null;

        // R14 near home
        if (user.homeLat != null && user.homeLon != null) {
          const d = distanceM(last.lat, last.lon, user.homeLat, user.homeLon);
          if (d <= 50) {
            rt.homeNearCount += 1;
            if (rt.homeNearCount >= 2) {
              alert(
                rt,
                user.userId,
                templates.alertContactHome,
                last.lat,
                last.lon,
              );
              await logRule(deps, user.userId, "R14", rt.walkId);
              await endWalk(deps, rt, "ARRIVED", now);
              return rt.pendingActions;
            }
          } else {
            rt.homeNearCount = 0;
          }
        }

        // R10 / R8 reply timers while CHECKING_IN
        if (rt.phase === "CHECKING_IN" && rt.checkinOpenedAt) {
          const since = now.getTime() - rt.checkinOpenedAt.getTime();
          if (!rt.nudged && since >= 60_000) {
            send(rt, user.userId, "nudge");
            rt.nudged = true;
            await logRule(deps, user.userId, "R10", rt.walkId, { step: "nudge" });
          } else if (rt.nudged && since >= 120_000) {
            alert(
              rt,
              user.userId,
              templates.alertContactQuiet,
              last.lat,
              last.lon,
            );
            rt.phase = "ALERTED";
            await logRule(deps, user.userId, "R10", rt.walkId, { step: "alert" });
          }
        }

        // R8 signal loss: no need on this ping (we just got one). Track gap via prev
        // Evaluated using window: if walking and last previous ping gap...
        // Actually R8 fires when NO ping for 4 min — need clock tick. Handle via
        // comparing now to last ping before this one was added — if we only get
        // pings when they arrive, gap detection needs a timer event. For sim,
        // when a ping arrives after long gap, check the gap from previous.
        if (prev) {
          const gap = last.time.getTime() - prev.time.getTime();
          if (gap >= 4 * 60_000 && rt.phase === "WALKING" && canCheckin(rt, now)) {
            openCheckin(rt, user.userId, now, "checkin");
            await logRule(deps, user.userId, "R8", rt.walkId, { gapMs: gap });
          }
          // 10 min gap + no reply already in check-in handled by R10; if still walking
          if (gap >= 10 * 60_000 && rt.phase === "WALKING") {
            alert(
              rt,
              user.userId,
              templates.alertContactQuiet,
              last.lat,
              last.lon,
            );
            rt.phase = "ALERTED";
            await logRule(deps, user.userId, "R8", rt.walkId, {
              gapMs: gap,
              step: "alert",
            });
          }
        }

        // Stationary detection
        if (prev) {
          const moved = distanceM(prev.lat, prev.lon, last.lat, last.lon);
          if (moved < STATIONARY_M) {
            if (!rt.stationarySince) rt.stationarySince = prev.time;
          } else {
            rt.stationarySince = null;
            rt.knownStopSince = null;
            rt.knownStopCell = null;
            rt.friendSince = null;
          }
        }

        const cell = toCell(last.lat, last.lon);
        const known = rt.plan?.stops.find((s) => s.cell === cell);
        if (known) {
          if (rt.knownStopCell !== cell) {
            rt.knownStopCell = cell;
            rt.knownStopSince = now;
            rt.friendSince = known.kind === "friend" ? now : null;
          }
          if (!rt.stationarySince) rt.stationarySince = rt.knownStopSince ?? now;
          const dwellMin =
            (now.getTime() - (rt.knownStopSince ?? now).getTime()) / 60000;
          // R5a: silent until allowed
          if (dwellMin <= known.allowedDwellMin) {
            // suppress R5b
          } else if (canCheckin(rt, now) && rt.phase === "WALKING") {
            openCheckin(rt, user.userId, now, "checkin");
            await logRule(deps, user.userId, "R5a", rt.walkId, {
              dwellMin,
              allowed: known.allowedDwellMin,
            });
          }
          // R15 friend
          if (known.kind === "friend") {
            if (!rt.friendSince) rt.friendSince = rt.knownStopSince ?? now;
            const friendMin =
              (now.getTime() - (rt.friendSince ?? now).getTime()) / 60000;
            if (friendMin > 15) {
              alert(
                rt,
                user.userId,
                templates.alertContactElsewhere,
                last.lat,
                last.lon,
              );
              await logRule(deps, user.userId, "R15", rt.walkId, {
                friendMin,
              });
              await endWalk(deps, rt, "ENDED_ELSEWHERE", now);
              return rt.pendingActions;
            }
          }
        } else if (rt.stationarySince && rt.phase === "WALKING") {
          // R5b: 3 min stationary (2 min after midnight)
          const afterMidnight = localHour(now, user.tz ?? "America/New_York") < 6;
          const thresholdMin = afterMidnight ? 2 : 3;
          const dwellMin =
            (now.getTime() - rt.stationarySince.getTime()) / 60000;
          if (dwellMin >= thresholdMin && canCheckin(rt, now) && !known) {
            openCheckin(rt, user.userId, now, "checkin");
            await logRule(deps, user.userId, "R5b", rt.walkId, {
              dwellMin,
              thresholdMin,
            });
            brainLog(deps, `R5b stationary ${dwellMin.toFixed(1)}/${thresholdMin}m`);
          } else if (!known && rt.stationarySince) {
            brainLog(
              deps,
              `stationary ${dwellMin.toFixed(1)}/${thresholdMin}m (waiting)`,
            );
          }
        }

        // R6 off route
        if (rt.plan && rt.plan.routeCells.length > 0 && rt.phase === "WALKING") {
          const onRoute = rt.plan.routeCells.includes(cell);
          // also allow buffer: check distance to any route cell center roughly via cell match only for hackathon
          if (!onRoute) {
            if (!rt.offRouteSince) rt.offRouteSince = now;
            const offMin = (now.getTime() - rt.offRouteSince.getTime()) / 60000;
            if (offMin >= 2 && canCheckin(rt, now)) {
              openCheckin(rt, user.userId, now, "checkin");
              await logRule(deps, user.userId, "R6", rt.walkId, { cell });
            }
          } else {
            rt.offRouteSince = null;
          }
        }

        // R7 late
        if (rt.plan && rt.walkStartedAt && rt.phase === "WALKING") {
          const elapsedMin =
            (now.getTime() - rt.walkStartedAt.getTime()) / 60000;
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

      // R1 note: if !night we already skipped R2; also skip check-ins outside night?
      // CONTEXT: "Outside night hours: no prompts/check-ins (pings still stored)"
      if (!night && rt.pendingActions.some((a) => a.type === "SendText")) {
        // Filter soft check-ins outside night, keep floors? Floors are R8/R10/R11 — those can fire anytime during walk.
        // Strict reading: no check-ins outside night. Keep alerts/calls.
        if (rt.phase !== "WALKING" && rt.phase !== "CHECKING_IN" && rt.phase !== "CALLING" && rt.phase !== "ALERTED") {
          rt.pendingActions = rt.pendingActions.filter(
            (a) => a.type !== "SendText" || a.tag === "arrived" || a.tag === "ended",
          );
        }
      }

      return rt.pendingActions;
    }

    return rt.pendingActions;
  }

  async function getLiveContext(walkId: string): Promise<LiveContext | null> {
    for (const [, rt] of states) {
      if (rt.walkId !== walkId) continue;
      const last = rt.pings[rt.pings.length - 1];
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

  return { handle, getLiveContext, getPhase, getRuntime, ensureHydrated };
}
