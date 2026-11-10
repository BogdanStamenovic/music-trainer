import { describe, it, expect } from "vitest";
import { gradeRhythm, gradeImprov, gradeCompose, gradeWrite } from "@/lib/grading";
import { generateItems, type MidiItem } from "@/lib/curriculum/items";
import { Exercise } from "@/lib/curriculum/schema";

const taps = (beats: number[], ms: number, offset = 300) => beats.flatMap((b) => [{ t: offset + b * ms, type: "on" as const, note: 64 }, { t: offset + b * ms + 80, type: "off" as const, note: 64 }]);

describe("rhythm echo", () => {
  const exp = [0, 1, 1.5, 2, 3]; // q, e e, q, q
  it("right rhythm at a steady (even slightly different) tempo, any pitch, late start: full marks", () => {
    expect(gradeRhythm(exp, taps(exp, 790), 80).score).toBe(1);
  });
  it("evened-out eighths lose points; a missing tap costs its share", () => {
    expect(gradeRhythm(exp, taps([0, 1, 1.75, 2.25, 3], 750), 80).score).toBeLessThan(0.8);
    expect(gradeRhythm(exp, taps([0, 1, 2, 3], 750), 80).score).toBeLessThanOrEqual(0.8);
  });
  it("generator fills bars exactly and exposes onsets", () => {
    const ex = Exercise.parse({ id: "E-099-1", type: "generated", prompt: { en: "r", sr: "r" }, count: 5, gen: { kind: "rhythm-echo", meter: "3/4", bars: 2, values: [1, 0.5, 2, 1.5] } });
    for (const x of generateItems(ex, "s")) {
      const m = x as MidiItem;
      expect(m.mode).toBe("rhythm");
      const last = m.rhythm!.at(-1)!;
      const total = (m.play!.durations ?? []).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(6 + 3); // + one count-in bar of clicks
      expect(m.play!.notes!.slice(0, 3)).toEqual([96, 91, 91]);
      expect(last).toBeLessThan(6);
      expect(m.abc).toContain("M:3/4");
    }
  });
});

describe("improvisation", () => {
  const ex = Exercise.parse({ id: "K-099-1", type: "generated", prompt: { en: "i", sr: "i" }, count: 1, gen: { kind: "improv", keys: ["C"], scale: "major-pentatonic", numerals: ["I", "IV", "V", "I"], beatsPerChord: 4, loops: 1, tempo: 120 } });
  const item = generateItems(ex, "s")[0] as MidiItem;
  const beat = 500;
  it("backing: 4 chords of 4 beats", () => {
    expect(item.play!.chords!.length).toBe(4);
    expect(item.play!.durations).toEqual([4, 4, 4, 4]);
    expect(item.improv!.scale).toEqual([0, 2, 4, 7, 9]);
  });
  it("chord tones on downbeats, in scale, active: high; out-of-scale noodling: low; silence: 0", () => {
    const good = [60, 64, 67, 69, 65, 69, 72, 69, 67, 71, 74, 72, 64, 62, 60, 67].map((n, i) => ({ t: i * beat, type: "on" as const, note: n }));
    // F and B are not in C major pentatonic, so the in-scale part drops for those
    const g = gradeImprov(item, good);
    expect(g.score).toBeGreaterThan(0.85);
    const bad = [61, 63, 66, 68, 70, 61, 63, 66].map((n, i) => ({ t: i * beat * 2 + 120, type: "on" as const, note: n }));
    expect(gradeImprov(item, bad).score).toBeLessThan(0.3);
    expect(gradeImprov(item, []).score).toBe(0);
  });
});

