import { z } from "zod";

// Content is data. Every musical fact a lesson asserts must be either generated
// by the theory library or carry a `checks` entry that the test suite verifies.

export const Loc = z.object({ en: z.string().min(1), sr: z.string().min(1) });
export type Loc = z.infer<typeof Loc>;

const NoteS = z.string().regex(/^[A-G](##|#|bb|b)?-?\d$/, "note with octave, e.g. F#4");
const PcS = z.string().regex(/^[A-G](##|#|bb|b)?$/, "pitch name without octave, e.g. Bb");
const Track = z.enum(["T", "E", "K", "V", "C", "L"]);
export type Track = z.infer<typeof Track>;

const ScaleType = z.enum(["major", "natural-minor", "harmonic-minor", "melodic-minor", "major-pentatonic", "minor-pentatonic", "blues", "dorian", "phrygian", "lydian", "mixolydian", "locrian"]);
const ChordQ = z.enum(["maj", "min", "dim", "aug", "maj7", "7", "min7", "m7b5", "dim7", "minmaj7", "augmaj7", "9", "maj9", "min9", "sus4", "sus2", "7sus4", "6", "min6"]);
const IvS = z.string().regex(/^(dd|d|m|M|P|A|AA)\d+$/);
const Mode = z.enum(["major", "minor"]);

/** Notes computed from theory instead of typed by hand. */
export const Derive = z.union([
  z.object({ chord: z.object({ root: NoteS, quality: ChordQ, inversion: z.number().int().min(0).max(3).default(0) }) }),
  z.object({ scale: z.object({ tonic: NoteS, type: ScaleType, octave: z.boolean().default(true), descending: z.boolean().default(false) }) }),
  z.object({ interval: z.object({ from: NoteS, iv: IvS, down: z.boolean().default(false) }) }),
  z.object({ roman: z.object({ key: NoteS, type: ScaleType.default("major"), numerals: z.array(z.string()).min(1) }) }),
]);
export type Derive = z.infer<typeof Derive>;

/** Assertions about static content, executed by tests/curriculum.test.ts. */
export const Check = z.union([
  z.object({ interval: z.object({ from: NoteS, to: NoteS, is: IvS }) }),
  z.object({ chord: z.object({ notes: z.array(NoteS).min(2), root: PcS, quality: ChordQ, inversion: z.number().int().default(0) }) }),
  z.object({ scale: z.object({ tonic: PcS, type: ScaleType, is: z.array(PcS) }) }),
  z.object({ keysig: z.object({ key: PcS, mode: Mode.default("major"), is: z.number().int() }) }),
  z.object({ roman: z.object({ key: PcS, type: ScaleType.default("major"), degree: z.number().int().min(1).max(7), is: z.string(), seventh: z.boolean().default(false) }) }),
  z.object({ semitones: z.object({ from: NoteS, to: NoteS, is: z.number().int() }) }),
  // Serbian only: vowels + syllabic r is reliable; English syllables need a dictionary
  z.object({ syllables: z.object({ text: z.string().min(1), lang: z.literal("sr"), is: z.number().int().min(1) }) }),
]);
export type Check = z.infer<typeof Check>;

export const Playback = z.object({
  notes: z.array(NoteS).optional(),
  chords: z.array(z.array(NoteS)).optional(),
  derive: Derive.optional(),
  mode: z.enum(["melodic", "harmonic", "chords"]).default("melodic"),
  tempo: z.number().min(20).max(240).default(80),
  durations: z.array(z.number().positive()).optional(), // beats per note/chord (real rhythm)
});
export type Playback = z.infer<typeof Playback>;

const Base = {
  id: z.string().regex(/^[A-Z]-\d{3}-\d+$/),
  prompt: Loc,
  pass: z.number().min(0).max(1).default(0.8),
  checks: z.array(Check).default([]),
  abc: z.string().optional(), // ABC notation fragment shown above the prompt
};

const Option = z.union([Loc, z.string()]); // plain string = language-neutral (e.g. "Bb", "V7")

// options are shuffled per seed (fixed for a given attempt); keepOrder for ordered option lists
export const Mcq = z.object({ ...Base, type: z.literal("mcq"), options: z.array(Option).min(2), answer: z.number().int().min(0), play: Playback.optional(), keepOrder: z.boolean().default(false) });

export const NotationInput = z.object({
  ...Base,
  type: z.literal("notation-input"),
  expect: z.array(PcS).optional(), // spelled pitch names; spelling is graded strictly
  derive: Derive.optional(),
  ordered: z.boolean().default(true),
});

const MidiCommon = {
  expect: z.array(NoteS).optional(),
  expectChords: z.array(z.array(NoteS)).optional(),
  derive: Derive.optional(),
  mode: z.enum(["chord", "sequence", "chords"]),
  octave: z.enum(["exact", "any"]).default("exact"),
  bass: z.boolean().default(false), // in octave:any chord mode, also require the right bass note
  tempo: z.number().min(20).max(240).optional(), // if set, timing is graded
  beats: z.array(z.number().positive()).optional(), // sequence: duration of each note in beats (real rhythm for playback + timing)
  showNotes: z.boolean().default(true),
};
export const MidiPlay = z.object({ ...Base, type: z.literal("midi-play"), ...MidiCommon });
export const MidiEcho = z.object({ ...Base, type: z.literal("midi-echo"), ...MidiCommon, play: Playback.optional(), showNotes: z.boolean().default(false) });

// ---------- voice ----------
// Sung pitches are graded from voice-score metrics (server, or the browser fallback).
// Octave-agnostic by default: a note sung an octave away from the written one counts,
// so content works for any voice type before the learner's range is known.
const SingCommon = {
  tolerance: z.number().min(10).max(200).default(50), // cents; full credit inside, zero at 3x
  octaveAgnostic: z.boolean().default(true),
  reference: z.boolean().default(true), // play the target(s) before recording
  // move written notes into the stored comfortable range by octaves: true = centred,
  // "low"/"high" = towards that end (chest / head-voice work), false = as written
  fitRange: z.union([z.boolean(), z.enum(["low", "high"])]).default(true),
};
export const SingPitch = z.object({ ...Base, type: z.literal("sing-pitch"), ...SingCommon, notes: z.array(NoteS).min(1), sustain: z.number().min(0).max(15).default(2) });
export const SingPhrase = z.object({ ...Base, type: z.literal("sing-phrase"), ...SingCommon, notes: z.array(z.union([NoteS, z.literal("r")])).optional() /* "r" = rest */, derive: Derive.optional(), accompany: Playback.optional() /* reference played instead of the targets (e.g. the melody to harmonize); sung alone afterwards: the mic would hear simultaneous playback */, beats: z.array(z.number().positive()).optional(), tempo: z.number().min(30).max(200).default(72) });
/** Records a low glide and a high glide; stores the learner's range. */
export const VoiceRange = z.object({ ...Base, type: z.literal("voice-range") });
/** Fatigue/hoarseness check-in. Anything but "fine" ends voice work for the day. */
export const Checkin = z.object({ ...Base, type: z.literal("checkin") });

// ---------- composition / writing exercises (C and L tracks) ----------
/** Write a short passage in ABC (recorded on the piano or typed); graded by the music21 worker's rule checks. */
export const Compose = z.object({
  ...Base,
  type: z.literal("compose"),
  key: z.string().regex(/^[A-G](#|b)? (major|minor)$/),
  meter: z.string().regex(/^\d+\/\d+$/),
  bars: z.number().int().min(1).max(32),
  rules: z.array(z.enum(["bars", "range", "key", "cadence", "half-cadence", "leaps", "stepwise", "augmented", "parallels", "rhythm"])).min(1),
  given: z.string().optional(), // ABC shown as the starting point (e.g. the question phrase)
  range: z.tuple([NoteS, NoteS]).optional(),
  voices: z.number().int().min(1).max(2).default(1),
  // a model answer: tests run it through the real music21 worker and require it to pass,
  // so an exercise whose rules cannot all be satisfied is caught before it ships
  example: z.string().optional(),
});
/** Write text (lyrics); graded by the learner's own rubric rating; AI feedback is optional and never blocks. */
export const Write = z.object({
  ...Base,
  type: z.literal("write"),
  language: z.enum(["en", "sr", "either"]).default("either"),
  lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
  rubric: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]*$/), label: Loc, weight: z.number().positive().default(1), top: Loc })).min(1),
});

/** Self-reported activity (warm-ups, practice routines). Scored by the learner. */
export const Practice = z.object({ ...Base, type: z.literal("practice"), minutes: z.number().min(0.5).max(30).default(3), play: Playback.optional() });

// ---------- generators ----------
const Range = z.tuple([NoteS, NoteS]);
export const Gen = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note-read"), clef: z.enum(["treble", "bass", "both"]).default("treble"), range: Range.optional(), accidentals: z.boolean().default(false), answer: z.enum(["name", "play"]).default("name") }),
  z.object({ kind: z.literal("interval-name"), intervals: z.array(IvS).min(1), roots: z.array(NoteS).optional(), range: Range.optional(), show: z.enum(["staff", "names", "both"]).default("both") }),
  z.object({ kind: z.literal("interval-build"), intervals: z.array(IvS).min(1), roots: z.array(NoteS).optional(), range: Range.optional(), down: z.boolean().default(false), answer: z.enum(["name", "play"]).default("name") }),
  z.object({ kind: z.literal("interval-ear"), intervals: z.array(IvS).min(2), range: Range.optional(), direction: z.enum(["up", "down", "harmonic", "mixed"]).default("up"), answer: z.enum(["choose", "play"]).default("choose") }),
  z.object({ kind: z.literal("semitones"), maxSemitones: z.number().int().min(1).max(12).default(12), range: Range.optional() }),
  z.object({ kind: z.literal("chord-ear"), qualities: z.array(ChordQ).min(2), inversions: z.array(z.number().int().min(0).max(3)).default([0]), range: Range.optional(), answer: z.enum(["choose", "play"]).default("choose") }),
  z.object({ kind: z.literal("chord-build"), qualities: z.array(ChordQ).min(1), roots: z.array(PcS).optional(), inversions: z.array(z.number().int().min(0).max(3)).default([0]), answer: z.enum(["name", "play"]).default("play") }),
  z.object({ kind: z.literal("chord-name"), qualities: z.array(ChordQ).min(2), roots: z.array(PcS).optional(), inversions: z.array(z.number().int().min(0).max(3)).default([0]) }),
  z.object({ kind: z.literal("scale-build"), types: z.array(ScaleType).min(1), tonics: z.array(PcS).min(1), answer: z.enum(["name", "play"]).default("play"), tempo: z.number().optional(), descending: z.boolean().default(false) }),
  z.object({ kind: z.literal("keysig"), keys: z.array(PcS).min(2), mode: Mode.default("major"), ask: z.enum(["count", "key", "relative"]).default("count") }),
  z.object({ kind: z.literal("roman"), keys: z.array(PcS).min(1), type: ScaleType.default("major"), degrees: z.array(z.number().int().min(1).max(7)).optional(), ask: z.enum(["numeral", "play", "name"]).default("numeral"), seventh: z.boolean().default(false) }),
  // tap back a rhythm heard on one pitch; pitch is ignored, timing is graded
  // values: single durations placed freely; cells: groups placed whole (keeps eighth pairs together, allows triplets [1/3,1/3,1/3])
  z.object({ kind: z.literal("rhythm-echo"), meter: z.string().regex(/^\d+\/\d+$/).default("4/4"), bars: z.number().int().min(1).max(4).default(1), values: z.array(z.number().positive()).default([]), cells: z.array(z.array(z.number().positive()).min(1)).optional(), tempo: z.number().min(40).max(160).default(80), showAbc: z.boolean().default(true) }),
  // hear a progression, pick which one it was
  z.object({ kind: z.literal("progression-ear"), keys: z.array(PcS).min(1), type: ScaleType.default("major"), options: z.array(z.array(z.string()).min(2)).min(2), tempo: z.number().default(60) }),
  // improvise over a looping backing progression; graded on scale use, chord tones on downbeats, activity
  z.object({ kind: z.literal("improv"), keys: z.array(PcS).min(1), type: ScaleType.default("major"), scale: ScaleType, numerals: z.array(z.string()).min(1), beatsPerChord: z.number().int().min(1).max(8).default(4), loops: z.number().int().min(1).max(8).default(2), tempo: z.number().min(40).max(200).default(80) }),
  // smooth: bass on the root, upper three voices moved to the nearest chord tones (voice leading)
  z.object({ kind: z.literal("progression"), keys: z.array(PcS).min(1), type: ScaleType.default("major"), numerals: z.array(z.string()).min(2), tempo: z.number().optional(), octave: z.enum(["exact", "any"]).default("any"), echo: z.boolean().default(false), smooth: z.boolean().default(false) }),
  z.object({ kind: z.literal("melody-echo"), tonics: z.array(PcS).min(1), type: ScaleType.default("major"), length: z.tuple([z.number().int().min(1), z.number().int().min(1)]), degrees: z.array(z.number().int().min(1).max(8)).optional(), maxLeap: z.number().int().min(1).max(8).default(2), startOnTonic: z.boolean().default(true), octave: z.number().int().default(4), tempo: z.number().default(80) }),
  z.object({ kind: z.literal("degree-ear"), tonics: z.array(PcS).min(1), type: ScaleType.default("major"), degrees: z.array(z.number().int().min(1).max(8)).min(2), answer: z.enum(["choose", "play"]).default("choose"), octave: z.number().int().default(4) }),
  z.object({ kind: z.literal("pitch-match"), range: Range.optional(), sustain: z.number().min(0).max(10).default(2), tolerance: z.number().min(10).max(200).default(50), intervals: z.array(IvS).optional() }),
  z.object({ kind: z.literal("phrase-sing"), tonics: z.array(PcS).min(1), type: ScaleType.default("major"), length: z.tuple([z.number().int().min(2), z.number().int().min(2)]), degrees: z.array(z.number().int().min(1).max(8)).optional(), maxLeap: z.number().int().min(1).max(8).default(2), tempo: z.number().default(72), tolerance: z.number().min(10).max(200).default(50) }),
  z.object({ kind: z.literal("bass-echo"), keys: z.array(PcS).min(1), type: ScaleType.default("major"), numerals: z.array(z.string()).min(2), length: z.number().int().min(2).max(8).default(4), octave: z.number().int().default(2), tempo: z.number().default(70), line: z.array(z.string()).optional() }),
]);
export type Gen = z.infer<typeof Gen>;

