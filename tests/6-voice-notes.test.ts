/**
 * Voice notes: same pipeline as text, original audio forwarded only during the
 * danger window, deduped by message id, capped at 5, honest when STT fails.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createVoiceNoteIngest } from "../src/voice/notes.ts";
import { alerts, allText, harness } from "./helpers.ts";

const DIR = join(import.meta.dir, ".tmp-voice-notes");
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("forwarding", () => {
  test("outside a danger window: nothing forwarded", async () => {
    const h = harness();
    await h.startWalk();
    const out = await h.voiceNote("on my way, all good");
    expect(alerts(out)).toHaveLength(0);
  });

  test("during the danger window: forwarded once per message id", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("‼️");
    const first = await h.voiceNote("he's still behind me", { id: "vn-1" });
    const fwd = alerts(first);
    expect(fwd).toHaveLength(1);
    expect(fwd[0]).toMatchObject({ emergency: true, followUp: true, voiceNoteIds: ["vn-1"] });
    expect(fwd[0]!.trailer).toContain("he's still behind me");
    const dup = await h.voiceNote("he's still behind me", { id: "vn-1" });
    expect(alerts(dup)).toHaveLength(0);
  });

  test("capped at 5 per danger window", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("‼️");
    let forwarded = 0;
    for (let i = 0; i < 8; i++) forwarded += alerts(await h.voiceNote(`update ${i}`, { id: `cap-${i}` })).length;
    expect(forwarded).toBe(5);
  });

  test("window closes once they're safe", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("‼️");
    await h.text("i'm safe now");
    const out = await h.voiceNote("just checking", { id: "after" });
    expect(alerts(out)).toHaveLength(0);
  });

  test("untranscribable note in danger is still forwarded, labelled", async () => {
    const h = harness();
    await h.startWalk();
    await h.react("‼️");
    const out = await h.voiceNote("", { id: "garbled", transcribed: false });
    const [fwd] = alerts(out);
    expect(fwd?.attachments).toHaveLength(1);
    expect(fwd?.trailer).toContain("unavailable");
  });

  test("untranscribable note outside danger asks them to type", async () => {
    const h = harness();
    await h.startWalk();
    const out = await h.voiceNote("", { transcribed: false });
    expect(allText(out)).toContain("couldn't make it out");
    expect(alerts(out)).toHaveLength(0);
  });

  test("first danger voice note is attached to the emergency alert itself", async () => {
    const h = harness();
    await h.startWalk();
    const out = await h.voiceNote("someone grabbed me", { id: "vn-first" });
    const all = alerts(out);
    expect(all).toHaveLength(1);
    expect(all[0]!.followUp).toBeFalsy();
    expect(all[0]!.voiceNoteIds).toEqual(["vn-first"]);
    // A later copy of the same message isn't forwarded again.
    expect(alerts(await h.voiceNote("someone grabbed me", { id: "vn-first" }))).toHaveLength(0);
  });
});

describe("ingest", () => {
  const audio = Buffer.from("fake-caf-bytes");

  test("keeps the original audio and the transcript", async () => {
    const ingest = createVoiceNoteIngest({ transcribe: async () => "help me", dir: DIR, persist: false });
    const got = await ingest({ messageId: "msg/1", userId: "u1", mimeType: "audio/x-caf", read: async () => audio });
    expect(got.transcript).toBe("help me");
    expect(got.ref.transcribed).toBe(true);
    expect(got.ref.path.endsWith(".caf")).toBe(true);
    expect(readFileSync(got.ref.path).equals(audio)).toBe(true);
  });

  test("failed transcription: audio still saved, flagged untranscribed", async () => {
    const ingest = createVoiceNoteIngest({ transcribe: async () => null, dir: DIR, persist: false });
    const got = await ingest({ messageId: "m2", userId: "u1", mimeType: "audio/mp4", read: async () => audio });
    expect(got.transcript).toBe("");
    expect(got.ref.transcribed).toBe(false);
    expect(existsSync(got.ref.path)).toBe(true);
    expect(got.ref.path.endsWith(".m4a")).toBe(true);
  });

  test("no transcriber configured", async () => {
    const ingest = createVoiceNoteIngest({ transcribe: null, dir: DIR, persist: false });
    const got = await ingest({ messageId: "m3", userId: "u1", mimeType: "audio/amr", read: async () => audio });
    expect(got.ref.transcribed).toBe(false);
  });
});
