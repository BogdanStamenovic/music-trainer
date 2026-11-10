# Handoff: curriculum waves 4–9

Status on 2026-11-10: waves 1–3 written (weeks 1–20; wave 3 deploying), 52 weekly
projects for the whole year. **Waves 4–9 are on hold on purpose** (manager-15,
2026-11-10). They are to be calibrated on real use: Bogdan had not done a lesson when
waves 1–3 were written, so pace, difficulty and what he skips were guesses.

## Before writing wave 4: read the data

`music-trainer calibrate` (or `--json`; HTTP: `/api/admin/calibration`) shows:
- **Per lesson:** estimated vs actual minutes, pass rate, retries, the hardest exercises,
  abandoned exercises (started, never submitted).
- **Per day:** focus, no-piano days, voice-rest days, minutes, lessons passed.
- **Pace by track:** actual / estimated minutes over passed lessons.

Questions to answer with it before planning a wave:

| Signal | Likely meaning | Adjust |
|---|---|---|
| pace ratio > 1.5 on a track | lessons too long or too hard | fewer exercises per lesson, or split lessons |
| pace ratio < 0.6 | too easy for a fluent pianist | denser lessons, fewer drills |
| many retries on one exercise type | an unclear prompt, or a grader too strict | check the prompt and grading before blaming the learner |
| abandoned exercises clustered in one kind (e.g. compose, sing) | friction in the UI or the task | fix the tool first |
| frequent no-piano days | the schedule doesn't match his life | more piano-free content (T, L, V) or a different weekly schedule |
| voice-rest days | vocal load too high | shorter V lessons, more rest between belt lessons |
| a track far behind the others | that day of the week keeps being skipped | ask him; maybe move days |

Times are client-measured from showing an exercise to submitting it, so they include pauses.

## Process that worked (waves 1–3)

1. **Map first.** Add the wave's tables to `MAP.md`: ids, titles, cross-track prereqs.
   Authors work in parallel, so ids must be fixed before anyone writes.
2. **One Opus author per track.** Each writes only its own directory, from the brief
   (the brief used for waves 1–3 is reproduced at the end of this file).
3. **Authors report engine gaps; the engine owner fixes them during the wave.**
   About half of the engine improvements came from these reports.
4. **Then one fresh Opus reviewer per track pair** (T+C, E+K, V+L), not the author. It fixes
   clear errors in place and lists judgement calls. Reviewers found 35 errors in wave 1 and
   about 45 in wave 2 (wave 3: see the git log). **Do not skip this pass.**
5. **Then validate, test, commit, and deploy via `ownbox update`.** Report per wave or per
   2–3 waves.

## Error patterns reviewers keep finding

Tell authors about these up front:
- **Explanation text contradicts the example right next to it**, e.g. "steps down" when
  the voices move up, or "bar 3" when the example shows bar 6.
- **Model answers that don't follow their own prompt**, e.g. changing three notes when
  the prompt says one or two.
- **A distractor that is also correct** (enharmonics: C♯ major vs D♭ major), or a prompt
  that admits a second answer.
- **ABC errors:** accidentals carry through the bar, `L:` lengths make bars too long,
  `w:` lyrics don't match the notes. ABC is now validated by abcjs, but whether the
  shown notes match the graded notes is still checked by eye.
- **Plain-string options with words:** they are not translated. Note names are now
  converted automatically; words must be `{en, sr}`.
- **Serbian terminology drifts between authors.** The canonical terms: ključni tonovi,
  jaka/slaba doba, prolaznica, prednja/zadnja rečenica, pobočno kretanje,
  "Sjaj, sjaj, zvezdice". Contested stress positions (gitara) are avoided.
- **Generators can't do what the lesson claims**, e.g. rhythms tied across a bar line.
  Authors must sample generated items (`generateItems` + seeds) and read them in both languages.

## Engine: what exists (see `schema.ts`, `items.ts`, `grading.ts`)

**Exercise types:** mcq (shuffled per seed), notation-input, midi-play/midi-echo
(sequence/chord/chords, `beats` = written rhythm graded for timing), practice,
sing-pitch/sing-phrase (rests, `accompany`, fitRange low/high), voice-range, checkin,
compose (music21 rules plus a required `example` model answer), write (self rubric plus
optional AI feedback), generated.

