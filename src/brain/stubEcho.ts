import type { Action, Brain, Event, LiveContext } from "../shared/types.ts";

/**
 * Person A solo harness: echo UserText as SendText; ignore other events.
 * Set BRAIN_MODE=echo to use this from src/index.ts.
 */
export function createEchoBrain(): Brain {
  return {
    async handle(event: Event): Promise<Action[]> {
      if (event.type === "UserText") {
        return [
          {
            type: "SendText",
            userId: event.userId,
            text: `got: ${event.text}`,
            tag: "nudge",
          },
        ];
      }
      if (event.type === "EmergencyCode") {
        return [
          {
            type: "SendText",
            userId: event.userId,
            text: "(echo brain) emergency word received. The real brain would act on it now.",
            tag: "nudge",
          },
        ];
      }
      return [];
    },

    async getLiveContext(_walkId: string): Promise<LiveContext | null> {
      return null;
    },
  };
}
