import { z } from "zod";

// Content is data. Every musical fact a lesson asserts must be either generated
// by the theory library or carry a `checks` entry that the test suite verifies.

export const Loc = z.object({ en: z.string().min(1), sr: z.string().min(1) });
export type Loc = z.infer<typeof Loc>;

const NoteS = z.string().regex(/^[A-G](##|#|bb|b)?-?\d$/, "note with octave, e.g. F#4");
const PcS = z.string().regex(/^[A-G](##|#|bb|b)?$/, "pitch name without octave, e.g. Bb");
const Track = z.enum(["T", "E", "K", "V", "C", "L"]);
export type Track = z.infer<typeof Track>;

const ScaleType = z.enum(["major", "natural-minor", "harmonic-minor", "melodic-minor", "major-pentatonic", "minor-pentatonic"]);
const ChordQ = z.enum(["maj", "min", "dim", "aug", "maj7", "7", "min7", "m7b5", "dim7"]);
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
  z.object({ chord: z.object({ notes: z.array(NoteS).min(3), root: PcS, quality: ChordQ, inversion: z.number().int().default(0) }) }),
  z.object({ scale: z.object({ tonic: PcS, type: ScaleType, is: z.array(PcS) }) }),
  z.object({ keysig: z.object({ key: PcS, mode: Mode.default("major"), is: z.number().int() }) }),
  z.object({ roman: z.object({ key: PcS, type: ScaleType.default("major"), degree: z.number().int().min(1).max(7), is: z.string() }) }),
  z.object({ semitones: z.object({ from: NoteS, to: NoteS, is: z.number().int() }) }),
]);
export type Check = z.infer<typeof Check>;

export const Playback = z.object({
  notes: z.array(NoteS).optional(),
  chords: z.array(z.array(NoteS)).optional(),
  derive: Derive.optional(),
  mode: z.enum(["melodic", "harmonic", "chords"]).default("melodic"),
  tempo: z.number().min(20).max(240).default(80),
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

export const Mcq = z.object({ ...Base, type: z.literal("mcq"), options: z.array(Option).min(2), answer: z.number().int().min(0), play: Playback.optional() });

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
  showNotes: z.boolean().default(true),
};
export const MidiPlay = z.object({ ...Base, type: z.literal("midi-play"), ...MidiCommon });
export const MidiEcho = z.object({ ...Base, type: z.literal("midi-echo"), ...MidiCommon, play: Playback.optional(), showNotes: z.boolean().default(false) });

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
  z.object({ kind: z.literal("roman"), keys: z.array(PcS).min(1), type: ScaleType.default("major"), degrees: z.array(z.number().int().min(1).max(7)).optional(), ask: z.enum(["numeral", "play", "name"]).default("numeral") }),
  z.object({ kind: z.literal("progression"), keys: z.array(PcS).min(1), type: ScaleType.default("major"), numerals: z.array(z.string()).min(2), tempo: z.number().optional(), octave: z.enum(["exact", "any"]).default("any"), echo: z.boolean().default(false) }),
  z.object({ kind: z.literal("melody-echo"), tonics: z.array(PcS).min(1), type: ScaleType.default("major"), length: z.tuple([z.number().int().min(1), z.number().int().min(1)]), degrees: z.array(z.number().int().min(1).max(8)).optional(), maxLeap: z.number().int().min(1).max(8).default(2), startOnTonic: z.boolean().default(true), octave: z.number().int().default(4), tempo: z.number().default(80) }),
  z.object({ kind: z.literal("degree-ear"), tonics: z.array(PcS).min(1), type: ScaleType.default("major"), degrees: z.array(z.number().int().min(1).max(8)).min(2), answer: z.enum(["choose", "play"]).default("choose"), octave: z.number().int().default(4) }),
  z.object({ kind: z.literal("bass-echo"), keys: z.array(PcS).min(1), type: ScaleType.default("major"), numerals: z.array(z.string()).min(2), length: z.number().int().min(2).max(8).default(4), octave: z.number().int().default(2), tempo: z.number().default(70) }),
]);
export type Gen = z.infer<typeof Gen>;

export const Generated = z.object({ ...Base, type: z.literal("generated"), count: z.number().int().min(1).max(30).default(5), gen: Gen });

export const Exercise = z.discriminatedUnion("type", [Mcq, NotationInput, MidiPlay, MidiEcho, Practice, Generated]);
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
