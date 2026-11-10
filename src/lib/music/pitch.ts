// Spelled pitch: letter + accidental + octave. Spelling is kept (not just MIDI
// numbers) because theory answers depend on it: D major has F#, never Gb.

export const LETTERS = ["C", "D", "E", "F", "G", "A", "B"] as const;
export type Letter = (typeof LETTERS)[number];
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];

export interface Note {
  letter: number; // 0..6 index into LETTERS
  acc: number; // -2..2 (flats negative)
  octave: number; // scientific pitch notation: C4 = middle C = MIDI 60
}

export type Locale = "en" | "sr";

const NOTE_RE = /^([A-Ga-g])(##|#|x|bb|b|♯|♭|𝄪|𝄫)?(-?\d+)?$/;

/** Parse "C4", "F#3", "Bb2", "Ebb5", "Fx4". Octave optional (defaults to `defOct`). */
export function parseNote(s: string, defOct = 4): Note {
  const m = NOTE_RE.exec(s.trim());
  if (!m) throw new Error(`bad note: ${JSON.stringify(s)}`);
  const letter = LETTERS.indexOf(m[1].toUpperCase() as Letter);
  const a = m[2] ?? "";
  const acc =
    a === "#" || a === "♯" ? 1 : a === "##" || a === "x" || a === "𝄪" ? 2 : a === "b" || a === "♭" ? -1 : a === "bb" || a === "𝄫" ? -2 : 0;
  const octave = m[3] !== undefined ? parseInt(m[3], 10) : defOct;
  return { letter, acc, octave };
}

export function hasOctave(s: string): boolean {
  const m = NOTE_RE.exec(s.trim());
  return !!m && m[3] !== undefined;
}

export function toMidi(n: Note): number {
  return (n.octave + 1) * 12 + LETTER_PC[n.letter] + n.acc;
}

export function pitchClass(n: Note): number {
  return (((LETTER_PC[n.letter] + n.acc) % 12) + 12) % 12;
}

export function noteStr(n: Note, withOctave = true): string {
  const acc = n.acc === 1 ? "#" : n.acc === 2 ? "##" : n.acc === -1 ? "b" : n.acc === -2 ? "bb" : "";
  return LETTERS[n.letter] + acc + (withOctave ? String(n.octave) : "");
}

/** Pitch-class name without octave, e.g. "F#". */
export function pcName(n: Note): string {
  return noteStr(n, false);
}

/**
 * Serbian (German-system) note names: H = B natural, B = B flat, -is/-es suffixes.
 * Es, As (contracted), B for Bb, Heses for Bbb.
 */
export function noteNameSr(n: Note, withOctave = false): string {
  const L = LETTERS[n.letter];
  let name: string;
  if (L === "B") {
    name = n.acc === 0 ? "H" : n.acc === -1 ? "B" : n.acc === -2 ? "Heses" : n.acc === 1 ? "His" : "Hisis";
  } else if (n.acc === 0) name = L;
  else if (n.acc > 0) name = L + "is".repeat(n.acc);
  else if (L === "E" || L === "A") name = L + "s" + "es".repeat(-n.acc - 1);
  else name = L + "es".repeat(-n.acc);
  return withOctave ? name + n.octave : name;
}

export function noteName(n: Note, locale: Locale, withOctave = false): string {
  return locale === "sr" ? noteNameSr(n, withOctave) : noteStr(n, withOctave);
}

const SR_RE = /^(Heses|Hisis|His|H|B|[CDEFGA])((?:is|es|s)*)(-?\d+)?$/i;

/** Parse a Serbian/German note name (case-insensitive): "Fis", "B", "H", "Es", "As4". */
export function parseNoteSr(s: string, defOct = 4): Note {
  const m = SR_RE.exec(s.trim());
  if (!m) throw new Error(`bad sr note: ${JSON.stringify(s)}`);
  const base = m[1].toLowerCase();
  const suf = m[2].toLowerCase();
  const octave = m[3] !== undefined ? parseInt(m[3], 10) : defOct;
  if (base === "h") {
    if (suf) throw new Error(`bad sr note: ${s}`);
    return { letter: 6, acc: 0, octave };
  }
  if (base === "his") return { letter: 6, acc: 1, octave };
  if (base === "hisis") return { letter: 6, acc: 2, octave };
  if (base === "heses") return { letter: 6, acc: -2, octave };
  if (base === "b") {
    if (suf) throw new Error(`bad sr note: ${s}`);
    return { letter: 6, acc: -1, octave };
  }
  const letter = LETTERS.indexOf(base.toUpperCase() as Letter);
  let acc = 0;
  if (suf === "") acc = 0;
  else if (/^(is)+$/.test(suf)) acc = suf.length / 2;
  else if ((base === "e" || base === "a") && /^s(es)*$/.test(suf)) acc = -(1 + (suf.length - 1) / 2);
  else if (base !== "e" && base !== "a" && /^(es)+$/.test(suf)) acc = -suf.length / 2;
  else throw new Error(`bad sr note: ${s}`);
  if (Math.abs(acc) > 2) throw new Error(`bad sr note: ${s}`);
  return { letter, acc, octave };
}

/** Accept either English ("Bb", "F#") or Serbian ("B", "Fis") spelling depending on locale. */
export function parseNoteLoose(s: string, locale: Locale, defOct = 4): Note | null {
  const t = s.trim();
  try {
    return locale === "sr" ? parseNoteSr(t, defOct) : parseNote(t, defOct);
  } catch {
    try {
      // fall back to the other system, but never reinterpret a bare "B"/"H" across systems
      if (/^[bBhH]\d*$/.test(t)) return null;
      return locale === "sr" ? parseNote(t, defOct) : parseNoteSr(t, defOct);
    } catch {
      return null;
    }
  }
}

export function midiToNote(midi: number, preferFlats = false): Note {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const sharp: [number, number][] = [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1], [6, 0]];
  const flat: [number, number][] = [[0, 0], [1, -1], [1, 0], [2, -1], [2, 0], [3, 0], [4, -1], [4, 0], [5, -1], [5, 0], [6, -1], [6, 0]];
  const [letter, acc] = (preferFlats ? flat : sharp)[pc];
  return { letter, acc, octave };
}

export function midiToName(midi: number, preferFlats = false): string {
  return noteStr(midiToNote(midi, preferFlats));
}

export function sameSpelling(a: Note, b: Note, octave = true): boolean {
  return a.letter === b.letter && a.acc === b.acc && (!octave || a.octave === b.octave);
}

export function midiToFreq(midi: number, a4 = 440): number {
  return a4 * Math.pow(2, (midi - 69) / 12);
}
