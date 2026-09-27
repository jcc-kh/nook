import type { Locations } from "../locations/index.ts";
import {
  clampTimeout,
  resolveTimeouts,
  TIMEOUT_LIMITS,
  type CheckinTimeouts,
  type EscalationPolicy,
  type LearnedRoutine,
  type TimeoutKey,
  type TrustedContact,
} from "../shared/settings.ts";
import type { Clock, Event, SendTextTag, VoiceNoteRef } from "../shared/types.ts";
import type { UserPatch, UserRecord, UserStore } from "../store/index.ts";
import type { InboundVoiceNote, IngestedVoiceNote } from "../voice/notes.ts";
import { copy, escalationOptions, learnedSummary, monitoringOptions } from "./copy.ts";
import {
  escalationKeyword,
  HOME_RE,
  type Intent,
  isCancel,
  isKeep,
  LOC_RE,
  monitoringKeyword,
  parseChoice,
  parseContact,
  parseDuration,
  parseIntent,
  parseName,
  parseOwnName,
  parseYesNo,
} from "./parse.ts";
import type { Inbound, SpectrumMessenger } from "./spectrum.ts";

/**
 * Deterministic onboarding + settings. Every question and transition is
 * decided here from structured state; nothing is inferred by an LLM.
 *
 * Onboarding sends one message per turn and only moves on when the user
 * answers (or, for the location step, shares their location):
 * user's name → contact (+ name / number if missing) → monitoring → escalation → location → home → done.
 */

type Question =
  | "userName"
  | "contact"
  | "contactName"
  | "contactPhone"
  | "monitoring"
  | "escalation"
  | "location"
  | "home"
  | "timeNudge"
  | "timeEscalate"
  | "timeNoUpdate";

type Pending =
  /**
   * `editing`: changing a setting after onboarding, so the answer needs a yes before it's saved.
   * `draft`: timings collected so far in the "change my check-in timing" flow.
   * `contact`: the half of a trusted contact we have while asking for the other half.
   */
  | {
      kind: "ask";
      question: Question;
      editing: boolean;
      draft?: CheckinTimeouts;
      contact?: Partial<TrustedContact>;
    }
  | { kind: "confirm"; patch: UserPatch; saved: string; summary: string };

type AskPending = Extract<Pending, { kind: "ask" }>;
type TextInbound = Extract<Inbound, { kind: "text" }>;
type VoiceInbound = Extract<Inbound, { kind: "voice" }>;

const TRACKED_TAGS: SendTextTag[] = ["prompt", "started", "checkin", "nudge", "arrived", "ended"];

export interface RouterDeps {
  messenger: SpectrumMessenger;
  locations: Locations;
  users: UserStore;
  clock: Clock;
  dispatch: (event: Event) => Promise<void>;
  /** Routine learning isn't built yet; plug a Tiger-backed source in here later. */
  learned?: (userId: string) => Promise<LearnedRoutine | null>;
  /** Saves + transcribes an inbound voice note. Without it, voice notes reach the brain untranscribed. */
  ingestVoiceNote?: (note: InboundVoiceNote) => Promise<IngestedVoiceNote>;
}

