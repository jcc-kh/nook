import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

/**
 * Proactive outbound check: Nook texts a number first, with no inbound message.
 *   bun run send:test +16465551234 "optional text"
 * Send-only (never reads app.messages), so it can run next to `bun start`.
 */
const [to, ...rest] = process.argv.slice(2);
const projectId = process.env.SPECTRUM_PROJECT_ID;
const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;

if (!to || !projectId || !projectSecret) {
  console.error('usage: bun run send:test <+1E164 or email> ["text"]  (needs SPECTRUM_PROJECT_ID/SECRET)');
  process.exit(1);
}

const text = rest.join(" ") || `Nook test: proactive message at ${new Date().toLocaleTimeString()}`;
const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
try {
  const im = imessage(app);
  const space = await im.space.create(await im.user(to));
  const sent = await space.send(text);
  console.log(`[send:test] sent to ${to} (chat ${space.id}) messageId=${sent?.id ?? "?"}`);
} catch (err) {
  console.error("[send:test] failed:", err);
  process.exitCode = 1;
} finally {
  await app.stop();
}
