import type { Locations } from "../locations/index.ts";
import type { Clock, Event } from "../shared/types.ts";
import type { UserRecord, UserStore } from "../store/index.ts";
import type { Inbound, SpectrumMessenger } from "./spectrum.ts";

const copy = {
  welcome:
    "Hi, I'm Nook. I walk you home at night. Share your location with me from the card below, then text:\ncontact +1XXXXXXXXXX codeword <word>",
  welcomeTerminal:
    "Hi, I'm Nook. Text: contact +1XXXXXXXXXX codeword <word>\nFake a location with: /loc <lat> <lon>",
  askHome: "When you're at home, text HOME so I know where that is.",
  homeSaved: "Home saved. You're all set. I'll check in when you walk at night.",
  homeNoFix:
    "I can't see your location yet. Make sure you're sharing it with me in Find My, then text HOME again.",
  badContact: "That contact number didn't look right. Try: contact +15551234567",
} as const;

export interface ParsedOnboarding {
  contact?: string;
  codeword?: string;
  home: boolean;
}

const CONTACT_RE = /\bcontact\s+(\+?\d[\d\s().-]{6,}\d)/i;
const CODEWORD_RE = /\bcodeword\s+([^\s,.;!?]+)/i;
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

export function parseOnboarding(text: string): ParsedOnboarding & { badContact: boolean } {
  const contactRaw = text.match(CONTACT_RE)?.[1];
  const contact = contactRaw ? toE164(contactRaw) : undefined;
  const codeword = text.match(CODEWORD_RE)?.[1]?.toLowerCase();
  return {
    ...(contact && { contact }),
    ...(codeword && { codeword }),
    home: HOME_RE.test(text),
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

  async function welcome(msg: Inbound) {
    const { user } = msg;
    if (messenger.provider === "terminal") {
      await reply(user, copy.welcomeTerminal);
      return;
    }
    await reply(user, copy.welcome);
    await locations.request(msg.chatId, user.handle);
  }

  /** Returns true when the text was an onboarding command (not forwarded to brain). */
  async function handleOnboardingText(user: UserRecord, text: string): Promise<boolean> {
    const loc = text.match(LOC_RE);
    if (loc && messenger.provider === "terminal") {
      await locations.inject(user.userId, Number(loc[1]), Number(loc[2]));
      return true;
    }

    const parsed = parseOnboarding(text);
    if (parsed.badContact) {
      await reply(user, copy.badContact);
      return true;
    }

    const saved: string[] = [];
    if (parsed.contact) {
      await users.setContact(user.userId, parsed.contact);
      saved.push(`emergency contact ${parsed.contact}`);
    }
    if (parsed.codeword) {
      await users.setCodeword(user.userId, parsed.codeword);
      saved.push(`codeword "${parsed.codeword}"`);
    }
    if (saved.length > 0) {
      const fresh = await users.getById(user.userId);
      const next = fresh?.homeLat === undefined ? ` ${copy.askHome}` : "";
      await reply(user, `Saved ${saved.join(" and ")}.${next}`);
      return true;
    }

    if (parsed.home) {
      const fix = locations.latest(user.userId);
      if (!fix) {
        await reply(user, copy.homeNoFix);
        return true;
      }
      await users.setHome(user.userId, fix.lat, fix.lon);
      await reply(user, copy.homeSaved);
      return true;
    }

    return false;
  }

  return async function route(msg: Inbound): Promise<void> {
    if (msg.isNewUser) await welcome(msg);

    if (msg.kind === "reaction") {
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
  };
}
