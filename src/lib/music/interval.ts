import { Note, toMidi, Locale } from "./pitch";

// Interval = (quality, number). Number is the letter-name distance + 1 (unison = 1).
// Quality letters: P perfect, M major, m minor, A augmented, d diminished (AA/dd doubly).
export type Quality = "dd" | "d" | "m" | "M" | "P" | "A" | "AA";
export interface Interval {
  quality: Quality;
  number: number; // 1..22 (compound allowed)
}

const BASE_SEMIS = [0, 2, 4, 5, 7, 9, 11]; // major/perfect sizes for simple 1..7
const PERFECT = new Set([1, 4, 5]); // simple numbers (mod 7) that are perfect-type

function simpleNum(n: number): number {
  return ((n - 1) % 7) + 1;
}

export function isPerfectType(number: number): boolean {
  return PERFECT.has(simpleNum(number));
}

export function semitones(iv: Interval): number {
  const s = simpleNum(iv.number);
  const oct = Math.floor((iv.number - 1) / 7);
  const base = BASE_SEMIS[s - 1] + 12 * oct;
  const perfect = PERFECT.has(s);
  const off = perfect
    ? { dd: -2, d: -1, P: 0, A: 1, AA: 2 }[iv.quality as "dd" | "d" | "P" | "A" | "AA"]
    : { dd: -3, d: -2, m: -1, M: 0, A: 1, AA: 2 }[iv.quality as "dd" | "d" | "m" | "M" | "A" | "AA"];
  if (off === undefined) throw new Error(`invalid quality ${iv.quality} for ${iv.number}`);
  return base + off;
}

const IV_RE = /^(dd|d|m|M|P|A|AA)(\d+)$/;
export function parseInterval(s: string): Interval {
  const m = IV_RE.exec(s.trim());
  if (!m) throw new Error(`bad interval: ${s}`);
  const iv = { quality: m[1] as Quality, number: parseInt(m[2], 10) };
  semitones(iv); // validates quality/number combination
  return iv;
}

export function ivStr(iv: Interval): string {
  return iv.quality + iv.number;
}

/** Interval from a up to b (b must not be lower than a by letter/octave). */
export function intervalBetween(a: Note, b: Note): Interval {
  const stepsA = a.octave * 7 + a.letter;
  const stepsB = b.octave * 7 + b.letter;
  let lo = a,
    hi = b,
    d = stepsB - stepsA;
  if (d < 0) {
    lo = b;
    hi = a;
    d = -d;
  }
  const number = d + 1;
  const semis = toMidi(hi) - toMidi(lo);
  const s = simpleNum(number);
  const oct = Math.floor((number - 1) / 7);
  const diff = semis - (BASE_SEMIS[s - 1] + 12 * oct);
  let quality: Quality | undefined;
  if (PERFECT.has(s)) quality = ({ "-2": "dd", "-1": "d", "0": "P", "1": "A", "2": "AA" } as Record<string, Quality>)[String(diff)];
  else quality = ({ "-3": "dd", "-2": "d", "-1": "m", "0": "M", "1": "A", "2": "AA" } as Record<string, Quality>)[String(diff)];
  if (!quality) throw new Error(`interval out of range between notes (diff ${diff})`);
  return { quality, number };
}

/** Transpose a note up (or down) by an interval, keeping correct spelling. */
export function transpose(n: Note, iv: Interval | string, down = false): Note {
  const i = typeof iv === "string" ? parseInterval(iv) : iv;
  const steps = (i.number - 1) * (down ? -1 : 1);
  const absSteps = n.octave * 7 + n.letter + steps;
  const letter = ((absSteps % 7) + 7) % 7;
  const octave = Math.floor(absSteps / 7);
  const target = toMidi(n) + semitones(i) * (down ? -1 : 1);
  const natural = toMidi({ letter, acc: 0, octave });
  const acc = target - natural;
  if (Math.abs(acc) > 2) throw new Error(`transpose needs triple accidental`);
  return { letter, acc, octave };
}

/** Inversion within the octave: M3 <-> m6, P4 <-> P5, A4 <-> d5 (numbers sum to 9). */
export function invert(iv: Interval): Interval {
  const s = simpleNum(iv.number);
  const q: Record<Quality, Quality> = { dd: "AA", d: "A", m: "M", M: "m", P: "P", A: "d", AA: "dd" };
  return { quality: q[iv.quality], number: s === 1 && iv.number > 1 ? 1 : 9 - s };
}

const EN_Q: Record<Quality, string> = { dd: "doubly diminished", d: "diminished", m: "minor", M: "major", P: "perfect", A: "augmented", AA: "doubly augmented" };
const EN_N = ["", "unison", "second", "third", "fourth", "fifth", "sixth", "seventh", "octave", "ninth", "tenth", "eleventh", "twelfth", "thirteenth"];
// Serbian interval names are all feminine nouns, so adjectives agree in feminine.
const SR_Q: Record<Quality, string> = { dd: "dvostruko smanjena", d: "smanjena", m: "mala", M: "velika", P: "čista", A: "povećana", AA: "dvostruko povećana" };
const SR_N = ["", "prima", "sekunda", "terca", "kvarta", "kvinta", "seksta", "septima", "oktava", "nona", "decima", "undecima", "duodecima", "tercdecima"];

export function intervalName(iv: Interval, locale: Locale): string {
  const n = (locale === "sr" ? SR_N : EN_N)[iv.number] ?? `${iv.number}`;
  const q = (locale === "sr" ? SR_Q : EN_Q)[iv.quality];
  return `${q} ${n}`;
}

export function intervalLabel(iv: Interval, locale: Locale): string {
  return `${intervalName(iv, locale)} (${ivStr(iv)})`;
}
