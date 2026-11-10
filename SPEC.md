# music-trainer — spec v1 (2026-11-10, manager-15)

A personal PWA on archserver that runs a daily music course for Bogdan: theory,
ear training / play-by-ear at the piano, singing, composition, improvisation and
lyric writing, with graded daily work, weekly tests and weekly projects.

## Who it is for (from Bogdan, 2026-11-10)

- ~10 years of piano, reads notation and plays fluently. **Theory: almost none.**
- Singing: untrained, no lessons. Wants everything: chest/head/mix, belt,
  falsetto, high voice, distortion (screams, false cords).
- Wants to **play by ear**, compose, improvise, write lyrics per genre.
- Budget **30 min/day core, up to 60 min with stretch block**.
- Piano: **Yamaha Arius** (USB-TO-HOST, class-compliant MIDI).
- Language: **both EN and SR**. UI toggle; lessons carry both terms
  ("dominant / dominanta").
- Device at the piano: OPEN QUESTION (iPhone Safari has no Web MIDI). Build for
  Chrome/Chromium Web MIDI first; mic fallback for everything MIDI does.

## Architecture (two repos — different questions, different deps)

| Repo | Question it owns | Stack | Port |
|---|---|---|---|
| `music-trainer` | What do I learn today, how did I do, what next | Next.js (App Router) + SQLite (better-sqlite3), PWA | 127.0.0.1:3310 → `tailscale serve --https=8448` |
| `voice-score` | What did this voice recording actually do | Python (uv), FastAPI, onnxruntime, SwiftF0 | 127.0.0.1:3311 |

- The trainer calls voice-score over HTTP. **voice-score down ⇒ trainer degrades**:
  in-browser SwiftF0 (onnxruntime-web, same 135 KB model) gives pitch metrics;
  only server-only extras disappear.
- archserver is not always on: the PWA caches the current day's lesson + assets
  and queues submissions in IndexedDB, syncing when the server is reachable.
- User data (SQLite DB, recordings) lives in a data dir from config, default
  `/mnt/windows/music-trainer-data` when mounted, else `~/.local/share/music-trainer`.
  Root disk is ~96% full: never store recordings on root by default.
- LLM grading uses keyless `claude -p` from a server-side job queue (async;
  results appear when ready). No API keys.

## Curriculum model (content is data, not code)

Content lives in `curriculum/` as YAML (or JSON), validated by a schema in the
repo (zod). Tracks:

| Code | Track | Graded by |
|---|---|---|
| T | Theory (notation→intervals→scales/keys→triads→7ths→functional harmony→modes→secondary dominants/modulation→jazz harmony→form) | deterministic |
| E | Ear / play-by-ear at the keys (intervals → chord quality → scale degrees → bass lines → progressions → melodic dictation → play songs by ear) | MIDI compare |
| K | Keys applied (play the theory: voicings, progressions in all keys, cadences, comping patterns, improvisation over changes) | MIDI compare (+ timing) |
| V | Voice (breath/support, onsets, pitch matching, range, registers, mix, belt, vibrato, falsetto; distortion gated late) | voice-score metrics + self-report |
| C | Composition/improv (melody writing, harmonization, form, arranging) | music21 rule checks + `claude -p` critique |
| L | Lyrics per genre (meter, rhyme, prosody, genre conventions) | `claude -p` rubric |

Schema sketch:

```yaml
id: T-012
track: T
title: {en: "Major scale construction", sr: "Građenje durske lestvice"}
prereqs: [T-011]
minutes: 10
explain: {en: "markdown…", sr: "markdown…"}   # may embed ABC notation blocks
exercises:
  - id: T-012-1
    type: mcq | notation-input | midi-play | midi-echo | interval-id | chord-id
          | sing-pitch | sing-phrase | free-text | compose | lyrics
    prompt: {en: …, sr: …}
    # type-specific payload, e.g. midi-play: {expect: ["C4","E4","G4"], mode: chord|sequence, tempo?}
    # midi-echo: {play: [...], expect: same, playback: midi-out|webaudio}
    grading: {pass: 0.8}
```