export function createInboundRouter(deps: RouterDeps) {
  const { messenger, locations, users, clock, dispatch } = deps;
  const reply = (user: UserRecord, text: string) => messenger.sendToUser(user.userId, text);
  const log = (user: UserRecord, ...parts: string[]) =>
    console.log(`[onboarding] ${user.userId} (${user.handle})`, ...parts);
  const fresh = async (user: UserRecord) => (await users.getById(user.userId)) ?? user;
  const pending = new Map<string, Pending>();
  /** Chat to send the Find My card into. */
  const chatIds = new Map<string, string>();
  const skippedLocation = new Set<string>();
  const askedHome = new Set<string>();

  function questionText(user: UserRecord, p: AskPending): string {
    switch (p.question) {
      case "userName":
        return copy.askUserName;
      case "contact":
        return copy.askContact;
      case "contactName":
        return copy.askContactName;
      case "contactPhone":
        return copy.askContactPhone(p.contact?.name ?? "their");
      case "monitoring":
        return copy.askMonitoring;
      case "escalation":
        return copy.askEscalation(user.trustedContact);
      case "location":
        return messenger.provider === "terminal" ? copy.locationTerminal : copy.locationRequest;
      case "home":
        return copy.askHome;
      case "timeNudge":
        return copy.askNudgeAfter(resolveTimeouts(user.timeouts).nudgeAfterSec);
      case "timeEscalate":
        return copy.askEscalateAfter(resolveTimeouts(user.timeouts).escalateAfterSec);
      case "timeNoUpdate":
        return copy.askNoUpdate(resolveTimeouts(user.timeouts).noUpdateMin);
    }
  }

  /** `lead`: acknowledgement of the previous answer, sent in the same message. */
  async function ask(
    user: UserRecord,
    question: Question,
    editing: boolean,
    opts: { lead?: string; draft?: CheckinTimeouts; contact?: Partial<TrustedContact> } = {},
  ) {
    const p: AskPending = {
      kind: "ask",
      question,
      editing,
      ...(opts.draft && { draft: opts.draft }),
      ...(opts.contact && { contact: opts.contact }),
    };
    pending.set(user.userId, p);
    await reply(user, [opts.lead, questionText(user, p)].filter(Boolean).join("\n\n"));
    if (question === "location" && messenger.provider !== "terminal") {
      const chatId = chatIds.get(user.userId);
      if (chatId) await locations.request(chatId, user.handle);
      else log(user, "no chat id for the Find My card");
    }
  }

  /** One step of the timing flow: a number in range, or "same" to keep the current value. */
  function readTiming(user: UserRecord, key: TimeoutKey, text: string): number | string {
    const unit = key === "noUpdateMin" ? "min" : "sec";
    const { min, max } = TIMEOUT_LIMITS[key];
    if (isKeep(text)) return resolveTimeouts(user.timeouts)[key];
    const n = parseDuration(text, unit);
    if (n === undefined || n < min || n > max) {
      return copy.badTiming(min, max, unit === "min" ? "minutes" : "seconds");
    }
    return clampTimeout(key, n);
  }

  async function propose(user: UserRecord, patch: UserPatch, prompt: string, saved: string, summary: string) {
    pending.set(user.userId, { kind: "confirm", patch, saved, summary });
    await reply(user, prompt);
  }

  async function save(user: UserRecord, patch: UserPatch, summary: string) {
    await users.updateUser(user.userId, patch);
    log(user, summary);
  }

  async function hasLocation(user: UserRecord): Promise<boolean> {
    if (locations.latest(user.userId)) return true;
    if (messenger.provider === "terminal") return false;
    return locations.isSharing(user.userId, user.handle);
  }

  /** Next unanswered onboarding step; null once onboarding is finished. */
  async function nextStep(user: UserRecord): Promise<Question | null> {
    if (!user.displayName) return "userName";
    if (!user.trustedContact) return "contact";
    if (!user.monitoringMode) return "monitoring";
    if (!user.escalation) return "escalation";
    if (!skippedLocation.has(user.userId) && !(await hasLocation(user))) return "location";
    if (user.homeLat === undefined && locations.latest(user.userId) && !askedHome.has(user.userId)) {
      return "home";
    }
    return null;
  }

  async function continueOnboarding(user: UserRecord, lead?: string) {
    const u = await fresh(user);
    const step = await nextStep(u);
    if (step) return ask(u, step, false, lead ? { lead } : {});
    return finish(u, lead);
  }

  async function finish(user: UserRecord, lead?: string) {
    pending.delete(user.userId);
    await save(user, { onboardedAt: clock.now() }, "onboarding complete");
    await reply(user, [lead, copy.done(await fresh(user))].filter(Boolean).join("\n\n"));
  }

  async function welcome(msg: Inbound) {
    const { user } = msg;
    log(user, "new user");
    if (user.displayName) {
      await reply(user, copy.welcome.split("\n\n")[0]!);
      return continueOnboarding(user);
    }
    pending.set(user.userId, { kind: "ask", question: "userName", editing: false });
    await reply(user, copy.welcome);
  }

  async function saveHome(user: UserRecord) {
    const fix = locations.latest(user.userId);
    if (!fix) {
      log(user, "home received but no location fix yet");
      await reply(user, copy.homeNoFix);
      return;
    }
    await users.setHome(user.userId, fix.lat, fix.lon);
    const where = fix.shortAddress ? ` ${fix.shortAddress}` : "";
    log(
      user,
      `home saved: ${fix.lat.toFixed(5)},${fix.lon.toFixed(5)}${where} (fix from ${fix.time.toISOString()})`,
    );
    const p = pending.get(user.userId);
    if (p?.kind === "ask" && p.question === "home") {
      askedHome.add(user.userId);
      return continueOnboarding(user, copy.homeSaved);
    }
    await reply(user, copy.homeSaved);
  }

  /** A complete trusted contact: reject the user's own number, then save (or propose when editing). */
  async function acceptContact(user: UserRecord, p: AskPending, contact: TrustedContact) {
    if (contact.phone === user.handle) return void (await reply(user, copy.contactIsSelf));
    if (!contact.name) return ask(user, "contactName", p.editing, { contact: { phone: contact.phone } });
    const summary = `trusted contact: ${contact.name} ${contact.phone}`;
    if (p.editing) {
      return propose(user, { trustedContact: contact }, copy.confirmContact(contact), copy.contactSaved(contact), summary);
    }
    await save(user, { trustedContact: contact }, summary);
    return continueOnboarding(user, copy.contactSaved(contact));
  }

  async function answer(user: UserRecord, p: AskPending, text: string): Promise<void> {
    const c = user.trustedContact;
    switch (p.question) {
      case "userName": {
        const name = parseOwnName(text);
        if (!name) return void (await reply(user, copy.badUserName));
        if (p.editing) return propose(user, { displayName: name }, copy.confirmUserName(name), copy.changeSaved, `name: ${name}`);
        await save(user, { displayName: name }, `name: ${name}`);
        return continueOnboarding(user, copy.userNameSaved(name));
      }
      case "contact": {
        const r = parseContact(text);
        if (r.contact) return acceptContact(user, p, r.contact);
        if (r.name) return ask(user, "contactPhone", p.editing, { contact: { name: r.name } });
        return void (await reply(user, r.sawNumber ? copy.badContact : copy.askContact));
      }
      case "contactName": {
        const r = parseContact(text);
        if (r.contact?.name) return acceptContact(user, p, r.contact);
        const name = parseName(text);
        if (!name || !p.contact?.phone) return void (await reply(user, copy.badContactName));
        return acceptContact(user, p, { name, phone: p.contact.phone });
      }
      case "contactPhone": {
        const r = parseContact(text);
        if (!r.contact) return void (await reply(user, copy.badContact));
        const name = r.contact.name ?? p.contact?.name;
        return acceptContact(user, p, { phone: r.contact.phone, ...(name && { name }) });
      }
      case "monitoring": {
        const mode = parseChoice(text, monitoringOptions, monitoringKeyword);
        if (!mode) return void (await reply(user, copy.pickNumber(monitoringOptions.length)));
        if (p.editing) return propose(user, { monitoringMode: mode }, copy.confirmMonitoring(mode), copy.changeSaved, `monitoring: ${mode}`);
        await save(user, { monitoringMode: mode }, `monitoring: ${mode}`);
        return continueOnboarding(user);
      }
      case "escalation": {
        const action = parseChoice(text, escalationOptions, escalationKeyword(c?.name));
        if (!action) return void (await reply(user, copy.pickNumber(escalationOptions.length)));
        const escalation: EscalationPolicy = { initialAction: "TEXT_USER", onNoTextResponse: action };
        if (p.editing) return propose(user, { escalation }, copy.confirmEscalation(action, c), copy.changeSaved, `escalation: TEXT_USER → ${action}`);
        await save(user, { escalation }, `escalation: TEXT_USER → ${action}`);
        return continueOnboarding(user);
      }
      case "location": {
        if (parseYesNo(text) === false || /\b(skip|later)\b/i.test(text)) {
          skippedLocation.add(user.userId);
          log(user, "skipped location sharing");
          return continueOnboarding(user, copy.locationSkipped);
        }
        if (await hasLocation(user)) return continueOnboarding(user, copy.locationConnected);
        return void (await reply(user, copy.locationWaiting));
      }
      case "home": {
        const yes = parseYesNo(text);
        if (yes === undefined) return void (await reply(user, copy.yesOrNo));
        if (yes) return saveHome(user);
        askedHome.add(user.userId);
        return continueOnboarding(user, copy.homeLater);
      }
      case "timeNudge": {
        const v = readTiming(user, "nudgeAfterSec", text);
        if (typeof v === "string") return void (await reply(user, v));
        return ask(user, "timeEscalate", true, { draft: { ...p.draft, nudgeAfterSec: v } });
      }
      case "timeEscalate": {
        const v = readTiming(user, "escalateAfterSec", text);
        if (typeof v === "string") return void (await reply(user, v));
        return ask(user, "timeNoUpdate", true, { draft: { ...p.draft, escalateAfterSec: v } });
      }
      case "timeNoUpdate": {
        const v = readTiming(user, "noUpdateMin", text);
        if (typeof v === "string") return void (await reply(user, v));
        const timeouts = resolveTimeouts({ ...p.draft, noUpdateMin: v });
        return propose(
          user,
          { timeouts },
          copy.confirmTimeouts(timeouts),
          copy.changeSaved,
          `timeouts: nudge ${timeouts.nudgeAfterSec}s, escalate ${timeouts.escalateAfterSec}s, no-update ${timeouts.noUpdateMin}min`,
        );
      }
    }
  }

  /** Setting changes after onboarding. Each one is proposed and needs a yes. */
  async function handleIntent(user: UserRecord, intent: Intent) {
    switch (intent.kind) {
      case "settings":
        return reply(user, copy.settings(user));
      case "learned": {
        const routine = await deps.learned?.(user.userId);
        return reply(user, routine ? learnedSummary(routine) : copy.learnedNothing);
      }
      case "monitoring":
        if (!intent.mode) return ask(user, "monitoring", true);
        return propose(user, { monitoringMode: intent.mode }, copy.confirmMonitoring(intent.mode), copy.changeSaved, `monitoring: ${intent.mode}`);
      case "contact":
        if (!intent.contact) return ask(user, "contact", true);
        return acceptContact(user, { kind: "ask", question: "contact", editing: true }, intent.contact);
      case "escalation":
        return ask(user, "escalation", true);
      case "timing":
        return ask(user, "timeNudge", true);
      case "name":
        if (!intent.name) return ask(user, "userName", true);
        return propose(user, { displayName: intent.name }, copy.confirmUserName(intent.name), copy.changeSaved, `name: ${intent.name}`);
    }
  }

  async function handleText(msg: TextInbound) {
    const user = await fresh(msg.user);
    const { text } = msg;
    const p = pending.get(user.userId);
    if (msg.threadTargetId) log(user, `in-thread reply to ${msg.threadTargetId}`);

    const loc = text.match(LOC_RE);
    if (loc && messenger.provider === "terminal") {
      await locations.inject(user.userId, Number(loc[1]), Number(loc[2]));
      return;
    }

    if (HOME_RE.test(text)) return saveHome(user);

    const intent = parseIntent(text);

    // Settings always win over an open walk / pending confirm — never dump these into the brain.
    if (
      intent &&
      (intent.kind === "settings" ||
        intent.kind === "learned" ||
        intent.kind === "name" ||
        intent.kind === "monitoring" ||
        intent.kind === "contact" ||
        intent.kind === "escalation" ||
        intent.kind === "timing")
    ) {
      if (p) pending.delete(user.userId);
      return handleIntent(user, intent);
    }

    if (p?.kind === "confirm") {
      const yes = parseYesNo(text);
      if (yes === true) {
        pending.delete(user.userId);
        await save(user, p.patch, `settings change confirmed: ${p.summary}`);
        await reply(user, p.saved);
        return;
      }
      if (yes === false) {
        pending.delete(user.userId);
        await reply(user, copy.changeCancelled);
        return;
      }
      // not yes/no — keep waiting, don't fall through to the walk brain
      await reply(user, copy.yesOrNo);
      return;
    }
    if (p?.kind === "ask") {
      if (p.editing && isCancel(text)) {
        pending.delete(user.userId);
        await reply(user, copy.changeCancelled);
        return;
      }
      return answer(user, p, text);
    }

    if (!user.onboardedAt) return continueOnboarding(user);

    await dispatch({
      type: "UserText",
      userId: user.userId,
      messageId: msg.messageId,
      text,
      time: clock.now(),
    });
  }

  /** Voice notes go through the same safety pipeline as text, with the original audio kept. */
  async function handleVoice(msg: VoiceInbound) {
    const user = await fresh(msg.user);
    if (!user.onboardedAt) {
      await reply(user, copy.voiceNoteOnboarding);
      return;
    }
    let text = "";
    let voiceNote: VoiceNoteRef | undefined;
    if (deps.ingestVoiceNote) {
      try {
        const got = await deps.ingestVoiceNote({
          messageId: msg.messageId,
          userId: user.userId,
          mimeType: msg.mimeType,
          ...(msg.name && { name: msg.name }),
          read: msg.read,
        });
        text = got.transcript;
        voiceNote = got.ref;
      } catch (err) {
        console.error(`[onboarding] voice note ingest failed for ${user.userId}`, err);
      }
    }
    log(user, `voice note ${msg.messageId}: ${voiceNote?.transcribed ? `transcript ${text.length} chars` : "(no transcript)"}`);
    await dispatch({
      type: "UserText",
      userId: user.userId,
      messageId: msg.messageId,
      text,
      time: clock.now(),
      ...(voiceNote && { voiceNote }),
    });
  }

  async function route(msg: Inbound): Promise<void> {
    chatIds.set(msg.user.userId, msg.chatId);
    if (msg.kind === "voice") {
      const blankUser = !msg.user.onboardedAt && !msg.user.trustedContact && !pending.has(msg.user.userId);
      if (msg.isNewUser || blankUser) return welcome(msg);
      return handleVoice(msg);
    }
    if (msg.kind === "reaction") {
      if (msg.isNewUser) return welcome(msg);
      const uid = msg.user.userId;
      const tag = TRACKED_TAGS.find((t) => messenger.lastMessageId(uid, t) === msg.targetMessageId);
      log(msg.user, `reacted ${msg.emoji} to ${tag ? `last "${tag}" message` : "an untracked message"}`);
      await dispatch({
        type: "UserReaction",
        userId: uid,
        emoji: msg.emoji,
        targetMessageId: msg.targetMessageId,
        ...(msg.messageId && { messageId: msg.messageId }),
        time: clock.now(),
      });
      return;
    }
    const blank = !msg.user.onboardedAt && !msg.user.trustedContact && !pending.has(msg.user.userId);
    if (msg.isNewUser || blank) return welcome(msg);
    await handleText(msg);
  }

  /** A location fix arrived. If onboarding is waiting on the share, that's the user's answer. */
  async function onFix(userId: string): Promise<void> {
    const p = pending.get(userId);
    if (p?.kind !== "ask" || p.question !== "location") return;
    const user = await users.getById(userId);
    if (user) await continueOnboarding(user, copy.locationConnected);
  }

  /** Drop any half-answered question (demo setup finishes onboarding directly in the DB). */
  function forget(userId: string): void {
    pending.delete(userId);
  }

  return { route, onFix, forget };
}
