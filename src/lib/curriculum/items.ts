// Turns exercise definitions (static or generator) into concrete, gradable items.
// Pure and deterministic given (exercise, seed), so the server can regenerate
// exactly what the client showed and re-grade a submission authoritatively.

import type { Exercise, Derive, Playback as PlaybackDef, Gen, Loc } from "./schema";
import { Note, parseNote, toMidi, noteStr, noteNameSr, pcName, midiToNote, LETTERS } from "../music/pitch";
import { parseInterval, transpose, intervalBetween, ivStr, intervalName } from "../music/interval";
import { scale, chord, CHORDS, ChordQuality, keySignature, relativeMinor, romanNumeral, romanChord, diatonicChord, qualityName, chordSymbol, SCALES, ScaleType } from "../music/harmony";
import { abcTune, abcChords } from "../music/abc";

export interface PlaySpec {
  mode: "melodic" | "harmonic" | "chords";
  notes?: number[]; // melodic: -1 = rest
  durations?: number[]; // melodic: beats per note (default 1 each)
  chords?: number[][];
  tempo: number;
}

interface ItemBase {
  id: string; // exerciseId#index
  exerciseId: string;
  prompt: Loc;
  abc?: string;
  play?: PlaySpec;
}
export interface McqItem extends ItemBase {
  kind: "mcq";
  options: Loc[];
  answer: number;
}
export interface NamesItem extends ItemBase {
  kind: "names";
  expect: string[]; // English pitch names, spelling strict
  ordered: boolean;
}
export interface MidiItem extends ItemBase {
  kind: "midi";
  mode: "chord" | "sequence" | "chords";
  expect: number[];
  expectChords?: number[][];
  octave: "exact" | "any";
  bass: boolean;
  tempo?: number;
  showNotes: boolean;
  noteLabels?: Loc; // human-readable expected notes, shown after answering
}
export interface PracticeItem extends ItemBase {
  kind: "practice";
  minutes: number;
}
export interface SingItem extends ItemBase {
  kind: "sing";
  targets: number[]; // MIDI notes to sing, in order
  beats?: number[]; // phrase: duration of each target in beats (with tempo)
  tempo?: number;
  sustain?: number; // pitch: seconds to hold the (last) note
  tolerance: number; // cents
  octaveAgnostic: boolean;
  noteLabels: Loc;
  // full sequence including rests (sent to voice-score, whose note indexes count rests);
  // absent = targets in order with no rests
  layout?: { midi?: number; beats: number }[];
}
export interface RangeItem extends ItemBase {
  kind: "range";
}
export interface CheckinItem extends ItemBase {
  kind: "checkin";
}
export type Item = McqItem | NamesItem | MidiItem | PracticeItem | SingItem | RangeItem | CheckinItem;

/** Learner state that shapes generated items. Stored with each submission so the server regenerates the same items. */
export interface GenCtx {
  voiceRange?: [number, number]; // comfortable range, MIDI low..high
}

/** Move a group of notes by whole octaves so it sits inside the comfortable range (best effort). */
export function fitToRange(ms: number[], range?: [number, number]): number[] {
  if (!range || !ms.length) return ms;
  const [lo, hi] = range;
  const mid = (lo + hi) / 2;
  const center = (Math.min(...ms) + Math.max(...ms)) / 2;
  let shift = Math.round((mid - center) / 12) * 12;
  // prefer a shift that keeps every note inside the range, if one exists
  for (const k of [shift, shift - 12, shift + 12]) {
    if (Math.min(...ms) + k >= lo && Math.max(...ms) + k <= hi) {
      shift = k;
      break;
    }
  }
  return ms.map((m) => m + shift);
}
const midiLabels = (ms: number[]): Loc => join(ms.map((m) => nno(midiToNote(m, false))));

