import type { Brain, Clock } from "../shared/types.ts";
import { createBrainEngine, type ParseReplyFn } from "./engine.ts";
import type { UserRecord } from "../store/types.ts";
import { createTigerUserStore } from "../store/users.ts";
import { parseReplyFallback } from "../llm/index.ts";

export interface CreateBrainOptions {
  clock: Clock;
  getUser?: (userId: string) => Promise<UserRecord | null>;
  parseReply?: ParseReplyFn;
  persist?: boolean;
}

export function createBrain(opts: CreateBrainOptions): Brain & {
  getPhase: (userId: string) => string;
  getRuntime: (userId: string) => unknown;
} {
  const store = createTigerUserStore();
  const getUser =
    opts.getUser ??
    (async (userId: string) => store.getById(userId));

  const engine = createBrainEngine({
    clock: opts.clock,
    getUser,
    parseReply: opts.parseReply ?? parseReplyFallback,
    persist: opts.persist ?? true,
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
