import type { Locations } from "../locations/index.ts";
import type { Clock, Event, SendTextTag } from "../shared/types.ts";
import type { UserRecord, UserStore } from "../store/index.ts";
import type { Inbound, SpectrumMessenger } from "./spectrum.ts";

const copy = {
  welcome:
    "Hi, I'm Nook. I walk you home at night.\n\nStep 1: share your location with me using the card below.",
  welcomeAlreadyShared:
    "Hi, I'm Nook. I walk you home at night.\n\nStep 1 is done: I can already see your location.",
  welcomeTerminal:
    "Hi, I'm Nook. I walk you home at night.\n\nStep 1: fake a location with /loc <lat> <lon>",
  askContact:
    "Step 2: who should I text if something seems wrong? Send me their phone number, like +1 555 123 4567.",
  askCodeword: (contact: string) =>
    `Step 3: pick a secret codeword. If you ever say it on a call with me, I'll quietly alert ${contact}. Send me one word, like pineapple.`,
  askHome: "Last step: next time you're at home, text HOME so I know where that is.",
  contactSaved: (contact: string) => `Got it. I'll text ${contact} if something's wrong.`,
  codewordSaved: (word: string) => `Codeword "${word}" saved.`,
  locationReceived: "Got your location, thanks.",
  homeSaved: "Home saved. You're all set. I'll check in when you walk at night.",
  homeNoFix:
    "I can't see your location yet. Make sure you're sharing it with me in Find My, then text HOME again.",
  badContact: "That number didn't look right. Send it with the area code, like +1 555 123 4567.",
} as const;

export type OnboardingStep = "contact" | "codeword" | "home" | "done";

export function nextStep(user: UserRecord): OnboardingStep {
  if (!user.contact) return "contact";
  if (!user.codeword) return "codeword";
  if (user.homeLat === undefined) return "home";
  return "done";
}

export interface ParsedOnboarding {
  contact?: string;
  codeword?: string;
  home: boolean;
  badContact: boolean;
}

const TRACKED_TAGS: SendTextTag[] = ["prompt", "checkin", "nudge", "arrived", "ended"];

