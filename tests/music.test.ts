import { describe, it, expect } from "vitest";
import { parseNote, toMidi, noteNameSr, parseNoteSr, noteStr, midiToName } from "@/lib/music/pitch";
import { intervalBetween, ivStr, transpose, semitones, parseInterval, invert, intervalName } from "@/lib/music/interval";
import { scale, names, chord, keySignature, relativeMinor, romanNumeral, romanChord, identifyChord, diatonicChord, triadQualityOf } from "@/lib/music/harmony";

// Expected values here are textbook facts written by hand, not derived from the library.
const n = (s: string) => parseNote(s);
const iv = (a: string, b: string) => ivStr(intervalBetween(n(a), n(b)));

describe("pitch", () => {
  it("midi numbers", () => {
    expect(toMidi(n("C4"))).toBe(60);
    expect(toMidi(n("A4"))).toBe(69);
    expect(toMidi(n("A0"))).toBe(21);
    expect(toMidi(n("C8"))).toBe(108);
    expect(toMidi(n("B#3"))).toBe(60);
    expect(toMidi(n("Cb4"))).toBe(59);
    expect(toMidi(n("Fx4"))).toBe(67);
  });
  it("serbian names", () => {
    const t: [string, string][] = [["B3", "H"], ["Bb3", "B"], ["Bbb3", "Heses"], ["Eb4", "Es"], ["Ab4", "As"], ["Db4", "Des"], ["Gb4", "Ges"], ["F#4", "Fis"], ["C#4", "Cis"], ["E#4", "Eis"], ["B#4", "His"], ["Ebb4", "Eses"], ["Abb4", "Ases"], ["F##4", "Fisis"], ["C4", "C"]];
    for (const [en, sr] of t) {
      expect(noteNameSr(n(en))).toBe(sr);
      expect(noteStr(parseNoteSr(sr, n(en).octave))).toBe(en.replace("##", "##"));
    }
  });
  it("midiToName", () => {
    expect(midiToName(61)).toBe("C#4");
    expect(midiToName(61, true)).toBe("Db4");
  });
});

describe("intervals", () => {
  it("identifies by spelling", () => {
    expect(iv("C4", "E4")).toBe("M3");
    expect(iv("C4", "Eb4")).toBe("m3");
    expect(iv("C4", "D#4")).toBe("A2");
    expect(iv("C4", "G4")).toBe("P5");
    expect(iv("C4", "F#4")).toBe("A4");
    expect(iv("C4", "Gb4")).toBe("d5");
    expect(iv("B3", "F4")).toBe("d5");
    expect(iv("F4", "B4")).toBe("A4");
    expect(iv("E4", "C5")).toBe("m6");
    expect(iv("C4", "A4")).toBe("M6");
    expect(iv("C4", "B4")).toBe("M7");
    expect(iv("D4", "C5")).toBe("m7");
    expect(iv("C4", "C5")).toBe("P8");
    expect(iv("E4", "F4")).toBe("m2");
    expect(iv("C4", "C4")).toBe("P1");
    expect(iv("C4", "D5")).toBe("M9");
    expect(iv("G4", "C4")).toBe("P5"); // order-independent
  });
  it("semitone sizes", () => {
    const t: Record<string, number> = { P1: 0, m2: 1, M2: 2, m3: 3, M3: 4, P4: 5, A4: 6, d5: 6, P5: 7, m6: 8, M6: 9, m7: 10, M7: 11, P8: 12, d7: 9, A5: 8 };
    for (const [k, v] of Object.entries(t)) expect(semitones(parseInterval(k))).toBe(v);
  });
  it("transposes with correct spelling", () => {
    expect(noteStr(transpose(n("D4"), "M3"))).toBe("F#4");
    expect(noteStr(transpose(n("Eb4"), "P5"))).toBe("Bb4");
    expect(noteStr(transpose(n("B3"), "m3"))).toBe("D4");
    expect(noteStr(transpose(n("C4"), "m3", true))).toBe("A3");
    expect(noteStr(transpose(n("F#4"), "M3"))).toBe("A#4");
    expect(noteStr(transpose(n("Ab4"), "d5"))).toBe("Ebb5");
  });
  it("inversion sums to 9", () => {
    expect(ivStr(invert(parseInterval("M3")))).toBe("m6");
    expect(ivStr(invert(parseInterval("P4")))).toBe("P5");
    expect(ivStr(invert(parseInterval("A4")))).toBe("d5");
    expect(ivStr(invert(parseInterval("m2")))).toBe("M7");
    expect(ivStr(invert(parseInterval("P8")))).toBe("P1");
  });
  it("names", () => {
    expect(intervalName(parseInterval("P5"), "sr")).toBe("čista kvinta");
    expect(intervalName(parseInterval("m3"), "sr")).toBe("mala terca");
    expect(intervalName(parseInterval("A4"), "en")).toBe("augmented fourth");
  });
});

