# Voice Command Demo

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Vite](https://img.shields.io/badge/built%20with-Vite-646cff.svg)](https://vite.dev)
[![React 19](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org)

**Hands-free voice control of a web application, using nothing but the browser's built-in
Web Speech API.** No API keys. No backend. No cloud service of its own. No paid tier.
The whole thing is a static bundle that runs on GitHub Pages.

**Live demo:** https://&lt;user&gt;.github.io/voice-command-demo/

Ask it a question out loud and it answers out loud:

> — *"Are there any problems?"*
> — *"Four things to look at. Three vans offline: Finch, Oriole and Kingfisher. Four vans
> in maintenance… Six vans at or below twenty percent charge…"*

> — *"Tell me about Kingfisher."*
> — *"Kingfisher, asset H C 140, is offline, assigned to Lakeview, charge 47 percent,
> 7 parcels still on board, odometer 53 thousand 640 kilometres, telematics
> 198 dot 51 dot 100 dot 75, last check-in 1 hour 36 minutes ago. Last seen leaving the
> Aldergate yard. No position fix since."*

The dataset behind those answers ships with the app: 48 fictional delivery vans across
six fictional depots. There is no server to ask.

---

## Contents

- [What this actually demonstrates](#what-this-actually-demonstrates)
- [Try it without speaking](#try-it-without-speaking)
- [How it works](#how-it-works)
- [The hard parts of the Web Speech API](#the-hard-parts-of-the-web-speech-api)
- [Command vocabulary](#command-vocabulary)
- [Browser support](#browser-support)
- [Privacy](#privacy)
- [Accessibility](#accessibility)
- [Running it locally](#running-it-locally)
- [Project layout](#project-layout)
- [Deploying](#deploying)
- [Licence](#licence)

---

## What this actually demonstrates

Most "voice AI" demos are a thin client in front of a paid speech API. This one is the
opposite: it is the demonstration that **a genuinely useful hands-free interface can be
built with two browser APIs that have shipped for over a decade and cost nothing**.

- `SpeechRecognition` — continuous speech to text, in the browser.
- `speechSynthesis` — text to speech, in the browser.

Everything else — the command router, the dataset, the response phrasing — is ordinary
TypeScript. The interesting engineering is not in recognising speech; it is in the dozen
awkward behaviours that sit between "the API exists" and "this does not drive people mad",
which are documented at length below and in the source.

## Try it without speaking

Every command has a **"Try it"** button on the *Commands* page, and there is a text input
in the voice panel. Both run the **identical handler** the microphone would have run —
not a parallel code path.

That matters for Firefox (no speech recognition at all), for anyone without a microphone,
for anyone in a shared or noisy space, for anyone whose speech the recogniser handles
badly, and for anyone who simply would rather not talk to their computer.

## How it works

```
  microphone
      │
      ▼
  SpeechRecognition ──► interim + final transcript ──► normalise
      ▲                          │                        │
      │                          ▼                        ▼
      │                     aria-live region       ordered command table
      │                    (screen readers)        (first match wins)
      │                                                   │
      │                                                   ▼
      │                                          handler over in-memory data
      │                                                   │
      │                             ┌─────────────────────┴─────────────┐
      │                             ▼                                   ▼
      │                    response text ────► aria-live         effect (navigate,
      │                             │                             filter, focus, stop,
      │                             ▼                             settings)
      └──── restart ◄──── speechSynthesis.speak() ────► onend/onerror
                          (recognition suspended
                           for the duration)
```

Three modules, deliberately separable:

| Module | Responsibility | Depends on |
| --- | --- | --- |
| `src/services/speech.ts` | Recognition + synthesis wrapper. Status model, permission pre-flight, feedback guard, restart logic, settings persistence. | Nothing. No React, no app code. |
| `src/services/commands.ts` | Ordered command table over the dataset. Pure and synchronous. | The dataset only. |
| `src/hooks/useVoiceSession.ts` | Binds the two to React. Owns the history, applies effects. | Both of the above. |

`speech.ts` is framework-free and reusable on its own — drop it into any project.

## The hard parts of the Web Speech API

These are the things that are not in the "getting started" article, each fixed in this
codebase with the reasoning written next to the fix.

**1. The app hears itself.** If recognition is live while synthesis is talking, the
microphone picks up the answer, transcribes it, and runs it as the next command. On a
laptop with open speakers this happens every single time. Fix: stop recognition before
speaking, restart it from `utterance.onend`.

**2. `speak()` must never hang.** Callers `await` it. Resolve the promise on **both**
`onend` and `onerror`, or the first engine error deadlocks the entire session. Safari can
drop an utterance without firing either, so there is also a watchdog timer scaled to the
text length and divided by the speech rate.

**3. "Continuous" is not continuous.** Chrome ends a recognition session on its own
silence timeout — a few seconds of quiet — even with `continuous = true`. Restart it from
`onend` or hands-free mode dies about ten seconds after the user stops talking, with no
indication that it has.

**4. …but restart with a budget.** If the engine *cannot* start (revoked permission,
unplugged microphone, recogniser offline), `start()` throws or errors immediately, which
fires `onend`, which restarts — a tight spin that pins a core. Restarts here are counted,
backed off, and eventually given up on with a message.

**5. `no-speech` and `aborted` are not errors.** They are the two most common events on
the error channel: "you went quiet" and "you called `stop()`". Surfacing them shows an
error banner during completely normal use. `not-allowed`, `audio-capture` and `network`
each get their own specific message instead.

**6. `start()` and `stop()` throw.** `InvalidStateError` when the engine is already in the
state you asked for — and you cannot know which state it is in, because it changes state
by itself. Every call is wrapped.

**7. Permission is a one-way door.** A denied microphone is remembered per origin and the
browser will never ask again. This demo probes `navigator.permissions.query({name:'microphone'})`
where it is supported (it *throws* in Firefox, which must be treated as "no information",
not as a denial), routes the prompt through `getUserMedia` so a refusal arrives as a
distinguishable `NotAllowedError`, and shows a "here is how to re-enable it" panel instead
of a generic error.

**8. `cancel()` fires the previous utterance's `onend`.** Which restarts recognition — in
the middle of the *new* utterance. Every utterance carries a monotonic id and only the
newest one may change state.

**9. Chrome truncates long utterances** at roughly 15 seconds. Worked around with a
`pause()`/`resume()` heartbeat, armed only for text long enough to hit the limit.

**10. `getVoices()` is empty on first call in Chrome** and populated synchronously in
Safari, which may never fire `voiceschanged`. Handle both: read immediately, subscribe to
the event, and schedule one delayed re-read if the first read came back empty.

**11. Say numbers the way people say them.** `203.0.113.5` is read by TTS engines as a
decimal number, which a listener cannot write back down; it is spoken here as
"203 dot 0 dot 113 dot 5". `HC-118` becomes "H C 118". Percentages are rounded, distances
get spelled-out units, and durations become "1 hour 37 minutes".

**12. Pluralise, and never recite zeros.** "1 vans" is a typo you skim past on screen and
a jolt when spoken. And a status report that says "zero offline, zero in maintenance, zero
low battery" takes eight seconds to say nothing — report only the non-zero categories and
fall back to a single "all clear".

## Command vocabulary

Nineteen commands. Full trigger lists, examples and a "Try it" button for each are on the
*Commands* page in the app.

| Command | Say something like | Answers with |
| --- | --- | --- |
| Fleet summary | "give me a fleet summary", "status", "how are we doing" | Headline counts, average charge, parcels outstanding |
| Any problems | "are there any problems", "what's wrong" | Offline, in maintenance, low charge, stale check-ins — non-zero categories only |
| Counts | "how many vans are charging", "how many at Riverside" | A count by state or by depot |
| List by state | "show me all the offline vans", "which vans are en route" | Names them and filters the table |
| Battery / charge | "which vans have low battery", "what's the battery on Dunlin" | Low-charge list, or one van's charge |
| Packages | "how many parcels are left", "how many parcels does Ibis have" | Fleet total, or one van's load |
| Depot report | "how is Riverside depot doing" | Depot breakdown plus anything flagged there |
| Vehicle detail | "tell me about Kingfisher", "details for 118" | Full report on one van, and highlights its row |
| Change view | "go to the commands page", "take me to browser support" | Navigates |
| Speak faster / slower | "speak faster", "slow down" | Adjusts the rate by 0.15 |
| Raise / lower pitch | "higher pitch", "lower pitch" | Adjusts the pitch by 0.2 |
| Mute / unmute | "mute", "unmute" | Stops or resumes spoken answers |
| Reset voice | "reset voice" | Back to the browser default voice, rate and pitch |
| Repeat | "say that again" | Repeats the previous answer |
| Help | "what can you do" | A ~15-second spoken summary |
| Stop | "stop listening", "never mind", "quiet" | Ends the session |

### How matching works — honestly

The transcript is lowercased, stripped of punctuation, and tested against an **ordered**
list of commands. The first command whose trigger phrase appears as a substring wins;
nothing after it is consulted. Vehicle call signs, depot names and state words are matched
on **word boundaries** instead, because the fleet contains vans called *Tern*, *Kite* and
*Teal* and a substring test finds them inside "eastern", "pattern" and "stealthy".

What that is **not**:

- **Not fuzzy.** "vehicals" matches nothing. No edit distance, no phonetic matching.
- **Not intent classification.** No model, no embeddings, no confidence score. "Don't tell
  me about the offline ones" matches the offline command, because negation is invisible to
  a substring test.
- **Not slot filling.** "Compare Northgate and Riverside" finds one depot and ignores the
  other.
- **Order-dependent.** `"mute"` is a substring of `"unmute"`, so unmute *must* be tested
  first or the user can never turn the voice back on — and a muted assistant cannot tell
  them why. Every ordering decision is commented in `commands.ts` and asserted in the test
  suite.

In exchange it is fully deterministic, runs in microseconds, needs no network and no
model, and when it gets something wrong you can read the source and see exactly why. That
is a fair trade for a small fixed vocabulary. It stops being a fair trade the moment the
vocabulary grows or users start speaking freely — at which point you want real intent
recognition, and you should not pretend otherwise.

## Browser support

There is a full matrix, with behavioural notes, on the *Browser support* page in the app.
The short version:

| Browser | Recognition (speech in) | Synthesis (speech out) |
| --- | --- | --- |
| Chrome (desktop & Android) | ✅ as `webkitSpeechRecognition` | ✅ |
| Edge (Chromium) | ✅ as `webkitSpeechRecognition` | ✅ |
| Safari (macOS & iOS) | ⚠️ present, but needs a user gesture; iOS ties it to the system dictation setting | ✅ |
| Firefox | ❌ not exposed to web content | ✅ |

Requirements:

- **A secure context** — HTTPS, or `http://localhost`. Microphone access is refused on a
  plain `http://` origin, which is the usual reason a LAN-hosted copy "doesn't work".
- **Microphone permission** — asked once per origin, and a denial is remembered.
- **A network connection**, for recognition, in Chromium browsers. See below.
- **A user gesture**, in Safari. The microphone button satisfies this everywhere.

Speech *synthesis* is local in every browser tested and works offline.

## Privacy

> **Speech recognition may be processed by your browser vendor's servers.**

"Built into the browser" is not the same as "processed on your device", and the API gives
JavaScript no way to tell the difference.

- **Chrome and Edge** stream the captured audio to their vendor's speech service and
  return a transcript. That is why recognition fails offline.
- **Safari** uses the platform speech framework, which may run on-device or on Apple's
  servers depending on OS version, language, and whether the model has been downloaded.
- **This app** has no backend. It transmits nothing itself. The only thing it stores is
  your chosen voice, rate, pitch and mute preference in `localStorage`. The transcript and
  command history live in memory and vanish when the tab closes.

If the audio itself is sensitive, the Web Speech API cannot give you the guarantee you
need — you want a recogniser you control, running somewhere you can point at.

## Accessibility

**Voice control is itself an assistive technology.** For someone with a motor impairment,
RSI, a temporary injury, or their hands full, speaking to an interface may be the only
practical way to use it. Which makes it all the more important that adding voice does not
degrade anything else — a voice mode reachable only by mouse, or that steals focus, or
that animates continuously, makes an app *less* accessible overall even though the new
feature is an accessibility feature.

It also has limits worth being honest about: recognition accuracy is measurably worse for
non-native accents, regional dialects, and people with dysarthria, aphasia or a stammer —
the exact groups most likely to benefit. Voice must be an addition to a pointer and
keyboard interface, never a replacement.

What this demo does:

- Every command is keyboard- and pointer-operable via **Try it** buttons and a text input,
  running the same handlers.
- Live transcript and every response are in `aria-live` regions — separate regions,
  because interim text updates several times a second and would otherwise drown the
  answer.
- All animation is disabled under `prefers-reduced-motion`; the listening pulse is
  decorative and duplicated by colour, label and a `role="status"` message.
- Skip link as the first focusable element; visible high-contrast focus rings; focus is
  never stolen.
- No state conveyed by colour alone — status pills carry text, the battery bar carries its
  number.
- Semantic landmarks throughout, and a `forced-colors` block for Windows high-contrast
  mode.

## Running it locally

Requires Node 20+ (CI uses 22).

```bash
npm install
npm run dev      # http://localhost:5173 — a secure context, so the microphone works
npm test         # vitest, jsdom, speech APIs stubbed — no microphone needed
npm run build    # tsc -b && vite build → dist/
npm run preview  # serve the production build locally
```

The test suite never touches a real microphone or audio device: every browser surface the
speech service uses is injected through its constructor, which is exactly why it takes
them as options rather than reaching for globals.

## Project layout

```
src/
  services/
    speech.ts          Recognition + synthesis wrapper. Framework-free, reusable.
    speechTypes.ts     Hand-written structural types for SpeechRecognition.
    speechFormat.ts    "Make it sound right when spoken" helpers.
    commands.ts        The ordered command table. Pure and synchronous.
  data/
    types.ts           Vehicle / Depot / status types.
    vehicles.ts        48 fictional vans, written out longhand.
    depots.ts          6 fictional depots, plus the status vocabulary.
    index.ts           Query layer — shaped like the HTTP calls a real app would make.
  hooks/
    useVoiceSession.ts React binding. Owns history, applies effects, avoids stale closures.
  components/
    FleetView.tsx      The app being controlled.
    CommandsView.tsx   Command reference + "Try it" buttons.
    SupportView.tsx    Browser matrix, permission flow, privacy, accessibility notes.
    VoicePanel.tsx     Mic button, live transcript, responses, history, settings.
  tests/               139 tests across five files. No microphone, no audio device.
```

Everything in `data/` is invented. Addresses come from the ranges reserved by
[RFC 5737](https://www.rfc-editor.org/rfc/rfc5737) (203.0.113.0/24, 198.51.100.0/24) and
[RFC 1918](https://www.rfc-editor.org/rfc/rfc1918) (192.168.0.0/16), so none of them can
route anywhere.

## Deploying

`.github/workflows/deploy-pages.yml` builds and publishes on every push to `main`.

One prerequisite: in the repository, **Settings → Pages → Build and deployment → Source**
must be **GitHub Actions**. With the default "Deploy from a branch" the workflow runs
green and publishes nothing.

`base: './'` in `vite.config.ts` keeps asset paths relative, so the build works under the
`/voice-command-demo/` project sub-path without the repository name being compiled in.

## Licence

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Ryan Gross.
