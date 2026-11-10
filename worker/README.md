# mtworker

Deterministic music-theory rule checks for music-trainer's weekly composition
projects: a short melody in ABC notation, optionally with a bass line, scored
against ten rules with [music21](https://web.mit.edu/music21/). The Next.js
server calls it as a subprocess. It is one half of composition grading; the
other half is an LLM rubric that lives elsewhere.

## How it works

1. The ABC text is normalised: missing `X:`, `M:` and `K:` headers are filled
   from the request, and inline voice fields (`[V:1] ...`) are moved onto their
   own lines, because music21 rejects or misreads both.
2. music21 parses it (durations, tuplets, ties, chords, accidentals, key
   signature). Tied notes are merged; a chord counts as its top note in the
   melody and its bottom note in the bass. With more than two voices the first
   is the melody and the last the bass.
3. The bar lines the learner actually wrote are recovered from music21's ABC
   tokenizer, because music21's own measures re-bar an overfull bar at the meter
   boundary and would hide the mistake the rhythm check is looking for.
4. Every note is respelled into the requested key (G# in C minor becomes Ab), so
   interval qualities reflect the key rather than whatever spelling the MIDI
   quantizer picked. Notes outside the key keep their written spelling.
5. Each requested rule runs and returns a score in 0..1; the overall score is
   the weighted mean.

Bar numbers in the output are on the requested meter's grid, with a pickup as
bar 0. They match the learner's bar lines whenever the rhythm check passes.

## Interface

```
python -m mtworker check   < request.json   > result.json
```

Exit 0 whenever a JSON result was written, including `{"ok": false}`. Exit 2
only for usage errors (wrong or extra arguments), with a message on stderr.

Request:

```json
{"abc": "X:1\nM:4/4\nL:1/8\nK:C\n...", "key": "C major", "meter": "4/4", "bars": 8,
 "rules": ["bars","range","key","cadence","half-cadence","leaps","stepwise","augmented","parallels","rhythm"],
 "range": [55, 76]}
```

| Field | Meaning |
|---|---|
| `abc` | 1 voice (melody) or 2 voices (`V:1` melody, `V:2` bass). Required. |
| `key` | `C major`, `F# minor`, `Bb major`, `E-flat minor`, `Am`. Default `C major`. |
| `meter` | `4/4`, `3/4`, `6/8`, ... Default `4/4`. The bar grid always uses this, even if the ABC's `M:` says otherwise. |
| `bars` | Requested bar count. Optional. |
| `rules` | Rule ids to run, in output order. Default: all ten. Unknown ids come back as `{"pass": false, "score": 0, "detail": "unknown rule"}`. |
| `range` | Optional `[low, high]` MIDI range the melody must stay inside. |

Response:

```json
{"ok": true, "music21": "10.5.2",
 "parsed": {"voices": 2, "notes": 27, "bars": 8, "key_detected": "C major", "meter": "4/4"},
 "checks": [{"id": "cadence", "pass": true, "score": 1.0, "weight": 2,
             "detail": "ends 2-1 on the tonic C; bass V-I (bar 8)", "bars": [8]}],
 "score": 1.0}
```

or `{"ok": false, "error": "could not parse ABC: ..."}`.

- `parsed.notes` counts melody notes (after merging ties). `parsed.bars` is the
  complete-bar count used by the `bars` rule. `parsed.meter` is the ABC's `M:`
  if written, else the requested meter. `key_detected` is music21's
  Krumhansl-style `analyze("key")` over all voices, or `null` if it fails.
- `warnings` (top level, only when non-empty): note tokens music21 could not
  read and silently turned into C, e.g. `"unreadable note '^2' read as C"`.
- A check that crashes internally returns `pass: false, score: 0`, a detail
  starting `internal error in check:` and an extra `trace` field; the other
  checks still run.

## Rules

| id | weight | Passes when | Score |
|---|---|---|---|
| `bars` | 1 | complete bars == `bars`. A pickup plus a matching short last bar count as one bar. | `1 - abs(have - want) / want` |
| `rhythm` | 1 | every written bar holds exactly one bar of the requested meter; a short first bar is a pickup, and a short last bar is fine only if it completes the pickup. All voices are checked. Without bar lines only the final grid bar can be wrong. | `1 - bad bars / bars` |
| `range` | 1 | melody span <= 16 semitones (a 10th) and, if `range` given, every note inside it | span part `1 - (span-16)/12`; averaged with fraction of notes in range |
| `key` | 1 | >= 90% of melody notes are in the key. Minor admits the natural, harmonic and melodic forms (raised 6th and 7th). | fraction in key |
| `cadence` | 2 | score >= 0.75 | last note tonic approached by step from 2 or 7: 1.0; tonic otherwise: 0.8; 3rd or 5th: 0.5; else 0. Two voices: x0.75 if the bass ends on the tonic but not from 5, x0.5 if it does not end on the tonic. A repeated final note looks past the repeat. |
| `half-cadence` | 1 | last melody note of the antecedent's last bar is degree 2, 5 or 7: bar 4 of 8 (`bars/2`); bars 4 and 12 of 16 (bar 8 of 16 is not graded: a half cadence in a double period, a full close when two periods stand side by side). Fewer than 8 bars: pass, not applicable. | share of checked bars that pass |
| `leaps` | 1 | no leap over 12 semitones; every leap of 8+ semitones (a 6th or more) is followed by a step (1-2 semitones) the other way | `1 - violations / leaps` |
| `stepwise` | 1 | >= 50% of moves (repeated notes excluded) are 1-2 semitones | `fraction / 0.5`, capped at 1 |
| `augmented` | 1 | no augmented melodic interval (A2, A4, A5, ... but not A1) and no diminished one, except a d5 followed by a step back inward | `1 - 1/3 per violation` |
| `parallels` | 2 | two voices: no two consecutive vertical pairs that are both perfect 5ths or both octaves/unisons (mod 12, so a 12th counts as a 5th) when both voices move. Contrary-motion "consecutive" 5ths/8ves are flagged too. One voice: pass, "single voice: not applicable". | `1 - 1/3 per violation` |

Vertical pairs for `parallels` are taken at every onset in either voice where
both voices sound; a held or repeated note in either voice is oblique motion
and never flagged.

## Install and run

Requires `uv`. Python >= 3.12; tested on 3.13.15 (what uv picks on this box,
its managed interpreter) and 3.14.9. music21 10.5.2.

On archserver the root disk is full, so the environment and cache live on
`/mnt/offload`. Every uv command needs:

```bash
export UV_PROJECT_ENVIRONMENT=/mnt/offload/music-trainer/worker-venv
export UV_CACHE_DIR=/mnt/offload/music-trainer/uv-cache
```

```bash
cd worker
uv sync --frozen            # create / update the venv from uv.lock
uv run --frozen pytest -q   # 66 tests, ~1.5 s
```

How the app calls it (any working directory):

```bash
UV_PROJECT_ENVIRONMENT=/mnt/offload/music-trainer/worker-venv \
UV_CACHE_DIR=/mnt/offload/music-trainer/uv-cache \
uv run --project /home/bodas/data/music-trainer/worker --frozen python -m mtworker check < request.json
```

Measured on archserver (Ryzen 5 5600), 2026-11-10:

| What | Number |
|---|---|
| venv size | 268 MB (music21 alone 113 MB) |
| uv cache | 150 MB |
| `import music21`, warm | 0.2-0.3 s (about 1.3 s the very first time, while bytecode compiles) |
| one 8-bar, 2-voice check in-process | 90 ms first, 39 ms warm |
| full subprocess round trip via `uv run` | 0.23-0.24 s; calling `worker-venv/bin/python` directly saves ~0.01 s |

music21 wrote nothing to `~` (no `~/.music21rc`, no `~/.cache/music21`) or
`/tmp/music21` during the test suite and CLI runs. It only writes settings when
asked to save them, and the parse uses `forceSource=True`, so no pickle cache.

## Limitations

- **One answer per piece, not a teacher.** Rules are the textbook common-practice
  ones from the project spec; a good pop melody can fail `stepwise` or
  `half-cadence` on purpose. The LLM rubric is meant to weigh that.
- **Repeats are not expanded.** `|: ... :|` is read once, so `bars` counts the
  written bars, not the played ones.
- **Rests do not break the melodic line.** Leaps, steps and augmented intervals
  are measured note to note across rests, so a leap across a phrase-break rest
  still needs its gap fill.
- **Bar numbers follow the meter grid**, not the written bar lines. When the
  rhythm check fails, later bar numbers in other checks can be off from what
  the learner wrote by the size of the error.
- **Pickup detection is "the first written bar is short".** A first bar that is
  short by mistake is taken as a pickup. Without any bar lines there is never a
  pickup.
- **Respelling assumes the requested key.** A note that is in the key is
  respelled to the key's spelling before intervals are named; a deliberate
  chromatic spelling that is enharmonic to a scale note (G# as a chromatic
  passing note in C minor) is read as the scale note (Ab).
- **Harmony is not analysed.** The bass is only used for the final cadence and
  for parallels; there is no chord labelling, no check for hidden (direct)
  5ths/8ves, voice crossing or spacing.
- **More than two voices**: the middle ones are ignored.
- **music21 guesses on garbage.** Tokens it cannot read become C (reported in
  `warnings`); other malformed input gives `ok: false` with music21's own
  error text, which is not always friendly ("invalid literal for int()").
  A fuzz run of 400 random mutations of a valid tune gave 318 `ok: true`,
  82 `ok: false`, 0 crashes and 0 internal check errors.
- **`key_detected` is a statistical guess** and is often wrong on 2-4 bar
  fragments (a 6-note C minor fragment came back as F minor). It is reported,
  not scored.
