# nook

Nook walks you home over iMessage. It watches live Find My location, stays quiet when a trip looks like yours, checks in when it does not, and can call with hands-free guidance. There is no app: setup, tapbacks, check-ins, and alerts all happen in one thread. The trusted contact never installs anything.

## Inspiration

When people think "Move Smarter" in NYC, they usually think of the subway. But a lot of getting around here happens on foot: walking is 28% of all trips New Yorkers make, and in Manhattan 59% of trips are on foot or by bike, the highest share of any county in the US.

Walking is also where people feel least safe. 40% of Americans say they'd be afraid to walk alone at night within a mile of home. That rises to 53% of women and 50% of city residents.

The tools people already have fall short:

- Location sharing only helps if a friend is awake and watching the dot.
- Manual safety apps only work if you remember to start them.
- Automatic safety apps track your location without knowing anything about you, and one false alarm is enough to make you mute them.

We wanted something native, with no app to open. It should be personal, so a detour you often take doesn't alert anyone, and it should check in on you first, without you having to ask.

## What it does

Setup is one iMessage thread: your name, one trusted contact, what Nook should do if you don't answer, and when it should watch. Share Find My once, tell it where home is, and you're done.

| Mode | What happens |
| --- | --- |
| Evenings | If you're out and moving in the evening, Nook asks "heading home?" Yes starts a walk. Most sensitive somewhere you've never been. |
| Whenever I'm away from home and moving | After about 2 minutes of walking, a quiet watch starts with no text. Sitting still is assumed safe. |
| Any time, on request | Text "walk me home" or "heading out" and a walk starts right away. |

Driving speed is ignored in every mode.

On a walk that looks normal (usual stop, familiar route, normal duration), Nook stays silent and signs off when you arrive. If something looks off (a new stop, a detour, running late, location goes quiet), it checks in, sends one follow-up if you don't answer, then takes the step you picked in setup.

Uneasy (👎): Nook asks if you want to keep going or find somewhere busier, then suggests nearby places open all night. Tap ❓ or say "call me" and it calls with hands-free guidance, using your name and the street you're on.

Danger ("I'm in danger", being chased, or ‼️): an alert goes out right away. Nook tells you to call 911 and texts your contact your location, route context, and what you reported. It also forwards your location in a dire situation. If you don't answer "are you in immediate danger?", Nook follows your setup step and can text your contact that it's unconfirmed. The model cannot mark an ambiguous danger reply as safe on its own.

Usual stops, usual route, and typical trip length come from your own history, so a stop that's normal for you stays quiet. Walking pace is a fixed band, used to tell a walk apart from a car or from standing still.

## How it's built

One Bun process. Photon Spectrum owns the iMessage line. The rules engine decides when to check in, follow up, or alert. Gemini only handles language.

```
Find My pings ──► Photon Spectrum (iMessage + live location)
                        │
                        ▼
              Rules engine (deterministic TypeScript / Bun)
               │                              │
               ▼                              ▼
   Tiger Cloud: Postgres +           Gemini: wording + reading replies
   TimescaleDB + PostGIS             (regex / templates if it's down)
   pings, walks, "what's normal"              │
                                              ▼
                          ElevenLabs (voice, transcription)
                          Vonage (calls) · Geoapify (routes, open places)
```

| Piece | Role |
| --- | --- |
| Photon Spectrum | Texts, reactions, voice notes, and the live Find My feed. Find My is not a GPS track: updates are irregular and jittery, so movement is judged over a window of pings, not the last two points. |
| Rules engine | Deterministic. The same situation always gets the same response. No model call on the location-ping path. Watching is separate from texting: being away from home is not itself a reason to speak. Every fired rule is logged with a `rule_id`. |
| Tiger Cloud | TimescaleDB for the ping stream, PostGIS for "is this a usual stop?" and "is this off your usual route?" Personalization is a `WalkPlan` loaded once when a walk starts. Safety floors (no reply, ‼️, codeword, signal loss) ignore it. |
| Gemini | Writes Nook's messages and reads replies as safe, uneasy, or in danger. Templates are the fallback. |
| ElevenLabs | Outbound voice agent and voice-note transcription. Knows your name and the street you're on. |
| Vonage | Places the phone call. |
| Geoapify | Walking directions and nearby places that are open late, from map data. |

Edge sends events in. The brain returns an action list. The messenger executes it (`brain.handle(event)` → `messenger.execute(action)`). Phase lives in memory and on `walks.status` so a restart can resume an open walk. `Clock.now()` is the only time source; a GPS simulator can run the demo without a phone.

Contract and state machine: [CONTEXT.md](CONTEXT.md). Ownership: [TEAM.md](TEAM.md).

## Setup

Requires [Bun](https://bun.sh).

```bash
bun install
cp .env.example .env
bun run typecheck
bun run start                 # GET /health on PORT (default 3000)
BRAIN_MODE=echo bun run smoke
```

`PROVIDER=terminal` (the default) runs without iMessage, Find My, or a phone. `PROVIDER=imessage` uses Spectrum.

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port. Default `3000`. |
| `BRAIN_MODE` | `stub` logs events and returns nothing. `echo` turns `UserText` into `SendText` (messaging harness). |
| `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` | Photon Spectrum project. |
| `DATABASE_URL` | Tiger Cloud (Postgres + TimescaleDB + PostGIS). |
| `GEMINI_API_KEY` | Message writing and reply parsing. |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_AGENT_PHONE_NUMBER_ID` | Outbound voice agent. |
| `TOOLS_SECRET` | Shared secret for ElevenLabs tool calls back to this process. |

Fill Spectrum, Tiger, Gemini, and ElevenLabs as you wire those services. Local voice-tool routes can be tunneled until the process has a public URL.