- **Day plan generator — one focus part per day** (changed 2026-11-10 by Bogdan,
  Discord 1569732915527684097, relayed by manager-15). The original "3 core blocks
  every day" model is superseded.
  - A configurable **weekly schedule** maps weekday → focus (T/E/K/V/C/L, a
    combination like E/K or V+C/L, or a test/rest day). Default: Mon T, Tue E/K,
    Wed V, Thu T, Fri E/K, Sat V + C/L project work, Sun weekly test + project due.
  - The focus part gets most of the session (25–50 min, configurable target):
    the planner fills it with consecutive unlocked lessons of that track.
  - Optional **maintenance block** (≤10 min): spaced-repetition review items
    (SM-2) from everything failed or due, plus a 3–5 min vocal warm-up /
    pitch-match. On by default; a setting turns it off.
  - If the focus track has no unlocked content (e.g. V before M2), the planner
    says so and falls back to the next track in the week that has content.
- **Device at the piano** (answered 2026-11-10): laptop `arch` (Linux,
  google-chrome-stable) with the Arius on USB, so Chrome Web MIDI is the main path.
- **Placement test** on day 1: notation fluency (expected high → fast-forward),
  theory (expected ~0), ear baseline, vocal range + pitch matching baseline.
- **Weekly (Sunday)**: a graded test over the week's material + one project
  rotating C / L / recorded vocal piece / play-by-ear a song. Grades stored with
  rubric breakdown and history charts.

## Voice safety (non-negotiable)

- Every voice block starts with a warm-up; a hoarseness/fatigue check-in can end
  the voice block for the day.
- Distortion / screams / false-cord module unlocks only after support + onset
  units pass, carries an explicit "stop if it hurts" protocol, has a daily cap,
  and **never scores "more distortion" higher**. voice-score may *label*
  distortion present (no safety score exists anywhere — survey 2026-11-10).
- Technique classification (chest/head/belt) is shown as **low-confidence hint**
  only (best published 10-class VocalSet accuracy ≈66%). Falsetto-vs-not is the
  one register signal strong enough to grade (GTSinger F1 0.96).

## Piano I/O

- Web MIDI in: notes, velocity, sustain pedal, timing.
- Web MIDI **out** to the Arius for ear-training playback (real piano sound),
  Web Audio piano sample fallback.
- Notation rendering: abcjs (or VexFlow if needed).

## Milestones

| M | Scope | Owner |
|---|---|---|
| M1 | Trainer skeleton: PWA (manifest, SW, offline day cache), i18n EN/SR, SQLite, MIDI in/out, curriculum schema + loader, day planner, SRS, placement test, grading for T/E/K, ownbox manifest, tailscale serve. Seed content: first ~2 weeks T/E/K. | builder `mt-app` |
| M2 | voice-score service (SwiftF0 default; benchmark vs RMVPE, FCPE/PESTO, pYIN baseline on real recordings), metrics: pitch accuracy in cents vs target, stability, sustain, range, vibrato rate/extent, falsetto detector (later), distortion label (later). Browser SwiftF0 fallback in trainer. ownbox manifest + systemd user unit. | builder `voice-score` |
| M3 | Weekly tests + projects, `claude -p` grading queue for C/L, music21 rule checks (lives in voice-score? NO — separate small python worker in trainer repo or its own tool; decide at M3). | mt-app |
| M4 | Full curriculum content EN/SR (~1 year), authored against the schema. | curriculum agent |

Done means exercised: fresh `ownbox install` works, `ownbox update` keeps the DB
and recordings, the PWA installs on the tailnet URL and a lesson is completed
end-to-end with a real MIDI device (or a virtual one: `snd-virmidi`/a2jmidid if
no piano is attached to archserver — say which was used).
