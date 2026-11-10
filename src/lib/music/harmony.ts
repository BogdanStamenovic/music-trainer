import { Note, parseNote, toMidi, pitchClass, noteStr, pcName, Locale, noteName } from "./pitch";
import { transpose, parseInterval, intervalBetween, ivStr, semitones } from "./interval";

// ---------- scales ----------
export const SCALES = {
  major: ["P1", "M2", "M3", "P4", "P5", "M6", "M7"],
  "natural-minor": ["P1", "M2", "m3", "P4", "P5", "m6", "m7"],
  "harmonic-minor": ["P1", "M2", "m3", "P4", "P5", "m6", "M7"],
  "melodic-minor": ["P1", "M2", "m3", "P4", "P5", "M6", "M7"], // ascending form
  "major-pentatonic": ["P1", "M2", "M3", "P5", "M6"],
  "minor-pentatonic": ["P1", "m3", "P4", "P5", "m7"],
} as const;
export type ScaleType = keyof typeof SCALES;

/** Scale notes ascending from tonic; `withOctave` appends the tonic an octave up. */
export function scale(tonic: Note | string, type: ScaleType, withOctave = false): Note[] {
  const t = typeof tonic === "string" ? parseNote(tonic) : tonic;
  const out = SCALES[type].map((iv) => transpose(t, iv));
  if (withOctave) out.push(transpose(t, "P8"));
  return out;
}

// ---------- chords ----------
export const CHORDS = {
  maj: ["P1", "M3", "P5"],
  min: ["P1", "m3", "P5"],
  dim: ["P1", "m3", "d5"],
  aug: ["P1", "M3", "A5"],
  maj7: ["P1", "M3", "P5", "M7"],
  "7": ["P1", "M3", "P5", "m7"],
  min7: ["P1", "m3", "P5", "m7"],
  m7b5: ["P1", "m3", "d5", "m7"],
  dim7: ["P1", "m3", "d5", "d7"],
} as const;
export type ChordQuality = keyof typeof CHORDS;
export const TRIAD_QUALITIES: ChordQuality[] = ["maj", "min", "dim", "aug"];

/** Chord in close position; inversion n moves the n lowest notes up an octave. */
export function chord(root: Note | string, quality: ChordQuality, inversion = 0): Note[] {
  const r = typeof root === "string" ? parseNote(root) : root;
  const notes = CHORDS[quality].map((iv) => transpose(r, iv));
  for (let i = 0; i < inversion; i++) {
    const n = notes.shift()!;
    notes.push({ ...n, octave: n.octave + 1 });
  }
  return notes;
}

export function chordSymbol(root: Note, quality: ChordQuality): string {
  const suf: Record<ChordQuality, string> = { maj: "", min: "m", dim: "dim", aug: "aug", maj7: "maj7", "7": "7", min7: "m7", m7b5: "m7b5", dim7: "dim7" };
  return pcName(root) + suf[quality];
}

const QUAL_NAMES: Record<ChordQuality, { en: string; sr: string }> = {
  maj: { en: "major", sr: "durski" },
  min: { en: "minor", sr: "molski" },
  dim: { en: "diminished", sr: "smanjeni" },
  aug: { en: "augmented", sr: "povećani" },
  maj7: { en: "major seventh", sr: "veliki durski septakord" },
  "7": { en: "dominant seventh", sr: "dominantni septakord" },
  min7: { en: "minor seventh", sr: "mali molski septakord" },
  m7b5: { en: "half-diminished seventh", sr: "polusmanjeni septakord" },
  dim7: { en: "diminished seventh", sr: "smanjeni septakord" },
};
export function qualityName(q: ChordQuality, locale: Locale): string {
  return QUAL_NAMES[q][locale];
}

/**
 * Identify a chord from MIDI numbers (any voicing/octave/doubling).
 * Returns root pitch class, quality and inversion (by bass note), or null.
 */
export function identifyChord(midis: number[]): { rootPc: number; quality: ChordQuality; inversion: number } | null {
  if (midis.length === 0) return null;
  const pcs = [...new Set(midis.map((m) => ((m % 12) + 12) % 12))];
  const bassPc = ((Math.min(...midis) % 12) + 12) % 12;
  for (const q of Object.keys(CHORDS) as ChordQuality[]) {
    const shape = CHORDS[q].map((iv) => semitones(parseInterval(iv)) % 12);
    if (shape.length !== pcs.length) continue;
    for (const root of pcs) {
      const rel = new Set(pcs.map((p) => (p - root + 12) % 12));
      if (shape.every((s) => rel.has(s))) {
        const inv = shape.findIndex((s) => (root + s) % 12 === bassPc);
        return { rootPc: root, quality: q, inversion: inv };
      }
    }
  }
  return null;
}

// ---------- keys ----------
/** Key signature as signed count: +n sharps, -n flats. Derived from the spelled scale. */
export function keySignature(tonic: Note | string, mode: "major" | "minor" = "major"): number {
  const notes = scale(tonic, mode === "major" ? "major" : "natural-minor");
  let s = 0;
  for (const n of notes) s += n.acc;
  return s;
}

