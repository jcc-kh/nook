/**
 * What the trusted contact receives, and what Nook tells the user about it.
 */
import { describe, expect, test } from "bun:test";
import { alertBody, deliverAlert, noticeFor, type AlertTransport } from "../src/messenger/alertDelivery.ts";
import { buildEmergencyAlert, voiceNoteTrailer } from "../src/shared/alerts.ts";
import { contactAlert } from "../src/shared/templates.ts";

const AT = new Date("2026-04-14T02:30:00.000Z");

describe("emergency alert text", () => {
  const base = {
    who: "Alex (+1 555-555-0199)",
    firstName: "Alex",
    confirmedAt: AT,
    confirmedVia: "text" as const,
    tz: "America/New_York",
    location: { lat: 40.80275, lon: -73.96394, address: "Amsterdam Ave", updatedAt: new Date(AT.getTime() - 20_000) },
    statements: [{ text: "someone is following me", source: "text" as const }],
    nookAction: "told them to call 911 now",
  };

  test("has every labelled field", () => {
    const t = buildEmergencyAlert({ ...base, trip: { minutesWalking: 12, destination: "home", onRoute: true } });
    expect(t).toContain("Alex (+1 555-555-0199)");
    expect(t).toContain("immediate danger");
    expect(t).toContain("confirmed: 10:30 pm, by text");
    expect(t).toContain("location: Amsterdam Ave");
    expect(t).toContain("coordinates: 40.80275, -73.96394");
    expect(t).toContain("20 sec before this alert");
    expect(t).toContain('what they said: "someone is following me"');
    expect(t).toContain("nook's response: told them to call 911 now");
    expect(t).toContain("walking 12 min");
    expect(t).toContain("heading to home");
    expect(t).toContain("https://maps.apple.com/?ll=40.80275,-73.96394");
    expect(t).toContain("please call Alex now");
  });

  test("no location is stated plainly, not faked", () => {
    const t = buildEmergencyAlert({ ...base, location: null });
    expect(t).not.toContain("maps.apple.com");
    expect(t.toLowerCase()).toContain("location");
  });

  test("reactions and untranscribed voice notes are labelled as such", () => {
    const t = buildEmergencyAlert({
      ...base,
      confirmedVia: "voice_note",
      statements: [
        { text: "tapped ‼️ (immediate danger)", source: "reaction" },
        { text: "", source: "voice_note", transcriptUnavailable: true },
      ],
      voiceNoteAttached: true,
    });
    expect(t).toContain("tapped ‼️");
    expect(t).toContain("transcription unavailable");
    expect(t.toLowerCase()).toContain("voice message");
  });

  test("voice note trailer marks machine transcripts", () => {
    expect(voiceNoteTrailer("he's behind me")).toContain("may contain errors");
    expect(voiceNoteTrailer(undefined)).toContain("unavailable");
  });

  test("routine alerts identify Nook and the user", () => {
    const t = contactAlert("quiet", "Alex (+1 555-555-0199)");
    expect(t).toContain("this is nook");
    expect(t).toContain("Alex (+1 555-555-0199)");
  });
});

describe("delivery", () => {
  function transport(fail: { text?: boolean; audio?: boolean; trailer?: boolean } = {}) {
    const sent: string[] = [];
    let texts = 0;
    const t: AlertTransport = {
      async sendText(s) {
        texts++;
        if (texts === 1 && fail.text) throw new Error("text failed");
        if (texts > 1 && fail.trailer) throw new Error("trailer failed");
        sent.push(`text:${s}`);
      },
      async sendAudio(p, m) {
        if (fail.audio) throw new Error("audio failed");
        sent.push(`audio:${p}:${m}`);
      },
    };
    return { t, sent };
  }
  const action = {
    text: "EMERGENCY from nook",
    lat: 40.8,
    lon: -73.96,
    emergency: true,
    attachments: [{ path: "/tmp/a.caf", mimeType: "audio/x-caf" }],
    trailer: "automated transcript (may contain errors): \"help\"",
  };

  test("order is text, audio, trailer", async () => {
    const { t, sent } = transport();
    const r = await deliverAlert(t, action);
    expect(r).toEqual({ ok: true, attachmentsOk: true, trailerOk: true });
    expect(sent.map((s) => s.split(":")[0])).toEqual(["text", "audio", "text"]);
  });

  test("audio failure is reported, text still counts", async () => {
    const { t } = transport({ audio: true });
    const r = await deliverAlert(t, action);
    expect(r.ok).toBe(true);
    expect(r.attachmentsOk).toBe(false);
    expect(noticeFor(action, r)).toEqual({ kind: "emergencyDelivered", attachmentsOk: false });
  });

  test("text failure stops everything and tells the user", async () => {
    const { t, sent } = transport({ text: true });
    const r = await deliverAlert(t, action);
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
    expect(noticeFor(action, r)).toEqual({ kind: "emergencyFailed" });
  });

  test("forwarded voice note notices", () => {
    const fwd = { ...action, followUp: true };
    expect(noticeFor(fwd, { ok: true, attachmentsOk: true, trailerOk: true })).toEqual({ kind: "voiceNoteForwarded" });
    expect(noticeFor(fwd, { ok: true, attachmentsOk: false, trailerOk: true })).toEqual({ kind: "voiceNoteForwardFailed" });
  });

  test("routine alert gets a maps link; emergency and follow-ups don't repeat one", () => {
    expect(alertBody({ text: "hi", lat: 40.8, lon: -73.96 })).toContain("maps.apple.com");
    expect(alertBody({ text: "hi", lat: 40.8, lon: -73.96, emergency: true })).toBe("hi");
    expect(alertBody({ text: "hi", lat: 40.8, lon: -73.96, followUp: true })).toBe("hi");
    expect(noticeFor({ followUp: true }, { ok: true, attachmentsOk: true, trailerOk: true })).toBeNull();
    expect(noticeFor({}, { ok: false, attachmentsOk: false, trailerOk: false })).toEqual({ kind: "contactUnreachable" });
  });
});
