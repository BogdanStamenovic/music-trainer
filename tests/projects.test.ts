import { describe, it, expect } from "vitest";
import { quantize, toAbc, gradeByEar, lyricsStats, syllables, spellInKey, parseKey, melodyLayout } from "@/lib/projects";
import { noteStr } from "@/lib/music/pitch";
import type { Melody } from "@/lib/curriculum/schema";

const ev = (seq: [number, number, number][]) => seq.flatMap(([n, on, off]) => [{ t: on, type: "on" as const, note: n }, { t: off, type: "off" as const, note: n }]);

describe("quantize + ABC", () => {
  it("snaps a slightly sloppy performance to the grid", () => {
    // tempo 120 -> quarter 500 ms, eighth 250 ms. C D E F as eighths, then G half note
    const q = quantize(ev([[60, 1010, 1240], [62, 1255, 1490], [64, 1490, 1760], [65, 1745, 1990], [67, 2005, 2980]]), { t0: 1000, tempo: 120, grid: 2, voices: 1 });
    expect(q.map((n) => [n.midi, n.start, n.dur])).toEqual([[60, 0, 1], [62, 1, 1], [64, 2, 1], [65, 3, 1], [67, 4, 4]]);
    expect(toAbc(q, { key: "C major", meter: "4/4", grid: 2 })).toContain("C D E F G4 |]");
  });
  it("ties across bar lines and fills rests", () => {
    const q = [{ midi: 67, start: 6, dur: 4, voice: 1 as const }];
    expect(toAbc(q, { key: "C major", meter: "4/4", grid: 2 }).split("\n").pop()).toBe("z6 G2- | G2 z6 |]");
  });
  it("accidentals relative to key signature and bar", () => {
    // G major: F# implicit; F natural needs '=', then F# again in the same bar needs '^'
    const q = [66, 65, 66].map((m, i) => ({ midi: m, start: i * 2, dur: 2, voice: 1 as const }));
    expect(toAbc(q, { key: "G major", meter: "3/4", grid: 2 }).split("\n").pop()).toBe("F2 =F2 ^F2 |]");
    // F major: Bb from the signature; A# outside the key is spelled Bb (flat key) -> no mark
    const q2 = [{ midi: 70, start: 0, dur: 8, voice: 1 as const }];
    expect(toAbc(q2, { key: "F major", meter: "4/4", grid: 2 }).split("\n").pop()).toBe("B8 |]");
  });
  it("two voices split at the given pitch", () => {
    const q = quantize(ev([[72, 0, 990], [48, 0, 990], [71, 1000, 1990], [43, 1000, 1990]]), { t0: 0, tempo: 60, grid: 1, voices: 2, split: 55 });
    const abc = toAbc(q, { key: "C major", meter: "2/4", grid: 1 });
    expect(abc).toContain("V:1");
    expect(abc).toContain("V:2 clef=bass");
    expect(abc).toContain("c B |]");
    expect(abc).toContain("C, G,, |]");
  });
  it("spelling follows the key; harmonic-minor leading tone", () => {
    expect(noteStr(spellInKey(66, parseKey("D major").tonic, "major"))).toBe("F#4");
    expect(noteStr(spellInKey(70, parseKey("F major").tonic, "major"))).toBe("Bb4");
    expect(noteStr(spellInKey(68, parseKey("A minor").tonic, "minor"))).toBe("G#4");
    expect(noteStr(spellInKey(63, parseKey("Bb major").tonic, "major"))).toBe("Eb4");
  });
});

const ode: Melody = { title: { en: "t", sr: "t" }, source: "x", key: "D major", meter: "4/4", tempo: 100, pickup: 0,
  notes: ["F#4", "F#4", "G4", "A4", "A4", "G4", "F#4", "E4", "D4", "D4", "E4", "F#4", "F#4", "E4", "E4"],
  beats: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5, 0.5, 2] };

describe("by-ear grading", () => {
  const play = (shift: number, msPerBeat: number, mutate?: (m: number[]) => number[]) => {
    const lay = melodyLayout(ode).filter((e) => e.midi != null);
    let mids = lay.map((e) => e.midi! + shift);
    if (mutate) mids = mutate(mids);
    let t = 0;
    return lay.flatMap((e, i) => {
      const on = t;
      t += e.beats * msPerBeat;
      return [{ t: on, type: "on" as const, note: mids[i] }, { t: t - 20, type: "off" as const, note: mids[i] }];
    });
  };
  it("any key, any steady tempo = full marks", () => {
    const g = gradeByEar(ode, play(-2, 700));
    expect(g.pitch).toBe(1);
    expect(g.rhythm).toBeCloseTo(1, 5);
    expect(g.transpose).toBe(-2);
  });
  it("one wrong note costs about two intervals", () => {
    const g = gradeByEar(ode, play(0, 600, (m) => m.map((x, i) => (i === 6 ? x + 1 : x))));
    expect(g.pitch).toBeGreaterThan(0.8);
    expect(g.pitch).toBeLessThan(1);
  });
  it("even rhythm where the tune has a dotted figure loses rhythm points, not pitch", () => {
    const lay = melodyLayout(ode).filter((e) => e.midi != null);
    const evs = lay.flatMap((e, i) => [{ t: i * 500, type: "on" as const, note: e.midi! }, { t: i * 500 + 400, type: "off" as const, note: e.midi! }]);
    const g = gradeByEar(ode, evs);
    expect(g.pitch).toBe(1);
    expect(g.rhythm).toBeLessThan(1);
    expect(g.rhythm).toBeGreaterThan(0.7);
  });
});

describe("lyrics helpers", () => {
  it("syllables EN/SR", () => {
    expect(syllables("love", "en")).toBe(1);
    expect(syllables("morning", "en")).toBe(2);
    expect(syllables("srce", "sr")).toBe(2);
    expect(syllables("prst", "sr")).toBe(1);
    expect(syllables("ljubav", "sr")).toBe(2);
    expect(syllables("trn", "sr")).toBe(1);
  });
  it("rhyme scheme and section headers", () => {
    const s = lyricsStats("[Verse]\nI woke up this morning\nthe sky was cold and blue\nI woke up this morning\nand nothing rang true", "en");
    expect(s.lines).toBe(4);
    expect(s.sections).toBe(1);
    expect(s.rhymeScheme).toBe("ABAB");
    // limitation: spelling-based, so sound-alike endings (shoe / do) are not detected
    expect(lyricsStats("my shoe\nto do", "en").rhymeScheme).toBe("AB");
    const sr = lyricsStats("U avliji bagrem cveta\nmiris nosi tiha noć\nčekam tebe pola leta\na ti nećeš, nećeš doć'", "sr");
    expect(sr.rhymeScheme).toBe("ABAB");
  });
});