**Generators:** note-read, interval-name/-build/-ear, semitones, chord-ear/-build/-name,
scale-build, keysig, roman (incl. sevenths), progression (smooth voice leading),
progression-ear, melody-echo, degree-ear, bass-echo (fixed `line`, inversions),
rhythm-echo (cells, triplets, hidden notation, count-in), improv, pitch-match, phrase-sing.

**Checks:**
- **Pitches and harmony:** interval, semitones, chord (by spelling from the root),
  scale, keysig, roman (incl. seventh), numeral (secondary and borrowed chords).
- **Lyrics:** syllables (Serbian only).

**Roman numerals are read as written:** I7 = dominant, bVII, V/V, V7/ii, iv in major,
and figures for inversions.

**Voice safety, enforced:**
- every V lesson starts with a check-in and a warm-up;
- `belt` needs support + onset + mix prerequisites and the stop protocol;
- `distortion` needs support + onset prerequisites and the stop protocol, max one per day,
  never on a voice-rest day;
- sung phrases are octave-agnostic per phrase.

## Known gaps (not built yet)

| Gap | Wanted by | Note |
|---|---|---|
| Arpeggio generator | K | arpeggios are static now |
| Secondary-dominant generator | T, E | static `derive` + progression-ear for now |
| "Choose chords for this melody" exercise with per-span grading | K, C | mcq workaround |
| Improv that plays a fixed call (call and response) | K | self-directed now |
| Simultaneous notes in sequence mode (two hands with rhythm) | K | |
| Rhythm ties across bar lines in rhythm-echo | E, K | use one long bar (e.g. 8/4) as a workaround |
| Harmony checks in compose (does the bass fit the melody?) | C | worker checks single lines plus parallels only |
| Motif/phrase-shape rules (inversion, climax placement) | C | AI critique covers projects only |
| Stress check (Serbian accent list), English syllables | L | stress claims are reviewed, not checked |
| Check that shown ABC matches the graded notes | all | reviewer by eye |
| Scale-ear generator (e.g. natural vs harmonic minor) | V, E | static mcq |
| Rising-key sequences for vocal exercises | V | self-rated practice |
| Repeated same-pitch notes in sung phrases | V | untested with real audio; use rests between |
| `composition.key` only major/minor (modes via the parallel minor) | projects | |
| `play` from roman numerals (`play: {roman: {key, numerals}, durations}`) | T, E | listening chords are typed + checked by hand |
| progression-ear options in a second key ("G: V7") for modulation | T, E | written in home-key numerals (V7/V – V) |
| Vibrato shown as feedback (voice-score computes rate/extent) | V | V-060 uses a wider tolerance only |
| Belt-call counter / rest timer between reps | V | instruction + self-count; the planner caps belt lessons at 1/day |
| Rests in static midi exercises | K | folded into the previous note's `beats`; ABC shows them |
| Swing timing (a ratio on `beats`/rhythm) | K, E | swing is taught as practice; grading uses straight time |
| Shell voicings in the `progression` generator | K | close position only; typed exercises for shells |
| `mcq` playback mixing a melody with chords | K, E | no "which texture" ear items |

## Waves 4–9 (outline in MAP.md)

| Wave | Weeks | Content |
|---|---|---|
| 4 | 21–26 | modes and modal mixture, transcribing pop, modal vamps, lead sheets; healthy belt and natural vibrato; song forms; rap flow |
| 5 | 27–32 | jazz I (extensions, ii–V–I in all keys, rootless voicings); recording practice; setting lyrics |
| 6 | 33–38 | jazz II (tritone subs, chord-scale); improvising over changes; high belt (gated); arranging |
| 7 | 39–44 | form; full songs by ear; accompanying a singer; stamina |
| 8 | 45–50 | chromatic harmony; reharmonization; **distortion module** (gated: protocol, cap, never scored higher) |
| 9 | 51–52 | counterpoint basics; review |

## The author brief used for waves 1–3

It is kept at `/tmp/claude-1000/m4-brief.md` during a session; its content is in
substance:
- the learner profile;
- EN + SR rules;
- machine-checked correctness (`checks` or generators; no hand-typed fact unchecked);
- lessons of 10–15 minutes with a concrete "why";
- loop until `npm run validate && npx vitest run` is clean;
- write only your directory, never commit;
- report engine gaps.

Each wave appends "WAVE n ADDITIONS" listing the new engine features and canonical terms.
