import { query } from "./db.ts";

export async function insertVoiceNote(row: {
  id: string;
  userId: string;
  walkId?: string | null;
  path: string;
  mimeType: string;
  transcript?: string;
  status: "transcribed" | "failed";
}): Promise<void> {
  await query(
    `INSERT INTO voice_notes (id, user_id, walk_id, path, mime_type, transcript, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [row.id, row.userId, row.walkId ?? null, row.path, row.mimeType, row.transcript ?? null, row.status],
  );
}

export async function markVoiceNoteForwarded(id: string, at: Date): Promise<void> {
  await query(`UPDATE voice_notes SET forwarded_at = $2 WHERE id = $1`, [id, at.toISOString()]);
}
