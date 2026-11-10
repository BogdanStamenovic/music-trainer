# music-trainer

A personal PWA that runs a daily music course (theory, ear training, piano, voice),
grades the work, from multiple-choice answers to what you play on a MIDI piano, and
schedules what to learn and review next. Built for one learner: a fluent pianist
with almost no theory, in English and Serbian.

Spec: [SPEC.md](SPEC.md). This repo is milestone M1 (trainer skeleton + seed content).
Singing analysis is a separate service,
[voice-score](https://github.com/BogdanStamenovic/voice-score) (M2).

## How it works

| Part | What it does | Where |
|---|---|---|
| Theory core | Spelled pitches (C4 = MIDI 60; Serbian H/B/Fis/Es naming), intervals, scales, chords, keys, roman numerals | `src/lib/music/` |
| Curriculum | One YAML file per lesson, validated by a zod schema. 15 generators make fresh items from parameters | `curriculum/`, `src/lib/curriculum/` |
| Grading | MCQ; note names with strict spelling (EN or SR input); MIDI chord (held set, any octave, optional bass/inversion), sequence (edit-distance alignment), progressions (onset clustering), timing (least-squares beat fit) | `src/lib/grading.ts` |
| Planner | One focus part per weekday from a configurable schedule (default Mon T, Tue E/K, Wed V, Thu T, Fri E/K, Sat V+C/L, Sun test), filled to 25–50 min, plus an optional ≤10 min maintenance block (SM-2 reviews + vocal warm-up) | `src/lib/server/planner.ts` |
| Placement | Day-one test; each probe that passes skips its lessons (only when their prereqs are done too) | `curriculum/placement.yaml` |
| Storage | SQLite (better-sqlite3), additive migrations, backup before every migration | `src/lib/server/db.ts` |
| Piano I/O | Web MIDI in (notes, velocity, pedal) and out (playback on the piano itself), Web Audio synth fallback, on-screen keyboard | `src/lib/client/midi.ts` |
| Offline | Service worker caches the app shell and today's lessons; submissions queue in IndexedDB and sync later | `public/sw.js`, `src/lib/client/queue.ts` |
| voice-score client | URL from config; `/health` with a 3 s timeout; `down` is a typed result, not an error | `src/lib/server/voiceScore.ts` |

Correctness of content is enforced, not assumed:

- Every musical fact in a lesson is either produced by the theory library
  (generators, `derive`) or carries a `checks` entry that the tests run.
- Every exercise is generated with several seeds, and each correct answer is played
  back through the grader, which must score it 1.0.
- Grading happens twice. The client grades for instant feedback; the server
  regenerates the same items from (exercise, seed) and grades again, and its result
  is the one stored.

## Install

```bash
ownbox install music-trainer        # or: ownbox update music-trainer --yes
```

`install.setup` (scripts/lifecycle.sh) builds the Next.js standalone server, deploys
it to `~/.local/lib/music-trainer/app`, writes `~/.config/music-trainer/env` (once,
never overwritten), installs and starts the user unit `music-trainer.service` on
127.0.0.1:3310, and runs `tailscale serve --bg --https=8448` (skipped with a
warning if 8448 is taken by something else). It then deletes `node_modules` from
the checkout, since the deployed server is self-contained (~55 MB).

`install.update` does the same, plus:

- a DB backup (`$MT_DATA_DIR/backups/pre-update-*.db`, last 10 kept)
- an atomic swap of the deployment
- a health check, with an automatic rollback to the previous deployment if it fails.

`install.remove` stops and removes the unit, the tailscale mapping and the deployment.
It asks before deleting data or config; without a TTY it keeps both.

Data dir: `/mnt/windows/music-trainer-data` when `/mnt/windows` is mounted at
install time, else `~/.local/share/music-trainer`. The server refuses to start if
the configured data dir is missing (e.g. disk not mounted) rather than recreate it
on the root disk; the unit retries every 20 s.

## Usage

- Open `https://archserver.<tailnet>.ts.net:8448/` in Chrome on the laptop with
  the piano attached over USB, then "Install app".
- `music-trainer status | logs [N] | restart | url`
- Dev: `npm run dev` (127.0.0.1:3310, data in `./data`), `npm test`,
  `npm run validate`, `npm run typecheck`.
- Writing content: [curriculum/README.md](curriculum/README.md).
- Browser E2E: `scripts/dev/e2e.py BASE_URL /dev/snd/midiC<N>D0 OUT_DIR` drives
  real Chrome and plays the answers on a virtual MIDI device (snd-virmidi).

Config (`~/.config/music-trainer/env`):

| Key | Default |
|---|---|
| `MT_DATA_DIR` | see above |
| `PORT`, `HOSTNAME` | 3310, 127.0.0.1 |
| `MT_VOICE_SCORE_URL` | http://127.0.0.1:3311 |
| `MT_TZ` | Europe/Belgrade (decides what "today" is) |
| `MT_CURRICULUM_DIR` | the deployed copy of `curriculum/` |

## Measured

- Tests: 37 (theory facts, grading, planner/SRS, all content).
- Full E2E on 2026-11-10 used google-chrome-stable 157 (headless) and a **virtual** MIDI
  device (snd-virmidi on archserver; no real piano was attached). It covered:
  - placement: 22 probes
  - planned lesson E-002: 6 exercises, one failed on purpose and retried
  - MIDI out: 68 note-ons reached the virtual port
  - offline: lesson rendered from cache, the submission was queued, then synced
  - Serbian UI
  - only expected console errors (offline fetches)
- Deployed size: ~55 MB. A build needs ~700 MB free while it runs.

## Limitations

What works today:

- T/E/K lessons with deterministic grading
- placement, planner, SRS, the M1 weekly test
- EN/SR
- MIDI in/out
- offline day cache

What does not exist yet:

- **Voice is not graded.** V-001 (the warm-up) is self-rated. voice-score is up
  and its client and proxy route exist, but no V exercise sends audio yet (M2).
  The browser pitch fallback (`voice-score-lite.mjs`) is not vendored yet.
- **No mic fallback for piano exercises.** Without Web MIDI (e.g. iPhone Safari)
  the on-screen keyboard is the only input.
- **The weekly test is basic.** It takes one exercise from each lesson passed in
  the last 7 days. Projects, C/L tracks and `claude -p` grading are M3.
- **Web Audio playback is a synthesized tone**, not piano samples. It is small
  and works offline; the real piano sound comes from MIDI out.
- **Not tested with the real piano yet.** All MIDI tests used snd-virmidi.
  Chrome only exposes ALSA ports it can open: on archserver the user is not in
  `audio`, so `/dev/snd/seq` needed an ACL.
- **Timing grading is a screen, not a verdict.** It checks evenness (RMS
  deviation from a fitted beat grid, 0.25 beat = zero score) and penalises tempo
  that is more than 15% off. Swing and rubato are not modelled.
- **Content is hand-written, about two weeks of it** (34 lessons). Terminology
  that `checks` cannot verify (degree names, cadence names) was reviewed but
  not machine-checked.
- **One user, no auth.** It is reachable only via localhost and the tailnet.
