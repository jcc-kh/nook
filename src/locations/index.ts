import {
  createGrpcClient,
  type AdvancedIMessage,
  type SharedFriendLocationUpdated,
  type TypedEventStream,
} from "@photon-ai/advanced-imessage/grpc";
import { cloud, type TokenData } from "spectrum-ts";
import type { Clock, LocationPing } from "../shared/types.ts";
import type { UserStore } from "../store/index.ts";

export interface Fix {
  lat: number;
  lon: number;
  accuracyM?: number;
  shortAddress?: string;
  time: Date;
}

export interface Locations {
  /** Send the Find My request card into a chat. No-op without Find My. */
  request(chatId: string, address: string): Promise<void>;
  /** Latest fix seen for a user (for onboarding `HOME`). */
  latest(userId: string): Fix | undefined;
  /** Feed a fix by hand (terminal `/loc`, smoke tests). Emits a LocationPing. */
  inject(userId: string, lat: number, lon: number): Promise<void>;
  stop(): Promise<void>;
}

export interface LocationsOptions {
  users: UserStore;
  clock: Clock;
  onPing: (ping: LocationPing) => Promise<void>;
  /** Omit for terminal mode: no Find My, `inject` only. */
  findMy?: { projectId: string; projectSecret: string };
}

const SHARED_ADDRESS = "imessage.spectrum.photon.codes:443";
const STALL_MS = 90_000;
const MAX_BACKOFF_MS = 30_000;

export async function createLocations(opts: LocationsOptions): Promise<Locations> {
  const { users, clock, onPing } = opts;
  const latestByUser = new Map<string, Fix>();

  async function emit(userId: string, fix: Fix): Promise<void> {
    latestByUser.set(userId, fix);
    await onPing({
      type: "LocationPing",
      userId,
      time: fix.time,
      lat: fix.lat,
      lon: fix.lon,
      ...(fix.accuracyM !== undefined && { accuracyM: fix.accuracyM }),
      ...(fix.shortAddress && { shortAddress: fix.shortAddress }),
    });
  }

  const base = {
    latest: (userId: string) => latestByUser.get(userId),
    inject: (userId: string, lat: number, lon: number) =>
      emit(userId, { lat, lon, time: clock.now() }),
  };

  if (!opts.findMy) {
    return {
      ...base,
      async request(chatId, address) {
        console.log(`[locations] (terminal) would send Find My request to ${address} in ${chatId}`);
      },
      async stop() {},
    };
  }

  let lastActivity = Date.now();
  const client = await createFindMyClient(opts.findMy, () => {
    lastActivity = Date.now();
  });
  const lastSeqByAddress = new Map<string, number>();
  let stopped = false;
  let current: TypedEventStream<SharedFriendLocationUpdated> | undefined;

  async function handleUpdate({ location, sourceSequence }: SharedFriendLocationUpdated) {
    if (lastSeqByAddress.get(location.address) === sourceSequence) return;
    lastSeqByAddress.set(location.address, sourceSequence);

    if (location.latitude === undefined || location.longitude === undefined) return;
    const user = await users.getByHandle(location.address);
    if (!user) return;

    await emit(user.userId, {
      lat: location.latitude,
      lon: location.longitude,
      accuracyM: location.accuracy,
      shortAddress: location.shortAddress,
      time: clock.now(),
    });
  }

  async function watchLoop() {
    let backoff = 1_000;
    while (!stopped) {
      current = client.locations.watch();
      lastActivity = Date.now();
      try {
        for await (const update of current) {
          lastActivity = Date.now();
          backoff = 1_000;
          try {
            await handleUpdate(update);
          } catch (err) {
            console.error("[locations] failed to handle update", err);
          }
        }
        if (!stopped) console.warn("[locations] watch stream ended; reconnecting");
      } catch (err) {
        if (!stopped) console.warn("[locations] watch stream error; reconnecting", err);
      }
      if (stopped) break;
      await Bun.sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  // Heartbeats keep lastActivity fresh; silence past STALL_MS means a half-open stream.
  const watchdog = setInterval(() => {
    if (current && Date.now() - lastActivity > STALL_MS) {
      console.warn("[locations] watch stalled; forcing reconnect");
      void current.close();
    }
  }, 15_000);

  void watchLoop();

  return {
    ...base,
    async request(chatId, address) {
      const receipt = await client.locations.request(chatId, address);
      console.log(
        `[locations] Find My request to ${receipt.address}: ${receipt.status}`,
        receipt.reason ?? "",
      );
    },
    async stop() {
      stopped = true;
      clearInterval(watchdog);
      await current?.close();
      await client.close();
    },
  };
}

/**
 * Spectrum does not expose Find My, so mint a line token the same way
 * @spectrum-ts/imessage does and talk to the line with the low-level SDK.
 */
async function createFindMyClient(
  creds: { projectId: string; projectSecret: string },
  onHeartbeat: () => void,
): Promise<AdvancedIMessage> {
  const mint = () => cloud.issueImessageTokens(creds.projectId, creds.projectSecret);
  let data: TokenData = await mint();
  let mintedAt = Date.now();
  let minting: Promise<TokenData> | undefined;

  async function tokens(): Promise<TokenData> {
    if (Date.now() - mintedAt < data.expiresIn * 800) return data;
    minting ??= mint()
      .then((d) => {
        data = d;
        mintedAt = Date.now();
        return d;
      })
      .finally(() => {
        minting = undefined;
      });
    return minting;
  }

  let address: string;
  let lineId: string | undefined;
  if (data.type === "shared") {
    address = process.env.SPECTRUM_IMESSAGE_ADDRESS ?? SHARED_ADDRESS;
  } else {
    lineId = process.env.SPECTRUM_IMESSAGE_LINE_ID ?? Object.keys(data.auth)[0];
    if (!lineId) throw new Error("Spectrum project has no iMessage line");
    address = `${lineId}.imsg.photon.codes:443`;
  }
  console.log(`[locations] Find My via ${data.type} line at ${address}`);

  return createGrpcClient({
    address,
    tls: true,
    retry: true,
    onHeartbeat,
    token: async () => {
      const d = await tokens();
      if (d.type === "shared") return d.token;
      const token = lineId ? d.auth[lineId] : undefined;
      if (!token) throw new Error(`No token for iMessage line ${lineId}`);
      return token;
    },
  });
}
