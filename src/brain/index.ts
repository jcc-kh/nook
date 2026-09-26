import type { Action, Brain, Clock, Event, LiveContext } from "../shared/types.ts";

export interface CreateBrainOptions {
  clock: Clock;
}

/** Empty brain: logs events, returns no actions. Person B replaces with real rules. */
export function createBrain(_opts: CreateBrainOptions): Brain {
  return {
    async handle(event: Event): Promise<Action[]> {
      console.log("[brain:stub]", event.type, "userId=", event.userId);
      return [];
    },

    async getLiveContext(_walkId: string): Promise<LiveContext | null> {
      return null;
    },
  };
}