describe("scales and keys", () => {
  it("major scales", () => {
    expect(names(scale("C4", "major"), false)).toEqual(["C", "D", "E", "F", "G", "A", "B"]);
    expect(names(scale("D4", "major"), false)).toEqual(["D", "E", "F#", "G", "A", "B", "C#"]);
    expect(names(scale("F4", "major"), false)).toEqual(["F", "G", "A", "Bb", "C", "D", "E"]);
    expect(names(scale("Eb4", "major"), false)).toEqual(["Eb", "F", "G", "Ab", "Bb", "C", "D"]);
    expect(names(scale("B3", "major"), false)).toEqual(["B", "C#", "D#", "E", "F#", "G#", "A#"]);
    expect(names(scale("F#4", "major"), false)).toEqual(["F#", "G#", "A#", "B", "C#", "D#", "E#"]);
    expect(names(scale("Gb4", "major"), false)).toEqual(["Gb", "Ab", "Bb", "Cb", "Db", "Eb", "F"]);
  });
  it("minor scales", () => {
    expect(names(scale("A3", "natural-minor"), false)).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
    expect(names(scale("A3", "harmonic-minor"), false)).toEqual(["A", "B", "C", "D", "E", "F", "G#"]);
    expect(names(scale("A3", "melodic-minor"), false)).toEqual(["A", "B", "C", "D", "E", "F#", "G#"]);
    expect(names(scale("E4", "harmonic-minor"), false)).toEqual(["E", "F#", "G", "A", "B", "C", "D#"]);
    expect(names(scale("D4", "harmonic-minor"), false)).toEqual(["D", "E", "F", "G", "A", "Bb", "C#"]);
  });
  it("scale octaves ascend", () => {
    expect(names(scale("A3", "major", true))).toEqual(["A3", "B3", "C#4", "D4", "E4", "F#4", "G#4", "A4"]);
  });
  it("key signatures", () => {
    const sig: Record<string, number> = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7 };
    for (const [k, v] of Object.entries(sig)) expect(keySignature(k + "4")).toBe(v);
    expect(keySignature("A4", "minor")).toBe(0);
    expect(keySignature("E4", "minor")).toBe(1);
    expect(keySignature("D4", "minor")).toBe(-1);
    expect(keySignature("C4", "minor")).toBe(-3);
    expect(noteStr(relativeMinor("C4"), false)).toBe("A");
    expect(noteStr(relativeMinor("Eb4"), false)).toBe("C");
    expect(noteStr(relativeMinor("A4"), false)).toBe("F#");
  });
});

describe("chords", () => {
  it("triads", () => {
    expect(names(chord("C4", "maj"))).toEqual(["C4", "E4", "G4"]);
    expect(names(chord("D4", "min"))).toEqual(["D4", "F4", "A4"]);
    expect(names(chord("B3", "dim"))).toEqual(["B3", "D4", "F4"]);
    expect(names(chord("C4", "aug"))).toEqual(["C4", "E4", "G#4"]);
    expect(names(chord("Eb4", "maj"))).toEqual(["Eb4", "G4", "Bb4"]);
    expect(names(chord("F#4", "min"))).toEqual(["F#4", "A4", "C#5"]);
    expect(names(chord("Db4", "maj"))).toEqual(["Db4", "F4", "Ab4"]);
    expect(names(chord("G4", "7"))).toEqual(["G4", "B4", "D5", "F5"]);
    expect(names(chord("B3", "dim7"))).toEqual(["B3", "D4", "F4", "Ab4"]);
  });
  it("inversions", () => {
    expect(names(chord("C4", "maj", 1))).toEqual(["E4", "G4", "C5"]);
    expect(names(chord("C4", "maj", 2))).toEqual(["G4", "C5", "E5"]);
  });
  it("diatonic numerals", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((d) => romanNumeral("C4", "major", d))).toEqual(["I", "ii", "iii", "IV", "V", "vi", "vii°"]);
    expect([1, 2, 3, 4, 5, 6, 7].map((d) => romanNumeral("A3", "natural-minor", d))).toEqual(["i", "ii°", "III", "iv", "v", "VI", "VII"]);
    expect([1, 2, 3, 4, 5, 6, 7].map((d) => romanNumeral("A3", "harmonic-minor", d))).toEqual(["i", "ii°", "III+", "iv", "V", "VI", "vii°"]);
    expect(names(diatonicChord("D4", "major", 5), false)).toEqual(["A", "C#", "E"]);
    expect(names(romanChord("G4", "major", "IV64"))).toEqual(["G4", "C5", "E5"]);
    expect(names(romanChord("C4", "major", "IV64"))).toEqual(["C4", "F4", "A4"]);
    expect(names(romanChord("C4", "major", "V6"))).toEqual(["B3", "D4", "G4"]);
    expect(names(romanChord("C4", "major", "IV"))).toEqual(["F4", "A4", "C5"]);
    expect(names(romanChord("C4", "major", "V7"))).toEqual(["G3", "B3", "D4", "F4"]);
    expect(triadQualityOf(diatonicChord("F4", "major", 7))).toBe("dim");
  });
  it("identify any voicing", () => {
    expect(identifyChord([52, 55, 60])).toEqual({ rootPc: 0, quality: "maj", inversion: 1 });
    expect(identifyChord([57, 60, 64, 69])).toEqual({ rootPc: 9, quality: "min", inversion: 0 });
    expect(identifyChord([43, 59, 62, 65])).toEqual({ rootPc: 7, quality: "7", inversion: 0 });
    expect(identifyChord([60, 61])).toBeNull();
  });
});