export function relativeMinor(majorTonic: Note | string): Note {
  const t = typeof majorTonic === "string" ? parseNote(majorTonic) : majorTonic;
  return transpose(t, "m3", true);
}
export function relativeMajor(minorTonic: Note | string): Note {
  const t = typeof minorTonic === "string" ? parseNote(minorTonic) : minorTonic;
  return transpose(t, "m3");
}

/** Order of sharps/flats as they appear in a key signature. */
export const SHARP_ORDER = ["F#", "C#", "G#", "D#", "A#", "E#", "B#"];
export const FLAT_ORDER = ["Bb", "Eb", "Ab", "Db", "Gb", "Cb", "Fb"];

// ---------- diatonic harmony ----------
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];

export function triadQualityOf(notes: Note[]): ChordQuality | null {
  const third = ivStr(intervalBetween(notes[0], notes[1]));
  const fifth = ivStr(intervalBetween(notes[0], notes[2]));
  if (third === "M3" && fifth === "P5") return "maj";
  if (third === "m3" && fifth === "P5") return "min";
  if (third === "m3" && fifth === "d5") return "dim";
  if (third === "M3" && fifth === "A5") return "aug";
  return null;
}

export function seventhQualityOf(notes: Note[]): ChordQuality | null {
  const ivs = notes.slice(1).map((n) => ivStr(intervalBetween(notes[0], n))).join(",");
  for (const q of ["maj7", "7", "min7", "m7b5", "dim7"] as ChordQuality[]) {
    if (CHORDS[q].slice(1).join(",") === ivs) return q;
  }
  return null;
}

/** Diatonic triad (or seventh) on scale degree 1..7, stacked in thirds from the scale. */
export function diatonicChord(tonic: Note | string, type: ScaleType, degree: number, seventh = false): Note[] {
  const sc = scale(tonic, type);
  const idx = degree - 1;
  const out: Note[] = [];
  const count = seventh ? 4 : 3;
  for (let k = 0; k < count; k++) {
    const i = idx + 2 * k;
    const n = sc[i % 7];
    out.push({ ...n, octave: n.octave + Math.floor(i / 7) });
  }
  return out;
}

/** Roman numeral for a diatonic triad: upper case major, lower minor, ° dim, + aug. */
export function romanNumeral(tonic: Note | string, type: ScaleType, degree: number): string {
  const q = triadQualityOf(diatonicChord(tonic, type, degree));
  const r = ROMAN[degree - 1];
  if (q === "maj") return r;
  if (q === "min") return r.toLowerCase();
  if (q === "dim") return r.toLowerCase() + "°";
  if (q === "aug") return r + "+";
  throw new Error("non-tertian diatonic triad");
}

/** Parse "I", "ii", "V", "vii°", "IV6", "V64", "V7" into degree/inversion/seventh. */
export function parseRoman(s: string): { degree: number; inversion: number; seventh: boolean } {
  const m = /^(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)(°|o|\+)?(7|65|43|42|6|64)?$/.exec(s.trim());
  if (!m) throw new Error(`bad roman numeral: ${s}`);
  const degree = ROMAN.indexOf(m[1].toUpperCase()) + 1;
  const fig = m[3] ?? "";
  const seventh = ["7", "65", "43", "42"].includes(fig);
  const inversion = { "": 0, "7": 0, "6": 1, "65": 1, "64": 2, "43": 2, "42": 3 }[fig]!;
  return { degree, inversion, seventh };
}

/**
 * Notes of a roman-numeral chord in a key, close position, requested inversion.
 * The bass is placed nearest the tonic (within -6..+5 semitones), which gives the
 * "hand stays still" voicings: in C, IV64 = C4 F4 A4 and V6 = B3 D4 G4.
 */
export function romanChord(tonic: Note | string, type: ScaleType, roman: string): Note[] {
  const t = typeof tonic === "string" ? parseNote(tonic) : tonic;
  const { degree, inversion, seventh } = parseRoman(roman);
  const notes = diatonicChord(t, type, degree, seventh);
  for (let i = 0; i < inversion; i++) {
    const n = notes.shift()!;
    notes.push({ ...n, octave: n.octave + 1 });
  }
  const d = toMidi(notes[0]) - toMidi(t);
  const shift = Math.floor((d + 6) / 12); // octaves to move down so that d lands in -6..+5
  return notes.map((n) => ({ ...n, octave: n.octave - shift }));
}

export function midis(notes: Note[]): number[] {
  return notes.map(toMidi);
}
export function names(notes: Note[], withOctave = true): string[] {
  return notes.map((n) => noteStr(n, withOctave));
}
export function localNames(notes: Note[], locale: Locale): string[] {
  return notes.map((n) => noteName(n, locale));
}
export function pcs(notes: Note[]): number[] {
  return notes.map(pitchClass);
}