export const Generated = z.object({ ...Base, type: z.literal("generated"), count: z.number().int().min(1).max(30).default(5), gen: Gen });

export const Exercise = z.discriminatedUnion("type", [Mcq, NotationInput, MidiPlay, MidiEcho, Practice, Generated, SingPitch, SingPhrase, VoiceRange, Checkin, Compose, Write]);
export type Exercise = z.infer<typeof Exercise>;

export const Lesson = z.object({
  id: z.string().regex(/^[TEKVCL]-\d{3}$/),
  track: Track,
  order: z.number().int(), // position within the track
  title: Loc,
  prereqs: z.array(z.string()).default([]),
  minutes: z.number().int().min(1).max(60),
  tags: z.array(z.string()).default([]),
  explain: Loc, // markdown; ```abc fenced blocks are rendered as notation
  exercises: z.array(Exercise).min(1),
});
export type Lesson = z.infer<typeof Lesson>;

export const PlacementSection = z.object({
  id: z.string(),
  title: Loc,
  intro: Loc,
  exercises: z.array(Exercise.and(z.object({ skips: z.array(z.string()).default([]) }))),
});
export const Placement = z.object({ sections: z.array(PlacementSection).min(1) });
export type Placement = z.infer<typeof Placement>;

// ---------- weekly projects (M3) ----------
// One project per week, rotating composition / lyrics / vocal piece / play a song by ear.
// Rubric criteria are scored 0..4 (by the claude -p reviewer, or by the learner when the
// reviewer is unavailable); deterministic parts (music21 rules, MIDI/voice metrics) are
// graded separately and combined with the rubric by `weights`.

