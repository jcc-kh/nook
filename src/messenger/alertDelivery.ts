import type { AlertContact } from "../shared/types.ts";

export interface AlertTransport {
  sendText(text: string): Promise<void>;
  /** Sends an audio file as-is (the original voice note). */
  sendAudio(path: string, mimeType: string): Promise<void>;
}

export interface AlertDeliveryResult {
  /** The main alert text went out. */
  ok: boolean;
  /** Every attachment went out (true when there were none). */
  attachmentsOk: boolean;
  /** Trailer went out (true when there was none). */
  trailerOk: boolean;
}

export function mapsLink(lat: number, lon: number): string {
  return `https://maps.apple.com/?ll=${lat.toFixed(5)},${lon.toFixed(5)}`;
}

/** Emergency alerts carry their own labelled map line; follow-ups don't repeat it. */
export function alertBody(action: Pick<AlertContact, "text" | "lat" | "lon" | "emergency" | "followUp">): string {
  if (action.emergency || action.followUp) return action.text;
  return `${action.text}\n${mapsLink(action.lat, action.lon)}`;
}

/**
 * Text first (so the contact has the location even if audio fails), then each
 * attachment, then the trailer. Reports exactly what went out so Nook never
 * tells the user something was sent when it wasn't.
 */
export async function deliverAlert(
  transport: AlertTransport,
  action: Pick<AlertContact, "text" | "lat" | "lon" | "emergency" | "followUp" | "attachments" | "trailer">,
): Promise<AlertDeliveryResult> {
  try {
    await transport.sendText(alertBody(action));
  } catch (err) {
    console.error(`[alert] text failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, attachmentsOk: false, trailerOk: false };
  }
  let attachmentsOk = true;
  for (const a of action.attachments ?? []) {
    try {
      await transport.sendAudio(a.path, a.mimeType);
    } catch (err) {
      attachmentsOk = false;
      console.error(`[alert] attachment ${a.path} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let trailerOk = true;
  if (action.trailer) {
    try {
      await transport.sendText(action.trailer);
    } catch (err) {
      trailerOk = false;
      console.error(`[alert] trailer failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ok: true, attachmentsOk, trailerOk };
}

export type AlertUserNotice =
  | { kind: "contactAlerted" }
  | { kind: "contactUnreachable" }
  | { kind: "emergencyDelivered"; attachmentsOk: boolean }
  | { kind: "emergencyFailed" }
  | { kind: "voiceNoteForwarded" }
  | { kind: "voiceNoteForwardFailed" }
  | null;

/** What Nook should tell the user after trying to reach their contact. */
export function noticeFor(
  action: Pick<AlertContact, "emergency" | "followUp" | "attachments">,
  result: AlertDeliveryResult,
): AlertUserNotice {
  const forwardingNote = action.followUp && (action.attachments?.length ?? 0) > 0;
  if (action.emergency && forwardingNote) {
    return result.ok && result.attachmentsOk ? { kind: "voiceNoteForwarded" } : { kind: "voiceNoteForwardFailed" };
  }
  if (action.followUp) return null;
  if (action.emergency) {
    return result.ok ? { kind: "emergencyDelivered", attachmentsOk: result.attachmentsOk } : { kind: "emergencyFailed" };
  }
  return result.ok ? { kind: "contactAlerted" } : { kind: "contactUnreachable" };
}
