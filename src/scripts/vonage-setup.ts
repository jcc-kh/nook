/**
 * One-time: creates the Vonage Voice application Nook calls through, using the
 * account's API key + secret, saves its private key to ./vonage-private.key and
 * writes VONAGE_APPLICATION_ID / VONAGE_PRIVATE_KEY_PATH into .env.
 *
 *   bun run vonage:setup
 *
 * Needs VONAGE_API_KEY, VONAGE_API_SECRET and PUBLIC_URL in .env. The webhook
 * URLs on the application are placeholders: each call sends its own NCCO and
 * event URL (see src/voice/vonage.ts).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const KEY_PATH = "./vonage-private.key";
const ENV_PATH = ".env";

function setEnv(text: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, "m");
  return re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, "\n")}${line}\n`;
}

async function main() {
  const apiKey = process.env.VONAGE_API_KEY?.trim();
  const apiSecret = process.env.VONAGE_API_SECRET?.trim();
  const publicUrl = process.env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (!apiKey || !apiSecret) throw new Error("set VONAGE_API_KEY and VONAGE_API_SECRET in .env");
  if (!publicUrl) throw new Error("set PUBLIC_URL in .env");

  if (process.env.VONAGE_APPLICATION_ID?.trim() && existsSync(KEY_PATH)) {
    console.log("[vonage:setup] VONAGE_APPLICATION_ID is set and the private key exists; nothing to do.");
    return;
  }

  const webhook = { address: `${publicUrl}/vonage/event/app`, http_method: "POST" };
  const res = await fetch("https://api.nexmo.com/v2/applications", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "Nook",
      capabilities: { voice: { webhooks: { answer_url: webhook, event_url: webhook } } },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    id?: string;
    keys?: { private_key?: string };
    title?: string;
    detail?: string;
  };
  if (!res.ok || !body.id || !body.keys?.private_key) {
    throw new Error(`Vonage application create failed (${res.status}): ${body.title ?? ""} ${body.detail ?? ""}`.trim());
  }

  writeFileSync(KEY_PATH, body.keys.private_key, { mode: 0o600 });
  let env = readFileSync(ENV_PATH, "utf8");
  env = setEnv(env, "VONAGE_APPLICATION_ID", body.id);
  env = setEnv(env, "VONAGE_PRIVATE_KEY_PATH", KEY_PATH);
  writeFileSync(ENV_PATH, env);
  console.log(`[vonage:setup] created application ${body.id}; private key saved to ${KEY_PATH}; .env updated.`);
}

main().catch((err) => {
  console.error("[vonage:setup] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
