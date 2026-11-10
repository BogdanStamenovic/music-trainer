import { describe, it, expect } from "vitest";
import { runCheck } from "@/lib/curriculum/validate";
import { gradeNames, gradeMidi, heldChord, clusterChords, timingScore } from "@/lib/grading";
import type { MidiItem } from "@/lib/curriculum/items";

describe("content checks catch wrong facts", () => {
  it("rejects wrong intervals/chords/scales/keys", () => {
    expect(runCheck({ interval: { from: "C4", to: "E4", is: "m3" } })).toMatch(/is M3/);
    expect(runCheck({ interval: { from: "C4", to: "E4", is: "M3" } })).toBeNull();
    expect(runCheck({ chord: { notes: ["E4", "G4", "C5"], root: "C", quality: "maj", inversion: 1 } })).toBeNull();
    expect(runCheck({ chord: { notes: ["E4", "G4", "C5"], root: "C", quality: "maj", inversion: 0 } })).toMatch(/inversion 1/);
    expect(runCheck({ chord: { notes: ["C4", "Eb4", "G4"], root: "C", quality: "maj", inversion: 0 } })).toMatch(/needs M3,P5/);
    // enharmonic misspelling: C E Ab sounds like C aug but is not spelled as one
    expect(runCheck({ chord: { notes: ["C4", "E4", "Ab4"], root: "C", quality: "aug", inversion: 0 } })).toMatch(/has M3,m6/);
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

import { gradeSing } from "@/lib/grading";
import { fitToRange } from "@/lib/curriculum/items";
import type { SingItem } from "@/lib/curriculum/items";

const sing = (o: Partial<SingItem>): SingItem => ({ id: "v#0", exerciseId: "v", kind: "sing", prompt: { en: "", sr: "" }, targets: [60], tolerance: 50, octaveAgnostic: true, noteLabels: { en: "", sr: "" }, ...o });
const note = (index: number, cents: number, sustain = 2, octave = 0) => ({ index, target_midi: 60, cents_error: cents, sustain_s: sustain, octave_offset: octave });

describe("sing grading", () => {
  it("tolerance band, linear falloff to 3x", () => {
    expect(gradeSing(sing({}), { analysis: { tracker: "t", notes: [note(0, -40)] } }).score).toBe(1);
    expect(gradeSing(sing({}), { analysis: { tracker: "t", notes: [note(0, 100)] } }).score).toBe(0.5);
    expect(gradeSing(sing({}), { analysis: { tracker: "t", notes: [note(0, 160)] } }).score).toBe(0);
  });
  it("missing note and no analysis score 0", () => {
    expect(gradeSing(sing({ targets: [60, 62] }), { analysis: { tracker: "t", notes: [note(0, 0)] } }).score).toBe(0.5);
    expect(gradeSing(sing({}), { analysis: null, reason: "nothing-voiced" }).score).toBe(0);
  });
  it("sustain shortfall scales the last note", () => {
    expect(gradeSing(sing({ sustain: 4 }), { analysis: { tracker: "t", notes: [note(0, 0, 2)] } }).score).toBe(0.5);
  });
  it("octave offset only counts when not octave-agnostic", () => {
    expect(gradeSing(sing({}), { analysis: { tracker: "t", notes: [note(0, 0, 2, 1)] } }).score).toBe(1);
    expect(gradeSing(sing({ octaveAgnostic: false }), { analysis: { tracker: "t", notes: [note(0, 0, 2, 1)] } }).score).toBe(0);
  });
  it("fitToRange moves by octaves into the range", () => {
    expect(fitToRange([60, 64, 67], [45, 64])).toEqual([48, 52, 55]);
    expect(fitToRange([48, 52], [57, 76])).toEqual([60, 64]);
    expect(fitToRange([60], undefined)).toEqual([60]);
  });
});

describe("sing grading with rests in the layout", () => {
  it("maps targets to voice-score indexes that count rests", () => {
    const it2 = sing({ targets: [60, 62], layout: [{ midi: 60, beats: 1 }, { beats: 1 }, { midi: 62, beats: 1 }] });
    expect(gradeSing(it2, { analysis: { tracker: "t", notes: [note(0, 5), note(2, -3)] } }).score).toBe(1);
    expect(gradeSing(it2, { analysis: { tracker: "t", notes: [note(0, 5), note(1, -3)] } }).score).toBe(0.5);
  });
});

describe("chord check with doubled notes", () => {
  it("accepts open voicings with a doubled root or fifth", () => {
    expect(runCheck({ chord: { notes: ["A2", "A3", "C4", "E4"], root: "A", quality: "min", inversion: 0 } })).toBeNull();
    expect(runCheck({ chord: { notes: ["C3", "G3", "C4", "E4"], root: "C", quality: "maj", inversion: 0 } })).toBeNull();
    expect(runCheck({ chord: { notes: ["G2", "G3", "B3", "D4", "F4"], root: "G", quality: "7", inversion: 0 } })).toBeNull();
  });
});

describe("chord checks by spelling", () => {
  it("min7 vs 6 is decided by the stated root; shells and 9ths are fine", () => {
    expect(runCheck({ chord: { notes: ["D3", "F3", "A3", "C4"], root: "D", quality: "min7", inversion: 0 } })).toBeNull();
    expect(runCheck({ chord: { notes: ["F3", "A3", "C4", "D4"], root: "F", quality: "6", inversion: 0 } })).toBeNull();
    expect(runCheck({ chord: { notes: ["G2", "B3", "F4"], root: "G", quality: "7", inversion: 0 } })).toBeNull(); // shell
    expect(runCheck({ chord: { notes: ["C3", "E3", "G3", "Bb3", "D4"], root: "C", quality: "9", inversion: 0 } })).toBeNull();
    expect(runCheck({ chord: { notes: ["F3", "A3", "C4", "D4"], root: "D", quality: "min7", inversion: 1 } })).toBeNull(); // Dm7/F
    expect(runCheck({ chord: { notes: ["D3", "F3", "A3", "C#4"], root: "D", quality: "min7", inversion: 0 } })).toMatch(/needs/);
  });
  it("seventh roman check", () => {
    expect(runCheck({ roman: { key: "C", type: "major", degree: 7, is: "viiø7", seventh: true } })).toBeNull();
  });
});

describe("octave-agnostic phrases", () => {
  it("whole phrase an octave down is fine; one note an octave off is wrong", () => {
    const it8 = sing({ targets: [48, 60], beats: [2, 2], tempo: 60 }); // octave leap C3 -> C4
    const n2 = (i: number, off: number) => ({ index: i, target_midi: 48, cents_error: 0, sustain_s: 2, octave_offset: off });
    expect(gradeSing(it8, { analysis: { tracker: "t", notes: [n2(0, -1), n2(1, -1)] } }).score).toBe(1); // both an octave down
    expect(gradeSing(it8, { analysis: { tracker: "t", notes: [n2(0, 0), n2(1, -1)] } }).score).toBe(0.5); // sang C3 twice
  });
});
