import { describe, it, expect } from "vitest";
import path from "node:path";
process.env.MT_CURRICULUM_DIR = path.join(process.cwd(), "curriculum");
const { getCurriculum } = await import("@/lib/curriculum/loader");
const { generateItems, harmonizeFits } = await import("@/lib/curriculum/items");
const { grade } = await import("@/lib/grading");
const { playEvents } = await import("@/lib/client/midi");
const { checkHarmonize } = await import("@/lib/curriculum/validate");

const ex = (id: string) => getCurriculum().byId.get(id.slice(0, 5))!.exercises.find((e) => e.id === id)!;

describe("harmonize", () => {
  it("fit rule: note on the change is a chord tone and chord tones fill half the slot", () => {
    const mary = ex("E-048-1") as Extract<ReturnType<typeof ex>, { type: "harmonize" }>;
    expect(harmonizeFits(mary, 6, "V")).toBe(true); // D D E D: E is a neighbour on beat 3
    expect(harmonizeFits(mary, 6, "I")).toBe(false); // D on the change
    expect(harmonizeFits(mary, 0, "IV")).toBe(false);
  });
  it("grades per slot: model and listed alternatives count", () => {
    const [it0] = generateItems(ex("E-048-3"), "s");
    if (it0.kind !== "harmonize") throw new Error("harmonize expected");
    const picks: (string | null)[] = [...it0.model];
    expect(grade(it0, { kind: "harmonize", picks }).score).toBe(1);
    picks[1] = "V"; // also fits (G G under V)
    expect(grade(it0, { kind: "harmonize", picks }).score).toBe(1);
    picks[2] = "I"; // A A under I does not
    expect(grade(it0, { kind: "harmonize", picks }).score).toBeCloseTo(7 / 8);
    picks[7] = null;
    expect(grade(it0, { kind: "harmonize", picks }).score).toBeCloseTo(6 / 8);
  });
  it("validation rejects a model that does not fit and a slot across a bar line", () => {
    const bad = { ...(ex("E-048-1") as never as Record<string, unknown>), model: ["I", "I", "I", "I", "I", "I", "V", "I"] };
    expect(checkHarmonize(bad as never, "x").join()).toMatch(/slot 3: I does not fit/);
    const cross = { ...(ex("E-048-1") as never as Record<string, unknown>), slots: [2, 4, 4, 4, 4, 4, 4, 6] };
    expect(checkHarmonize(cross as never, "x").join()).toMatch(/crosses a bar line/);
  });
});

describe("function-ear", () => {
  it("answer matches the chord played last; options keep the home/away/tension order", () => {
    for (const id of ["E-047-3", "E-047-4"])
      for (const it of generateItems(ex(id), "seed-f", 12)) {
        if (it.kind !== "mcq") throw new Error("mcq");
        expect(it.options.map((o) => o.en.match(/\((I|IV|V7)\)/)![1])).toEqual(["I", "IV", "V7"]);
        const target = ["I", "IV", "V7"][it.answer];
        expect(it.compare![it.answer]!.notes.en.endsWith(target)).toBe(true);
      }
  });
});

describe("layered playback", () => {
  it("melody and chords start together; melody louder", () => {
    const ev = playEvents({ mode: "layers", tempo: 60, layers: [{ mode: "melodic", notes: [60, 62], durations: [1, 1], tempo: 60 }, { mode: "chords", chords: [[48, 52, 55]], durations: [2], tempo: 60 }] });
    expect(ev.map((e) => e.at)).toEqual([0, 1, 0]);
    expect(ev[0].vel).toBeGreaterThan(ev[2].vel!);
  });
});
