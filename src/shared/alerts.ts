import type { InputSource } from "./types.ts";

/**
 * Trusted-contact messages for immediate danger. Plain text (iMessage has no
 * bold), labelled lines, and the user's own words quoted exactly: Nook never
 * strengthens what they said.
 */

export interface EmergencyStatement {
  text: string;
  source: InputSource;
  /** Voice note whose transcription failed; the audio follows as an attachment. */
  transcriptUnavailable?: boolean;
}

export interface EmergencyAlertInput {
  /** "Claire (+1 646-322-0667)" */
  who: string;
  /** First name for the closing line. */
  firstName: string;
  confirmedAt: Date;
  confirmedVia: InputSource;
  tz?: string;
  location: {
    lat: number;
    lon: number;
    address?: string;
    updatedAt?: Date;
  } | null;
  statements: EmergencyStatement[];
  /** How an ambiguous message was confirmed, e.g. `answered "yes" when nook asked if they're in immediate danger`. */
  confirmation?: string;
  /** e.g. "told them to call 911 now" */
  nookAction: string;
  trip?: {
    minutesWalking?: number;
    destination?: string;
    onRoute?: boolean | null;
  };
  voiceNoteAttached?: boolean;
}

export function mapsLink(lat: number, lon: number): string {
  return `https://maps.apple.com/?ll=${lat.toFixed(5)},${lon.toFixed(5)}`;
}

function clock(d: Date, tz = "America/New_York"): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  })
    .format(d)
    .toLowerCase();
}

function ago(from: Date, to: Date): string {
  const sec = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  if (sec < 90) return `${sec} sec before this alert`;
  return `${Math.round(sec / 60)} min before this alert`;
}

const VIA: Record<InputSource, string> = {
  reaction: "tapped ‼️ in iMessage",
  text: "by text",
  voice_note: "by voice message",
  voice_call: "on a call with nook",
};

function statementLine(s: EmergencyStatement): string {
  if (s.source === "reaction") return `what they did: ${s.text}`;
  if (s.source === "voice_note") {
    return s.transcriptUnavailable
      ? "what they said: voice message attached (automatic transcription unavailable)"
      : `what they said (automated transcript of their voice message): "${s.text}"`;
  }
  if (s.source === "voice_call") return `what they said on the call (as reported by nook's voice agent): "${s.text}"`;
  return `what they said: "${s.text}" (their words)`;
}

export function buildEmergencyAlert(a: EmergencyAlertInput): string {
  const lines = [
    `EMERGENCY from nook: ${a.who} says they're in immediate danger.`,
    "",
    `confirmed: ${clock(a.confirmedAt, a.tz)}, ${VIA[a.confirmedVia]}`,
  ];
  if (a.location) {
    lines.push(`location: ${a.location.address ?? "street unknown, see map"}`);
    lines.push(`coordinates: ${a.location.lat.toFixed(5)}, ${a.location.lon.toFixed(5)}`);
    if (a.location.updatedAt) {
      lines.push(
        `location updated: ${clock(a.location.updatedAt, a.tz)} (${ago(a.location.updatedAt, a.confirmedAt)})`,
      );
    }
  } else {
    lines.push("location: not available (their location sharing isn't reaching nook)");
  }
  for (const s of a.statements) lines.push(statementLine(s));
  if (a.confirmation) lines.push(`then: ${a.confirmation}`);
  if (a.voiceNoteAttached) lines.push("their voice message follows this text.");
  lines.push(`nook's response: ${a.nookAction}`);
  const trip = a.trip;
  if (trip) {
    const parts = [
      trip.minutesWalking != null
        ? trip.minutesWalking < 1
          ? "just started walking"
          : `walking ${Math.round(trip.minutesWalking)} min`
        : "",
      trip.destination ? `heading to ${trip.destination}` : "",
      trip.onRoute === false ? "off their route" : trip.onRoute === true ? "on their route" : "",
    ].filter(Boolean);
    if (parts.length) lines.push(`trip: ${parts.join(", ")}`);
  }
  if (a.location) lines.push(`map: ${mapsLink(a.location.lat, a.location.lon)}`);
  lines.push("");
  lines.push(`please call ${a.firstName} now. if you can't reach them, call 911 and give this location.`);
  return lines.join("\n");
}

/** Heading sent before a forwarded voice note during an open emergency. */
export function voiceNoteHeading(firstName: string, at: Date, tz?: string): string {
  return `nook: new voice message from ${firstName} (${clock(at, tz)}). audio below.`;
}

/** Sent after the forwarded audio. */
export function voiceNoteTrailer(transcript: string | undefined): string {
  return transcript?.trim()
    ? `automated transcript (may contain errors): "${transcript.trim()}"`
    : "automatic transcription unavailable. please listen to the audio above.";
}
