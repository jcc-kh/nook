import type { Action, ExecuteResult } from "../shared/types.ts";

export interface Messenger {
  execute(action: Action): Promise<ExecuteResult>;
}

let stubSeq = 0;

/** Logs actions; returns a fake messageId for SendText. Person A replaces with Spectrum. */
export function createMessenger(): Messenger {
  return {
    async execute(action: Action): Promise<ExecuteResult> {
      console.log("[messenger:stub]", action.type, action);
      if (action.type === "SendText") {
        stubSeq += 1;
        return { messageId: `stub-${stubSeq}` };
      }
      return {};
    },
  };
}