export const Criterion = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: Loc,
  weight: z.number().positive(),
  top: Loc, // what a 4/4 looks like, concretely
});
export type Criterion = z.infer<typeof Criterion>;

const ProjectBase = {
  id: z.string().regex(/^P[CLVE]-\d{3}$/),
  order: z.number().int(),
  title: Loc,
  brief: Loc, // markdown, may embed ```abc
  minutes: z.number().int().min(10).max(240),
  prereqs: z.array(z.string()).default([]), // soft: lessons that should come first
  rubric: z.array(Criterion).min(2),
};

/** A melody given as data (vocal piece, by-ear song). Public-domain tunes only. */
export const Melody = z.object({
  title: Loc,
  source: z.string(), // provenance / public-domain note
  key: z.string(), // e.g. "D major"
  meter: z.string().regex(/^\d+\/\d+$/),
  tempo: z.number().min(30).max(200),
  notes: z.array(z.union([NoteS, z.literal("r")])).min(4), // "r" = rest
  beats: z.array(z.number().positive()), // one per entry in notes
  pickup: z.number().min(0).default(0), // beats before the first bar line
});
export type Melody = z.infer<typeof Melody>;

export const RULE_IDS = ["bars", "range", "key", "cadence", "half-cadence", "leaps", "stepwise", "augmented", "parallels", "rhythm"] as const;

