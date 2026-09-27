import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Returns the transcript ("" when there was no speech), or null when transcription failed. */
export type Transcriber = (audio: Buffer, mimeType: string, filename: string) => Promise<string | null>;

const STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";

async function postScribe(apiKey: string, model: string, audio: Buffer, mimeType: string, filename: string) {
  const form = new FormData();
  form.append("model_id", model);
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), filename);
  const res = await fetch(STT_URL, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  if (!res.ok) return { ok: false as const, status: res.status, body };
  try {
    const json = JSON.parse(body) as { text?: string };
    return { ok: true as const, text: (json.text ?? "").trim() };
  } catch {
    return { ok: false as const, status: res.status, body };
  }
}

/** iMessage voice notes are usually CAF/Opus; convert to 16 kHz WAV with macOS afconvert when STT rejects them. */
export async function convertToWav(audio: Buffer, ext: string): Promise<Buffer | null> {
  if (process.platform !== "darwin") return null;
  const dir = await mkdtemp(join(tmpdir(), "nook-vn-"));
  try {
    const src = join(dir, `in.${ext}`);
    const out = join(dir, "out.wav");
    await writeFile(src, audio);
    const proc = Bun.spawn(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", src, out], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) return null;
    return await readFile(out);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function createElevenLabsTranscriber(apiKey: string, model = process.env.ELEVENLABS_STT_MODEL || "scribe_v1"): Transcriber {
  return async (audio, mimeType, filename) => {
    try {
      const first = await postScribe(apiKey, model, audio, mimeType, filename);
      if (first.ok) return first.text;
      console.warn(`[stt] scribe rejected ${mimeType} (${first.status}): ${first.body.slice(0, 160)}`);
      if (first.status === 401 || first.status === 429) return null;
      const ext = filename.split(".").pop() || "caf";
      const wav = await convertToWav(audio, ext);
      if (!wav) return null;
      const second = await postScribe(apiKey, model, wav, "audio/wav", "voice-note.wav");
      if (second.ok) return second.text;
      console.warn(`[stt] scribe rejected wav (${second.status}): ${second.body.slice(0, 160)}`);
      return null;
    } catch (e) {
      console.warn(`[stt] failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
}

export function transcriberFromEnv(): Transcriber | null {
  const key = process.env.ELEVENLABS_API_KEY;
  return key ? createElevenLabsTranscriber(key) : null;
}
