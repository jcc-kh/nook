import { Spectrum, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { templateForTag } from "../shared/templates.ts";
import type { Action, ExecuteResult, SendTextTag } from "../shared/types.ts";
import type { UserRecord, UserStore } from "../store/index.ts";
import type { Messenger } from "./index.ts";

export type Provider = "terminal" | "imessage";

interface InboundBase {
  user: UserRecord;
  isNewUser: boolean;
  /** iMessage chat GUID (`any;-;+1…`) or terminal space id. */
  chatId: string;
}

export type Inbound =
  | (InboundBase & { kind: "text"; messageId: string; text: string })
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

  const spaces = new Map<string, Space>();
  const lastIdByTag = new Map<string, Map<SendTextTag, string>>();

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
    const space = await spaceForUser(userId);
    if (!space) {
      console.warn(`[messenger] no space for ${userId}; dropping: ${text}`);
      return {};
    }
    const sent = await space.send(text);
    return sent ? { messageId: sent.id } : {};
  }

  async function alertContact(userId: string, text: string, lat: number, lon: number) {
    const user = await users.getById(userId);
    const body = `${text}\n${mapsLink(lat, lon)}`;
    if (!user?.contact) {
      console.warn(`[messenger] AlertContact for ${userId} but no contact on file:\n${body}`);
      return;
    }
    const space = await openDm(user.contact);
    if (!space) {
      // Terminal has no second person to text; surface it in the log instead.
      console.log(`[messenger] → contact ${user.contact}:\n${body}`);
      return;
    }
    await space.send(body);
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
      case "StartCall":
        console.warn("[messenger] StartCall not wired yet (L4):", action.vars);
        return {};
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
      if (content.type === "text") {
        yield { ...base, kind: "text", messageId: message.id, text: content.text };
      } else if (content.type === "reaction") {
        yield { ...base, kind: "reaction", emoji: content.emoji, targetMessageId: content.target.id };
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