export const Project = z.discriminatedUnion("kind", [
  z.object({
    ...ProjectBase,
    kind: z.literal("composition"),
    composition: z.object({
      key: z.string(), // "C major" | "A minor"
      meter: z.string().regex(/^\d+\/\d+$/),
      bars: z.number().int().min(2).max(64),
      rules: z.array(z.enum(RULE_IDS)).min(1),
      range: z.tuple([NoteS, NoteS]).optional(), // singable range for the melody
      chords: z.array(z.string()).optional(), // given progression (roman numerals), one per bar
      voices: z.number().int().min(1).max(2).default(1),
    }),
    weights: z.object({ rules: z.number().min(0), rubric: z.number().min(0) }).default({ rules: 0.5, rubric: 0.5 }),
  }),
  z.object({
    ...ProjectBase,
    kind: z.literal("lyrics"),
    lyrics: z.object({
      genre: Loc,
      language: z.enum(["en", "sr", "either"]).default("either"),
      lines: z.tuple([z.number().int().min(2), z.number().int().min(2)]),
      structure: Loc, // e.g. "verse (8) - chorus (4) - verse (8) - chorus (4)"
    }),
  }),
  z.object({
    ...ProjectBase,
    kind: z.literal("vocal"),
    melody: Melody,
    tolerance: z.number().min(10).max(200).default(75),
    weights: z.object({ pitch: z.number().min(0), rubric: z.number().min(0) }).default({ pitch: 0.6, rubric: 0.4 }),
  }),
  z.object({
    ...ProjectBase,
    kind: z.literal("byear"),
    melody: Melody,
    weights: z.object({ pitch: z.number().min(0), rhythm: z.number().min(0), rubric: z.number().min(0) }).default({ pitch: 0.6, rhythm: 0.2, rubric: 0.2 }),
  }),
]);
export type Project = z.infer<typeof Project>;
