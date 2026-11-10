# music-trainer

A personal PWA that runs a daily music course (theory, ear training, piano, voice),
grades the work, from multiple-choice answers to what you play on a MIDI piano, and
schedules what to learn and review next. Built for one learner: a fluent pianist
with almost no theory, in English and Serbian.

Spec: [SPEC.md](SPEC.md). This repo covers milestones M1 (trainer skeleton + seed
content), the trainer side of M2 (voice track), M3 (weekly test + projects) and M4
(the year's curriculum, shipped in waves; plan in [curriculum/MAP.md](curriculum/MAP.md)). Singing analysis is a separate
service, [voice-score](https://github.com/BogdanStamenovic/voice-score); its browser
fallback is vendored here.

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
| Voice | Records in the browser (mic processing off), stores the take on the data disk, analyzes it on voice-score. When voice-score is down, the vendored voice-score-lite analyzes in the browser; offline, the take is queued in IndexedDB. Takes made while it was down get a server analysis later | `src/lib/client/voice.ts`, `src/lib/server/recordings.ts` |
| Voice grading | Per target note: full credit within the tolerance (cents), linear down to 0 at 3x; a short sustain scales the score down. Octave-agnostic, and items are moved by octaves into the stored comfortable range | `gradeSing` in `src/lib/grading.ts` |
| Voice safety | Validation forces every V lesson to open with a fatigue/hoarseness check-in and then a warm-up. "Tired" or "hoarse" makes the day a voice-rest day: every voice lesson is blocked until tomorrow. Voice stays out of SRS | `src/lib/curriculum/validate.ts`, `ExerciseQueue` |

| Weekly test | Sunday. Up to 2 exercises from each lesson practised that week (most practised first, max 8), plus up to 4 items SRS shows are failing. Voice is excluded (it is assessed by recorded projects) | `weeklyTest` in `src/lib/server/planner.ts` |
| Weekly projects | One per ISO week, rotating composition → lyrics → vocal piece → play a song by ear; content in `curriculum/projects/` with explicit rubrics | `src/lib/server/projects.ts` |
| Rule checks | music21 worker (Python, uv; venv on `/mnt/offload`): bars, rhythm, range, key, cadence, half cadence, leaps/gap fill, stepwise motion, augmented intervals, parallel 5ths/8ves. JSON over stdin/stdout | `worker/` |
| AI review | `claude -p` (keyless, no tools/MCP/settings/hooks, empty cwd) scores each rubric criterion 0-4 with comments, from a SQLite job queue in the server: one at a time, 3 attempts with backoff, 4 min timeout, hourly retry while the CLI is unavailable, superseded by resubmission | `src/lib/server/claude.ts`, `jobs.ts` |
| Composition input | Record on the MIDI piano against a metronome (one-bar count-in), quantize (♩/♪/16th grid, optional bass split at G3), spell in the key and write ABC (ties across bar lines, accidentals relative to the signature and the bar). The ABC is editable and can be typed instead | `quantize`/`toAbc` in `src/lib/projects.ts`, `Composer` |
| Grade history | Weekly averages per track, weekly test scores, project grades with their parts | `/history` |

Project grades combine a measured part with a rubric part:

| Kind | Measured | Rubric |
|---|---|---|
| composition | music21 rules (50%) | claude review (50%); the learner's self-assessment is the provisional grade until it arrives, and stands if the review cannot run |
| lyrics | — (line/syllable/rhyme stats are shown, not graded) | claude review (100%), same fallback |
| vocal piece | voice-score pitch per note (60%) | self-assessment (40%): an LLM reading text cannot judge a performance it did not hear |
| by ear | interval accuracy, key-independent (60%) + rhythm ratios (20%) | self-assessment (20%) |

Curriculum status (wave 1, 2026-11-10): 115 lessons (T 32, E 22, K 22, V 27, C 6,
L 6) covering weeks 1–8, and 52 weekly projects (13 per kind, no repeats in a year).
Each track was written by one author agent and then read by an independent reviewer
agent. The reviewers fixed 35 errors (wrong facts in explanations, a fingering, a
Serbian stress example, unfair exercises), and their findings drove the engine fixes
listed in the git log.

Correctness of content is enforced, not assumed:

- Every musical fact in a lesson is either produced by the theory library
  (generators, `derive`) or carries a `checks` entry that the tests run.
- Every exercise is generated with several seeds, and each correct answer is played
  back through the grader, which must score it 1.0 (improvisation: at least 0.8).
- Every compose exercise carries a model answer that is run through the real music21
  worker and must pass its own rules (`tests/compose-examples.test.ts`).
- Chord claims are checked by spelling from the stated root (so Dm7 is not mistaken
  for F6); Serbian syllable counts are checked (vowels + syllabic r).
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
the checkout, since the deployed server is self-contained (~70 MB, of which 15 MB is
the browser voice fallback).

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
  `scripts/dev/e2e_voice.py BASE_URL OUT_DIR [--fallback]` does the voice track with a
  faked microphone (an oscillator at the target pitch).
- Voice history and the consent switch: `/voice`.

### Recordings for voice-score validation

`GET /api/voice/validation-set?limit=N` returns the learner's first recordings
(oldest first), each with its absolute file path, the targets sent, and both the
server and browser analyses. It works **only while consent is on** (the switch on
`/voice`, off by default; the time consent was given is stored); otherwise it
returns 403. The files stay on archserver under `$MT_DATA_DIR/recordings/`.

Config (`~/.config/music-trainer/env`):

| Key | Default |
|---|---|
| `MT_DATA_DIR` | see above |
| `PORT`, `HOSTNAME` | 3310, 127.0.0.1 |
| `MT_VOICE_SCORE_URL` | http://127.0.0.1:3311 |
| `MT_TZ` | Europe/Belgrade (decides what "today" is) |
| `MT_CURRICULUM_DIR` | the deployed copy of `curriculum/` |

## Measured

- Tests: 48 (theory facts, grading, planner/SRS, voice, all content). The voice tests
  send synthesized tones through the real voice-score when it is up. A tone a semitone
  sharp fails; an in-tune tone is within 20 cents.
- Full E2E on 2026-11-10 used google-chrome-stable 157 (headless) and a **virtual** MIDI
  device (snd-virmidi on archserver; no real piano was attached). It covered:
  - placement: 22 probes
  - planned lesson E-002: 6 exercises, one failed on purpose and retried
  - MIDI out: 68 note-ons reached the virtual port
  - offline: lesson rendered from cache, the submission was queued, then synced
  - Serbian UI
  - only expected console errors (offline fetches)
- Voice E2E on 2026-11-10, real Chrome with a **faked microphone** (an oscillator; no
  human voice yet), logs in `docs/`:
  - real voice-score: range stored as sung (A2–E4, comfortable B2–D4); pitch matches
    within ±8 cents; the take a semitone sharp measured +94 cents and scored 0
  - 3–5 note phrases segmented and graded per note
  - consent gate: 403 → 200 → 403
  - history playback serves Range requests (206)
  - a "hoarse" check-in blocks voice lessons for the day
  - fallback (voice-score unreachable): 6 takes analyzed by swiftf0-web in Chrome;
    offline, a take was analyzed locally, queued, and uploaded on reconnect; once
    voice-score was back, all 7 takes were re-analyzed. Browser vs server on the
    same takes: within 2 cents per note.
- M3 E2E on 2026-11-10 (real Chrome, real music21 worker, real `claude -p`; log in
  `docs/e2e-m3-2026-11-10.log`):
  - composition played on the on-screen keyboard: quantized exactly as played; rules 100%
    except range (B3 below the asked C4-E5); review back in 30 s; 77% final
  - typed ABC ending on the leading tone: cadence 0% ("ends on B (degree 7)"), 62%
  - Serbian lyrics: reviewed in Serbian in 42 s; the review caught that 1 of the 3
    asked stanzas was written and graded 50% against a self-assessed 75%
  - by-ear tune played a whole tone low: transposition -2 detected, pitch 100%
  - vocal piece (faked mic): pitch 100%
  - reviewer cost reported by the CLI: ~$0.02-0.05 per review at list price; it runs
    on the subscription, keyless
- music21 worker: 66 pytest tests; ~0.24 s per check as a subprocess; venv 268 MB on
  `/mnt/offload`.
- Added size of the browser fallback: 14.9 MB (onnxruntime-web WASM build only:
  14.85 MB WASM + 78 KB loaders, + the vendored lite module and 135 KB model). It
  is loaded only when voice-score is down, then cached by the service worker.
- Deployed size: ~70 MB. A build needs ~850 MB free while it runs.

## Limitations

What works today:

- T/E/K lessons with deterministic grading
- V lessons (breath, range, pitch matching, onsets, sirens, intervals, steady tones,
  phrases) graded from voice-score metrics, with the browser fallback
- placement, planner, SRS, the M1 weekly test
- EN/SR
- MIDI in/out
- offline day cache

What does not exist yet:

- **Voice grading is pitch and duration only.** Onset quality, registers, breath
  and tone are self-judged; technique classification will come from voice-score
  as low-confidence hints, never as grades (SPEC). Nothing about distortion exists
  yet; it is gated to a later module.
- **No human voice has gone through it yet.** The E2E fed oscillator tones. Real
  voices bring vibrato, scoops and glides, and how voice-score segments a sung
  glide (V-006) is untested.
- **Voice is not in the weekly test or SRS.** Daily singing load comes from the
  plan and the check-in; recorded vocal pieces are an M3 project.
- **No daily cap on singing minutes yet** beyond lesson length; the spec's cap
  applies to the (not yet built) distortion module.
- **No mic fallback for piano exercises.** Without Web MIDI (e.g. iPhone Safari)
  the on-screen keyboard is the only input.
- **The AI review is a second opinion, not ground truth.** It reads ABC and text;
  it never hears anything. Rubric scores from one run can differ from the next by a
  point. Rule checks are deterministic but only cover what is listed.
- **Rule checks are single-line.** No harmonic analysis, hidden 5ths/8ves or voice
  crossing; repeats are not expanded; rests do not break the melodic line (see
  `worker/README.md`).
- **Lyric stats are spelling-based** (rhyme and syllables), shown as approximate.
- **Only 8 projects exist** (2 per kind); after 8 weeks they repeat. No Serbian
  traditional tune yet for the vocal/by-ear projects (no checked transcription).
- **Web Audio playback is a synthesized tone**, not piano samples. It is small
  and works offline; the real piano sound comes from MIDI out.
- **Not tested with the real piano yet.** All MIDI tests used snd-virmidi.
  Chrome only exposes ALSA ports it can open: on archserver the user is not in
  `audio`, so `/dev/snd/seq` needed an ACL.
- **Timing grading is a screen, not a verdict.** It checks evenness (RMS
  deviation from a fitted beat grid, 0.25 beat = zero score) and penalises tempo
  that is more than 15% off. Swing and rubato are not modelled.
- **Content is hand-written, about two weeks of it** (42 lessons + warm-up). Terminology
  that `checks` cannot verify (degree names, cadence names) was reviewed but
  not machine-checked.
- **Language facts are only partly machine-checked.** Serbian syllable counts are;
  stress positions, English syllables and terminology rest on the authors and the
  review pass.
- **Improvisation grading is a coarse screen:** notes in the scale or the current
  chord, chord tones on the downbeats of the changes you play, and activity. It cannot
  judge phrasing or taste.
- **Waves 2–9 of the curriculum are not written yet** (see MAP.md). When a track runs
  out, the planner fills days with drills from passed lessons.
- **One user, no auth.** It is reachable only via localhost and the tailnet.
