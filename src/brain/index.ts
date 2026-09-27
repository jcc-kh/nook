import type { Brain, ClassifyInput, Clock } from "../shared/types.ts";
import { createBrainEngine } from "./engine.ts";
import type { UserRecord } from "../store/types.ts";
import { createTigerUserStore } from "../store/users.ts";
import { createLlm, type Llm } from "../llm/index.ts";
import type { WriteMessages } from "../shared/types.ts";
import { createNavService, navProviderFromEnv, type NavService } from "../nav/index.ts";
import { voiceConfigFromEnv } from "../voice/index.ts";

export interface CreateBrainOptions {
  clock: Clock;
  getUser?: (userId: string) => Promise<UserRecord | null>;
  classify?: ClassifyInput;
  writeMessages?: WriteMessages;
  nav?: NavService;
  callsEnabled?: () => boolean;
  persist?: boolean;
  verbose?: boolean;
  /** Override; default from createLlm() / env. */
  llm?: Llm;
}

export function createBrain(opts: CreateBrainOptions): Brain & {
  getPhase: (userId: string) => string;
  getRuntime: (userId: string) => unknown;
} {
  const store = createTigerUserStore();
  const getUser =
    opts.getUser ??
    (async (userId: string) => store.getById(userId));

  const llm = opts.llm ?? createLlm();
  const nav = opts.nav ?? createNavService(navProviderFromEnv());
  console.log(`[nav] provider=${nav.providerName}`);

  const engine = createBrainEngine({
    clock: opts.clock,
    getUser,
    classify: opts.classify ?? llm.classify,
    writeMessages: opts.writeMessages ?? llm.writeMessages,
    nav,
    callsEnabled: opts.callsEnabled ?? (() => voiceConfigFromEnv() != null),
    persist: opts.persist ?? true,
    verbose: opts.verbose ?? process.env.BRAIN_LOG !== "0",
  });

  return {
    handle: engine.handle,
    tick: engine.tick,
    resetUser: engine.resetUser,
    getLiveContext: engine.getLiveContext,
    safeDestinations: engine.safeDestinations,
    setDestination: engine.setDestination,
    navigation: engine.navigation,
    getPhase: engine.getPhase,
    getRuntime: engine.getRuntime,
  };
}

export { createBrainEngine } from "./engine.ts";
export { createEchoBrain } from "./stubEcho.ts";
