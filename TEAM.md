# Nook — team split & to-do lists

Agent-facing work board for two developers. Full contract: [CONTEXT.md](CONTEXT.md).

**Person A = Messaging + Voice (edge)**  
**Person B = Data + Brain**

They meet only at `src/shared/types.ts` and `brain.handle(event) → Action[]` / `messenger.execute(action)`.

---

## Split refinements (vs the Claude draft)

Keep Claude’s edge-vs-brain split. Adjust these details so nobody blocks or double-owns:

| Topic | Decision |
| --- | --- |
| Hour 0 | **Both** write `types.ts`, `clock.ts`, `templates.ts` together before splitting. Do not invent parallel event shapes. |
| Call outcomes | **A** owns the ElevenLabs tool HTTP that reports `CallEvent` outcomes (`/tools/call-outcome`). **B** owns what each outcome does (R10 / R11). A does not invent alert copy. The emergency word was dropped. |
| Call start | **B** returns `StartCall`. **A** implements `execute(StartCall)` (Twilio outbound). Sync at start of L4. |
| `getLiveContext` | **B** implements. **A**’s `/tools/location` only calls it — no Gemini, no Tiger queries in voice. |
| Deploy | **A** owns DigitalOcean App Platform (Dockerfile, 1 instance, env, `/health`). Claude’s draft omitted this; it is edge work. |
| Dashboard | **B** only (L5). A does not build UI. |
| Seed / sim | **B** owns GPS sim + seed. A may feed sim pings into a stub for smoke tests, but B owns the scripts. |
| Layers | A demo-critical path: **L1 → L4 → L4b**. B demo-critical: **L1 → L2 → L3**, then L4 rules. L5 is polish for both. |

**Solo test harnesses (lock these day 1):**

- **A:** stub `Brain` — `handle` logs the event and returns a canned `SendText` (or echoes text). No Tiger required.
- **B:** `PROVIDER=terminal` + `SimClock` + route playback into `handle`. No real iMessage / Find My / ElevenLabs.

---

## Shared — hour 0 (both, before splitting)

Do these in one sitting. Neither person starts module work until this lands on `main`.

- [x] Agree: Bun + TypeScript; package name `nook`; `PROVIDER=terminal|imessage`
- [x] Land [CONTEXT.md](CONTEXT.md) contract (already in repo) — both read it end-to-end
- [x] Create `src/shared/types.ts` exactly as in CONTEXT (events, actions, `WalkPhase`, `RuleId`, `WalkPlan`, `Brain`, `ParsedReply`)
- [x] Create `src/shared/clock.ts` — `SystemClock`, `SimClock` (`set`, `advance`); **forbid `Date.now()` in rules**
- [x] Create `src/shared/templates.ts` — prompt / check-in / nudge / arrived / ended / unclear strings
- [x] Empty `Brain.handle` → `[]` + log; empty `messenger.execute` stub
- [x] Agree onboarding utterances:
  - first text → create user
  - agent sends Find My `request` card
  - user: trusted contact name + number (superseded by the guided onboarding in CONTEXT)
  - `HOME` while live fix → write `users.home`
  - night default `22:00–06:00` in `users.tz`
- [x] Env template `.env.example` (keys only, no secrets): Spectrum, Tiger, Gemini, ElevenLabs, tools secret, `PROVIDER`, `PORT`

---

## Person A — Messaging + Voice

**Owns dirs:** `src/messenger/`, `src/locations/`, `src/voice/`, onboarding flow in `src/index.ts` (edge wiring), `Dockerfile`, `.do/app.yaml`  
**Does not own:** rules, Tiger schema, Gemini, sim seed, dashboard

### Solo test (always available)

```ts
// stub brain: every UserText → SendText echo; LocationPing → []
async handle(event): Promise<Action[]> {
  if (event.type === "UserText")
    return [{ type: "SendText", userId: event.userId, text: `got: ${event.text}`, tag: "nudge" }];
  return [];
}
```

