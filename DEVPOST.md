# Nook

**Other safety apps make you open something, or they watch a dot and panic at the first pause.** Nook is already in iMessage. Share Find My once and you are done: no app to install, no session to arm, no timer to remember. It moves first when you are actually out, it learns what a normal trip looks like for you, and it does not text your contact because you stopped at a bodega.

**Elevator pitch** (194 characters)

> The safety buddy already in your texts. Share Find My once. Nook notices you are out, learns your route, and checks in only when a trip looks off. No app to open, and no alarm for a normal stop.

## Inspiration

Getting home at night in a city is a real safety problem, and the tools people already have miss it in opposite ways.

Sharing your location with a friend only helps if they are awake and staring at the dot. Safety apps ask you to open them, start a session, and set a timer at the exact moment you are least likely to do any of that. The ones that run in the background mostly surveil: they keep a live location and wait for someone else to notice. The few that act on their own tend to escalate on the first pause, so a normal stop pages your emergency contact and you stop trusting the app.

We wanted something that lives where the night already happens, in Messages, and that knows the difference between "she stopped at the store" and "something is wrong."

## What it does

You text Nook. Setup stays in that thread: your name, one trusted contact, when it should watch, and what to do if you do not answer a check-in. You share Find My once and tell it where home is.

Then it gets out of the way, until one of three things is true:

- You say so. "Walk me home," or "heading out," starts a walk any time.
- It is evening and you are not home. After about two minutes more than 150 meters from home, Nook asks "heading home?" Yes starts the walk. Being home at night does nothing. Driving speed is ignored.
- You chose "whenever I'm away from home." Sitting still is assumed safe. Walking for about two minutes starts a quiet watch, with no text. If you were moving and then stop for a few minutes, Nook checks in. Ok means you got where you were going, and it stays quiet until you leave that spot.

On a walk it stays quiet when the trip looks like yours: a usual stop, a familiar route, a normal duration. It texts once when it does not: a stop somewhere new, a detour, running late, or a location that goes silent. One nudge, then the step you picked (text your contact, or keep checking with you). ‼️ or a clear "I'm in danger" tells you to call 911 and texts that contact your location right away. Nook never contacts the police itself.

A call, when you ask for one, is a voice that knows your name and the street you are on. It can walk you toward somewhere open, or stay on the line. Your contact hears from Nook only when something is wrong, not when you get home.

## How we built it

One Bun process. TypeScript throughout.

Photon Spectrum is the iMessage line: texts, tapbacks, and a live Find My watch that is not a message log. The brain is a deterministic rules engine. Every location update is code, not a model call. Tiger Cloud (Postgres, TimescaleDB, PostGIS) stores the pings and the walks, and answers "what is normal for this person" with percentiles, usual cells, and known stops.

Gemini only handles language, and only off the location path: wording, and reading a free-text reply as safe, uneasy, or danger. If it is down, templates and a regex classifier keep the rules running. ElevenLabs is the voice and the voice-note transcription. Vonage places the phone call when we are not using a tap-to-talk link. Geoapify supplies walking guidance and places that are open late, for the moments someone says they feel uneasy and wants a busier street.

Walk state lives in Tiger, so a restart can pick an open trip back up instead of forgetting you were out.

## Challenges we ran into

Find My does not behave like a GPS breadcrumb. Updates arrive when the phone feels like it, with gaps, jitter, and optional coordinates. A slow walk and a person standing still can look the same if you only compare the last two pings, and a car looks like a very fast walk. The rules had to measure a window of movement, not a single fix.

The other hard problem was restraint. A check-in that fires because you are merely not at home will get muted. We had to separate "watching" from "texting": evening and away from home asks; away and moving stays quiet until you stop; ok after a stop means you arrived, not "please keep hovering."

We also had to keep the model out of the safety decision. A slow or wrong classification cannot be what decides whether your contact gets a text. Answering a call is not the same as being safe. And a usual route does not exist on night one, so the product has to be useful before it has learned you.

## Accomplishments that we're proud of

The whole loop runs in a thread people already have. Onboarding, Find My, the check-in, the tapback, the call, and the one text to a trusted contact who has never installed anything.

The trigger model matches how people actually go out. Nook does not text you for sitting at a friend's place. It does ask when it is late and you are not home. It does notice when a walk turns into an unexplained stop.

Personalization is a query. "Late," "off your usual way," and "you usually stay here this long" come from your own history, and the same ping always produces the same decision.

## What we learned

The product is mostly the texts you do not send. Trust dies on the first false alarm, and it also dies if the app only works when you remember to open it.

Live location is a stream with holes, not a track. Safety logic has to tolerate silence on purpose (a check-in when updates stop) and ignore noise on purpose (a car, a single bad fix, a person who is simply sitting).

And the escalation policy has to be the user's. Nook should always take a next step when a check-in goes unanswered. Which step is a choice they made in setup, not a surprise at 1am.

## What's next for Nook

Learn faster. A few arrived walks should be enough to treat a friend's apartment and a usual bodega as expected, so those stops stay silent from the start.

Get better at the trip that is not a walk: a rideshare, a subway gap where Find My drops, a night that ends somewhere that is not home on purpose.

And make the voice more useful on the street. Hands-free guidance toward somewhere open, without ever widening who Nook is allowed to contact.
