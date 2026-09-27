import { reply, Spectrum, type Content, type Message, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { templateForTag } from "../shared/templates.ts";
import type { Action, ExecuteResult, SendTextTag } from "../shared/types.ts";
import type { UserRecord, UserStore } from "../store/index.ts";
import { placeCall, voiceConfigFromEnv } from "../voice/index.ts";
import type { Messenger } from "./index.ts";
import { copy } from "./copy.ts";

export type Provider = "terminal" | "imessage";

interface InboundBase {
  user: UserRecord;
  isNewUser: boolean;
  /** iMessage chat GUID (`any;-;+1…`) or terminal space id. */
  chatId: string;
}

export type Inbound =
  /** `threadTargetId`: set when the user replied inside a thread (to that message). */
  | (InboundBase & { kind: "text"; messageId: string; text: string; threadTargetId?: string })
  | (InboundBase & { kind: "reaction"; emoji: string; targetMessageId: string });

export interface SpectrumMessenger extends Messenger {
  readonly provider: Provider;
  /** Normalized inbound stream: sender resolved to a user, own echoes dropped. */
  inbound(): AsyncIterable<Inbound>;
  /** Untagged reply (onboarding copy). */
  sendToUser(userId: string, text: string): Promise<ExecuteResult>;
  lastMessageId(userId: string, tag: SendTextTag): string | undefined;
  stop(): Promise<void>;
}

export interface SpectrumMessengerOptions {
  provider: Provider;
  users: UserStore;
  projectId?: string;
  projectSecret?: string;
}

function mapsLink(lat: number, lon: number): string {
  return `https://maps.apple.com/?ll=${lat.toFixed(5)},${lon.toFixed(5)}`;
}

/**
 * Plain text of a message, looking inside in-thread replies and text+attachment
 * groups. A shared contact card becomes "Name +number" so it parses like a typed contact.
 */
function textOf(content: Content): string | undefined {
  switch (content.type) {
    case "text":
      return content.text;
    case "reply":
      return textOf(content.content as Content);
    case "contact": {
      const phones = content.phones ?? [];
      const phone = (phones.find((p) => p.type === "mobile") ?? phones[0])?.value;
      const n = content.name;
      const name = n?.formatted ?? [n?.first, n?.last].filter(Boolean).join(" ");
      return [name, phone].filter(Boolean).join(" ") || undefined;
    }
    case "group": {
      const parts = content.items.map((m) => textOf(m.content)).filter((t): t is string => !!t);
      return parts.length ? parts.join("\n") : undefined;
    }
    default:
      return undefined;
  }
}

export async function createSpectrumMessenger(
  opts: SpectrumMessengerOptions,
): Promise<SpectrumMessenger> {
  const { provider, users } = opts;

  let imApp: Awaited<ReturnType<typeof startImessage>> | undefined;
  let termApp: Awaited<ReturnType<typeof startTerminal>> | undefined;

  if (provider === "imessage") {
    if (!opts.projectId || !opts.projectSecret) {
      throw new Error("PROVIDER=imessage needs SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET");
    }
    imApp = await startImessage(opts.projectId, opts.projectSecret);
  } else {
    termApp = await startTerminal();
  }
  const app = imApp ?? termApp!;

  const voice = voiceConfigFromEnv();
  const spaces = new Map<string, Space>();
  const lastIdByTag = new Map<string, Map<SendTextTag, string>>();
  /** The user's in-thread message currently being handled; our replies go into that thread. */
  const threads = new Map<string, Message>();
  /** Drop identical back-to-back sends (Spectrum / reconnect weirdness). */
  const recentSend = new Map<string, { text: string; at: number }>();
  const SEND_DEDUP_MS = 8_000;

  async function openDm(handle: string): Promise<Space | undefined> {
    if (!imApp) return undefined;
    const im = imessage(imApp);
    return im.space.create(await im.user(handle));
  }

  async function spaceForUser(userId: string): Promise<Space | undefined> {
    const known = spaces.get(userId);
    if (known) return known;
    const user = await users.getById(userId);
    if (!user) return undefined;
    const space = await openDm(user.handle);
    if (space) spaces.set(userId, space);
    return space;
  }

  async function sendToUser(userId: string, text: string): Promise<ExecuteResult> {
    const prev = recentSend.get(userId);
    const now = Date.now();
    if (prev && prev.text === text && now - prev.at < SEND_DEDUP_MS) {
      console.log(`[messenger] dedup skip identical → ${userId}`);
      return {};
    }
    recentSend.set(userId, { text, at: now });

    const space = await spaceForUser(userId);
    if (!space) {
      console.warn(`[messenger] no space for ${userId}; dropping: ${text}`);
      return {};
    }
    const thread = threads.get(userId);
    if (thread) {
      try {
        const sent = await space.send(reply(text, thread));
        // Spectrum sometimes returns no id even though the threaded send landed —
        // never fall through to a second main-chat send or the user gets doubles.
        return sent?.id ? { messageId: sent.id } : {};
      } catch (err) {
        console.warn(`[messenger] threaded reply to ${userId} failed; sending in the main chat`, err);
      }
    }
    const sent = await space.send(text);
    return sent?.id ? { messageId: sent.id } : {};
  }

  async function alertContact(userId: string, text: string, lat: number, lon: number) {
    const user = await users.getById(userId);
    const body = `${text}\n${mapsLink(lat, lon)}`;
    const contact = user?.trustedContact;
    if (!contact) {
      console.warn(`[messenger] AlertContact for ${userId} but no trusted contact on file:\n${body}`);
      return;
    }
    try {
      const space = await openDm(contact.phone);
      if (!space) {
        // Terminal has no second person to text; surface it in the log instead.
        console.log(`[messenger] → trusted contact ${contact.name ?? ""} ${contact.phone}:\n${body}`);
        return;
      }
      await space.send(body);
      console.log(`[messenger] alerted trusted contact ${contact.name ?? ""} ${contact.phone}`);
      await sendToUser(userId, copy.contactAlerted(contact.name)).catch(() => {});
    } catch (err) {
      // e.g. Photon "Target not allowed for this project": the user must not assume someone was told.
      console.error(
        `[messenger] could NOT alert trusted contact ${contact.phone}: ${err instanceof Error ? err.message : err}`,
      );
      // sendToUser already dedups identical text; one notify per failed alert.
      await sendToUser(userId, copy.contactUnreachable(contact.name)).catch(() => {});
    }
  }

  async function execute(action: Action): Promise<ExecuteResult> {
    switch (action.type) {
      case "SendText": {
        const result = await sendToUser(action.userId, action.text || templateForTag(action.tag));
        if (result.messageId) {
          let byTag = lastIdByTag.get(action.userId);
          if (!byTag) lastIdByTag.set(action.userId, (byTag = new Map()));
          byTag.set(action.tag, result.messageId);
        }
        return result;
      }
      case "AlertContact":
        await alertContact(action.userId, action.text, action.lat, action.lon);
        return {};
      case "StartCall": {
        const user = await users.getById(action.userId);
        if (!user) throw new Error(`StartCall for unknown user ${action.userId}`);
        if (!voice) {
          // Don't throw — help flows also AlertContact; failing here used to
          // fire callFailed + ended_unresolved on top of the contact path.
          console.warn(
            `[messenger] StartCall skipped for ${user.handle} (walk ${action.walkId}): calls not configured`,
          );
          return {};
        }
        const conversationId = await placeCall(voice, user.handle, action);
        console.log(`[messenger] calling ${user.handle} (walk ${action.walkId}, conversation ${conversationId ?? "?"})`);
        return {};
      }
    }
  }

  async function* inbound(): AsyncIterable<Inbound> {
    for await (const [space, message] of app.messages) {
      if (message.direction === "outbound") continue;
      const handle = message.sender?.id;
      if (!handle) continue;

      const existing = await users.getByHandle(handle);
      const user = existing ?? (await users.upsertUser(handle));
      spaces.set(user.userId, space);

      const base: InboundBase = { user, isNewUser: !existing, chatId: space.id };
      const content = message.content;
      if (content.type === "reaction") {
        yield { ...base, kind: "reaction", emoji: content.emoji, targetMessageId: content.target.id };
        continue;
      }
      const text = textOf(content);
      if (text === undefined) {
        console.log(`[messenger] ignoring ${content.type} message from ${user.userId}`);
        continue;
      }
      if (content.type !== "reply") {
        yield { ...base, kind: "text", messageId: message.id, text };
        continue;
      }
      // The consumer handles each message before pulling the next, so the
      // thread stays set exactly while this message's replies are sent.
      threads.set(user.userId, message);
      try {
        yield { ...base, kind: "text", messageId: message.id, text, threadTargetId: content.target.id };
      } finally {
        threads.delete(user.userId);
      }
    }
  }

  return {
    provider,
    execute,
    inbound,
    sendToUser,
    lastMessageId: (userId, tag) => lastIdByTag.get(userId)?.get(tag),
    stop: () => app.stop(),
  };
}

function startImessage(projectId: string, projectSecret: string) {
  return Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
}

function startTerminal() {
  return Spectrum({ providers: [terminal.config()] });
}