### L1 — Onboarding + iMessage + location ingest

**Demo gate:** text the agent → Find My card → share location → pings flow as `LocationPing` into stub brain; 👍/👎 on a prompt message work.

- [ ] Init Spectrum with `PROVIDER=terminal` and `PROVIDER=imessage` (cloud package — tapbacks need cloud)
- [ ] Map inbound Spectrum text → `UserText` (`time` from `Clock.now()`)
- [ ] Map inbound tapbacks → `UserReaction` using `Emoji.like` / `dislike` / `emphasize` / `question` (👍 👎 ‼️ ❓)
- [ ] Implement `execute(SendText)` — return `messageId`; store last id **per tag** (`prompt`, `checkin`, `nudge`, …)
- [ ] Implement `execute(AlertContact)` — open/send to trusted contact’s iMessage space (E.164); both numbers must be iMessage-capable
- [ ] Onboarding: first inbound creates user id mapping (handle ↔ `userId`); send Find My via `im.locations.request(chatGuid, address)`
- [x] Guided onboarding, one message per turn: contact (name + validated number, card, or in-thread reply) → monitoring → escalation → location → home; persist via a **store callback B exposes** (or temporary in-memory until B’s `users` table is ready — then wire)
- [ ] On `HOME`: if latest location known, call B’s “set home” write (or queue until store ready)
- [ ] `im.locations.watch(address)`: reconnect on drop; dedupe `sourceSequence`; **skip** updates missing lat/lon; emit `LocationPing` with optional `accuracyM`, `shortAddress`
- [ ] Verify before coding (checklist in CONTEXT): locations package vs Spectrum line; send return id for tapback matching

### L2 — Check-in message plumbing

**Demo gate:** stub brain returns `SendText` with `tag: "checkin"`; user 👍 attaches to that `messageId`; second “nudge” tag has its own id.

- [ ] Keep map `tag → lastOutboundMessageId` so tapbacks resolve to the open check-in / prompt
- [ ] Deliver `SendText` tags `checkin` and `nudge` with distinct template copy from `templates.ts`
- [ ] Deliver `AlertContact` text + lat/lon (format a maps link or plain coords — keep simple)

### L3 — Address side-channel only

**Demo gate:** `LocationPing.shortAddress` reaches B when Find My provides it.

- [ ] Copy `shortAddress` from Find My snapshot onto `LocationPing` when present
- [ ] No new rules; no Gemini

### L4 — ElevenLabs call + tools

**Demo gate:** stub/`StartCall` places a real outbound call; `/tools/location` returns live context JSON; the agent reports the call outcome through `/tools/call-outcome`.

- [x] Implement `execute(StartCall)` → `POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call` (`src/voice/index.ts`) with dynamic variables `user_id`, `walk_id`, `display_name`, `street`, `minutes_walking`. A failed call texts the user and is fed back as `ended_unresolved`
- [x] HTTP routes (same process): `POST /tools/location`, `POST /tools/call-outcome`; `x-tools-secret` header; location calls `brain.getLiveContext(walkId)`
- [ ] ElevenLabs agent config: webhook tools pointing at those routes, the secret header, and a prompt that reports `started` when the user answers, then exactly one of `resolved_safe` / `request_escalation` / `ended_unresolved`. Picking up is not "safe"
- [ ] Bind `user_id` / `walk_id` into tool params via ElevenLabs **dynamic variables**, not free-form model guessing
- [ ] Report `ended_unresolved` when the call ends without an outcome (post-call webhook), so a pending contact step doesn't wait for the 15 min guard
- [ ] Local: ngrok → tools URLs until DO is up
- [ ] Sync with B: they return `StartCall` from R11; you only execute

### L4b — DigitalOcean App Platform

**Demo gate:** always-on HTTPS URL; `/health` 200; Spectrum + watch survive one redeploy.

