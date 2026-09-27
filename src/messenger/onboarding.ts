import type { Locations } from "../locations/index.ts";
import type { EscalationPolicy, LearnedRoutine } from "../shared/settings.ts";
import type { Clock, Event, SendTextTag } from "../shared/types.ts";
import type { UserPatch, UserRecord, UserStore } from "../store/index.ts";
import { copy, emergencyOptions, escalationOptions, learnedSummary, monitoringOptions } from "./copy.ts";
import {
  containsPhrase,
  emergencyKeyword,
  escalationKeyword,
  HOME_RE,
  type Intent,
  isCancel,
  LOC_RE,
  monitoringKeyword,
  parseChoice,
  parseCodePhrase,
  parseContact,
  parseIntent,
  parseYesNo,
} from "./parse.ts";
import type { Inbound, SpectrumMessenger } from "./spectrum.ts";

/**
 * Deterministic onboarding + settings. Every question and transition is
 * decided here from structured state; nothing is inferred by an LLM.
 */

type Question = "contact" | "monitoring" | "escalation" | "codeOffer" | "codePhrase" | "codeAction";

type Pending =
  /** `editing`: changing a setting after onboarding, so the answer needs a yes before it's saved. */
  | { kind: "ask"; question: Question; editing: boolean; phrase?: string }
  | { kind: "confirm"; patch: UserPatch; saved: string; summary: string };

type AskPending = Extract<Pending, { kind: "ask" }>;
type TextInbound = Extract<Inbound, { kind: "text" }>;

const TRACKED_TAGS: SendTextTag[] = ["prompt", "checkin", "nudge", "arrived", "ended"];

/** Next unanswered onboarding question; null once onboarding is finished. */
export function nextQuestion(user: UserRecord): Question | null {
  if (!user.trustedContact) return "contact";
  if (!user.monitoringMode) return "monitoring";
  if (!user.escalation) return "escalation";
  if (!user.onboardedAt) return "codeOffer";
  return null;
}

export interface RouterDeps {
  messenger: SpectrumMessenger;
  locations: Locations;
  users: UserStore;
  clock: Clock;
  dispatch: (event: Event) => Promise<void>;
  /** Routine learning isn't built yet; plug a Tiger-backed source in here later. */
  learned?: (userId: string) => Promise<LearnedRoutine | null>;
}

