import { Note, LETTERS } from "./pitch";

// ABC notation: C4 = "C", C5 = "c", C6 = "c'", C3 = "C,". Accidentals: ^ sharp, _ flat, = natural.
export function noteToAbc(n: Note, explicitNatural = false): string {
  const acc = n.acc === 1 ? "^" : n.acc === 2 ? "^^" : n.acc === -1 ? "_" : n.acc === -2 ? "__" : explicitNatural ? "=" : "";
  const L = LETTERS[n.letter];
  let s: string;
  if (n.octave >= 5) s = L.toLowerCase() + "'".repeat(n.octave - 5);
  else s = L + ",".repeat(4 - n.octave);
  return acc + s;
}

export type Clef = "treble" | "bass";

export function clefFor(notes: Note[]): Clef {
  const avg = notes.reduce((a, n) => a + n.octave * 7 + n.letter, 0) / Math.max(1, notes.length);
  return avg < 4 * 7 ? "bass" : "treble"; // below middle C on average -> bass clef
}

/** A tune with whole notes; `chord` stacks all notes into one chord. */
export function abcTune(notes: Note[], opts: { clef?: Clef; chord?: boolean; key?: string; len?: string } = {}): string {
  const clef = opts.clef ?? clefFor(notes);
  const body = opts.chord ? `[${notes.map((n) => noteToAbc(n)).join("")}]` : notes.map((n) => noteToAbc(n)).join(" ");
  return `X:1\nL:${opts.len ?? "1/1"}\nK:${opts.key ?? "C"} clef=${clef}\n${body} |]`;
}

/** Several chords in sequence. */
export function abcChords(chords: Note[][], opts: { clef?: Clef; key?: string } = {}): string {
  const all = chords.flat();
  const clef = opts.clef ?? clefFor(all);
  const body = chords.map((c) => `[${c.map((n) => noteToAbc(n)).join("")}]`).join(" ");
  return `X:1\nL:1/1\nK:${opts.key ?? "C"} clef=${clef}\n${body} |]`;
}