describe("compose / write", () => {
  const ci = { id: "x#0", exerciseId: "x", kind: "compose" as const, prompt: { en: "", sr: "" }, key: "C major", meter: "4/4", bars: 2, rules: ["bars"], voices: 1 as const };
  it("compose uses the server's rule result; unavailable worker = completion credit flagged", () => {
    expect(gradeCompose(ci, { abc: "C D E F |]", rules: { ok: true, score: 0.7 } }).score).toBe(0.7);
    expect(gradeCompose(ci, { abc: "C D E F |]", rules: { ok: false, unavailable: true, error: "no venv" } })).toEqual({ score: 1, detail: { unchecked: true, error: "no venv" } });
    expect(gradeCompose(ci, { abc: "C D E F |]" }).score).toBe(0);
    expect(gradeCompose(ci, { abc: "  ", rules: { ok: true, score: 1 } }).score).toBe(0);
  });
  it("write = weighted self rubric", () => {
    const wi = { id: "w#0", exerciseId: "w", kind: "write" as const, prompt: { en: "", sr: "" }, language: "en" as const, rubric: [{ id: "a", label: { en: "", sr: "" }, weight: 1, top: { en: "", sr: "" } }, { id: "b", label: { en: "", sr: "" }, weight: 3, top: { en: "", sr: "" } }] };
    expect(gradeWrite(wi, { text: "x\ny", self: { a: 4, b: 2 } }).score).toBeCloseTo(0.625);
  });
  it("roman generator with sevenths", () => {
    const ex = Exercise.parse({ id: "T-099-1", type: "generated", prompt: { en: "r", sr: "r" }, count: 7, gen: { kind: "roman", keys: ["C"], seventh: true, ask: "name" } });
    for (const x of generateItems(ex, "s")) expect((x as unknown as { expect: string[] }).expect.length).toBe(4);
  });
});

import { validateLessons } from "@/lib/curriculum/validate";
import { Lesson } from "@/lib/curriculum/schema";
describe("distortion gate (voice safety)", () => {
  const L = (id: string, tags: string[], prereqs: string[], explainEn = "x", explainSr = "x") =>
    Lesson.parse({ id, track: "V", order: Number(id.slice(2)), title: { en: id, sr: id + "s" }, prereqs, minutes: 8, tags, explain: { en: explainEn, sr: explainSr },
      exercises: [{ id: `${id}-1`, type: "checkin", prompt: { en: "c", sr: "c" } }, { id: `${id}-2`, type: "practice", prompt: { en: "w", sr: "w" } }] });
  const sup = L("V-101", ["support"], []);
  const ons = L("V-102", ["onset"], ["V-101"]);
  it("passes when support + onset are prerequisites and the stop protocol is stated", () => {
    const d = L("V-103", ["distortion"], ["V-102"], "Stop at any pain.", "Odmah prekini na bilo kakav bol.");
    expect(validateLessons([sup, ons, d])).toEqual([]);
  });
  it("rejects missing prerequisites and a missing stop protocol", () => {
    const d = L("V-104", ["distortion"], ["V-101"]);
    const errs = validateLessons([sup, ons, d]).join("\n");
    expect(errs).toMatch(/onset/);
    expect(errs).toMatch(/stop protocol/);
  });
});

import { runCheck } from "@/lib/curriculum/validate";
describe("mcq shuffle + syllable check", () => {
  it("static options shuffle per seed, answer follows; keepOrder keeps them", () => {
    const ex = Exercise.parse({ id: "T-098-1", type: "mcq", prompt: { en: "q", sr: "q" }, options: ["a", "b", "c", "d"], answer: 2 });
    const seen = new Set<string>();
    for (const s of ["1", "2", "3", "4", "5", "6"]) {
      const it0 = generateItems(ex, s)[0] as { options: { en: string }[]; answer: number };
      expect(it0.options[it0.answer].en).toBe("c");
      seen.add(it0.options.map((o) => o.en).join(""));
    }
    expect(seen.size).toBeGreaterThan(1);
    const keep = Exercise.parse({ id: "T-098-2", type: "mcq", prompt: { en: "q", sr: "q" }, options: ["1", "2", "3"], answer: 1, keepOrder: true });
    expect((generateItems(keep, "x")[0] as { options: { en: string }[] }).options.map((o) => o.en)).toEqual(["1", "2", "3"]);
  });
  it("Serbian syllable check (syllabic r)", () => {
    expect(runCheck({ syllables: { text: "Srce moje, crveni trn", lang: "sr", is: 8 } })).toBeNull();
    expect(runCheck({ syllables: { text: "Mladi momak konja izvodio", lang: "sr", is: 10 } })).toBeNull();
    expect(runCheck({ syllables: { text: "prst", lang: "sr", is: 2 } })).toMatch(/has 1/);
  });
});

