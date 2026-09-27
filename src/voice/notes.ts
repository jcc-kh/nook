import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { VoiceNoteRef } from "../shared/types.ts";
import { insertVoiceNote } from "../store/voiceNotes.ts";
import type { Transcriber } from "./transcribe.ts";

export interface InboundVoiceNote {
  messageId: string;
  userId: string;
  mimeType: string;
  name?: string;
  read: () => Promise<Buffer>;
}

export interface IngestedVoiceNote {
  ref: VoiceNoteRef;
  /** "" when transcription failed or there was no speech. */
  transcript: string;
}

const EXT: Record<string, string> = {
  "audio/x-caf": "caf",
  "audio/caf": "caf",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
};

function extensionFor(mimeType: string, name?: string): string {
  const fromMime = EXT[mimeType.toLowerCase().split(";")[0]!.trim()];
  if (fromMime) return fromMime;
  const fromName = name?.match(/\.([a-z0-9]{2,5})$/i)?.[1];
  return fromName?.toLowerCase() ?? "caf";
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "note";

/**
 * Saves the original audio (so it can be forwarded untouched to a trusted
 * contact during an emergency), transcribes it, and records it in voice_notes.
 */
export function createVoiceNoteIngest(opts: {
  transcribe: Transcriber | null;
  dir?: string;
  persist?: boolean;
}) {
  const dir = resolve(opts.dir ?? process.env.VOICE_NOTES_DIR ?? "data/voice-notes");
  const persist = opts.persist ?? true;

  return async function ingest(note: InboundVoiceNote): Promise<IngestedVoiceNote> {
    const ext = extensionFor(note.mimeType, note.name);
    const path = join(dir, `${safe(note.userId)}-${safe(note.messageId)}.${ext}`);
    const audio = await note.read();
    await mkdir(dir, { recursive: true });
    await writeFile(path, audio);

    const transcript = opts.transcribe
      ? await opts.transcribe(audio, note.mimeType, `voice-note.${ext}`)
      : null;
    const ok = transcript !== null;

    if (persist) {
      try {
        await insertVoiceNote({
          id: note.messageId,
          userId: note.userId,
          path,
          mimeType: note.mimeType,
          ...(ok && { transcript }),
          status: ok ? "transcribed" : "failed",
        });
      } catch (e) {
        console.warn(`[voice-note] db insert failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return {
      ref: { id: note.messageId, path, mimeType: note.mimeType, transcribed: ok },
      transcript: transcript ?? "",
    };
  };
}