export function createInboundRouter(deps: RouterDeps) {
  const { messenger, locations, users, clock, dispatch } = deps;
  const reply = (user: UserRecord, text: string) => messenger.sendToUser(user.userId, text);
  const log = (user: UserRecord, ...parts: string[]) =>
    console.log(`[onboarding] ${user.userId} (${user.handle})`, ...parts);
  const fresh = async (user: UserRecord) => (await users.getById(user.userId)) ?? user;
  const awaitingShare = new Set<string>();
  const pending = new Map<string, Pending>();

  function questionText(user: UserRecord, question: Question, phrase?: string): string {
    switch (question) {
      case "contact":
        return copy.askContact;
      case "monitoring":
        return copy.askMonitoring;
      case "escalation":
        return copy.askEscalation(user.trustedContact);
      case "codeOffer":
        return copy.offerCode;
      case "codePhrase":
        return copy.askCodePhrase;
      case "codeAction":
        return copy.askCodeAction(phrase ?? "", user.trustedContact);
    }
  }

  async function ask(user: UserRecord, question: Question, editing: boolean, phrase?: string) {
    pending.set(user.userId, { kind: "ask", question, editing, ...(phrase && { phrase }) });
    await reply(user, questionText(user, question, phrase));
  }

  async function propose(user: UserRecord, patch: UserPatch, prompt: string, saved: string, summary: string) {
    pending.set(user.userId, { kind: "confirm", patch, saved, summary });
    await reply(user, prompt);
  }

  async function save(user: UserRecord, patch: UserPatch, summary: string) {
    await users.updateUser(user.userId, patch);
    log(user, summary);
  }

  async function continueOnboarding(user: UserRecord) {
    const u = await fresh(user);
    const question = nextQuestion(u);
    if (question) await ask(u, question, false);
    else pending.delete(u.userId);
  }

  async function finish(user: UserRecord) {
    pending.delete(user.userId);
    await save(user, { onboardedAt: clock.now() }, "onboarding complete");
    await reply(user, copy.done);
  }

  async function welcome(msg: Inbound) {
    const { user } = msg;
    log(user, "new user");
    await reply(user, copy.intro);
    if (messenger.provider === "terminal") {
      awaitingShare.add(user.userId);
      await reply(user, copy.locationTerminal);
    } else if (await locations.isSharing(user.userId, user.handle)) {
      log(user, "already sharing location");
      await reply(user, copy.locationConnected);
    } else {
      awaitingShare.add(user.userId);
      await reply(user, copy.locationRequest);
      await locations.request(msg.chatId, user.handle);
    }
    await continueOnboarding(user);
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
    await reply(user, copy.homeSaved);
  }

  async function answer(user: UserRecord, p: AskPending, text: string): Promise<void> {
    const c = user.trustedContact;
    switch (p.question) {
      case "contact": {
        const { contact, sawNumber } = parseContact(text);
        if (!contact) return void (await reply(user, sawNumber ? copy.badContact : copy.askContact));
        const summary = `trusted contact: ${contact.name ?? "(no name)"} ${contact.phone}`;
        if (p.editing) return propose(user, { trustedContact: contact }, copy.confirmContact(contact), copy.contactSaved(contact), summary);
        await save(user, { trustedContact: contact }, summary);
        await reply(user, copy.contactSaved(contact));
        return continueOnboarding(user);
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
      case "codeOffer": {
        const yes = parseYesNo(text);
        if (yes === undefined) return void (await reply(user, copy.yesOrNo));
        if (!yes) {
          log(user, "declined emergency word");
          return finish(user);
        }
        return ask(user, "codePhrase", p.editing);
      }
      case "codePhrase": {
        const phrase = parseCodePhrase(text);
        if (!phrase) return void (await reply(user, copy.badCodePhrase));
        return ask(user, "codeAction", p.editing, phrase);
      }
      case "codeAction": {
        const action = parseChoice(text, emergencyOptions, emergencyKeyword(c?.name));
        if (!action) return void (await reply(user, copy.pickNumber(emergencyOptions.length)));
        const emergencyCode = { phrase: p.phrase ?? "", action };
        const summary = `emergency word set (${emergencyCode.phrase.length} chars) → ${action}`;
        const set = copy.codeSet(emergencyCode.phrase, action, c);
        if (p.editing) return propose(user, { emergencyCode }, copy.confirmCode(emergencyCode.phrase, action, c), set, summary);
        await save(user, { emergencyCode }, summary);
        await reply(user, set);
        return finish(user);
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
        return propose(
          user,
          { trustedContact: intent.contact },
          copy.confirmContact(intent.contact),
          copy.contactSaved(intent.contact),
          `trusted contact: ${intent.contact.name ?? "(no name)"} ${intent.contact.phone}`,
        );
      case "escalation":
        return ask(user, "escalation", true);
      case "code":
        if (!intent.remove) return ask(user, "codePhrase", true);
        if (!user.emergencyCode) return reply(user, copy.noCodeToRemove);
        return propose(user, { emergencyCode: undefined }, copy.confirmCodeRemoval, copy.codeRemoved, "emergency word removed");
    }
  }

  async function handleText(msg: TextInbound) {
    const user = await fresh(msg.user);
    const { text } = msg;
    const p = pending.get(user.userId);

    const loc = text.match(LOC_RE);
    if (loc && messenger.provider === "terminal") {
      await locations.inject(user.userId, Number(loc[1]), Number(loc[2]));
      return;
    }

    const choosingPhrase = p?.kind === "ask" && p.question === "codePhrase";
    if (user.emergencyCode && !choosingPhrase && containsPhrase(text, user.emergencyCode.phrase)) {
      log(user, `emergency word received → ${user.emergencyCode.action}`);
      await dispatch({ type: "EmergencyCode", userId: user.userId, source: "text", time: clock.now() });
      return;
    }

    if (HOME_RE.test(text)) return saveHome(user);

    const intent = parseIntent(text);
    if (intent?.kind === "settings" || intent?.kind === "learned") return handleIntent(user, intent);

    if (p?.kind === "confirm") {
      pending.delete(user.userId);
      const yes = parseYesNo(text);
      if (yes) {
        await save(user, p.patch, `settings change confirmed: ${p.summary}`);
        await reply(user, p.saved);
        return;
      }
      await reply(user, copy.changeCancelled);
      if (yes === false) return;
    } else if (p?.kind === "ask") {
      if (p.editing && isCancel(text)) {
        pending.delete(user.userId);
        await reply(user, copy.changeCancelled);
        return;
      }
      return answer(user, p, text);
    }

    if (!user.onboardedAt) return continueOnboarding(user);
    if (intent) return handleIntent(user, intent);

    await dispatch({
      type: "UserText",
      userId: user.userId,
      messageId: msg.messageId,
      text,
      time: clock.now(),
    });
  }

  async function route(msg: Inbound): Promise<void> {
    if (msg.kind === "reaction") {
      if (msg.isNewUser) await welcome(msg);
      const uid = msg.user.userId;
      const tag = TRACKED_TAGS.find((t) => messenger.lastMessageId(uid, t) === msg.targetMessageId);
      log(msg.user, `reacted ${msg.emoji} to ${tag ? `last "${tag}" message` : "an untracked message"}`);
      await dispatch({
        type: "UserReaction",
        userId: uid,
        emoji: msg.emoji,
        targetMessageId: msg.targetMessageId,
        time: clock.now(),
      });
      return;
    }
    if (msg.isNewUser) return welcome(msg);
    await handleText(msg);
  }

  /** First fix after asking the user to share: tell them it worked. */
  async function onFix(userId: string): Promise<void> {
    if (!awaitingShare.delete(userId)) return;
    const user = await users.getById(userId);
    if (user) await reply(user, copy.locationConnected);
  }

  return { route, onFix };
}
