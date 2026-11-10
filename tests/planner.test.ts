import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// Fixture curriculum: T-001..T-004 (10 min each), E-001 (needs T-002), K-001, warm-up.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-cur-"));
const lesson = (id: string, track: string, order: number, prereqs: string[], tags: string[] = [], minutes = 10) =>
  JSON.stringify({ id, track, order, title: { en: id, sr: id + " sr" }, prereqs, minutes, tags, explain: { en: "x", sr: "x" },
    exercises: [{ id: `${id}-1`, type: "mcq", prompt: { en: "q", sr: "q" }, options: ["a", "b"], answer: 0, keepOrder: true }] });
fs.writeFileSync(path.join(dir, "T1.json"), lesson("T-001", "T", 1, []));
fs.writeFileSync(path.join(dir, "T2.json"), lesson("T-002", "T", 2, ["T-001"]));
fs.writeFileSync(path.join(dir, "T3.json"), lesson("T-003", "T", 3, ["T-002"]));
fs.writeFileSync(path.join(dir, "T4.json"), lesson("T-004", "T", 4, ["T-003"]));
fs.writeFileSync(path.join(dir, "E1.json"), lesson("E-001", "E", 1, ["T-002"]));
fs.writeFileSync(path.join(dir, "K1.json"), lesson("K-001", "K", 1, []));
fs.writeFileSync(path.join(dir, "V0.json"), lesson("V-001", "V", 1, [], ["maintenance", "warmup"], 4));
process.env.MT_CURRICULUM_DIR = dir;

const { setDb, migrate } = await import("@/lib/server/db");
const { buildPlan, weekdayOf } = await import("@/lib/server/planner");
const { updateSettings, getSettings } = await import("@/lib/server/settings");
const { submit, sm2, finishPlacement } = await import("@/lib/server/progress");

beforeEach(() => {
  const conn = new Database(":memory:");
  migrate(conn, os.tmpdir());
  setDb(conn);
});

// 2026-11-09 is a Monday.
describe("planner", () => {
  it("weekday mapping", () => {
    expect(weekdayOf("2026-11-09")).toBe("mon");
    expect(weekdayOf("2026-11-15")).toBe("sun");
  });
  it("placement first, until done or skipped", () => {
    expect(buildPlan("2026-11-09").kind).toBe("placement");
    updateSettings({ placementSkipped: true });
    expect(buildPlan("2026-11-09").kind).toBe("focus");
  });
  it("Monday = theory, chained lessons up to the focus target", () => {
    updateSettings({ placementSkipped: true, focusMinutes: 30 });
    const p = buildPlan("2026-11-09");
    expect(p.focusUsed).toEqual(["T"]);
    expect(p.lessons.map((l) => l.id)).toEqual(["T-001", "T-002", "T-003"]);
    expect(p.maintenance?.warmup).toBe("V-001");
  });
  it("Tuesday = E/K interleaved; cross-track prereq is soft and flagged", () => {
    updateSettings({ placementSkipped: true, focusMinutes: 25 });
    const p = buildPlan("2026-11-10");
    expect(p.lessons.map((l) => l.id).sort()).toEqual(["E-001", "K-001"]);
    expect(p.lessons.find((l) => l.id === "E-001")?.aheadOfTheory).toEqual(["T-002"]);
  });
  it("Wednesday = voice with no content falls back with a note", () => {
    updateSettings({ placementSkipped: true });
    const p = buildPlan("2026-11-11");
    expect(p.focusUsed).not.toContain("V");
    expect(p.lessons.length).toBeGreaterThan(0);
    expect(p.note?.en).toMatch(/Voice/);
  });
  it("maintenance can be turned off", () => {
    updateSettings({ placementSkipped: true, maintenance: false });
    expect(buildPlan("2026-11-09").maintenance).toBeNull();
  });
  it("Sunday test needs passed lessons, else regular lessons", () => {
    updateSettings({ placementSkipped: true });
    expect(buildPlan("2026-11-15").kind).toBe("focus");
    submit({ uuid: "u1", date: "2026-11-15", context: "lesson", lessonId: "T-001", exerciseId: "T-001-1", seed: "x", responses: [{ itemId: "T-001-1#0", response: { kind: "mcq", choice: 0 } }] });
    const p = buildPlan("2026-11-15");
    expect(p.kind).toBe("test");
    expect(p.test?.exercises.map((e) => e.exerciseId)).toEqual(["T-001-1"]);
  });
  it("custom schedule is validated", () => {
    expect(() => updateSettings({ schedule: { ...getSettings().schedule, mon: ["X" as never] } })).toThrow();
  });
});

