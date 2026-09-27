import type { Action, Brain, Clock, Event, LiveContext } from "../shared/types.ts";

/** Hour-0 empty brain (BRAIN_MODE=stub). */
export function createBrain(_opts: { clock: Clock }): Brain {
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