// ---------- seeded RNG ----------
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export class Rng {
  private s: number;
  constructor(seed: string) {
    this.s = hash(seed) || 1;
  }
  next(): number {
    // mulberry32
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(a: readonly T[]): T {
    return a[Math.floor(this.next() * a.length)];
  }
  shuffle<T>(a: T[]): T[] {
    const b = a.slice();
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
  }
}

// ---------- helpers ----------
const L = (en: string, sr: string): Loc => ({ en, sr });
const nn = (n: Note): Loc => L(pcName(n), noteNameSr(n));
const nno = (n: Note): Loc => L(noteStr(n), noteNameSr(n, true));
const join = (ls: Loc[], sep = " "): Loc => L(ls.map((l) => l.en).join(sep), ls.map((l) => l.sr).join(sep));
const opt = (o: string | Loc): Loc => (typeof o === "string" ? L(o, o) : o);
const SCALE_NAMES: Record<ScaleType, Loc> = {
  major: L("major", "durska"),
  "natural-minor": L("natural minor", "prirodna molska"),
  "harmonic-minor": L("harmonic minor", "harmonska molska"),
  "melodic-minor": L("melodic minor (ascending)", "melodijska molska (uzlazno)"),
  "major-pentatonic": L("major pentatonic", "durska pentatonska"),
  "minor-pentatonic": L("minor pentatonic", "molska pentatonska"),
};
const ivLoc = (s: string): Loc => {
  const iv = parseInterval(s);
  return L(`${intervalName(iv, "en")} (${s})`, `${intervalName(iv, "sr")} (${s})`);
};
const qLoc = (q: ChordQuality): Loc => L(qualityName(q, "en"), qualityName(q, "sr"));
const isMinor = (t: ScaleType) => t.includes("minor");
const SR_VARIANT_LOC: Record<ScaleType, string> = { major: "", "natural-minor": "prirodnom", "harmonic-minor": "harmonskom", "melodic-minor": "melodijskom", "major-pentatonic": "(pentatonika)", "minor-pentatonic": "(pentatonika)" };
const SR_VARIANT: Record<ScaleType, string> = { major: "", "natural-minor": "prirodni", "harmonic-minor": "harmonski", "melodic-minor": "melodijski", "major-pentatonic": "pentatonika", "minor-pentatonic": "pentatonika" };
/**
 * Key/scale names. Serbian: "C-dur", "a-mol" (minor keys lower case), locative
 * "u C-duru", "u a-molu"; scale variants follow ("a-mol harmonski").
 * `variant` adds the scale variant (needed for scales, not for keys).
 */
function keyName(tonic: Note, type: ScaleType, variant = true): { nom: Loc; loc: Loc } {
  const minor = isMinor(type);
  const base = minor ? noteNameSr(tonic).toLowerCase() + "-mol" : noteNameSr(tonic) + "-dur";
  const showVar = variant && type !== "major" && (type !== "natural-minor" || variant);
  const v = showVar && SR_VARIANT[type] ? " " + SR_VARIANT[type] : "";
  const en = `${pcName(tonic)} ${type === "major" || (type === "natural-minor" && !variant) ? (minor ? "minor" : "major") : SCALE_NAMES[type].en}`;
  return { nom: L(en, base + v), loc: L(en, base + "u" + (v ? " " + SR_VARIANT_LOC[type] : "")) };
}
/** Serbian count + noun in accusative after a verb: 1 povisilicu, 2-4 povisilice, 5+ povisilica. */
function accCount(n: number, sharp: boolean): string {
  const stem = sharp ? "povisilic" : "snizilic";
  return `${n} ${stem}${n === 1 ? "u" : n <= 4 ? "e" : "a"}`;
}
const chordSr = (root: Note, q: ChordQuality) => `${noteNameSr(root)} ${qualityName(q, "sr")}${["maj", "min", "dim", "aug"].includes(q) ? " trozvuk" : ""}`;
const INV_NAMES: Loc[] = [L("root position", "osnovni položaj"), L("1st inversion", "1. obrtaj (sekstakord)"), L("2nd inversion", "2. obrtaj (kvartsekstakord)"), L("3rd inversion", "3. obrtaj")];

export function derive(d: Derive): Note[][] {
  if ("chord" in d) return [chord(d.chord.root, d.chord.quality, d.chord.inversion)];
  if ("scale" in d) {
    const s = scale(d.scale.tonic, d.scale.type, d.scale.octave);
    return [d.scale.descending ? s.reverse() : s];
  }
  if ("interval" in d) {
    const a = parseNote(d.interval.from);
    return [[a, transpose(a, d.interval.iv, d.interval.down)]];
  }
  return d.roman.numerals.map((r) => romanChord(d.roman.key, d.roman.type, r));
}

function playSpec(p: PlaybackDef | undefined): PlaySpec | undefined {
  if (!p) return undefined;
  if (p.chords) return { mode: "chords", chords: p.chords.map((c) => c.map((n) => toMidi(parseNote(n)))), tempo: p.tempo };
  if (p.derive) {
    const d = derive(p.derive);
    if ("roman" in p.derive) return { mode: "chords", chords: d.map((c) => c.map(toMidi)), tempo: p.tempo };
    return { mode: p.mode, notes: d[0].map(toMidi), tempo: p.tempo };
  }
  return { mode: p.mode, notes: (p.notes ?? []).map((n) => toMidi(parseNote(n))), tempo: p.tempo };
}

function inRange(n: Note, range?: [string, string]): boolean {
  if (!range) return true;
  const m = toMidi(n);
  return m >= toMidi(parseNote(range[0])) && m <= toMidi(parseNote(range[1]));
}

/** Random natural/accidental note within range. Avoids double accidentals and E#/B#/Cb/Fb. */
function randomNote(rng: Rng, range: [string, string], accidentals = true): Note {
  const lo = toMidi(parseNote(range[0]));
  const hi = toMidi(parseNote(range[1]));
  for (let i = 0; i < 100; i++) {
    const m = rng.int(lo, hi);
    const n = midiToNote(m, rng.next() < 0.5);
    if (!accidentals && n.acc !== 0) continue;
    return n;
  }
  return midiToNote(lo);
}

/** Distinct multiple-choice options with the correct one included, shuffled. */
function mcq(rng: Rng, correct: string, pool: string[], k = 4): { options: string[]; answer: number } {
  const others = rng.shuffle(pool.filter((p) => p !== correct)).slice(0, k - 1);
  const options = rng.shuffle([correct, ...others]);
  return { options, answer: options.indexOf(correct) };
}

// ---------- static exercises ----------
function staticItem(ex: Exclude<Exercise, { type: "generated" }>, ctx: GenCtx = {}): Item {
  const base = { id: `${ex.id}#0`, exerciseId: ex.id, prompt: ex.prompt, abc: ex.abc };
  switch (ex.type) {
    case "mcq":
      return { ...base, kind: "mcq", options: ex.options.map(opt), answer: ex.answer, play: playSpec(ex.play) };
    case "notation-input": {
      const expect = ex.expect ?? derive(ex.derive!)[0].map((n) => pcName(n));
      return { ...base, kind: "names", expect, ordered: ex.ordered };
    }
    case "midi-play":
    case "midi-echo": {
      let expect: number[] = [];
      let expectChords: number[][] | undefined;
      let labels: Loc | undefined;
      if (ex.mode === "chords") {
        const cs = ex.expectChords ? ex.expectChords.map((c) => c.map((n) => parseNote(n))) : derive(ex.derive!);
        expectChords = cs.map((c) => c.map(toMidi));
        labels = join(cs.map((c) => join(c.map(nn), "-")), " | ");
      } else {
        const ns = ex.expect ? ex.expect.map((n) => parseNote(n)) : derive(ex.derive!)[0];
        expect = ns.map(toMidi);
        labels = join(ns.map(nno));
      }
      let play: PlaySpec | undefined = ex.type === "midi-echo" ? playSpec(ex.play) : undefined;
      if (ex.type === "midi-echo" && !play)
        play = expectChords ? { mode: "chords", chords: expectChords, tempo: ex.tempo ?? 60 } : { mode: ex.mode === "chord" ? "harmonic" : "melodic", notes: expect, tempo: ex.tempo ?? 80 };
      return { ...base, kind: "midi", mode: ex.mode, expect, expectChords, octave: ex.octave, bass: ex.bass, tempo: ex.tempo, showNotes: ex.showNotes, noteLabels: labels, play };
    }
    case "practice":
      return { ...base, kind: "practice", minutes: ex.minutes, play: playSpec(ex.play) };
    case "sing-pitch": {
      const ms = ex.fitRange ? fitToRange(ex.notes.map((n) => toMidi(parseNote(n))), ctx.voiceRange) : ex.notes.map((n) => toMidi(parseNote(n)));
      return { ...base, kind: "sing", targets: ms, sustain: ex.sustain, tolerance: ex.tolerance, octaveAgnostic: ex.octaveAgnostic, noteLabels: midiLabels(ms), play: ex.reference ? { mode: "melodic", notes: ms, tempo: 50 } : undefined };
    }
    case "sing-phrase": {
      const raw = ex.notes ? ex.notes.map((n) => toMidi(parseNote(n))) : derive(ex.derive!)[0].map(toMidi);
      const ms = ex.fitRange ? fitToRange(raw, ctx.voiceRange) : raw;
      const beats = ex.beats ?? ms.map(() => 1);
      return { ...base, kind: "sing", targets: ms, beats, tempo: ex.tempo, tolerance: ex.tolerance, octaveAgnostic: ex.octaveAgnostic, noteLabels: midiLabels(ms), play: ex.reference ? { mode: "melodic", notes: ms, tempo: ex.tempo } : undefined };
    }
    case "voice-range":
      return { ...base, kind: "range" };
    case "checkin":
      return { ...base, kind: "checkin" };
  }
}

// ---------- generators ----------
function genItem(ex: Extract<Exercise, { type: "generated" }>, g: Gen, rng: Rng, idx: number, ctx: GenCtx = {}): Item {
  const id = `${ex.id}#${idx}`;
  const base = { id, exerciseId: ex.id };
  switch (g.kind) {
    case "note-read": {
      const clef = g.clef === "both" ? rng.pick(["treble", "bass"] as const) : g.clef;
      const range = (g.range ?? (clef === "treble" ? ["C4", "A5"] : ["E2", "C4"])) as [string, string];
      const n = randomNote(rng, range, g.accidentals);
      const abc = abcTune([n], { clef });
      if (g.answer === "play")
        return { ...base, kind: "midi", mode: "sequence", expect: [toMidi(n)], octave: "exact", bass: false, showNotes: false, prompt: L("Play this note (right octave).", "Odsviraj ovu notu (u pravoj oktavi)."), abc, noteLabels: nno(n) };
      const pool = LETTERS.map((l) => l as string);
      const correct = pcName(n);
      const accPool = g.accidentals ? [correct, ...rng.shuffle(["C#", "Db", "F#", "Gb", "Bb", "A#", "Eb", "D#", "Ab", "G#"])] : pool;
      const { options, answer } = mcq(rng, correct, [...new Set([...accPool, ...pool])]);
      return { ...base, kind: "mcq", prompt: L("Name this note.", "Kako se zove ova nota?"), abc, options: options.map((o) => nn(parseNote(o))), answer };
    }
    case "interval-name": {
      const ivs = g.intervals;
      for (let t = 0; t < 200; t++) {
        const iv = rng.pick(ivs);
        const root = g.roots ? parseNote(rng.pick(g.roots)) : randomNote(rng, (g.range ?? ["C4", "C5"]) as [string, string]);
        let top: Note;
        try {
          top = transpose(root, iv);
        } catch {
          continue;
        }
        if (Math.abs(top.acc) > 1) continue;
        const { options, answer } = mcq(rng, iv, [...new Set([...ivs, "m2", "M2", "m3", "M3", "P4", "A4", "P5", "m6", "M6", "m7", "M7", "P8"])]);
        const prompt =
          g.show === "staff" ? L("Name the interval.", "Koji je ovo interval?") : L(`Name the interval ${pcName(root)} → ${pcName(top)} (upward).`, `Koji je interval ${noteNameSr(root)} → ${noteNameSr(top)} (naviše)?`);
        return { ...base, kind: "mcq", prompt, abc: g.show === "names" ? undefined : abcTune([root, top], { len: "1/2" }), options: options.map(ivLoc), answer };
      }
      throw new Error(`interval-name: could not generate for ${ex.id}`);
    }
    case "interval-build": {
      for (let t = 0; t < 200; t++) {
        const iv = rng.pick(g.intervals);
        const root = g.roots ? parseNote(rng.pick(g.roots)) : randomNote(rng, (g.range ?? ["C4", "C5"]) as [string, string]);
        let top: Note;
        try {
          top = transpose(root, iv, g.down);
        } catch {
          continue;
        }
        if (Math.abs(top.acc) > 1) continue;
        const dir = g.down ? L("below", "ispod") : L("above", "iznad");
        const ivl = ivLoc(iv);
        if (g.answer === "play")
          return {
            ...base,
            kind: "midi",
            mode: "sequence",
            expect: [toMidi(root), toMidi(top)],
            octave: "exact",
            bass: false,
            showNotes: false,
            prompt: L(`Play ${noteStr(root)}, then the note a ${ivl.en} ${dir.en} it.`, `Odsviraj ${noteNameSr(root, true)}, pa notu koja je ${ivl.sr} ${dir.sr} nje.`),
            noteLabels: join([nno(root), nno(top)]),
          };
        return {
          ...base,
          kind: "names",
          ordered: true,
          expect: [pcName(top)],
          prompt: L(`Which note is a ${ivl.en} ${dir.en} ${pcName(root)}? Spell it correctly.`, `Koja nota je ${ivl.sr} ${dir.sr} ${noteNameSr(root)}? Napiši je ispravno.`),
        };
      }
      throw new Error(`interval-build: could not generate for ${ex.id}`);
    }
    case "interval-ear": {
      const range = (g.range ?? ["C3", "C5"]) as [string, string];
      for (let t = 0; t < 200; t++) {
        const iv = rng.pick(g.intervals);
        const dir = g.direction === "mixed" ? rng.pick(["up", "down", "harmonic"] as const) : g.direction;
        const a = randomNote(rng, range);
        let b: Note;
        try {
          b = transpose(a, iv, dir === "down");
        } catch {
          continue;
        }
        if (!inRange(b, [range[0], "C6"])) continue;
        const notes = [toMidi(a), toMidi(b)];
        const play: PlaySpec = { mode: dir === "harmonic" ? "harmonic" : "melodic", notes, tempo: 70 };
        if (g.answer === "play")
          return {
            ...base,
            kind: "midi",
            mode: "sequence",
            expect: notes,
            octave: "exact",
            bass: false,
            showNotes: false,
            play,
            prompt: L("Listen, then play both notes back (find them on the keys).", "Slušaj, pa odsviraj obe note (nađi ih na klavijaturi)."),
            noteLabels: join([nno(a), nno(b)]),
          };
        const { options, answer } = mcq(rng, iv, g.intervals, Math.min(4, g.intervals.length));
        return { ...base, kind: "mcq", play, prompt: L("Which interval do you hear?", "Koji interval čuješ?"), options: options.map(ivLoc), answer };
      }
      throw new Error(`interval-ear: could not generate for ${ex.id}`);
    }
    case "semitones": {
      const range = (g.range ?? ["C4", "B4"]) as [string, string];
      const a = randomNote(rng, range);
      const k = rng.int(1, g.maxSemitones);
      const b = midiToNote(toMidi(a) + k, rng.next() < 0.5);
      const { options, answer } = mcq(rng, String(k), Array.from({ length: 12 }, (_, i) => String(i + 1)));
      return {
        ...base,
        kind: "mcq",
        prompt: L(`How many half steps from ${noteStr(a)} up to ${noteStr(b)}?`, `Koliko polustepena ima od ${noteNameSr(a, true)} naviše do ${noteNameSr(b, true)}?`),
        options: options.map((o) => L(o, o)),
        answer,
      };
    }
    case "chord-ear": {
      const range = (g.range ?? ["C3", "G4"]) as [string, string];
      for (let t = 0; t < 200; t++) {
        const q = rng.pick(g.qualities);
        const inv = rng.pick(g.inversions);
        const root = randomNote(rng, range);
        let notes: Note[];
        try {
          notes = chord(root, q, inv);
        } catch {
          continue;
        }
        if (notes.some((n) => Math.abs(n.acc) > 1)) continue;
        const ms = notes.map(toMidi);
        const play: PlaySpec = { mode: "harmonic", notes: ms, tempo: 60 };
        if (g.answer === "play")
          return {
            ...base,
            kind: "midi",
            mode: "chord",
            expect: ms,
            octave: "any",
            bass: inv > 0,
            showNotes: false,
            play,
            prompt: L("Listen, then play the chord back (any octave).", "Slušaj, pa odsviraj akord (bilo koja oktava)."),
            noteLabels: join(notes.map(nno)),
          };
        const { options, answer } = mcq(rng, q, g.qualities, g.qualities.length);
        return { ...base, kind: "mcq", play, prompt: L("What quality is this chord?", "Kakav je ovo akord?"), options: options.map((o) => qLoc(o as ChordQuality)), answer };
      }
      throw new Error(`chord-ear: could not generate for ${ex.id}`);
    }
    case "chord-build": {
      const roots = g.roots ?? ["C", "D", "E", "F", "G", "A", "Bb", "Eb"];
      for (let t = 0; t < 200; t++) {
        const q = rng.pick(g.qualities);
        const inv = rng.pick(g.inversions);
        const root = parseNote(rng.pick(roots), 4);
        let notes: Note[];
        try {
          notes = chord(root, q, inv);
        } catch {
          continue;
        }
        if (notes.some((n) => Math.abs(n.acc) > 1)) continue;
        const sym = chordSymbol(root, q);
        const symSr = chordSr(root, q);
        const invTxt = inv ? INV_NAMES[inv] : null;
        if (g.answer === "name")
          return {
            ...base,
            kind: "names",
            ordered: true,
            expect: notes.map(pcName),
            prompt: L(`Spell ${sym} (${qualityName(q, "en")})${invTxt ? ", " + invTxt.en : ""}, lowest note first.`, `Napiši ${symSr}${invTxt ? ", " + invTxt.sr : ""}, od najniže note.`),
          };
        return {
          ...base,
          kind: "midi",
          mode: "chord",
          expect: notes.map(toMidi),
          octave: "any",
          bass: inv > 0,
          showNotes: false,
          prompt: L(`Play ${sym} (${qualityName(q, "en")})${invTxt ? ", " + invTxt.en : ""}.`, `Odsviraj ${symSr}${invTxt ? ", " + invTxt.sr : ""}.`),
          noteLabels: join(notes.map(nn), "-"),
        };
      }
      throw new Error(`chord-build: could not generate for ${ex.id}`);
    }
    case "chord-name": {
      const roots = g.roots ?? ["C", "D", "E", "F", "G", "A", "Bb", "Eb"];
      for (let t = 0; t < 200; t++) {
        const q = rng.pick(g.qualities);
        const inv = rng.pick(g.inversions);
        const root = parseNote(rng.pick(roots), 4);
        let notes: Note[];
        try {
          notes = chord(root, q, inv);
        } catch {
          continue;
        }
        if (notes.some((n) => Math.abs(n.acc) > 1)) continue;
        const correct = `${pcName(root)}|${q}`;
        const pool = new Set<string>([correct]);
        for (const r of roots) for (const qq of g.qualities) pool.add(`${r}|${qq}`);
        // prefer distractors with the same root or same quality: that is the actual confusion
        const near = [...pool].filter((p) => p !== correct && (p.startsWith(pcName(root) + "|") || p.endsWith("|" + q)));
        const { options, answer } = mcq(rng, correct, near.length >= 3 ? near : [...pool]);
        return {
          ...base,
          kind: "mcq",
          prompt: L("Which chord is this?", "Koji je ovo akord?"),
          abc: abcTune(notes, { chord: true }),
          options: options.map((o) => {
            const [r, qq] = o.split("|");
            const rn = parseNote(r);
            return L(`${chordSymbol(rn, qq as ChordQuality)} (${pcName(rn)} ${qualityName(qq as ChordQuality, "en")})`, chordSr(rn, qq as ChordQuality));
          }),
          answer,
        };
      }
      throw new Error(`chord-name: could not generate for ${ex.id}`);
    }
    case "scale-build": {
      const type = rng.pick(g.types);
      const tonicName = rng.pick(g.tonics);
      const tonic = parseNote(tonicName, toMidi(parseNote(tonicName, 4)) > 66 ? 3 : 4);
      // melodic minor descends as natural minor
      let notes = g.descending && type === "melodic-minor" ? scale(tonic, "natural-minor", true) : scale(tonic, type, true);
      if (g.descending) notes = notes.reverse();
      const nm = SCALE_NAMES[type];
      const kn = keyName(tonic, type).nom;
      const dir = g.descending ? L(", descending", ", silazno") : L("", "");
      if (g.answer === "name")
        return {
          ...base,
          kind: "names",
          ordered: true,
          expect: notes.slice(0, 7).map(pcName),
          prompt: L(`Spell the ${pcName(tonic)} ${nm.en} scale (7 notes, from the tonic).`, `Napiši lestvicu ${kn.sr} (7 tonova, od tonike).`),
        };
      return {
        ...base,
        kind: "midi",
        mode: "sequence",
        expect: notes.map(toMidi),
        octave: "exact",
        bass: false,
        tempo: g.tempo,
        showNotes: false,
        prompt: L(
          `Play ${pcName(tonic)} ${g.descending && type === "melodic-minor" ? "melodic minor (descending = natural minor)" : nm.en}${dir.en}, one octave from ${noteStr(g.descending ? notes[0] : tonic)}${g.tempo ? ` at ♩=${g.tempo}` : ""}.`,
          `Odsviraj lestvicu ${kn.sr}${dir.sr}, jednu oktavu od ${noteNameSr(g.descending ? notes[0] : tonic, true)}${g.tempo ? `, ♩=${g.tempo}` : ""}.`,
        ),
        noteLabels: join(notes.map(nn)),
      };
    }
    case "keysig": {
      const key = rng.pick(g.keys);
      const tonic = parseNote(key);
      const sig = keySignature(tonic, g.mode);
      const sigLoc = (s: number): Loc => (s === 0 ? L("no sharps or flats", "bez predznaka") : s > 0 ? L(`${s} sharp${s > 1 ? "s" : ""}`, `${s} ${s === 1 ? "povisilica" : "povisilice"}`.replace(/^([5-7]) povisilice$/, "$1 povisilica")) : L(`${-s} flat${s < -1 ? "s" : ""}`, `${-s} ${s === -1 ? "snizilica" : "snizilice"}`.replace(/^([5-7]) snizilice$/, "$1 snizilica")));
      const modeLoc = g.mode === "major" ? L("major", "dur") : L("minor", "mol");
      const keyLoc = keyName(tonic, g.mode === "major" ? "major" : "natural-minor", false).nom;
      if (g.ask === "count") {
        const pool = [-7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7].map(String);
        const { options, answer } = mcq(rng, String(sig), pool.filter((p) => Math.abs(+p - sig) <= 3));
        return { ...base, kind: "mcq", prompt: L(`Key signature of ${keyLoc.en}?`, `Koliko predznaka ima ${keyLoc.sr}?`), options: options.map((o) => sigLoc(+o)), answer };
      }
      if (g.ask === "relative") {
        const rel = g.mode === "major" ? relativeMinor(tonic) : transpose(tonic, "m3");
        const correct = pcName(rel);
        const pool = g.keys.map((k) => pcName(g.mode === "major" ? relativeMinor(parseNote(k)) : transpose(parseNote(k), "m3")));
        const { options, answer } = mcq(rng, correct, [...new Set(pool)]);
        const other = g.mode === "major" ? L("minor", "mol") : L("major", "dur");
        const relName = (o: string): Loc => keyName(parseNote(o), g.mode === "major" ? "natural-minor" : "major", false).nom;
        return { ...base, kind: "mcq", prompt: L(`Relative ${other.en} of ${keyLoc.en}?`, `Paralelni ${other.sr} za ${keyLoc.sr}?`), options: options.map(relName), answer };
      }
      const pool = [...new Set(g.keys.map((k) => pcName(parseNote(k))))];
      const { options, answer } = mcq(rng, pcName(tonic), pool);
      return { ...base, kind: "mcq", prompt: L(`Which ${modeLoc.en} key has ${sigLoc(sig).en}?`, sig === 0 ? `Koji ${modeLoc.sr} nema predznaka?` : `Koji ${modeLoc.sr} ima ${accCount(Math.abs(sig), sig > 0)}?`), options: options.map((o) => nn(parseNote(o))), answer };
    }
    case "roman": {
      const key = parseNote(rng.pick(g.keys), 4);
      const deg = rng.pick(g.degrees ?? [1, 2, 3, 4, 5, 6, 7]);
      const rn = romanNumeral(key, g.type, deg);
      const notes = diatonicChord(key, g.type, deg);
      const keyLoc = keyName(key, g.type, g.type !== "natural-minor").loc;
      if (g.ask === "numeral") {
        const pool = [1, 2, 3, 4, 5, 6, 7].map((d) => romanNumeral(key, g.type, d));
        const chordTxt = join(notes.map(nn), "-");
        const { options, answer } = mcq(rng, rn, pool);
        return { ...base, kind: "mcq", prompt: L(`In ${keyLoc.en}, the chord ${chordTxt.en} is…`, `U ${keyLoc.sr}, akord ${chordTxt.sr} je…`), options: options.map((o) => L(o, o)), answer };
      }
      if (g.ask === "name")
        return { ...base, kind: "names", ordered: true, expect: notes.map(pcName), prompt: L(`Spell ${rn} in ${keyLoc.en} (root, third, fifth).`, `Napiši ${rn} u ${keyLoc.sr} (osnovni ton, terca, kvinta).`) };
      return {
        ...base,
        kind: "midi",
        mode: "chord",
        expect: notes.map(toMidi),
        octave: "any",
        bass: false,
        showNotes: false,
        prompt: L(`Play ${rn} in ${keyLoc.en}.`, `Odsviraj ${rn} u ${keyLoc.sr}.`),
        noteLabels: join(notes.map(nn), "-"),
      };
    }
    case "progression": {
      const key = parseNote(rng.pick(g.keys), toMidi(parseNote(g.keys[0], 4)) > 67 ? 3 : 4);
      const chords = g.numerals.map((r) => romanChord(key, g.type, r));
      const keyLoc = keyName(key, g.type, g.type !== "natural-minor").loc;
      const prog = g.numerals.join(" – ");
      const ec = chords.map((c) => c.map(toMidi));
      return {
        ...base,
        kind: "midi",
        mode: "chords",
        expect: [],
        expectChords: ec,
        octave: g.octave,
        bass: true,
        tempo: g.tempo,
        showNotes: false,
        play: g.echo ? { mode: "chords", chords: ec, tempo: g.tempo ?? 60 } : undefined,
        prompt: g.echo
          ? L(`Listen to ${prog} in ${keyLoc.en}, then play it back.`, `Slušaj ${prog} u ${keyLoc.sr}, pa odsviraj.`)
          : L(`Play ${prog} in ${keyLoc.en} (block chords${g.tempo ? `, one per beat at ♩=${g.tempo}` : ""}).`, `Odsviraj ${prog} u ${keyLoc.sr} (akordi${g.tempo ? `, jedan po dobi, ♩=${g.tempo}` : ""}).`),
        noteLabels: join(chords.map((c) => join(c.map(nn), "-")), " | "),
      };
    }
    case "melody-echo": {
      const tonicName = rng.pick(g.tonics);
      const tonic = parseNote(tonicName, g.octave);
      const sc = scale(tonic, g.type, true); // degrees 1..8
      const allowed = (g.degrees ?? sc.map((_, i) => i + 1)).map((d) => d - 1).filter((i) => i < sc.length);
      const len = rng.int(g.length[0], g.length[1]);
      const seq: number[] = [];
      let cur = g.startOnTonic ? 0 : rng.pick(allowed);
      seq.push(cur);
      for (let i = 1; i < len; i++) {
        const cand = allowed.filter((d) => Math.abs(d - cur) <= g.maxLeap && (d !== cur || allowed.length === 1));
        cur = rng.pick(cand.length ? cand : allowed);
        seq.push(cur);
      }
      const notes = seq.map((i) => sc[i]);
      const ms = notes.map(toMidi);
      const keyLoc = keyName(tonic, g.type, g.type !== "natural-minor").nom;
      return {
        ...base,
        kind: "midi",
        mode: "sequence",
        expect: ms,
        octave: "exact",
        bass: false,
        showNotes: false,
        play: { mode: "melodic", notes: [toMidi(tonic), ...ms], tempo: g.tempo },
        prompt: L(`Key: ${keyLoc.en}. First you hear the tonic ${noteStr(tonic)}, then a ${len}-note melody. Play the melody back.`, `Tonalitet: ${keyLoc.sr}. Prvo čuješ toniku ${noteNameSr(tonic, true)}, pa melodiju od ${len} ${len >= 2 && len <= 4 ? "tona" : len === 1 ? "tona" : "tonova"}. Odsviraj melodiju.`),
        noteLabels: join(notes.map(nno)),
      };
    }
    case "degree-ear": {
      const tonic = parseNote(rng.pick(g.tonics), g.octave);
      const sc = scale(tonic, g.type, true);
      const deg = rng.pick(g.degrees);
      const target = sc[deg - 1];
      const cadence = [diatonicChord(tonic, g.type === "major" ? "major" : "harmonic-minor", 1), diatonicChord(tonic, g.type === "major" ? "major" : "harmonic-minor", 4), diatonicChord(tonic, g.type === "major" ? "major" : "harmonic-minor", 5), diatonicChord(tonic, g.type === "major" ? "major" : "harmonic-minor", 1)];
      // key-establishing I-IV-V-I in the octave below, then the target note
      const ctx = cadence.map((c) => c.map((n) => toMidi(n) - 12));
      const play: PlaySpec = { mode: "chords", chords: [...ctx, [toMidi(target)]], tempo: 72 };
      const keyLoc = keyName(tonic, g.type, g.type !== "natural-minor").nom;
      if (g.answer === "play")
        return {
          ...base,
          kind: "midi",
          mode: "sequence",
          expect: [toMidi(target)],
          octave: "any",
          bass: false,
          showNotes: false,
          play,
          prompt: L(`Key: ${keyLoc.en} (you hear I–IV–V–I). Play the last note.`, `Tonalitet: ${keyLoc.sr} (čuješ I–IV–V–I). Odsviraj poslednji ton.`),
          noteLabels: nn(target),
        };
      const { options, answer } = mcq(rng, String(deg), g.degrees.map(String), Math.min(4, g.degrees.length));
      return {
        ...base,
        kind: "mcq",
        play,
        prompt: L(`Key: ${keyLoc.en} (you hear I–IV–V–I). Which scale degree is the last note?`, `Tonalitet: ${keyLoc.sr} (čuješ I–IV–V–I). Koji je stupanj lestvice poslednji ton?`),
        options: options.map((o) => (o === "8" ? L("8 (tonic, octave up)", "8. (tonika, oktavu više)") : L(`degree ${o}`, `${o}. stupanj`))),
        answer,
      };
    }
    case "pitch-match": {
      // in the learner's comfortable range when known; written range otherwise (graded octave-agnostic)
      const [lo, hi] = ctx.voiceRange ?? [toMidi(parseNote(g.range?.[0] ?? "C3")), toMidi(parseNote(g.range?.[1] ?? "C4"))];
      if (g.intervals) {
        for (let t = 0; t < 200; t++) {
          const iv = rng.pick(g.intervals);
          const root = midiToNote(rng.int(lo, hi), rng.next() < 0.5);
          let top: Note;
          try {
            top = transpose(root, iv);
          } catch {
            continue;
          }
          if (toMidi(top) > hi || Math.abs(top.acc) > 1) continue;
          const ms = [toMidi(root), toMidi(top)];
          const ivl = ivLoc(iv);
          return {
            ...base,
            kind: "sing",
            targets: ms,
            beats: [2, 2],
            tempo: 60,
            tolerance: g.tolerance,
            octaveAgnostic: true,
            noteLabels: midiLabels(ms),
            play: { mode: "melodic", notes: [ms[0]], tempo: 40 },
            prompt: L(`You hear ${noteStr(root)}. Sing it, then the note a ${ivl.en} above (two beats each).`, `Čuješ ${noteNameSr(root, true)}. Otpevaj ga, pa ton koji je ${ivl.sr} iznad (po dve dobe).`),
          };
        }
        throw new Error(`pitch-match: could not generate for ${ex.id}`);
      }
      const m = rng.int(lo, hi);
      return {
        ...base,
        kind: "sing",
        targets: [m],
        sustain: g.sustain,
        tolerance: g.tolerance,
        octaveAgnostic: true,
        noteLabels: midiLabels([m]),
        play: { mode: "melodic", notes: [m], tempo: 40 },
        prompt: L(`Listen, then sing the note on "ah" and hold it ~${g.sustain} s.`, `Slušaj, pa otpevaj ton na "a" i drži ga ~${g.sustain} s.`),
      };
    }
    case "phrase-sing": {
      const tonic = parseNote(rng.pick(g.tonics), 3);
      const sc = scale(tonic, g.type, true);
      const allowed = (g.degrees ?? sc.map((_, i) => i + 1)).map((d) => d - 1).filter((i) => i < sc.length);
      const len = rng.int(g.length[0], g.length[1]);
      let cur = 0;
      const seq = [cur];
      for (let i = 1; i < len; i++) {
        const cand = allowed.filter((d) => Math.abs(d - cur) <= g.maxLeap && d !== cur);
        // avoid see-saw phrases (G A G A): do not return to the note before last when there is another way on
        const fresh = cand.filter((d) => d !== seq[seq.length - 2]);
        cur = rng.pick(fresh.length ? fresh : cand.length ? cand : allowed);
        seq.push(cur);
      }
      const raw = seq.map((i) => toMidi(sc[i]));
      const ms = fitToRange(raw, ctx.voiceRange);
      const kl = keyName(tonic, g.type, g.type !== "natural-minor").nom;
      return {
        ...base,
        kind: "sing",
        targets: ms,
        beats: ms.map(() => 1),
        tempo: g.tempo,
        tolerance: g.tolerance,
        octaveAgnostic: true,
        noteLabels: join(seq.map((i) => nn(sc[i]))),
        play: { mode: "melodic", notes: ms, tempo: g.tempo },
        prompt: L(`${kl.en}: listen to the ${len}-note phrase, then sing it back on "la" (one beat per note).`, `${kl.sr}: slušaj frazu od ${len} ${len <= 4 ? "tona" : "tonova"}, pa je otpevaj na "la" (jedna doba po tonu).`),
      };
    }
    case "bass-echo": {
      const key = parseNote(rng.pick(g.keys), g.octave);
      const roots: Note[] = [];
      const names: string[] = [];
      for (let i = 0; i < g.length; i++) {
        // start and (from 3 notes on) end on the first numeral; no immediate repeats
        const prev = names[i - 1];
        const r = i === 0 || (i === g.length - 1 && g.length >= 3 && prev !== g.numerals[0]) ? g.numerals[0] : rng.pick(g.numerals.filter((x) => x !== prev).length ? g.numerals.filter((x) => x !== prev) : g.numerals);
        names.push(r);
        roots.push(romanChord(key, g.type, r.replace(/[0-9]+$/, ""))[0]);
      }
      const ms = roots.map(toMidi);
      const keyLoc = keyName(key, g.type, g.type !== "natural-minor").nom;
      return {
        ...base,
        kind: "midi",
        mode: "sequence",
        expect: ms,
        octave: "any",
        bass: false,
        showNotes: false,
        play: { mode: "melodic", notes: ms, tempo: g.tempo },
        prompt: L(`Key: ${keyLoc.en}. Listen to the bass line (roots of ${g.numerals.join(", ")}) and play it back.`, `Tonalitet: ${keyLoc.sr}. Slušaj bas liniju (osnovni tonovi ${g.numerals.join(", ")}) i odsviraj je.`),
        noteLabels: L(names.join(" "), names.join(" ")),
      };
    }
  }
}

/** Items for one exercise. `seed` must be stored with the attempt for re-grading. */
export function generateItems(ex: Exercise, seed: string, countOverride?: number, ctx: GenCtx = {}): Item[] {
  if (ex.type !== "generated") return [staticItem(ex, ctx)];
  const rng = new Rng(`${ex.id}|${seed}`);
  const count = countOverride ?? ex.count;
  const items: Item[] = [];
  const seen = new Set<string>();
  for (let i = 0, tries = 0; items.length < count && tries < count * 20; tries++) {
    const it = genItem(ex, ex.gen, rng, i, ctx);
    const key = JSON.stringify([it.prompt.en, it.abc, (it as McqItem).answer, (it as MidiItem).expect, (it as SingItem).targets, it.play]);
    if (seen.has(key) && tries < count * 10) continue; // avoid identical repeats when the space allows it
    seen.add(key);
    items.push({ ...it, id: `${ex.id}#${i}` });
    i++;
  }
  return items;
}

export { SCALES, CHORDS };

/** True when an exercise can only be done at a (MIDI) keyboard (used by "no piano today"). */
export function needsPiano(ex: Exercise): boolean {
  if (ex.type === "midi-play" || ex.type === "midi-echo") return true;
  if (ex.type !== "generated") return false;
  try {
    return generateItems(ex, "probe", 1)[0]?.kind === "midi";
  } catch {
    return false;
  }
}