describe("progress + SRS", () => {
  it("passing all exercises passes the lesson, idempotent per uuid, and schedules review", () => {
    const s = { uuid: "u2", date: "2026-11-09", context: "lesson" as const, lessonId: "T-001", exerciseId: "T-001-1", seed: "x", responses: [{ itemId: "T-001-1#0", response: { kind: "mcq" as const, choice: 0 } }] };
    const r = submit(s);
    expect(r.pass).toBe(true);
    expect(r.lessonPassed).toBe(true);
    expect(r.srsDue).toBe("2026-11-10");
    expect(submit(s)).toEqual(r);
  });
  it("failure schedules for tomorrow and does not pass", () => {
    const r = submit({ uuid: "u3", date: "2026-11-09", context: "lesson", lessonId: "T-001", exerciseId: "T-001-1", seed: "x", responses: [{ itemId: "T-001-1#0", response: { kind: "mcq", choice: 1 } }] });
    expect(r.pass).toBe(false);
    expect(r.lessonPassed).toBe(false);
    expect(r.srsDue).toBe("2026-11-10");
  });
  it("sm2 intervals grow", () => {
    let c = { ease: 2.5, interval: 0, reps: 0, lapses: 0 };
    const iv: number[] = [];
    for (let i = 0; i < 4; i++) { c = sm2(c, 5); iv.push(c.interval); }
    expect(iv).toEqual([1, 3, 8, 22]);
  });
  it("placement skips respect prereq chains", () => {
    // placement not loaded in fixture; findExercise falls through, so skip nothing
    expect(finishPlacement([{ exerciseId: "nope", score: 1, pass: true }]).skipped).toEqual([]);
  });
});

describe("no piano today", () => {
  it("rebuilds the day with theory (or voice when theory is ahead), only for that day", async () => {
    const { setNoPiano, getPlan, buildPlan: bp } = await import("@/lib/server/planner");
    updateSettings({ placementSkipped: true, focusMinutes: 25 });
    const normal = getPlan("2026-11-10"); // Tuesday: E/K
    expect(normal.focusUsed).toEqual(["E", "K"]);
    const np = setNoPiano("2026-11-10", true);
    expect(np.noPiano).toBe(true);
    expect(np.focusUsed).toEqual(["T"]);
    expect(np.note?.sr).toMatch(/bez klavira/);
    expect(getPlan("2026-11-10").noPiano).toBe(true); // persisted for the day
    expect(bp("2026-11-17").focusUsed).toEqual(["E", "K"]); // next Tuesday untouched
    expect(setNoPiano("2026-11-10", false).focusUsed).toEqual(["E", "K"]);
  });
  it("needsPiano: midi exercises yes, mcq no", async () => {
    const { needsPiano } = await import("@/lib/curriculum/items");
    expect(needsPiano({ id: "K-001-1", type: "midi-play", prompt: { en: "x", sr: "x" }, pass: 0.8, checks: [], mode: "sequence", expect: ["C4"], octave: "exact", bass: false, showNotes: true })).toBe(true);
    expect(needsPiano({ id: "T-001-1", type: "mcq", prompt: { en: "x", sr: "x" }, pass: 0.8, checks: [], options: ["a", "b"], answer: 0, keepOrder: false })).toBe(false);
  });
});

describe("weekly test v2", () => {
  const mcq = (uuid: string, date: string, lesson: string, right: boolean) =>
    submit({ uuid, date, context: "lesson", lessonId: lesson, exerciseId: `${lesson}-1`, seed: "x", responses: [{ itemId: `${lesson}-1#0`, response: { kind: "mcq", choice: right ? 0 : 1 } }] });
  it("this week's lessons (most practised first) plus items failed earlier", async () => {
    const { weeklyTest, isoWeek } = await import("@/lib/server/planner");
    expect(isoWeek("2026-11-15")).toEqual({ week: "2026-W46", monday: "2026-11-09", sunday: "2026-11-15" });
    expect(isoWeek("2027-01-01").week).toBe("2026-W53");
    mcq("w0", "2026-11-03", "T-003", false); // last week, failed -> SRS lapse
    mcq("w1", "2026-11-10", "T-001", true);
    mcq("w2", "2026-11-11", "T-002", true);
    mcq("w3", "2026-11-12", "T-002", true);
    const t = weeklyTest("2026-11-15").exercises;
    expect(t).toEqual([
      { exerciseId: "T-002-1", lessonId: "T-002", source: "week" },
      { exerciseId: "T-001-1", lessonId: "T-001", source: "week" },
      { exerciseId: "T-003-1", lessonId: "T-003", source: "review" },
    ]);
  });
});

describe("practice fill", () => {
  it("tops up a short day with drills from passed lessons (generated exercises only)", async () => {
    const { practiceFill } = await import("@/lib/server/planner");
    // fixture lessons are mcq-only (no generated exercises): nothing to drill
    expect(practiceFill(["T"], 30, "2026-11-20")).toEqual([]);
    expect(practiceFill(["T"], 3, "2026-11-20")).toEqual([]);
  });
});

describe("belt daily cap", () => {
  it("belt lessons share the distortion cap", async () => {
    const { distortionBlocked } = await import("@/lib/server/planner");
    expect(distortionBlocked("T-001", "2026-11-20")).toBeNull(); // not a belt lesson
  });
});
