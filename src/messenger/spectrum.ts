import { attachment, reply, Spectrum, voice as voiceContent, type Content, type Message, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { basename } from "node:path";
import { templateForTag } from "../shared/templates.ts";
import type { Action, AlertContact, ExecuteResult, SendTextTag } from "../shared/types.ts";
import type { UserRecord, UserStore } from "../store/index.ts";
import { markVoiceNoteForwarded } from "../store/voiceNotes.ts";
import { placeCall, voiceConfigFromEnv } from "../voice/index.ts";
import type { TalkLinks } from "../voice/talk.ts";
import type { VonageCalls } from "../voice/vonage.ts";
import { alertBody, deliverAlert, noticeFor, type AlertTransport } from "./alertDelivery.ts";
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
  | (InboundBase & { kind: "reaction"; emoji: string; targetMessageId: string })
  | (InboundBase & {
      kind: "voice";
      messageId: string;
      mimeType: string;
      name?: string;
      read: () => Promise<Buffer>;
      threadTargetId?: string;
    });

export interface SpectrumMessenger extends Messenger {
  readonly provider: Provider;
  /** Normalized inbound stream: sender resolved to a user, own echoes dropped. */
  inbound(): AsyncIterable<Inbound>;
  /** Untagged reply (onboarding copy). */
  sendToUser(userId: string, text: string): Promise<ExecuteResult>;
  lastMessageId(userId: string, tag: SendTextTag): string | undefined;
  /** Whether the most recent trusted-contact alert for this user actually went out. */
  lastContactAlert(userId: string): ContactAlertResult | undefined;
  stop(): Promise<void>;
}

export interface ContactAlertResult {
  ok: boolean;
  /** Voice-note attachments went out too (true when there were none). */
  attachmentsOk?: boolean;
  name?: string;
  /** Epoch ms. */
  at: number;
}

export interface SpectrumMessengerOptions {
  provider: Provider;
  users: UserStore;
  projectId?: string;
  projectSecret?: string;
  /** Used for StartCall when there's no ElevenLabs phone number. */
  talkLinks?: TalkLinks;
  vonageCalls?: VonageCalls;
}

interface InboundAudio {
  mimeType: string;
  name?: string;
  read: () => Promise<Buffer>;
}

/** A voice message, or an audio file sent as an attachment (possibly inside a reply or group). */
function audioOf(content: Content): InboundAudio | undefined {
  switch (content.type) {
    case "voice":
      return { mimeType: content.mimeType, ...(content.name && { name: content.name }), read: () => content.read() };
    case "attachment":
      return content.mimeType.toLowerCase().startsWith("audio/")
        ? { mimeType: content.mimeType, name: content.name, read: () => content.read() }
        : undefined;
    case "reply":
      return audioOf(content.content as Content);
    case "group":
      for (const m of content.items) {
        const a = audioOf(m.content);
        if (a) return a;
      }
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Plain text of a message, looking inside in-thread replies and text+attachment
 * groups. A shared contact card becomes "Name +number" so it parses like a typed
 * contact; a shared Apple Maps place (rich link) becomes its URL.
 */
function textOf(content: Content): string | undefined {
  switch (content.type) {
    case "text":
      return content.text;
    case "richlink":
      return content.url;
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
  const lastAlerts = new Map<string, ContactAlertResult>();
  /** Drop identical back-to-back sends (Spectrum / reconnect weirdness). */
  const recentSend = new Map<string, { text: string; at: number }>();
  const SEND_DEDUP_MS = 30_000;
  /** Inbound message ids already handled. Stream reconnects can redeliver the same one. */
  const seenInbound = new Set<string>();
  const recentInbound = new Map<string, number>();
  const INBOUND_DEDUP_MS = 8_000;

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
        const msg = err instanceof Error ? err.message : String(err);
        // These throw inside reply() before anything is delivered.
        const beforeSend = /reply\(\) (target is undefined|requires content|cannot wrap)/.test(msg);
        if (!beforeSend) {
          console.warn(`[messenger] threaded reply to ${userId} failed; not sending a second copy`, err);
          return {};
        }
        console.warn(`[messenger] threaded reply to ${userId} failed before send; sending in the main chat`, err);
      }
    }
    const sent = await space.send(text);
    return sent?.id ? { messageId: sent.id } : {};
  }

  async function transportFor(phone: string, label: string): Promise<AlertTransport> {
    let space: Space | undefined;
    try {
      space = await openDm(phone);
    } catch (err) {
      // e.g. Photon "Target not allowed for this project".
      const reason = err instanceof Error ? err.message : String(err);
      return {
        sendText: async () => {
          throw new Error(`can't open chat with ${phone}: ${reason}`);
        },
        sendAudio: async () => {
          throw new Error(`can't open chat with ${phone}: ${reason}`);
        },
      };
    }
    if (!space) {
      // Terminal has no second person to text; surface it in the log instead.
      return {
        sendText: async (t) => console.log(`[messenger] → trusted contact ${label}:\n${t}`),
        sendAudio: async (p, m) => console.log(`[messenger] → trusted contact ${label}: [audio ${m}] ${p}`),
      };
    }
    const s = space;
    return {
      sendText: async (t) => {
        await s.send(t);
      },
      sendAudio: async (path, mimeType) => {
        try {
          await s.send(voiceContent(path, { mimeType, name: basename(path) }));
        } catch (err) {
          console.warn(`[messenger] voice send failed, retrying as a file: ${err instanceof Error ? err.message : err}`);
          await s.send(attachment(path, { mimeType, name: basename(path) }));
        }
      },
    };
  }

  async function notifyUser(userId: string, notice: ReturnType<typeof noticeFor>, name?: string) {
    if (!notice) return;
    const text = {
      contactAlerted: () => copy.contactAlerted(name),
      contactUnreachable: () => copy.contactUnreachable(name),
      emergencyDelivered: () =>
        copy.emergencyDelivered(name, notice.kind === "emergencyDelivered" ? notice.attachmentsOk : true),
      emergencyFailed: () => copy.emergencyFailed(name),
      voiceNoteForwarded: () => copy.voiceNoteForwarded(name),
      voiceNoteForwardFailed: () => copy.voiceNoteForwardFailed(name),
    }[notice.kind]();
    // sendToUser already dedups identical text; one notice per alert.
    await sendToUser(userId, text).catch(() => {});
  }

  async function alertContact(action: AlertContact) {
    const { userId } = action;
    const user = await users.getById(userId);
    const body = alertBody(action);
    const contact = user?.trustedContact;
    if (!contact) {
      console.warn(`[messenger] AlertContact for ${userId} but no trusted contact on file:\n${body}`);
      lastAlerts.set(userId, { ok: false, at: Date.now() });
      if (action.emergency && !action.followUp) await sendToUser(userId, copy.emergencyNoContact).catch(() => {});
      return;
    }
    const dedupKey = `alert:${contact.phone}`;
    const prevAlert = recentSend.get(dedupKey);
    const now = Date.now();
    const dedupText = `${body}\0${(action.voiceNoteIds ?? []).join(",")}`;
    if (prevAlert && prevAlert.text === dedupText && now - prevAlert.at < SEND_DEDUP_MS) {
      console.log(`[messenger] dedup skip duplicate alert → ${contact.phone}`);
      return;
    }
    recentSend.set(dedupKey, { text: dedupText, at: now });

    const transport = await transportFor(contact.phone, `${contact.name ?? ""} ${contact.phone}`.trim());
    const result = await deliverAlert(transport, action);
    lastAlerts.set(userId, {
      ok: result.ok,
      attachmentsOk: result.attachmentsOk,
      at: Date.now(),
      ...(contact.name && { name: contact.name }),
    });
    if (result.ok) {
      console.log(
        `[messenger] alerted trusted contact ${contact.name ?? ""} ${contact.phone}` +
          (action.attachments?.length ? ` (attachments ${result.attachmentsOk ? "ok" : "FAILED"})` : ""),
      );
    } else {
      console.error(`[messenger] could NOT alert trusted contact ${contact.phone}`);
    }
    if (result.ok && result.attachmentsOk && action.voiceNoteIds?.length) {
      const at = new Date();
      for (const id of action.voiceNoteIds) {
        await markVoiceNoteForwarded(id, at).catch((e) =>
          console.warn(`[messenger] markVoiceNoteForwarded failed: ${e instanceof Error ? e.message : e}`),
        );
      }
    }
    await notifyUser(userId, noticeFor(action, result), contact.name);
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
        await alertContact(action);
        return {};
      case "StartCall": {
        const user = await users.getById(action.userId);
        if (!user) throw new Error(`StartCall for unknown user ${action.userId}`);
        if (!voice) {
          console.warn(
            `[messenger] StartCall skipped for ${user.handle} (walk ${action.walkId}): calls not configured`,
          );
          return sendToUser(action.userId, copy.callsUnavailable);
        }
        const contactName = user.trustedContact?.name;
        if (voice.agentPhoneNumberId) {
          const conversationId = await placeCall(voice, user.handle, action, contactName);
          console.log(`[messenger] calling ${user.handle} (walk ${action.walkId}, conversation ${conversationId ?? "?"})`);
          return {};
        }
        if (opts.vonageCalls) {
          try {
            await opts.vonageCalls.start(action, user.handle, contactName);
            return {};
          } catch (err) {
            if (!opts.talkLinks) throw err;
            console.error(`[messenger] Vonage call failed, sending a tap-to-talk link instead`, err);
          }
        }
        if (!opts.talkLinks) throw new Error("tap-to-talk links not set up");
        const url = opts.talkLinks.create(action, contactName);
        console.log(`[messenger] sent tap-to-talk link to ${user.handle} (walk ${action.walkId})`);
        return sendToUser(action.userId, copy.talkLink(url));
      }
    }
  }

  function rememberInbound(id: string): boolean {
    if (seenInbound.has(id)) return true;
    seenInbound.add(id);
    if (seenInbound.size > 500) {
      const oldest = seenInbound.values().next().value;
      if (oldest) seenInbound.delete(oldest);
    }
    return false;
  }

  async function* inbound(): AsyncIterable<Inbound> {
    for await (const [space, message] of app.messages) {
      if (message.direction === "outbound") continue;
      const handle = message.sender?.id;
      if (!handle) continue;
      if (rememberInbound(message.id)) continue;

      const existing = await users.getByHandle(handle);
      const user = existing ?? (await users.upsertUser(handle));
      spaces.set(user.userId, space);

      const base: InboundBase = { user, isNewUser: !existing, chatId: space.id };
      const content = message.content;
      if (content.type === "reaction") {
        yield { ...base, kind: "reaction", emoji: content.emoji, targetMessageId: content.target.id };
        continue;
      }
      const audio = audioOf(content);
      if (audio) {
        const threadTargetId = content.type === "reply" ? content.target.id : undefined;
        const voiceMsg: Inbound = {
          ...base,
          kind: "voice",
          messageId: message.id,
          ...audio,
          ...(threadTargetId && { threadTargetId }),
        };
        if (content.type !== "reply") {
          yield voiceMsg;
          continue;
        }
        threads.set(user.userId, message);
        try {
          yield voiceMsg;
        } finally {
          threads.delete(user.userId);
        }
        continue;
      }
      const text = textOf(content);
      if (text === undefined) {
        console.log(`[messenger] ignoring ${content.type} message from ${user.userId}`);
        continue;
      }
      const inboundKey = `${handle}\0${text}`;
      const inboundAt = Date.now();
      const prevInbound = recentInbound.get(inboundKey);
      recentInbound.set(inboundKey, inboundAt);
      if (prevInbound != null && inboundAt - prevInbound < INBOUND_DEDUP_MS) {
        console.log(`[messenger] dedup skip replayed inbound from ${handle}`);
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
    lastContactAlert: (userId) => lastAlerts.get(userId),
    stop: () => app.stop(),
  };
}

function startImessage(projectId: string, projectSecret: string) {
  return Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
}

function startTerminal() {
  return Spectrum({ providers: [terminal.config()] });
}