describe("rhythm cells, triplets, written rhythm timing", () => {
  it("cells keep groups whole and triplets are written as triplets", () => {
    const ex = Exercise.parse({ id: "E-097-1", type: "generated", prompt: { en: "r", sr: "r" }, count: 6, gen: { kind: "rhythm-echo", meter: "4/4", bars: 2, cells: [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5], [1]] } });
    for (const x of generateItems(ex, "s")) {
      const m = x as MidiItem;
      expect((m.play!.durations ?? []).reduce((a, b) => a + b, 0)).toBeCloseTo(8 + 4); // + count-in bar
      if ((m.play!.durations ?? []).some((d) => Math.abs(d - 1 / 3) < 1e-6)) expect(m.abc).toContain("(3B2B2B2");
    }
    const hidden = Exercise.parse({ id: "E-097-2", type: "generated", prompt: { en: "r", sr: "r" }, count: 1, gen: { kind: "rhythm-echo", values: [1], showAbc: false } });
    expect(generateItems(hidden, "s")[0].abc).toBeUndefined();
  });
  it("static echo with beats: plays the rhythm and grades timing against it", async () => {
    const { grade } = await import("@/lib/grading");
    const ex = Exercise.parse({ id: "E-097-3", type: "midi-echo", prompt: { en: "p", sr: "p" }, mode: "sequence", expect: ["E4", "E4", "F4", "G4", "G4"], beats: [1.5, 0.5, 1, 1, 2], tempo: 90 });
    const it0 = generateItems(ex, "s")[0] as MidiItem;
    expect(it0.play!.durations).toEqual([1.5, 0.5, 1, 1, 2]);
    expect(it0.rhythm).toEqual([0, 1.5, 2, 3, 4]);
    const beat = 600;
    const ok = it0.rhythm!.flatMap((b, i) => [{ t: b * beat, type: "on" as const, note: it0.expect[i] }]);
    const even = it0.expect.map((n, i) => ({ t: i * beat, type: "on" as const, note: n }));
    expect(grade(it0, { kind: "midi", events: ok }).score).toBe(1);
    expect(grade(it0, { kind: "midi", events: even }).score).toBeLessThan(0.95);
  });
});

import { fitToRange } from "@/lib/curriculum/items";
describe("voice engine fixes", () => {
  it("sing-phrase: rests in the layout, rhythm in playback, written spelling kept", () => {
    const ex = Exercise.parse({ id: "V-097-1", type: "sing-phrase", prompt: { en: "p", sr: "p" }, notes: ["Bb3", "r", "C4", "D4"], beats: [1, 1, 1, 2], tempo: 80 });
    const it0 = generateItems(ex, "s", undefined, { voiceRange: [55, 67] })[0] as { targets: number[]; layout: { midi?: number; beats: number }[]; play: { notes: number[]; durations: number[] }; noteLabels: { en: string } };
    expect(it0.targets.length).toBe(3);
    expect(it0.layout.map((e) => e.midi == null)).toEqual([false, true, false, false]);
    expect(it0.play.durations).toEqual([1, 1, 1, 2]);
    expect(it0.play.notes[1]).toBe(-1);
    expect(it0.noteLabels.en).toMatch(/^Bb/);
  });
  it("fitRange low/high place the phrase towards that end", () => {
    expect(fitToRange([60, 62, 64], [45, 72], "low")).toEqual([48, 50, 52]);
    expect(fitToRange([60, 62, 64], [45, 72], "high")).toEqual([60, 62, 64]);
    expect(fitToRange([48, 50], [45, 72], "high")).toEqual([72, 74]); // may reach 2 above the comfortable top
    expect(fitToRange([60, 64, 67], [45, 65], "high")).toEqual([60, 64, 67]); // head-voice phrase stays up (G4 = top + 2)
  });
  it("octave pitch-match does not fail on a range narrower than an octave", () => {
    const ex = Exercise.parse({ id: "V-097-2", type: "generated", prompt: { en: "p", sr: "p" }, count: 3, gen: { kind: "pitch-match", intervals: ["P8"] } });
    expect(generateItems(ex, "s", undefined, { voiceRange: [50, 58] }).length).toBe(3);
  });
});

