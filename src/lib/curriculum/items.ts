// Turns exercise definitions (static or generator) into concrete, gradable items.
// Pure and deterministic given (exercise, seed), so the server can regenerate
// exactly what the client showed and re-grade a submission authoritatively.

import type { Exercise, Derive, Playback as PlaybackDef, Gen, Loc } from "./schema";
import { Note, parseNote, toMidi, noteStr, noteNameSr, pcName, midiToNote, LETTERS } from "../music/pitch";
import { parseInterval, transpose, intervalBetween, ivStr, intervalName } from "../music/interval";
import { scale, chord, CHORDS, ChordQuality, keySignature, relativeMinor, romanNumeral, romanNumeral7, romanChord, diatonicChord, qualityName, chordSymbol, SCALES, ScaleType } from "../music/harmony";
import { abcTune, abcChords, noteToAbc } from "../music/abc";

export interface PlaySpec {
  mode: "melodic" | "harmonic" | "chords" | "layers";
  notes?: number[]; // melodic: -1 = rest
  durations?: number[]; // melodic: beats per note (default 1 each)
  chords?: number[][];
  tempo: number;
  layers?: PlaySpec[]; // "layers": parts played together from the same start (melody + chords)
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
  /** Ear drills: what each option would have sounded like, for "compare / check on the piano" after a miss. */
  compare?: ({ play: PlaySpec; notes: Loc } | null)[];
}
export interface NamesItem extends ItemBase {
  kind: "names";
  expect: string[]; // English pitch names, spelling strict
  ordered: boolean;
}
export interface MidiItem extends ItemBase {
  kind: "midi";
  mode: "chord" | "sequence" | "chords" | "rhythm" | "improv";
  rhythm?: number[]; // rhythm mode: expected onsets in beats from the first note
  improv?: { scale: number[]; chords: number[][]; beatsPerChord: number; loops: number; tonicPc: number }; // pitch classes; chords as pcs
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
export interface ComposeItem extends ItemBase {
  kind: "compose";
  key: string;
  meter: string;
  bars: number;
  rules: string[];
  given?: string;
  range?: [number, number];
  voices: 1 | 2;
}
export interface WriteItem extends ItemBase {
  kind: "write";
  language: "en" | "sr" | "either";
  lines?: [number, number];
  rubric: { id: string; label: Loc; weight: number; top: Loc }[];
}
export interface HarmonizeItem extends ItemBase {
  kind: "harmonize";
  tune: Loc;
  melody: number[]; // -1 = rest
  durations: number[];
  pickup: number;
  beatsPerBar: number;
  slots: number[]; // beats per slot
  choices: string[];
  chordNotes: Record<string, number[]>; // playback voicing per choice
  model: string[];
  accept: string[][]; // per slot: choices whose chord tones fit the strong-beat melody notes
  tempo: number;
}
export type Item = McqItem | NamesItem | MidiItem | PracticeItem | SingItem | RangeItem | CheckinItem | ComposeItem | WriteItem | HarmonizeItem;

/** Learner state that shapes generated items. Stored with each submission so the server regenerates the same items. */
export interface GenCtx {
  voiceRange?: [number, number]; // comfortable range, MIDI low..high
}

/** Move a group of notes by whole octaves so it sits inside the comfortable range (best effort). */
export function fitToRange(ms: number[], range?: [number, number], where: boolean | "low" | "lowmid" | "high" = true): number[] {
  if (!range || !ms.length || where === false) return ms;
  const lo = range[0];
  // head voice / falsetto work may reach 2 semitones above the comfortable top
  const hi = where === "high" ? range[1] + 2 : range[1];
  const target = where === "low" ? lo + (Math.max(...ms) - Math.min(...ms)) / 2 : where === "high" ? hi - (Math.max(...ms) - Math.min(...ms)) / 2 : where === "lowmid" ? lo + (hi - lo) / 3 : (lo + hi) / 2;
  const center = (Math.min(...ms) + Math.max(...ms)) / 2;
  let shift = Math.round((target - center) / 12) * 12;
  const fits = (k: number) => Math.min(...ms) + k >= lo && Math.max(...ms) + k <= hi;
  const cands = [-24, -12, 0, 12, 24].map((d) => shift + d).filter(fits);
  if (cands.length) {
    // high: the highest placement that fits (it may reach 2 above the comfortable top);
    // low: the lowest; centred: the one nearest the centre
    if (where === "high") shift = Math.max(...cands);
    else if (where === "low") shift = Math.min(...cands);
    else shift = cands.reduce((a, b) => (Math.abs(b - shift) < Math.abs(a - shift) ? b : a));
  }
  return ms.map((m) => m + shift);
}
/** Labels that keep the written spelling (Bb stays Bb) after an octave shift. */
function spelledLabels(written: Note[], shifted: number[]): Loc {
  return join(written.map((n, i) => nno({ ...n, octave: n.octave + Math.round((shifted[i] - toMidi(n)) / 12) })));
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
/** "a minor third" / "an augmented fourth" */
const aan = (phrase: string) => `${/^[aeiou]/i.test(phrase) ? "an" : "a"} ${phrase}`;
const nn = (n: Note): Loc => L(pcName(n), noteNameSr(n));
const nno = (n: Note): Loc => L(noteStr(n), noteNameSr(n, true));
const join = (ls: Loc[], sep = " "): Loc => L(ls.map((l) => l.en).join(sep), ls.map((l) => l.sr).join(sep));
/**
 * Plain-string options are language-neutral, EXCEPT note names: "B" means B-flat to a
 * Serbian reader. Options made only of note names (with separators, e.g. "A, C, E♭",
 * "Bb", "F#4") show German-system names in Serbian.
 */
const opt = (o: string | Loc): Loc => {
  if (typeof o !== "string") return o;
  const parts = o.split(/([\s,/–-]+)/);
  const toks = parts.filter((p, i) => i % 2 === 0 && p !== "");
  if (!toks.length) return L(o, o);
  const notes = toks.map((t) => {
    try {
      return /^[A-G](##|#|bb|b|♯|♭)?-?\d?$/.test(t) ? parseNote(t.replace("♯", "#").replace("♭", "b")) : null;
    } catch {
      return null;
    }
  });
  if (notes.some((n) => !n)) return L(o, o);
  // only when it is clearly note names: one token, a comma list, or accidentals/octaves.
  // Space/dash-separated bare letters ("A A B A", "A–B–A") are form labels.
  const commaList = parts.some((p, i) => i % 2 === 1 && p.includes(","));
  const marked = toks.some((t) => /[#b♯♭]|\d/.test(t.slice(1)));
  if (toks.length > 1 && !commaList && !marked) return L(o, o);
  let k = 0;
  const sr = parts.map((p, i) => (i % 2 === 0 && p !== "" ? noteNameSr(notes[k]!, /\d$/.test(toks[k++])) : p)).join("");
  return L(o, sr);
};
const SCALE_NAMES: Record<ScaleType, Loc> = {
  major: L("major", "durska"),
  "natural-minor": L("natural minor", "prirodna molska"),
  "harmonic-minor": L("harmonic minor", "harmonska molska"),
  "melodic-minor": L("melodic minor (ascending)", "melodijska molska (uzlazno)"),
  "major-pentatonic": L("major pentatonic", "durska pentatonska"),
  "minor-pentatonic": L("minor pentatonic", "molska pentatonska"),
  blues: L("blues scale", "bluz lestvica"),
  dorian: L("dorian", "dorski"),
  phrygian: L("phrygian", "frigijski"),
  lydian: L("lydian", "lidijski"),
  mixolydian: L("mixolydian", "miksolidijski"),
  locrian: L("locrian", "lokrijski"),
};
const MODES = new Set<ScaleType>(["blues", "dorian", "phrygian", "lydian", "mixolydian", "locrian"]);
const ivLoc = (s: string): Loc => {
  const iv = parseInterval(s);
  return L(`${intervalName(iv, "en")} (${s})`, `${intervalName(iv, "sr")} (${s})`);
};
const qLoc = (q: ChordQuality): Loc => L(qualityName(q, "en"), qualityName(q, "sr"));
const isMinor = (t: ScaleType) => t.includes("minor");
const SR_VARIANT_LOC: Record<ScaleType, string> = { major: "", "natural-minor": "prirodnom", "harmonic-minor": "harmonskom", "melodic-minor": "melodijskom", "major-pentatonic": "(pentatonika)", "minor-pentatonic": "(pentatonika)", blues: "", dorian: "", phrygian: "", lydian: "", mixolydian: "", locrian: "" };
const SR_VARIANT: Record<ScaleType, string> = { major: "", "natural-minor": "prirodni", "harmonic-minor": "harmonski", "melodic-minor": "melodijski", "major-pentatonic": "pentatonika", "minor-pentatonic": "pentatonika", blues: "", dorian: "", phrygian: "", lydian: "", mixolydian: "", locrian: "" };
/**
 * Key/scale names. Serbian: "C-dur", "a-mol" (minor keys lower case), locative
 * "u C-duru", "u a-molu"; scale variants follow ("a-mol harmonski").
 * `variant` adds the scale variant (needed for scales, not for keys).
 */
function keyName(tonic: Note, type: ScaleType, variant = true): { nom: Loc; loc: Loc } {
  if (MODES.has(type)) {
    // modes and the blues scale are named as such: "D dorian" / "D dorski" (locative "u D dorskom")
    const sr = SCALE_NAMES[type].sr;
    const srLoc = type === "blues" ? `${noteNameSr(tonic)} bluz lestvici` : `${noteNameSr(tonic)} ${sr.replace(/i$/, "om")}`;
    return { nom: L(`${pcName(tonic)} ${SCALE_NAMES[type].en}`, `${noteNameSr(tonic)} ${sr}`), loc: L(`${pcName(tonic)} ${SCALE_NAMES[type].en}`, srLoc) };
  }
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
// seventh chords have their own inversion names (figured bass 65 / 43 / 42)
const INV_NAMES_7: Loc[] = [L("root position", "osnovni položaj"), L("1st inversion (6/5)", "1. obrtaj (kvintsekstakord)"), L("2nd inversion (4/3)", "2. obrtaj (terckvartakord)"), L("3rd inversion (4/2)", "3. obrtaj (sekundakord)")];
const invName = (q: ChordQuality, inv: number): Loc => (CHORDS[q].length >= 4 ? INV_NAMES_7 : INV_NAMES)[inv];

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

const bassOf = (c: Note[]): Note => c.reduce((a, b) => (toMidi(a) <= toMidi(b) ? a : b));

/** Move a playback by whole semitones (octave shifts from fitToRange); rests (-1) stay rests. */
function shiftPlay(p: PlaySpec | undefined, by: number): PlaySpec | undefined {
  if (!p || !by) return p;
  return { ...p, notes: p.notes?.map((n) => (n < 0 ? n : n + by)), chords: p.chords?.map((c) => c.map((n) => n + by)) };
}

function playSpec(p: PlaybackDef | undefined): PlaySpec | undefined {
  if (!p) return undefined;
  if (p.chords) return { mode: "chords", chords: p.chords.map((c) => c.map((n) => toMidi(parseNote(n)))), tempo: p.tempo, durations: p.durations };
  if (p.derive) {
    const d = derive(p.derive);
    if ("roman" in p.derive) return { mode: "chords", chords: d.map((c) => c.map(toMidi)), tempo: p.tempo };
    return { mode: p.mode, notes: d[0].map(toMidi), tempo: p.tempo };
  }
  return { mode: p.mode, notes: (p.notes ?? []).map((n) => toMidi(parseNote(n))), tempo: p.tempo, durations: p.durations };
}

function inRange(n: Note, range?: [string, string]): boolean {
  if (!range) return true;
  const m = toMidi(n);
  return m >= toMidi(parseNote(range[0])) && m <= toMidi(parseNote(range[1]));
}

// common spellings for the black keys (the keys people actually play in)
const COMMON = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
/** Random note within range, black keys spelled the common way (Db Eb F# Ab Bb). */
function randomNote(rng: Rng, range: [string, string], accidentals = true): Note {
  const lo = toMidi(parseNote(range[0]));
  const hi = toMidi(parseNote(range[1]));
  for (let i = 0; i < 100; i++) {
    const m = rng.int(lo, hi);
    const pc = ((m % 12) + 12) % 12;
    const n = parseNote(COMMON[pc], Math.floor(m / 12) - 1);
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
function staticItem(ex: Exclude<Exercise, { type: "generated" }>, ctx: GenCtx = {}, seed = ""): Item {
  const base = { id: `${ex.id}#0`, exerciseId: ex.id, prompt: ex.prompt, abc: ex.abc };
  switch (ex.type) {
    case "mcq": {
      const options = ex.options.map(opt);
      if (ex.keepOrder) return { ...base, kind: "mcq", options, answer: ex.answer, play: playSpec(ex.play) };
      const order = new Rng(`${ex.id}|${seed}|order`).shuffle(options.map((_, i) => i));
      return { ...base, kind: "mcq", options: order.map((i) => options[i]), answer: order.indexOf(ex.answer), play: playSpec(ex.play) };
    }
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
      // written rhythm (onsets in beats) for sequences AND chord progressions
      const rhythm = ex.beats && ex.mode !== "chord" ? ex.beats.reduce<number[]>((acc, b, i) => (acc.push(i === 0 ? 0 : acc[i - 1] + ex.beats![i - 1]), acc), []) : undefined;
      let play: PlaySpec | undefined = ex.type === "midi-echo" ? playSpec(ex.play) : undefined;
      if (ex.type === "midi-echo" && !play)
        play = expectChords ? { mode: "chords", chords: expectChords, tempo: ex.tempo ?? 60, durations: ex.beats } : { mode: ex.mode === "chord" ? "harmonic" : "melodic", notes: expect, tempo: ex.tempo ?? 80, durations: ex.beats };
      return { ...base, kind: "midi", mode: ex.mode, expect, expectChords, octave: ex.octave, bass: ex.bass, tempo: ex.tempo, showNotes: ex.showNotes, noteLabels: labels, play, rhythm };
    }
    case "practice":
      return { ...base, kind: "practice", minutes: ex.minutes, play: playSpec(ex.play) };
    case "sing-pitch": {
      const written = ex.notes.map((n) => parseNote(n));
      const ms = fitToRange(written.map(toMidi), ctx.voiceRange, ex.fitRange);
      const shift = ms[0] - toMidi(written[0]);
      return {
        ...base,
        kind: "sing",
        targets: ms,
        sustain: ex.sustain,
        tolerance: ex.tolerance,
        octaveAgnostic: ex.octaveAgnostic,
        noteLabels: spelledLabels(written, ms),
        play: ex.accompany ? shiftPlay(playSpec(ex.accompany), shift) : ex.reference ? { mode: "melodic", notes: ms, tempo: 50 } : undefined,
      };
    }
    case "sing-phrase": {
      // rests ("r") are kept in the layout: voice-score note indexes count them
      const seq: (Note | null)[] = ex.notes ? ex.notes.map((n) => (n === "r" ? null : parseNote(n))) : derive(ex.derive!)[0];
      const written = seq.filter((n): n is Note => n !== null);
      const ms = fitToRange(written.map(toMidi), ctx.voiceRange, ex.fitRange);
      const allBeats = ex.beats ?? seq.map(() => 1);
      let k = 0;
      const layout = seq.map((n, i) => (n ? { midi: ms[k++], beats: allBeats[i] } : { beats: allBeats[i] }));
      const beats = layout.filter((e) => e.midi != null).map((e) => e.beats);
      return {
        ...base,
        kind: "sing",
        targets: ms,
        beats,
        tempo: ex.tempo,
        tolerance: ex.tolerance,
        octaveAgnostic: ex.octaveAgnostic,
        noteLabels: spelledLabels(written, ms),
        layout: seq.some((n) => n === null) ? layout : undefined,
        // the accompaniment moves by the same octaves as the sung line, so it sounds where you sing
        play: ex.accompany ? shiftPlay(playSpec(ex.accompany), written.length ? ms[0] - toMidi(written[0]) : 0) : ex.reference ? { mode: "melodic", notes: layout.map((e) => e.midi ?? -1), durations: layout.map((e) => e.beats), tempo: ex.tempo } : undefined,
      };
    }
    case "voice-range":
      return { ...base, kind: "range" };
    case "checkin":
      return { ...base, kind: "checkin" };
    case "compose":
      return { ...base, kind: "compose", key: ex.key, meter: ex.meter, bars: ex.bars, rules: ex.rules, given: ex.given, voices: ex.voices as 1 | 2, range: ex.range ? [toMidi(parseNote(ex.range[0])), toMidi(parseNote(ex.range[1]))] : undefined };
    case "write":
      return { ...base, kind: "write", language: ex.language, lines: ex.lines, rubric: ex.rubric };
    case "harmonize":
      return harmonizeItem(ex, base);
  }
}

/** V means V7 for fit (the 7th, scale degree 4, is a chord tone over V). */
const FIT_NUMERAL: Record<string, string> = { V: "V7" };

/**
 * Does `chord` fit slot `i` of the melody? The note sounding where the chord starts is a
 * chord tone, and chord tones fill at least half of the slot's sounding time (rests
 * excluded). Passing and neighbour notes on weak beats are allowed; V means V7 here.
 */
export function harmonizeFits(ex: Extract<Exercise, { type: "harmonize" }>, i: number, chordNum: string): boolean {
  const tonic = parseNote(ex.key, 3);
  const pcs = new Set(romanChord(tonic, "major", FIT_NUMERAL[chordNum] ?? chordNum).map(pitchClassOf));
  const s0 = ex.pickup + ex.slots.slice(0, i).reduce((a, b) => a + b, 0);
  const s1 = s0 + ex.slots[i];
  let t = 0;
  let sounding = 0;
  let fit = 0;
  let first: boolean | null = null;
  ex.melody.notes.forEach((n, k) => {
    const a = t;
    const b = t + ex.melody.durations[k];
    t = b;
    const overlap = Math.min(b, s1) - Math.max(a, s0);
    if (overlap <= 1e-9 || n === "z") return;
    const ok = pcs.has(pitchClassOf(parseNote(n)));
    if (first === null && a <= s0 + 1e-9) first = ok;
    else if (first === null) first = ok; // slot starts on a rest: the first note decides
    sounding += overlap;
    if (ok) fit += overlap;
  });
  return first === true && fit >= sounding / 2 - 1e-9;
}

/** Chords that count per slot: the model plus the authored alternatives. */
export function harmonizeAccept(ex: Extract<Exercise, { type: "harmonize" }>): string[][] {
  return ex.model.map((m, i) => [m, ...(ex.alternatives?.[i] ?? []).filter((c) => c !== m)]);
}

function harmonizeItem(ex: Extract<Exercise, { type: "harmonize" }>, base: { id: string; exerciseId: string; prompt: Loc; abc?: string }): HarmonizeItem {
  const tonic = parseNote(ex.key, 3);
  const chordNotes: Record<string, number[]> = {};
  for (const c of ex.choices) chordNotes[c] = romanChord(tonic, "major", FIT_NUMERAL[c] ?? c).map(toMidi);
  return {
    ...base,
    kind: "harmonize",
    tune: ex.tune,
    melody: ex.melody.notes.map((n) => (n === "z" ? -1 : toMidi(parseNote(n)))),
    durations: ex.melody.durations,
    pickup: ex.pickup,
    beatsPerBar: ex.beatsPerBar,
    slots: ex.slots,
    choices: ex.choices,
    chordNotes,
    model: ex.model,
    accept: harmonizeAccept(ex),
    tempo: ex.tempo,
    abc: base.abc ?? melodyAbc(ex),
  };
}

/** The melody as ABC with bar lines (L:1/8 so halves of a beat are whole units). */
export function melodyAbc(ex: Extract<Exercise, { type: "harmonize" }>): string {
  const parts: string[] = [];
  let t = 0;
  const barAt = (x: number) => x > ex.pickup - 1e-9 && Math.abs(((x - ex.pickup) % ex.beatsPerBar)) < 1e-9;
  ex.melody.notes.forEach((n, i) => {
    const len = Math.round(ex.melody.durations[i] * 2);
    const sym = n === "z" ? "z" : noteToAbc(parseNote(n));
    parts.push(sym + (len === 1 ? "" : String(len)));
    t += ex.melody.durations[i];
    if (i < ex.melody.notes.length - 1 && (barAt(t) || (ex.pickup > 0 && Math.abs(t - ex.pickup) < 1e-9))) parts.push("|");
  });
  return `X:1\nM:${ex.beatsPerBar}/4\nL:1/8\nK:${ex.key}\n${parts.join(" ")} |]`;
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
            prompt: L(`Play ${noteStr(root)}, then the note ${aan(ivl.en)} ${dir.en} it.`, `Odsviraj ${noteNameSr(root, true)}, pa notu koja je ${ivl.sr} ${dir.sr} nje.`),
            noteLabels: join([nno(root), nno(top)]),
          };
        return {
          ...base,
          kind: "names",
          ordered: true,
          expect: [pcName(top)],
          prompt: L(`Which note is ${aan(ivl.en)} ${dir.en} ${pcName(root)}? Spell it correctly.`, `Koja nota je ${ivl.sr} ${dir.sr} ${noteNameSr(root)}? Napiši je ispravno.`),
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
        if (!inRange(b, [range[0], "C6"]) || Math.abs(b.acc) > 1) continue;
        const notes = [toMidi(a), toMidi(b)];
        let play: PlaySpec = { mode: dir === "harmonic" ? "harmonic" : "melodic", notes, tempo: 70 };
        if (g.cue === "triad") {
          if (iv !== "m3" && iv !== "M3") throw new Error(`interval-ear ${ex.id}: cue "triad" is for m3/M3 only`);
          if (dir === "down") throw new Error(`interval-ear ${ex.id}: cue "triad" needs the 3rd above the root`);
          const triad = chord(a, iv === "M3" ? "maj" : "min", 0).map(toMidi);
          // the chord, a beat of silence, then the interval (both notes are in the chord)
          play = dir === "harmonic"
            ? { mode: "chords", chords: [triad, [], notes], durations: [2, 1, 2], tempo: 70 }
            : { mode: "chords", chords: [triad, [], [notes[0]], [notes[1]]], durations: [2, 1, 1, 1.5], tempo: 70 };
        }
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
        const compare = options.map((o) => {
          try {
            const c = transpose(a, o, dir === "down");
            const ns = [toMidi(a), toMidi(c)];
            return { play: { mode: dir === "harmonic" ? "harmonic" : "melodic", notes: ns, tempo: 70 } as PlaySpec, notes: join([nno(a), nno(c)]) };
          } catch {
            return null;
          }
        });
        const prompt = g.cue === "triad"
          ? L("First the chord, then its root and 3rd. Major or minor 3rd? Let the chord's colour tell you.", "Prvo akord, pa njegova osnova i terca. Velika ili mala terca? Neka ti boja akorda kaže.")
          : L("Which interval do you hear?", "Koji interval čuješ?");
        return { ...base, kind: "mcq", play, prompt, options: options.map(ivLoc), answer, compare };
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
        const compare = options.map((o) => {
          try {
            const ns = chord(root, o as ChordQuality, inv);
            if (ns.some((n) => Math.abs(n.acc) > 1)) return null;
            return { play: { mode: "harmonic", notes: ns.map(toMidi), tempo: 60 } as PlaySpec, notes: join(ns.map(nno)) };
          } catch {
            return null;
          }
        });
        return { ...base, kind: "mcq", play, prompt: L("What quality is this chord?", "Kakav je ovo akord?"), options: options.map((o) => qLoc(o as ChordQuality)), answer, compare };
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
        const invTxt = inv ? invName(q, inv) : null;
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
      const rn = g.seventh ? romanNumeral7(key, g.type, deg) : romanNumeral(key, g.type, deg);
      const notes = diatonicChord(key, g.type, deg, g.seventh);
      const keyLoc = keyName(key, g.type, g.type !== "natural-minor").loc;
      if (g.ask === "numeral") {
        const pool = [1, 2, 3, 4, 5, 6, 7].map((d) => (g.seventh ? romanNumeral7(key, g.type, d) : romanNumeral(key, g.type, d)));
        const chordTxt = join(notes.map(nn), "-");
        const { options, answer } = mcq(rng, rn, pool);
        return { ...base, kind: "mcq", prompt: L(`In ${keyLoc.en}, the chord ${chordTxt.en} is…`, `U ${keyLoc.sr}, akord ${chordTxt.sr} je…`), options: options.map((o) => L(o, o)), answer };
      }
      if (g.ask === "name")
        return { ...base, kind: "names", ordered: true, expect: notes.map(pcName), prompt: g.seventh ? L(`Spell ${rn} in ${keyLoc.en} (root, third, fifth, seventh).`, `Napiši ${rn} u ${keyLoc.sr} (osnovni ton, terca, kvinta, septima).`) : L(`Spell ${rn} in ${keyLoc.en} (root, third, fifth).`, `Napiši ${rn} u ${keyLoc.sr} (osnovni ton, terca, kvinta).`) };
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
      const chords = g.smooth ? smoothVoicing(g.numerals.map((r) => romanChord(key, g.type, r)), key) : g.numerals.map((r) => romanChord(key, g.type, r));
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
      const cad = g.type === "major" ? "I–IV–V–I" : "i–iv–V–i";
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
          prompt: L(`Key: ${keyLoc.en} (you hear ${cad}). Play the last note.`, `Tonalitet: ${keyLoc.sr} (čuješ ${cad}). Odsviraj poslednji ton.`),
          noteLabels: nn(target),
        };
      const { options, answer } = mcq(rng, String(deg), g.degrees.map(String), Math.min(4, g.degrees.length));
      return {
        ...base,
        kind: "mcq",
        play,
        prompt: L(`Key: ${keyLoc.en} (you hear ${cad}). Which scale degree is the last note?`, `Tonalitet: ${keyLoc.sr} (čuješ ${cad}). Koji je stupanj lestvice poslednji ton?`),
        options: options.map((o) => (o === "8" ? L("8 (tonic, octave up)", "8. (tonika, oktavu više)") : L(`degree ${o}`, `${o}. stupanj`))),
        answer,
      };
    }
    case "rhythm-echo": {
      const [num, den] = g.meter.split("/").map(Number);
      const barBeats = num * (4 / den);
      const units: number[][] = g.cells?.length ? g.cells : g.values.map((v) => [v]);
      const durs: number[] = [];
      for (let b = 0; b < g.bars; b++) {
        let left = barBeats;
        for (let guard = 0; left > 1e-9 && guard < 64; guard++) {
          const fit = units.filter((u) => u.reduce((a, x) => a + x, 0) <= left + 1e-9);
          const u = fit.length ? rng.pick(fit) : [left];
          durs.push(...u);
          left -= u.reduce((a, x) => a + x, 0);
        }
      }
      const onsets: number[] = [];
      let t = 0;
      for (const d of durs) {
        onsets.push(t);
        t += d;
      }
      const pitch = 72;
      return {
        ...base,
        kind: "midi",
        mode: "rhythm",
        expect: durs.map(() => pitch),
        rhythm: onsets,
        octave: "any",
        bass: false,
        tempo: g.tempo,
        showNotes: false,
        // one bar of high clicks first (a pulse to hear triplets vs eighths against), then the rhythm
        play: { mode: "melodic", notes: [...Array.from({ length: num }, (_, i) => (i === 0 ? 96 : 91)), ...durs.map(() => pitch)], durations: [...Array.from({ length: num }, () => barBeats / num), ...durs], tempo: g.tempo },
        abc: g.showAbc ? abcRhythm(durs, g.meter) : undefined,
        prompt: L(`Listen, then tap the rhythm back on any key (♩=${g.tempo}).`, `Slušaj, pa otkucaj ritam na bilo kojoj dirki (♩=${g.tempo}).`),
        noteLabels: L(durs.map(fmtBeats).join(" "), durs.map(fmtBeats).join(" ")),
      };
    }
    case "function-ear": {
      const keyName0 = rng.pick(g.keys);
      const key = parseNote(keyName0, toMidi(parseNote(keyName0, 4)) > 67 ? 3 : 4);
      const FUN = ["I", "IV", "V7"] as const;
      const feelLoc: Record<string, Loc> = {
        I: L("home (I)", "kuća (I)"),
        IV: L("away, but relaxed (IV)", "odlazak, ali opušteno (IV)"),
        V7: L("tension: wants to go home (V7)", "napetost: vuče kući (V7)"),
      };
      const endLoc: Record<string, Loc> = {
        I: L("ends at home (I)", "završava kod kuće (I)"),
        IV: L("ends away, open (IV)", "završava u odlasku, otvoreno (IV)"),
        V7: L("hangs on the tension (V7)", "visi na napetosti (V7)"),
      };
      // fixed option order (home, away, tension) so the three feelings keep their place
      const target = rng.pick([...FUN]);
      const ENDINGS: Record<string, string[][]> = {
        I: [["I", "IV", "V7", "I"], ["I", "V7", "IV", "I"], ["I", "IV", "I", "V7", "I"]],
        IV: [["I", "V7", "I", "IV"], ["I", "IV", "V7", "I", "IV"]],
        V7: [["I", "IV", "I", "V7"], ["I", "IV", "V7"], ["I", "V7", "I", "IV", "V7"]],
      };
      const build = (t: string) => {
        if (g.ask === "feel") {
          const nums = ["I", "IV", "V7", "I", t];
          const v = smoothVoicing(nums.map((r) => romanChord(key, "major", r)), key).map((c) => c.map(toMidi));
          return { play: { mode: "chords", chords: [...v.slice(0, 4), [], v[4]], durations: [1, 1, 1, 2, 1, 3], tempo: g.tempo } as PlaySpec, nums };
        }
        const nums = rng.pick(ENDINGS[t]);
        const v = smoothVoicing(nums.map((r) => romanChord(key, "major", r)), key).map((c) => c.map(toMidi));
        return { play: { mode: "chords", chords: v, durations: nums.map((_, i) => (i === nums.length - 1 ? 3 : 2)), tempo: g.tempo } as PlaySpec, nums };
      };
      const main = build(target);
      const keyLoc = keyName(key, "major", true).loc;
      const compare = FUN.map((t) => {
        const b = t === target ? main : build(t);
        return { play: b.play, notes: L(b.nums.join(" – "), b.nums.join(" – ")) };
      });
      return {
        ...base,
        kind: "mcq",
        play: main.play,
        prompt:
          g.ask === "feel"
            ? L(`In ${keyLoc.en}: I – IV – V7 – I sets home, then one more chord. How does that last chord feel?`, `U ${keyLoc.sr}: I – IV – V7 – I postavi „kuću”, pa još jedan akord. Kako deluje taj poslednji akord?`)
            : L(`A short progression in ${keyLoc.en}. How does it end?`, `Kratka progresija u ${keyLoc.sr}. Kako se završava?`),
        options: FUN.map((t) => (g.ask === "feel" ? feelLoc[t] : endLoc[t])),
        answer: FUN.indexOf(target),
        compare,
      };
    }
    case "progression-ear": {
      // keep the voicing in a comfortable register: tonics above G4 move down an octave
      const keyName0 = rng.pick(g.keys);
      const key = parseNote(keyName0, toMidi(parseNote(keyName0, 4)) > 67 ? 3 : 4);
      const k = rng.int(0, g.options.length - 1);
      const opts = g.options.map((o) => o.join(" – "));
      const raw = g.options[k].map((r) => romanChord(key, g.type, r));
      const chords = (g.smooth ? smoothVoicing(raw, key) : raw).map((c) => c.map(toMidi));
      const durations = g.beats ? g.options[k].map((_, i) => g.beats![i % g.beats!.length]) : undefined;
      const { options, answer } = mcq(rng, opts[k], opts, Math.min(4, opts.length));
      const keyLoc = keyName(key, g.type, g.type !== "natural-minor").loc;
      return {
        ...base,
        kind: "mcq",
        play: { mode: "chords", chords, tempo: g.tempo, durations },
        prompt: L(`Which progression do you hear (in ${keyLoc.en})?`, `Koju progresiju čuješ (u ${keyLoc.sr})?`),
        options: options.map((o) => L(o, o)),
        answer,
      };
    }
    case "improv": {
      const key = parseNote(rng.pick(g.keys), 3);
      const chordNotes = g.numerals.map((r) => romanChord(key, g.type, r));
      const scaleTonic = key;
      const sc = scale(scaleTonic, g.scale).map((n) => pitchClassOf(n));
      const chordsPc = chordNotes.map((c) => c.map((n) => pitchClassOf(n)));
      const beat = g.beatsPerChord;
      const all: number[][] = [];
      const durations: number[] = [];
      for (let l = 0; l < g.loops; l++)
        for (const c of chordNotes) {
          all.push(c.map(toMidi));
          durations.push(beat);
        }
      const keyLoc = keyName(key, g.type, g.type !== "natural-minor").nom;
      const scLoc = keyName(scaleTonic, g.scale, true).nom;
      // a blues (dominant 7ths on I/IV/V) is not "in C major": name only the tonal centre
      const dominantBlues = g.numerals.includes("I7") && (g.type === "major" || g.type === "mixolydian");
      return {
        ...base,
        kind: "midi",
        mode: "improv",
        expect: [],
        octave: "any",
        bass: false,
        tempo: g.tempo,
        showNotes: false,
        improv: { scale: sc, chords: chordsPc, beatsPerChord: beat, loops: g.loops, tonicPc: pitchClassOf(key) },
        play: { mode: "chords", chords: all, durations, tempo: g.tempo },
        prompt: L(
          `Improvise a melody over ${g.numerals.join(" – ")}${dominantBlues ? ` (key of ${pcName(key)})` : ` in ${keyLoc.en}`} (×${g.loops}). Notes: ${scLoc.en.replace(/ scale$/, "")} scale; aim for chord tones on the first beat of each chord.`,
          `Improvizuj melodiju preko ${g.numerals.join(" – ")}${dominantBlues ? ` (tonalni centar ${noteNameSr(key)})` : ` u ${keyName(key, g.type, g.type !== "natural-minor").loc.sr}`} (×${g.loops}). Tonovi: ${scLoc.sr}; na prvu dobu svakog akorda ciljaj ton akorda.`,
        ),
        noteLabels: L(g.numerals.join(" "), g.numerals.join(" ")),
      };
    }
    case "pitch-match": {
      // in the learner's comfortable range when known; written range otherwise (graded octave-agnostic)
      const [lo, hi] = ctx.voiceRange ?? [toMidi(parseNote(g.range?.[0] ?? "C3")), toMidi(parseNote(g.range?.[1] ?? "C4"))];
      if (g.intervals) {
        for (let t = 0; t < 200; t++) {
          const iv = rng.pick(g.intervals);
          const m0 = rng.int(lo, hi);
          const root = parseNote(COMMON[((m0 % 12) + 12) % 12], Math.floor(m0 / 12) - 1);
          let top: Note;
          try {
            top = transpose(root, iv);
          } catch {
            continue;
          }
          // a stored range narrower than the interval: after 100 tries, allow the top to exceed it
          if ((toMidi(top) > hi && t < 100) || Math.abs(top.acc) > 1) continue;
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
            noteLabels: join([nno(root), nno(top)]), // spelled like the prompt (Bb3, not A#3)
            play: { mode: "melodic", notes: [ms[0]], tempo: 40 },
            prompt: L(`You hear ${noteStr(root)}. Sing it, then the note ${aan(ivl.en)} above (two beats each).`, `Čuješ ${noteNameSr(root, true)}. Otpevaj ga, pa ton koji je ${ivl.sr} iznad (po dve dobe).`),
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
      for (let i = 0; i < (g.line ? g.line.length : g.length); i++) {
        if (g.line) {
          names.push(g.line[i]);
          roots.push(bassOf(romanChord(key, g.type, g.line[i]))); // inversion figures give the bass (V6 -> the 3rd)
          continue;
        }
        // start and (from 3 notes on) end on the first numeral; no immediate repeats
        const prev = names[i - 1];
        const r = i === 0 || (i === g.length - 1 && g.length >= 3 && prev !== g.numerals[0]) ? g.numerals[0] : rng.pick(g.numerals.filter((x) => x !== prev).length ? g.numerals.filter((x) => x !== prev) : g.numerals);
        names.push(r);
        roots.push(bassOf(romanChord(key, g.type, r)));
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
        // "bass notes", not "roots": inversion figures put other chord tones in the bass
        prompt: L(`Key: ${keyLoc.en}. Listen to the bass line (bass notes of ${(g.line ?? g.numerals).join(", ")}) and play it back.`, `Tonalitet: ${keyLoc.sr}. Slušaj bas liniju (bas tonovi akorada ${(g.line ?? g.numerals).join(", ")}) i odsviraj je.`),
        noteLabels: L(names.join(" "), names.join(" ")),
      };
    }
  }
}

/** Items for one exercise. `seed` must be stored with the attempt for re-grading. */
/**
 * Voice-led block chords: bass = root in octave 3; three upper voices = triad tones
 * (root doubled) or, for seventh chords, 3rd/5th/7th. Each chord tries every
 * assignment of its tones to the voices, each voice taking the nearest instance of
 * its pitch class to where it was, and keeps the cheapest total movement. The first
 * chord starts near E4-G4-C5.
 */
export function smoothVoicing(chords: Note[][], tonic?: Note): Note[][] {
  const leadingPc = tonic ? (pitchClassOf(tonic) + 11) % 12 : null;
  const tonicPc = tonic ? pitchClassOf(tonic) : null;
  let prev = [64, 67, 72];
  let prevBass: number | null = null;
  let prevSeventhPc: number | null = null; // the 7th of the previous chord, if it had one
  // parallel perfect 5ths/8ves between any two voices (bass included) cost extra
  const parallels = (a: number[], b: number[]) => {
    let n = 0;
    for (let i = 0; i < a.length; i++)
      for (let j = i + 1; j < a.length; j++) {
        const before = (((a[j] - a[i]) % 12) + 12) % 12;
        const after = (((b[j] - b[i]) % 12) + 12) % 12;
        const moved = a[i] !== b[i] && a[j] !== b[j] && Math.sign(b[i] - a[i]) === Math.sign(b[j] - a[j]);
        if (moved && before === after && (before === 0 || before === 7)) n++;
      }
    return n;
  };
  const near = (pc: number, to: number) => {
    const base = to - ((((to - pc) % 12) + 12) % 12);
    return to - base <= 6 ? base : base + 12;
  };
  const perms = <T,>(a: T[]): T[][] => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((r) => [x, ...r])));
  return chords.map((c) => {
    // Doubling (triads): root position doubles the root; first inversion (3rd in the bass)
    // doubles the ROOT, never the bass: in V6 the bass is the leading tone; second
    // inversion doubles the bass (5th), as in the cadential 6/4.
    // Seventh chords: the three tones above the bass.
    const root = c.find((r) => c.every((n) => n === r || [2, 4, 6].includes((n.letter - r.letter + 7) % 7))) ?? c[0];
    let tones =
      c.length >= 4
        ? c.slice(1, 4)
        : c[0].letter === root.letter && c[0].acc === root.acc
          ? [c[0], c[1], c[2]]
          : (c[0].letter - root.letter + 7) % 7 === 2
            ? [root, root, c.find((n) => (n.letter - root.letter + 7) % 7 === 4)!]
            : [c[0], c[1], c[2]];
    // diminished triads (vii°): double the 3rd, never the root (the leading tone)
    const third = c.find((n) => (n.letter - root.letter + 7) % 7 === 2);
    const fifth = c.find((n) => (n.letter - root.letter + 7) % 7 === 4);
    if (c.length === 3 && third && fifth && (toMidi(fifth) - toMidi(root) + 120) % 12 === 6) {
      // bass on the root: above it 3rd, 3rd, 5th (no second leading tone);
      // vii°6 (3rd in the bass): above it root, 3rd, 5th, so the 3rd is the doubled note
      const bassIsRoot = c[0].letter === root.letter && c[0].acc === root.acc;
      tones = bassIsRoot ? [third, third, fifth] : [root, third, fifth];
    }
    let best: { midis: number[]; notes: Note[] } | null = null;
    let bestCost = Infinity;
    const bass = toMidi({ ...c[0], octave: 3 });  // c[0] is the bass (romanChord puts the inversion's bass first)
    for (const order of perms(tones)) {
      // upper voices stay strictly above the bass (no unison with it) and at or below G5
      // (the soprano range taught in T-033)
      const midis = order.map((n, v) => {
        let m = near(pitchClassOf(n), prev[v]);
        while (m <= bass) m += 12;
        while (m > 79 && m - 12 > bass) m -= 12;
        return m;
      });
      let cost = midis.reduce((a, m, v) => a + Math.abs(m - prev[v]), 0);
      if (prevBass !== null) cost += 5 * parallels([prevBass, ...prev], [bass, ...midis]);
      // the leading tone resolves up to the tonic when the next chord has the tonic
      if (leadingPc !== null && tonicPc !== null && c.some((n) => pitchClassOf(n) === tonicPc))
        prev.forEach((p, v) => {
          if ((((p % 12) + 12) % 12) === leadingPc && midis[v] - p !== 1) cost += 4;
        });
      // a chord 7th resolves down by step (C of D7 -> B of G): anything else costs extra
      if (prevSeventhPc !== null)
        prev.forEach((p, v) => {
          if ((((p % 12) + 12) % 12) === prevSeventhPc) {
            const d = p - midis[v];
            if (d < 1 || d > 2) cost += 6;
          }
        });
      if (cost < bestCost) {
        bestCost = cost;
        best = { midis, notes: order };
      }
    }
    const pairs = best!.midis.map((m, i) => ({ m, n: best!.notes[i] })).sort((a, b) => a.m - b.m);
    prev = pairs.map((p) => p.m);
    prevBass = bass;
    const seventh = c.length >= 4 ? c.find((n) => (n.letter - root.letter + 7) % 7 === 6) : undefined;
    prevSeventhPc = seventh ? pitchClassOf(seventh) : null;
    const upper = pairs.map(({ m, n }) => ({ ...n, octave: n.octave + Math.round((m - toMidi(n)) / 12) }));
    return [{ ...c[0], octave: 3 }, ...upper];
  });
}

/** 0.5 -> "1/2", 0.333.. -> "1/3", 1.5 -> "3/2" (beats, for labels). */
function fmtBeats(d: number): string {
  for (const den of [1, 2, 3, 4, 6, 8]) {
    const num = d * den;
    if (Math.abs(num - Math.round(num)) < 1e-6) return den === 1 ? String(Math.round(num)) : `${Math.round(num)}/${den}`;
  }
  return d.toFixed(2);
}

function pitchClassOf(n: Note): number {
  return ((toMidi(n) % 12) + 12) % 12;
}

/** Rhythm on one staff line (B4) in ABC; durations in quarter-note beats. */
function abcRhythm(durs: number[], meter: string): string {
  const [num, den] = meter.split("/").map(Number);
  const bar = num * (4 / den);
  let out = "";
  let inBar = 0;
  const third = (x: number) => Math.abs(x - 1 / 3) < 1e-6;
  const sixth = (x: number) => Math.abs(x - 1 / 6) < 1e-6;
  for (let i = 0; i < durs.length; i++) {
    const d = durs[i];
    // triplets: three 1/3-beat notes = eighth-note triplet (3B2B2B2; three 1/6 = sixteenth triplet
    const twoThirds = (x: number) => Math.abs(x - 2 / 3) < 1e-6;
    // swing pair (2/3 + 1/3 or 1/3 + 2/3 of a beat) = quarter + eighth under a triplet bracket
    if (i + 1 < durs.length && ((twoThirds(d) && third(durs[i + 1])) || (third(d) && twoThirds(durs[i + 1])))) {
      out += twoThirds(d) ? "(3B4B2 " : "(3B2B4 ";
      inBar += 1;
      i += 1;
    } else if ((third(d) || sixth(d)) && i + 2 < durs.length && durs[i + 1] === d && durs[i + 2] === d) {
      out += third(d) ? "(3B2B2B2 " : "(3BBB ";
      inBar += 3 * d;
      i += 2;
    } else {
      const sixteenths = Math.round(d * 4);
      out += `B${sixteenths === 1 ? "" : sixteenths} `;
      inBar += d;
    }
    if (inBar >= bar - 1e-6) {
      out += "| ";
      inBar = 0;
    }
  }
  return `X:1\nM:${meter}\nL:1/16\nK:C clef=perc\n${out.trim().replace(/\|$/, "")}|]`;
}

export function generateItems(ex: Exercise, seed: string, countOverride?: number, ctx: GenCtx = {}): Item[] {
  if (ex.type !== "generated") return [staticItem(ex, ctx, seed)];
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
const EAR_KINDS = new Set(["interval-ear", "chord-ear", "progression-ear", "degree-ear", "scale-ear"]);
/** Recognize-by-ear drills (choose an answer after listening), as opposed to play-back or theory. */
export function isEarRecognition(ex: Exercise): boolean {
  if (ex.type === "mcq") return !!ex.play;
  if (ex.type !== "generated") return false;
  const g = ex.gen as { kind: string; answer?: string };
  return EAR_KINDS.has(g.kind) && (g.answer ?? "choose") !== "play";
}

/**
 * Does passing `ex` count toward passing its lesson? Ear-recognition drills inside
 * non-E lessons do not (calibration 2026-11-13: harmonic m3/M3 in T-004 took 6 rounds
 * at chance level and turned a theory lesson into 20 min of ear grinding). They are
 * still graded and go to SRS; the E track is where ear skills gate.
 */
export function gatesLesson(ex: Exercise, track: string): boolean {
  if (ex.type === "practice" || ex.type === "checkin") return false;
  if (ex.gate !== undefined) return ex.gate;
  return !(track !== "E" && isEarRecognition(ex));
}

export function needsPiano(ex: Exercise): boolean {
  if (ex.type === "midi-play" || ex.type === "midi-echo") return true;
  if (ex.type !== "generated") return false;
  try {
    return generateItems(ex, "probe", 1)[0]?.kind === "midi";
  } catch {
    return false;
  }
}