- [ ] `Dockerfile` (Bun or Node — prefer explicit Dockerfile over DO Bun buildpack)
- [ ] App Platform **Web Service**: min=1, max=1; health check `/health`
- [ ] Wire secrets: Spectrum, Tiger URL (for process if shared), ElevenLabs, tools secret, `PROVIDER=imessage`, `PORT`
- [ ] Point ElevenLabs tool URLs at DO HTTPS
- [ ] Confirm one instance only (no split-brain on in-memory walk state)
- [ ] Fallback plan documented: same image on a Droplet if gRPC dies on App Platform

### L5 — Polish (only if L4 demo-solid)

- [ ] Photon SIP trunk instead of Twilio ([cookbook](https://photon.codes/docs/beta/cookbooks/voice/elevenlabs)); dedicated voice-capable line
- [ ] Optional: Spectrum webhook receive path (not required if long-lived SDK loop works on DO)

### Person A — out of scope

- Rules R1–R16, walk plan math, Tiger SQL, seed script, Gemini, rule dashboard
- Inventing alert / check-in copy beyond what’s in `templates.ts` / B’s `writeMessages`

---

## Person B — Data + Brain

**Owns dirs:** `src/store/`, `src/brain/`, `src/llm/`, `src/sim/`, `src/dashboard/`  
**Does not own:** Spectrum send/receive, Find My watch, ElevenLabs HTTP, Dockerfile

### Solo test (always available)

- `PROVIDER=terminal` (A can run Spectrum; or B uses a thin harness that calls `handle` directly)
- `SimClock` + `src/sim` route playback → `LocationPing` / fake `UserReaction` / `UserText`
- Assert: returned `Action[]` types + `events.rule_id` rows in Tiger (or in-memory event log until DB up)

### L1 — Store + prompt + arrive

**Demo gate:** sim night walk → R2 prompt action; 👍 → walk open; near home → R14 alert + IDLE. Daytime walk → R1 stores ping, no prompt.

- [ ] Paste full SQL into `src/store/schema.sql`; apply on Tiger Cloud
- [ ] `pg` client; insert every `LocationPing` (even when R1 suppresses prompts)
- [ ] In-memory last-5-minute ping window per `userId`
- [ ] Cell helper: `round(lat,3)+","+round(lon,3)`
- [ ] **R1** outside night: no prompt/check-in actions
- [ ] **R2** prompt conditions (speed 0.7–2.2 m/s × 2 min, ≥120 m, >150 m from home, no prompt in 2 h)
- [ ] **R2x** speed >3 m/s → skip prompt
- [ ] **R3** 👍 → `WALKING`; 👎 → cooldown 2 h; no reply 10 min → cooldown 1 h
- [ ] **R4** text `walk me home` (any time) → start walk
- [ ] **R14** two pings within 50 m of home → `AlertContact` “got home”, close walk → `IDLE`
- [ ] Log every fired rule to `events` with `rule_id`
- [ ] Persist `walks.status` / phase so restart can resume
- [ ] Simulator: scripted polyline + clock into `handle`
- [ ] Export store helpers A needs: upsert user, set contact, set home

### L2 — Check-ins + escalation (default plan)

**Demo gate:** late walk / silence / no-reply floors produce check-in → nudge → `AlertContact` under sim; R16 rate limit holds.

- [ ] Default `WalkPlan` only: `expectedMin = dist/1.3`, `lateMin = expected+5` (no Tiger baselines yet)
- [ ] **R5b** stationary 3 min (2 min after midnight) off known stop → soft check-in
- [ ] **R7a** past late → soft check-in; **R7b** late+10 → urgent
- [ ] **R8** no ping 4 min → check-in; 10 min + no reply → `AlertContact` (**floor**, ignore personalization)
- [ ] **R9a** 👍 on check-in → `WALKING`; suppress same tag 10 min
- [ ] **R10** no reply 60 s → nudge; +60 s → `AlertContact` with last lat/lon (**floor**)
- [ ] **R16** ≤1 check-in / 3 min; zero check-ins while `CALLING`
- [ ] Enter `CHECKING_IN` / `ALERTED` phases as in CONTEXT state machine

### L3 — Personalization

**Demo gate:** seeded user gets R5a silence at bodega, R6 off-route check-in, free-text “at Sam’s” ends walk (R15) with stubbed `parseReply`.

- [ ] Seed ~2 weeks of walks / stops / labels (`src/sim` seed script)
- [ ] Query `walk_baselines` + `known_stops` **once** when entering `WALKING` → `WalkPlan`  
  - `expected = p50` if `n>=3` else L2 formula  
  - `late = max(p90*1.25, expected+5)`  
  - route cells or directions polyline + 150 m buffer  
  - stops: visits≥2 + `place_labels`; dwell caps 30 / 60 friend / default 10
- [ ] **R5a** known stop: silent until allowed dwell
- [ ] **R6** >200 m from route for 2 min → check-in
- [ ] **R9b** `llm/parseReply` → ok (write `place_labels`) | help (`StartCall` + `AlertContact`) | unclear; on Gemini throw → unclear template
- [ ] **R15** friend stop >15 min or reply says so → `ENDED_ELSEWHERE` + contact text
- [ ] Confirm: ping path still imports **zero** from `llm/`

### L4 — Call rules (needs A’s `execute(StartCall)`)

**Demo gate:** sim ‼️ → `StartCall` action; inject `request_escalation` → `AlertContact`, stay `CALLING`.

- [ ] **R11** ‼️ or text `call me` → `CALLING` + `StartCall` immediately (**floor**)
- [ ] `getLiveContext(walkId)` from in-memory window (+ last `shortAddress`) — **no LLM**
- [x] Call outcomes: `resolved_safe` → `WALKING`, cancel pending contact; `request_escalation` / `ended_unresolved` with a pending contact step → `AlertContact`

### L5 — Polish

- [ ] `llm/writeMessages(plan)` once at walk start; templates if Gemini fails
- [ ] Tiny rule dashboard reading `events` by `rule_id`
- [ ] **R12** ❓ → nearest open place (only if time)

### Person B — out of scope

- Photon / Spectrum wiring, Find My watch loop, ElevenLabs HTTP, ngrok, App Platform
- Claiming “the call works” without A’s outbound execute

---

## Sync points (calendar these)

| When | What |
| --- | --- |
| Hour 0 | Shared types + clock + templates on `main` |
| End of L1 | A can emit real `LocationPing` / reactions; B’s L1 rules pass on sim; wire A→B `handle` + B→A `execute` in `index.ts` |
| Start of L4 | Agree `StartCall.vars` and tool secret header; A stands up `/tools/*`; B ships R11 + call outcomes |
| L4b | A deploys DO; B confirms walk resume from Tiger after restart |
| Pre-demo | One cloud user: onboarding → night prompt → walk → check-in → ‼️ call → "reach my contact" on the call → alert → home |

---

## Layer ownership (quick map)

| Layer | Person A | Person B |
| --- | --- | --- |
| L1 | Onboarding, Spectrum, locations | Schema, window, R1–R4, R14, sim |
| L2 | messageId / check-in plumbing | R5b, R7, R8, R9a, R10, R16 |
| L3 | shortAddress passthrough | Seed, WalkPlan, R5a, R6, R9b, R15 |
| L4 | ElevenLabs call + tools + call outcomes | R11, call outcomes, getLiveContext |
| L4b | DO App Platform always-on | Verify resume-from-Tiger |
| L5 | Photon SIP | Gemini writeMessages, dashboard, R12 |

---

## Definition of done (hackathon demo)

1. Terminal + sim: B’s L1–L3 rules green without a phone.  
2. Cloud iMessage: A’s onboarding + Find My + tapbacks.  
3. Integrated: prompt → walk → unusual check-in → silence escalation.  
4. ‼️ places call; asking for help on the call alerts the contact; home closes walk.  
5. Process on DO App Platform (1 instance) with ElevenLabs tools on HTTPS.