import { smoothVoicing } from "@/lib/curriculum/items";
import { romanChord } from "@/lib/music/harmony";
import { noteStr } from "@/lib/music/pitch";
describe("smooth voicing", () => {
  it("I-IV-V-I in C: bass on roots, upper voices move by step or stay", () => {
    const v = smoothVoicing(["I", "IV", "V", "I"].map((r) => romanChord("C4", "major", r)));
    expect(v.map((c) => noteStr(c[0]))).toEqual(["C3", "F3", "G3", "C3"]);
    for (let i = 1; i < v.length; i++) {
      const moves = v[i].slice(1).map((n, k) => Math.abs(toM(n) - toM(v[i - 1][k + 1])));
      expect(Math.max(...moves)).toBeLessThanOrEqual(4); // at most a (major) third: smooth
      expect(moves.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(6);
      // no parallel perfect 5ths/8ves between any two voices
      const a = v[i - 1].map(toM), b = v[i].map(toM);
      for (let x = 0; x < 4; x++) for (let y = x + 1; y < 4; y++) {
        const i0 = (((a[y] - a[x]) % 12) + 12) % 12, i1 = (((b[y] - b[x]) % 12) + 12) % 12;
        const same = a[x] !== b[x] && a[y] !== b[y] && Math.sign(b[x] - a[x]) === Math.sign(b[y] - a[y]);
        expect(same && i0 === i1 && (i0 === 0 || i0 === 7), `parallel in ${i}: ${x}-${y}`).toBe(false);
      }
    }
  });
});
import { toMidi as toM } from "@/lib/music/pitch";

import { checkAbc } from "@/lib/curriculum/validate";
describe("ABC validation", () => {
  it("passes clean ABC with matching lyrics; flags bad syntax and syllable mismatches", () => {
    expect(checkAbc("X:1\nM:4/4\nL:1/4\nK:C\nC D E F | G4 |]\nw: Twin-kle twin-kle star", "t")).toEqual([]);
    expect(checkAbc("X:1\nK:C\nC D ^^^ E |]", "t").join()).toMatch(/Unknown character/);
    expect(checkAbc("X:1\nM:4/4\nL:1/4\nK:C\nC D E F | G4 |]\nw: Twin-kle twin-kle", "t").join()).toMatch(/4 syllables for 5 notes/);
    expect(checkAbc("X:1\nM:4/4\nL:1/4\nK:C\nC D E F | G4 |]\nw: Twin-kle_ twin-kle", "t")).toEqual([]); // explicit hold: trusted
  });
});

describe("accompaniment follows the singer's octave", () => {
  it("accompany moves by the same octave shift as the sung targets", () => {
    const ex = Exercise.parse({ id: "V-096-1", type: "sing-phrase", prompt: { en: "p", sr: "p" }, notes: ["E4", "F4", "G4"], accompany: { notes: ["C4", "D4", "E4"], mode: "melodic" } });
    const low = generateItems(ex, "s", undefined, { voiceRange: [45, 57] })[0] as { targets: number[]; play: { notes: number[] } };
    expect(low.targets).toEqual([52, 53, 55]); // an octave down
    expect(low.play.notes).toEqual([48, 50, 52]); // the melody too
  });
});

describe("smooth voicing edge cases + inverted bass lines", () => {
  it("no upper voice in unison with (or below) the bass", () => {
    const v = smoothVoicing(["I", "vi", "IV", "V"].map((r) => romanChord("D4", "major", r)));
    for (const c of v) for (const n of c.slice(1)) expect(toM(n)).toBeGreaterThan(toM(c[0]));
  });
  it("bass-echo honours inversion figures", () => {
    const ex = Exercise.parse({ id: "E-096-1", type: "generated", prompt: { en: "b", sr: "b" }, count: 1, gen: { kind: "bass-echo", keys: ["C"], numerals: ["I", "V6"], line: ["I", "V6", "I"], octave: 3 } });
    const it0 = generateItems(ex, "s")[0] as MidiItem;
    expect(it0.expect.map((m) => m % 12)).toEqual([0, 11, 0]); // C, B (3rd of V), C
  });
});

describe("smooth voicing doubling", () => {
  it("V6 never doubles the leading tone; I64 doubles the bass", () => {
    const v = smoothVoicing(["I", "V6", "I"].map((r) => romanChord("C4", "major", r)));
    const v6 = v[1].map((n) => toM(n) % 12);
    expect(v6[0]).toBe(11); // B in the bass
    expect(v6.filter((p) => p === 11).length).toBe(1); // ... and only there
    const k64 = smoothVoicing(["I64", "V7", "I"].map((r) => romanChord("C4", "major", r)))[0].map((n) => toM(n) % 12);
    expect(k64.filter((p) => p === 7).length).toBe(2); // G doubled
  });
});
