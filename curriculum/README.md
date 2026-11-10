# Curriculum authoring guide

Lessons are data: one YAML file per lesson at `curriculum/<TRACK>/<ID>.yaml`, validated
by the zod schema in `src/lib/curriculum/schema.ts`. Run `npm run validate` and `npm test`
after every change; both must be clean.

## Rules

- **Both languages, always.** Every `title`, `explain`, `prompt` and option is `{en, sr}`.
  Serbian uses Serbian music terms (Latin script, with č ć š ž đ) and German-system note
  names in prose: **H** = B natural, **B** = B flat, Cis/Des/Es/As/Fis/Ges. Mention the
  other language's term on first use when it helps ("dominant / dominanta").
- **No hand-typed musical fact goes unchecked.** Prefer `type: generated` (the theory
  library makes the item, so it is correct by construction). For static items: either use
  `derive` instead of typing notes, or attach `checks` that assert the fact (interval,
  chord, scale, keysig, roman, semitones). The test suite runs every check, generates
  every exercise with several seeds and verifies that the correct answer grades 1.0.
- Static `expect` notes and `options` are English spellings (`F#4`, `Bb`); the UI shows
  Serbian names in SR mode. Plain-string options are language-neutral (note names,
  numerals); use `{en, sr}` for words.
- Lesson `minutes` is realistic for the whole lesson (read + exercises), 8–15.
- `explain` is markdown. Fenced ```abc blocks are rendered as notation (abcjs). Keep it
  short and concrete: the learner plays piano fluently (10 years, reads well) but has
  almost no theory. Explain the *why*, connect to the keyboard, no fluff.
- Exercise ids: `<LESSON-ID>-<n>`. Lesson ids `T-001`…; `order` = position in track.

## Exercise types

| type | what | key fields |
|---|---|---|
| `mcq` | multiple choice (may play audio or show `abc`) | `options`, `answer` (0-based), `play?` |
| `notation-input` | type note names, strict spelling | `expect: [D, E, F#]` or `derive` |
| `midi-play` | play on the piano | `mode: chord|sequence|chords`, `expect`/`expectChords`/`derive`, `octave: exact|any`, `bass`, `tempo?` (timing graded) |
| `midi-echo` | app plays, learner plays back | as midi-play; `play?` (defaults to the expected notes) |
| `practice` | self-rated routine | `minutes`, `play?` |
| `sing-pitch` | sing note(s); sustain applies to the last | `notes`, `sustain`, `tolerance` (cents), `octaveAgnostic`, `fitRange` |
| `sing-phrase` | sing a phrase in time | `notes` or `derive`, `beats?`, `tempo`, `tolerance` |
| `voice-range` | low glide + high glide; stores the range | — |
| `checkin` | fatigue/hoarseness check-in; anything but "fine" ends voice work for the day | — |
| `generated` | items made by a generator | `count`, `gen: {kind: …}` (see below) |

`derive`: `{chord: {root: C4, quality: maj, inversion: 0}}`, `{scale: {tonic: D4, type: major}}`,
`{interval: {from: C4, iv: M3}}`, `{roman: {key: C4, numerals: [I, IV, V7, I]}}`.
Chord qualities: maj min dim aug maj7 7 min7 m7b5 dim7. Scale types: major natural-minor
harmonic-minor melodic-minor major-pentatonic minor-pentatonic. Roman numerals: I…VII /
i…vii with optional figure 6, 64, 7, 65, 43, 42.

Generators (`gen.kind`): note-read, interval-name, interval-build, interval-ear, semitones,
chord-ear, chord-build, chord-name, scale-build, keysig, roman, progression, melody-echo,
degree-ear, bass-echo, pitch-match (single notes, or root + interval with `intervals`;
in intervals mode beats are fixed at 2+2 at ♩=60 and `sustain` is ignored), phrase-sing.

Voice rules (validation enforces them): every V lesson starts with `checkin`, then a
`practice` warm-up; singing types exist only in the V track. Sung items are graded
octave-agnostic and moved into the learner's stored comfortable range. Their parameters are in `schema.ts` (`Gen`) and their behaviour in
`src/lib/curriculum/items.ts`.

`checks` examples:

```yaml
checks:
  - interval: {from: C4, to: G4, is: P5}
  - chord: {notes: [E4, G4, C5], root: C, quality: maj, inversion: 1}
  - scale: {tonic: D, type: major, is: [D, E, F#, G, A, B, C#]}
  - keysig: {key: Eb, mode: major, is: -3}
  - roman: {key: C, type: major, degree: 7, is: "vii°"}
  - semitones: {from: C4, to: E4, is: 4}
```

## Seed plan (M1, ~2 weeks)

With the weekday-focus schedule (Mon T, Tue E/K, Thu T, Fri E/K, ...) a focus day uses
2–4 lessons, so two weeks need ~14 T and ~20 E/K lessons.

## ABC notes

- A `w:` lyric line applies only to the music line directly above it: split lyrics per line.
- Accidentals carry through the bar (`^F` then `F` in the same bar is still F♯); write `=F`.
- All lesson ABC is validated with abcjs (parser warnings; one syllable per note in `w:`
  lines unless `_`/`*` holds are used). Whether the shown notes match the graded notes is
  still checked by eye.
