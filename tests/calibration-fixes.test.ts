import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// Fixture: five short new V lessons, one passed T lesson with a generated drill (practice fill),
// and a T lesson with an ear drill that must not gate it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-fix-"));
const mcq = (id: string) => ({ id, type: "mcq", prompt: { en: "q", sr: "q" }, options: ["a", "b"], answer: 0, keepOrder: true });
const lesson = (id: string, track: string, order: number, exercises: unknown[], minutes = 5) =>
  JSON.stringify({ id, track, order, title: { en: id, sr: id + " sr" }, prereqs: [], minutes, tags: [], explain: { en: "x", sr: "x" }, exercises });
for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(dir, `V${i}.json`), lesson(`V-00${i}`, "V", i, [mcq(`V-00${i}-1`)]));
fs.writeFileSync(path.join(dir, "T1.json"), lesson("T-001", "T", 1, [mcq("T-001-1"), { id: "T-001-2", type: "generated", prompt: { en: "q", sr: "q" }, count: 3, gen: { kind: "semitones", maxSemitones: 4 } }], 10));
fs.writeFileSync(
  path.join(dir, "T2.json"),
  lesson("T-002", "T", 2, [mcq("T-002-1"), { id: "T-002-2", type: "generated", prompt: { en: "q", sr: "q" }, count: 2, gen: { kind: "interval-ear", intervals: ["m3", "M3"], direction: "up", cue: "triad" } }], 10),
);
process.env.MT_CURRICULUM_DIR = dir;

const { setDb, migrate } = await import("@/lib/server/db");
const { buildPlan } = await import("@/lib/server/planner");
const { updateSettings } = await import("@/lib/server/settings");
const { submit, markLessons, lessonStatuses } = await import("@/lib/server/progress");
const { generateItems, gatesLesson } = await import("@/lib/curriculum/items");
const { getCurriculum } = await import("@/lib/curriculum/loader");

beforeEach(() => {
  const conn = new Database(":memory:");
  migrate(conn, os.tmpdir());
  setDb(conn);
  updateSettings({ placementSkipped: true });
});

describe("new voice lessons per day are capped", () => {
  it("default 3 on a V day; the spare time goes to T/E practice, not voice", () => {
    markLessons(["T-001", "T-002"], "passed", "lesson");
    const p = buildPlan("2026-11-11"); // Wednesday = V
    expect(p.lessons.filter((l) => l.track === "V").map((l) => l.id)).toEqual(["V-001", "V-002", "V-003"]);
    expect(p.practice?.length).toBeGreaterThan(0);
    expect(p.practice!.every((x) => !x.lessonId.startsWith("V"))).toBe(true);
  });
  it("is a setting (1..10)", () => {
    updateSettings({ maxNewVoiceLessons: 1 });
    expect(buildPlan("2026-11-11").lessons.filter((l) => l.track === "V")).toHaveLength(1);
    expect(updateSettings({ maxNewVoiceLessons: 99 }).maxNewVoiceLessons).toBe(10);
  });
});

describe("ear drills don't gate non-E lessons", () => {
  it("T lesson passes without its ear drill; the drill is still graded", () => {
    const ex = getCurriculum().byId.get("T-002")!.exercises;
    expect(gatesLesson(ex[0], "T")).toBe(true);
    expect(gatesLesson(ex[1], "T")).toBe(false);
    expect(gatesLesson(ex[1], "E")).toBe(true);
    expect(gatesLesson({ ...ex[1], gate: true } as typeof ex[1], "T")).toBe(true);
    const items = generateItems(ex[1], "s");
    const wrong = items.map((it) => ({ itemId: it.id, response: { kind: "mcq" as const, choice: it.kind === "mcq" ? 1 - it.answer : 0 } }));
    const r = submit({ uuid: "e1", date: "2026-11-12", context: "lesson", lessonId: "T-002", exerciseId: "T-002-2", seed: "s", count: 2, responses: wrong });
    expect(r.pass).toBe(false);
    expect(r.srsDue).toBeDefined();
    expect(lessonStatuses().get("T-002")?.status).not.toBe("passed");
    submit({ uuid: "e2", date: "2026-11-12", context: "lesson", lessonId: "T-002", exerciseId: "T-002-1", seed: "s", responses: [{ itemId: "T-002-1#0", response: { kind: "mcq", choice: 0 } }] });
    expect(lessonStatuses().get("T-002")?.status).toBe("passed");
  });
});

describe("interval-ear: triad cue and compare data", () => {
  it("plays the matching triad, then root and 3rd; compare covers every option", () => {
    const ex = getCurriculum().byId.get("T-002")!.exercises[1];
    for (const it of generateItems(ex, "seed-x", 8)) {
      if (it.kind !== "mcq") throw new Error("mcq expected");
      const [triad, rest, root, third] = it.play!.chords!;
      expect(rest).toEqual([]);
      expect(triad[0]).toBe(root[0]);
      expect(third[0] - root[0]).toBe(it.options[it.answer].en.includes("major") ? 4 : 3);
      expect(triad[1]).toBe(third[0]); // the 3rd heard is the chord's 3rd
      expect(it.compare).toHaveLength(2);
      const sizes = it.compare!.map((c) => c!.play.notes![1] - c!.play.notes![0]).sort();
      expect(sizes).toEqual([3, 4]);
    }
  });
  it("rejects the cue for intervals other than 3rds", () => {
    const bad = { id: "T-002-9", type: "generated", prompt: { en: "q", sr: "q" }, count: 2, pass: 0.8, checks: [], gen: { kind: "interval-ear", intervals: ["P4", "P5"], direction: "up", answer: "choose", cue: "triad" } };
    expect(() => generateItems(bad as never, "s")).toThrow(/m3\/M3/);
  });
});