const CONTACT_RE = /\bcontact\s+(\+?\d[\d\s().-]{6,}\d)/i;
const CODEWORD_RE = /\bcodeword\s+([^\s,.;!?]+)/i;
const BARE_PHONE_RE = /^\s*\+?[\d\s().-]*\d{3}[\d\s().-]*\s*$/;
const BARE_WORD_RE = /^\s*([a-z][a-z'-]{1,29})\s*[.!]?\s*$/i;
const HOME_RE = /^\s*home\s*[.!]?\s*$/i;
const LOC_RE = /^\/loc\s+(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)\s*$/i;

/** US-default E.164 normalization; returns null when it can't be a phone number. */
export function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (raw.trim().startsWith("+")) return digits.length >= 8 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * Explicit `contact …` / `codeword …` always work. While onboarding is waiting
 * on a step, a bare phone number or a single word also answers it.
 */
export function parseOnboarding(text: string, step: OnboardingStep = "done"): ParsedOnboarding {
  const home = HOME_RE.test(text);
  let contactRaw = text.match(CONTACT_RE)?.[1];
  if (!contactRaw && step === "contact" && BARE_PHONE_RE.test(text)) contactRaw = text;
  let codeword = text.match(CODEWORD_RE)?.[1];
  if (!codeword && !home && step === "codeword") codeword = text.match(BARE_WORD_RE)?.[1];

  const contact = contactRaw ? toE164(contactRaw) : null;
  return {
    ...(contact && { contact }),
    ...(codeword && { codeword: codeword.toLowerCase() }),
    home,
    badContact: contactRaw !== undefined && !contact,
  };
}

export interface RouterDeps {
  messenger: SpectrumMessenger;
  locations: Locations;
  users: UserStore;
  clock: Clock;
  dispatch: (event: Event) => Promise<void>;
}

export function createInboundRouter(deps: RouterDeps) {
  const { messenger, locations, users, clock, dispatch } = deps;
  const reply = (user: UserRecord, text: string) => messenger.sendToUser(user.userId, text);
  const log = (user: UserRecord, ...parts: string[]) =>
    console.log(`[onboarding] ${user.userId} (${user.handle})`, ...parts);
  const confirmedFix = new Set<string>();

  async function promptFor(user: UserRecord, step: OnboardingStep) {
    if (step === "contact") await reply(user, copy.askContact);
    else if (step === "codeword") await reply(user, copy.askCodeword(user.contact!));
    else if (step === "home") await reply(user, copy.askHome);
  }

  async function welcome(msg: Inbound) {
    const { user } = msg;
    log(user, "new user");
    if (messenger.provider === "terminal") {
      await reply(user, copy.welcomeTerminal);
    } else {
      if (await locations.isSharing(user.userId, user.handle)) {
        confirmedFix.add(user.userId);
        await reply(user, copy.welcomeAlreadyShared);
      } else {
        await reply(user, copy.welcome);
        await locations.request(msg.chatId, user.handle);
      }
    }
    await promptFor(user, nextStep(user));
  }

  /** Returns true when the text was an onboarding answer (not forwarded to brain). */
  async function handleOnboardingText(user: UserRecord, text: string): Promise<boolean> {
    const loc = text.match(LOC_RE);
    if (loc && messenger.provider === "terminal") {
      await locations.inject(user.userId, Number(loc[1]), Number(loc[2]));
      return true;
    }

    const parsed = parseOnboarding(text, nextStep(user));
    if (parsed.badContact) {
      await reply(user, copy.badContact);
      return true;
    }

    if (parsed.contact || parsed.codeword) {
      const lines: string[] = [];
      if (parsed.contact) {
        await users.setContact(user.userId, parsed.contact);
        log(user, `contact saved: ${parsed.contact}`);
        lines.push(copy.contactSaved(parsed.contact));
      }
      if (parsed.codeword) {
        await users.setCodeword(user.userId, parsed.codeword);
        log(user, `codeword saved (${parsed.codeword.length} chars)`);
        lines.push(copy.codewordSaved(parsed.codeword));
      }
      await reply(user, lines.join(" "));
      const fresh = (await users.getById(user.userId)) ?? user;
      await promptFor(fresh, nextStep(fresh));
      return true;
    }

    if (parsed.home) {
      const fix = locations.latest(user.userId);
      if (!fix) {
        log(user, "HOME received but no location fix yet");
        await reply(user, copy.homeNoFix);
        return true;
      }
      await users.setHome(user.userId, fix.lat, fix.lon);
      const where = fix.shortAddress ? ` ${fix.shortAddress}` : "";
      log(
        user,
        `home saved: ${fix.lat.toFixed(5)},${fix.lon.toFixed(5)}${where} (fix from ${fix.time.toISOString()})`,
      );
      await reply(user, copy.homeSaved);
      return true;
    }

    return false;
  }

  async function route(msg: Inbound): Promise<void> {
    if (msg.isNewUser) await welcome(msg);

    if (msg.kind === "reaction") {
      const uid = msg.user.userId;
      const tag = TRACKED_TAGS.find((t) => messenger.lastMessageId(uid, t) === msg.targetMessageId);
      log(msg.user, `reacted ${msg.emoji} to ${tag ? `last "${tag}" message` : "an untracked message"}`);
      await dispatch({
        type: "UserReaction",
        userId: msg.user.userId,
        emoji: msg.emoji,
        targetMessageId: msg.targetMessageId,
        time: clock.now(),
      });
      return;
    }

    if (await handleOnboardingText(msg.user, msg.text)) return;
    if (msg.isNewUser) return;

    await dispatch({
      type: "UserText",
      userId: msg.user.userId,
      messageId: msg.messageId,
      text: msg.text,
      time: clock.now(),
    });
  }

  /** First fix while still onboarding: tell the user sharing worked. */
  async function onFix(userId: string): Promise<void> {
    if (confirmedFix.has(userId)) return;
    confirmedFix.add(userId);
    const user = await users.getById(userId);
    if (!user || nextStep(user) === "done") return;
    await reply(user, copy.locationReceived);
  }

  return { route, onFix };
}
