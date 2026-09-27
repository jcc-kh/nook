/**
 * Text, tapback, and voice note must drive the same safety state.
 */
import { describe, expect, test } from "bun:test";
import { alerts, allText, calls, harness } from "./helpers.ts";

type Channel = "reaction" | "text" | "voice_note";
const CHANNELS: Channel[] = ["reaction", "text", "voice_note"];

function send(h: ReturnType<typeof harness>, ch: Channel, emoji: string, words: string) {
  if (ch === "reaction") return h.react(emoji);
  if (ch === "text") return h.text(words);
  return h.voiceNote(words);
}

describe("input parity", () => {
  for (const ch of CHANNELS) {
    test(`${ch}: uneasy → uneasy state, route question, no alert`, async () => {
      const h = harness();
      await h.startWalk();
      const out = await send(h, ch, "👎", "i feel uneasy");
      expect(h.rt().safety).toBe("uneasy");
      expect(alerts(out)).toHaveLength(0);
      expect(calls(out)).toHaveLength(0);
      expect(allText(out)).toContain("somewhere busier");
    });

    test(`${ch}: call request → StartCall, no alert`, async () => {
      const h = harness();
      await h.startWalk();
      const out = await send(h, ch, "❓", "can you call me");
      expect(calls(out)).toHaveLength(1);
      expect(alerts(out)).toHaveLength(0);
      expect(h.phase()).toBe("CALLING");
    });

    test(`${ch}: immediate danger → 911 guidance + emergency alert, no call`, async () => {
      const h = harness();
      await h.startWalk();
      const out = await send(h, ch, "‼️", "someone is attacking me");
      expect(h.rt().safety).toBe("immediate_danger");
      expect(alerts(out).filter((a) => a.emergency)).toHaveLength(1);
      expect(calls(out)).toHaveLength(0);
      expect(allText(out)).toContain("911");
    });

    test(`${ch}: safe after uneasy → back to safe`, async () => {
      const h = harness();
      await h.startWalk();
      await h.react("👎");
      expect(h.rt().safety).toBe("uneasy");
      const out = await send(h, ch, "👍", "i'm okay now");
      expect(h.rt().safety).toBe("safe");
      expect(alerts(out)).toHaveLength(0);
    });
  }

  test("voice note of immediate danger attaches the original audio", async () => {
    const h = harness();
    await h.startWalk();
    const out = await h.voiceNote("someone is attacking me", { id: "vn-a" });
    const [alert] = alerts(out);
    expect(alert?.attachments).toEqual([{ path: "/tmp/vn-a.caf", mimeType: "audio/x-caf" }]);
    expect(alert?.voiceNoteIds).toEqual(["vn-a"]);
    expect(alert?.text).toContain("someone is attacking me");
  });
});