import { romanNumeral7, parseRoman as pr } from "@/lib/music/harmony";
describe("sevenths, extended chords, modes", () => {
  it("diatonic seventh numerals", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((d) => romanNumeral7("C4", "major", d))).toEqual(["Imaj7", "ii7", "iii7", "IVmaj7", "V7", "vi7", "viiø7"]);
    expect([1, 2, 3, 4, 5, 6, 7].map((d) => romanNumeral7("A3", "harmonic-minor", d))).toEqual(["i(maj7)", "iiø7", "III+maj7", "iv7", "V7", "VImaj7", "vii°7"]);
    expect([1, 2, 3, 4, 5, 6, 7].map((d) => romanNumeral7("A3", "natural-minor", d))).toEqual(["i7", "iiø7", "IIImaj7", "iv7", "v7", "VImaj7", "VII7"]);
  });
  it("parses seventh numerals for voicing", () => {
    expect(pr("Imaj7")).toEqual({ degree: 1, inversion: 0, seventh: true });
    expect(pr("viiø7")).toEqual({ degree: 7, inversion: 0, seventh: true });
    expect(pr("ii65")).toEqual({ degree: 2, inversion: 1, seventh: true });
    expect(names(romanChord("C4", "major", "ii7"))).toEqual(["D4", "F4", "A4", "C5"]);
  });
  it("extended chords and modes", () => {
    expect(names(chord("C4", "9"))).toEqual(["C4", "E4", "G4", "Bb4", "D5"]);
    expect(names(chord("D4", "min9"))).toEqual(["D4", "F4", "A4", "C5", "E5"]);
    expect(names(chord("G4", "7sus4"))).toEqual(["G4", "C5", "D5", "F5"]);
    expect(names(scale("D4", "dorian"), false)).toEqual(["D", "E", "F", "G", "A", "B", "C"]);
    expect(names(scale("G4", "mixolydian"), false)).toEqual(["G", "A", "B", "C", "D", "E", "F"]);
    expect(names(scale("F4", "lydian"), false)).toEqual(["F", "G", "A", "B", "C", "D", "E"]);
    expect(names(scale("E4", "phrygian"), false)).toEqual(["E", "F", "G", "A", "B", "C", "D"]);
    expect(names(scale("B3", "locrian"), false)).toEqual(["B", "C", "D", "E", "F", "G", "A"]);
    expect(names(scale("A3", "blues"), false)).toEqual(["A", "C", "D", "Eb", "E", "G"]);
  });
});

describe("roman numerals as written (lead-sheet convention)", () => {
  it("case and markers set the quality; diatonic numerals stay diatonic", () => {
    expect(names(romanChord("C4", "major", "I7"))).toEqual(["C4", "E4", "G4", "Bb4"]);
    expect(names(romanChord("C4", "major", "Imaj7"))).toEqual(["C4", "E4", "G4", "B4"]);
    expect(names(romanChord("C4", "major", "IV7"))).toEqual(["F4", "A4", "C5", "Eb5"]);
    expect(names(romanChord("C4", "major", "iv"))).toEqual(["F4", "Ab4", "C5"]); // borrowed
    expect(names(romanChord("C4", "major", "bVII"))).toEqual(["Bb3", "D4", "F4"]);
    expect(names(romanChord("C4", "major", "bIII"))).toEqual(["Eb4", "G4", "Bb4"]);
    expect(names(romanChord("A3", "harmonic-minor", "i(maj7)"))).toEqual(["A3", "C4", "E4", "G#4"]);
    expect(names(romanChord("C4", "major", "viiø7"))).toEqual(["B3", "D4", "F4", "A4"]);
    expect(names(romanChord("A3", "harmonic-minor", "vii°7"))).toEqual(["G#3", "B3", "D4", "F4"]);
  });
  it("secondary dominants", () => {
    expect(names(romanChord("C4", "major", "V/V"))).toEqual(["D4", "F#4", "A4"]);
    expect(names(romanChord("C4", "major", "V7/ii"))).toEqual(["A3", "C#4", "E4", "G4"]);
    expect(names(romanChord("C4", "major", "vii°/V"))).toEqual(["F#3", "A3", "C4"]); // tritone from C: placed below (-6)
    expect(names(romanChord("G4", "major", "V7/IV"))).toEqual(["G4", "B4", "D5", "F5"]);
  });
});
