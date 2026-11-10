import { describe, it, expect } from "vitest";
import { runCheck } from "@/lib/curriculum/validate";
import { gradeNames, gradeMidi, heldChord, clusterChords, timingScore } from "@/lib/grading";
import type { MidiItem } from "@/lib/curriculum/items";

describe("content checks catch wrong facts", () => {
  it("rejects wrong intervals/chords/scales/keys", () => {
    expect(runCheck({ interval: { from: "C4", to: "E4", is: "m3" } })).toMatch(/is M3/);
    expect(runCheck({ interval: { from: "C4", to: "E4", is: "M3" } })).toBeNull();
    expect(runCheck({ chord: { notes: ["E4", "G4", "C5"], root: "C", quality: "maj", inversion: 1 } })).toBeNull();
    expect(runCheck({ chord: { notes: ["E4", "G4", "C5"], root: "C", quality: "maj", inversion: 0 } })).toMatch(/inv 1/);
    expect(runCheck({ chord: { notes: ["C4", "Eb4", "G4"], root: "C", quality: "maj", inversion: 0 } })).toMatch(/min/);
    // enharmonic misspelling: C E Ab sounds like C aug but is not spelled as one
    expect(runCheck({ chord: { notes: ["C4", "E4", "Ab4"], root: "C", quality: "aug", inversion: 0 } })).toMatch(/spelled/);
    expect(runCheck({ scale: { tonic: "D", type: "major", is: ["D", "E", "Gb", "G", "A", "B", "Db"] } })).toMatch(/F#/);
    expect(runCheck({ keysig: { key: "Eb", mode: "major", is: -2 } })).toMatch(/-3/);
    expect(runCheck({ roman: { key: "C", type: "major", degree: 7, is: "vii°" } })).toBeNull();
  });
});

const mk = (o: Partial<MidiItem>): MidiItem => ({ id: "x#0", exerciseId: "x", kind: "midi", prompt: { en: "", sr: "" }, mode: "sequence", expect: [], octave: "exact", bass: false, showNotes: false, ...o });

describe("grading", () => {
  it("names: strict spelling, both languages", () => {
    expect(gradeNames(["D", "E", "F#"], "D E F#", "en", true).score).toBe(1);
    expect(gradeNames(["D", "E", "F#"], "D E Gb", "en", true).score).toBeCloseTo(2 / 3);
    expect(gradeNames(["Bb", "D", "F"], "B D F", "sr", true).score).toBe(1); // sr B = Bb
    expect(gradeNames(["B", "D#", "F#"], "H Dis Fis", "sr", true).score).toBe(1);
    expect(gradeNames(["Eb", "G", "Bb"], "es, g, b", "sr", true).score).toBe(1);
  });
  it("chord: held set, octave any vs exact, bass", () => {
    const ev = [
      { t: 0, type: "on" as const, note: 60 },
      { t: 20, type: "on" as const, note: 64 },
      { t: 30, type: "on" as const, note: 67 },
      { t: 500, type: "off" as const, note: 60 },
    ];
    expect(heldChord(ev)).toEqual([60, 64, 67]);
    expect(gradeMidi(mk({ mode: "chord", expect: [60, 64, 67] }), ev).score).toBe(1);
    expect(gradeMidi(mk({ mode: "chord", expect: [48, 52, 55], octave: "any" }), ev).score).toBe(1);
    expect(gradeMidi(mk({ mode: "chord", expect: [64, 67, 72], octave: "any", bass: true }), ev).score).toBe(0.5);
  });
  it("sequence: wrong note costs one edit", () => {
    const seq = [60, 62, 64, 65].map((n, i) => ({ t: i * 500, type: "on" as const, note: n }));
    expect(gradeMidi(mk({ expect: [60, 62, 64, 65] }), seq).score).toBe(1);
    expect(gradeMidi(mk({ expect: [60, 62, 63, 65] }), seq).score).toBe(0.75);
  });
  it("timing: steady at a different tempo is fine, uneven is not", () => {
    expect(timingScore([0, 1, 2, 3], [0, 520, 1040, 1560], 120).score).toBe(1); // ~115 bpm
    expect(timingScore([0, 1, 2, 3], [0, 300, 1100, 1500], 120).score).toBeLessThan(0.5);
    expect(timingScore([0, 1, 2, 3], [0, 1000, 2000, 3000], 120).score).toBeLessThan(0.5); // half tempo
  });
  it("chords: clustering and progression scoring", () => {
    const prog = [[60, 64, 67], [60, 65, 69], [59, 62, 67], [60, 64, 67]];
    const ev = prog.flatMap((c, k) => c.map((n, i) => ({ t: k * 800 + i * 15, type: "on" as const, note: n })));
    expect(clusterChords(ev).map((c) => c.notes)).toEqual(prog);
    expect(gradeMidi(mk({ mode: "chords", expectChords: prog, octave: "any", bass: true }), ev).score).toBe(1);
    const wrong = ev.map((e) => (e.t >= 1600 && e.t < 2400 && e.note === 62 ? { ...e, note: 63 } : e));
    const s = gradeMidi(mk({ mode: "chords", expectChords: prog, octave: "any", bass: true }), wrong).score;
    expect(s).toBeGreaterThan(0.8);
    expect(s).toBeLessThan(1);
  });
});
