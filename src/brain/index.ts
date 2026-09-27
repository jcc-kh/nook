import type { Brain, Clock } from "../shared/types.ts";
import { createBrainEngine, type ParseReplyFn } from "./engine.ts";
import type { UserRecord } from "../store/types.ts";
import { createTigerUserStore } from "../store/users.ts";
import { createLlm, type Llm } from "../llm/index.ts";
import type { WriteMessages } from "../shared/types.ts";

export interface CreateBrainOptions {
  clock: Clock;
  getUser?: (userId: string) => Promise<UserRecord | null>;
  parseReply?: ParseReplyFn;
  writeMessages?: WriteMessages;
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

  const engine = createBrainEngine({
    clock: opts.clock,
    getUser,
    parseReply: opts.parseReply ?? llm.parseReply,
    writeMessages: opts.writeMessages ?? llm.writeMessages,
    persist: opts.persist ?? true,
    verbose: opts.verbose ?? process.env.BRAIN_LOG !== "0",
  });

  return {
    handle: engine.handle,
    getLiveContext: engine.getLiveContext,
    getPhase: engine.getPhase,
    getRuntime: engine.getRuntime,
  };
}

export { createBrainEngine } from "./engine.ts";
export { createEchoBrain } from "./stubEcho.ts";
