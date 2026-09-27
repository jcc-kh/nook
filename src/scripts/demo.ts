/**
 * Drive one demo-recording scene on the running server (needs DEV_SIM=1).
 *
 *   bun run demo setup            # once: finish onboarding, seed the familiar route, hold real pings
 *   bun run demo start-walk       # scene 1
 *   bun run demo familiar-stop    # scene 2 (sends nothing)
 *   bun run demo safe-arrival     # scene 3
 *   bun run demo unfamiliar-stop  # scene 4 (then 👎 / ❓ on the phone for scenes 5–6)
 *   bun run demo danger-prep      # scene 7 (then ‼️ on the phone)
 *   bun run demo notify-contact   # scene 8 (and before a scene 9 voice note)
 *   bun run demo reset            # between takes
 *   bun run demo restore          # when done filming
 *
 * DEMO_HANDLE (default Claire) is the user; DEMO_OTHER is a second user whose open walk setup ends.
 */
const step = process.argv[2];
if (!step) {
  console.error("usage: bun run demo <step>");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
const handle = process.env.DEMO_HANDLE ?? "+13322683713";
const other = process.env.DEMO_OTHER ?? "+16463220667";

const res = await fetch(`http://127.0.0.1:${port}/dev/demo/${step}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ handle, ...(step === "setup" && { other }) }),
});
const body = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as { ok?: boolean };
console.log(JSON.stringify(body, null, 2));
if (!res.ok || !body.ok) process.exit(1);

export {};
