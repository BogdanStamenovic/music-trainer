import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-ng-"));
const mcq = (id: string) => ({ id, type: "mcq", prompt: { en: "q", sr: "q" }, options: ["a", "b"], answer: 0, keepOrder: true });
const lesson = (id: string, track: string, order: number, exercises: unknown[], minutes = 10, prereqs: string[] = []) =>
  JSON.stringify({ id, track, order, title: { en: id, sr: id }, prereqs, minutes, tags: [], explain: { en: "x", sr: "x" }, exercises });
fs.writeFileSync(path.join(dir, "E1.json"), lesson("E-001", "E", 1, [mcq("E-001-1"), mcq("E-001-2")], 12));
fs.writeFileSync(path.join(dir, "E2.json"), lesson("E-002", "E", 2, [mcq("E-002-1")], 12, ["E-001"]));
fs.writeFileSync(path.join(dir, "E3.json"), lesson("E-003", "E", 3, [mcq("E-003-1")], 12, ["E-002"]));
fs.writeFileSync(path.join(dir, "E4.json"), lesson("E-004", "E", 4, [mcq("E-004-1")], 12, ["E-003"]));
fs.writeFileSync(path.join(dir, "K1.json"), lesson("K-001", "K", 1, [mcq("K-001-1")], 12));
fs.writeFileSync(path.join(dir, "K2.json"), lesson("K-002", "K", 2, [mcq("K-002-1")], 12, ["K-001"]));
fs.writeFileSync(path.join(dir, "K3.json"), lesson("K-003", "K", 3, [mcq("K-003-1")], 12, ["K-002"]));
fs.mkdirSync(path.join(dir, "projects"), { recursive: true });
process.env.MT_CURRICULUM_DIR = dir;

const { setDb, migrate, getDb } = await import("@/lib/server/db");
const { submit, lessonStatuses, logEvent } = await import("@/lib/server/progress");
const { buildPlan, catchUpTest, slowLastTime } = await import("@/lib/server/planner");
const { updateSettings } = await import("@/lib/server/settings");
const { overdueProject, resolveOverdue } = await import("@/lib/server/projects");

beforeEach(() => {
  const conn = new Database(":memory:");
  migrate(conn, os.tmpdir());
  setDb(conn);
  updateSettings({ placementSkipped: true });
});
let u = 0;
const ans = (ex: string, right: boolean, date = "2026-11-13", ms = 60_000, context: "lesson" | "test" = "lesson") =>
  submit({ uuid: `u${u++}`, date, context, lessonId: ex.slice(0, 5), exerciseId: ex, seed: "s", ms, responses: [{ itemId: `${ex}#0`, response: { kind: "mcq", choice: right ? 0 : 1 } }] });

describe("grind cap", () => {
  it("2 failed rounds in a sitting defer the drill; the lesson passes provisionally, then fully later", () => {
    expect(ans("E-001-1", false).deferred).toBeUndefined();
    expect(ans("E-001-1", false).deferred).toBe(true);
    const r = ans("E-001-2", true);
    expect(r.lessonPassed).toBe(true);
    expect(lessonStatuses().get("E-001")).toMatchObject({ status: "passed", source: "provisional" });
    ans("E-001-1", true, "2026-11-14"); // passed in a later review/lesson
    expect(lessonStatuses().get("E-001")?.source).toBe("lesson");
  });
  it("rounds are counted per day", () => {
    ans("E-001-1", false, "2026-11-13");
    expect(ans("E-001-1", false, "2026-11-14").deferred).toBeUndefined();
  });
});

describe("missed Sunday test", () => {
  it("offered during the next week, gone once taken or skipped, never older than last week", () => {
    ans("E-001-2", true, "2026-11-12"); // something practised in W46
    expect(catchUpTest("2026-11-17")?.sunday).toBe("2026-11-15");
    expect(catchUpTest("2026-11-15")).toBeNull(); // Sunday itself: the regular test
    expect(catchUpTest("2026-11-24")).toBeNull(); // the week after: nothing practised in W47, nothing carried
    logEvent("2026-11-17", "test_skip", null, null, { sunday: "2026-11-15" });
    expect(catchUpTest("2026-11-18")).toBeNull();
  });
  it("taking it this week clears it", () => {
    ans("E-001-2", true, "2026-11-12");
    ans("E-001-2", true, "2026-11-17", 1000, "test");
    expect(catchUpTest("2026-11-18")).toBeNull();
  });
});

describe("overdue project", () => {
  const ins = (id: string, week: string, status = "open") =>
    getDb().prepare("INSERT INTO projects(id, week, project_id, kind, assigned_at, status, updated_at) VALUES (?,?,?,?,?,?,?)").run(id, week, "PC-001", "composition", 1, status, 1);
  it("newest open one is offered; older ones are skipped quietly; continue moves it to this week", () => {
    ins("a", "2026-W45");
    ins("b", "2026-W46");
    expect(overdueProject("2026-11-17")?.id).toBe("b");
    expect((getDb().prepare("SELECT status FROM projects WHERE id='a'").get() as { status: string }).status).toBe("skipped");
    resolveOverdue("b", "continue", "2026-11-17");
    expect((getDb().prepare("SELECT week FROM projects WHERE id='b'").get() as { week: string }).week).toBe("2026-W47");
    expect(overdueProject("2026-11-17")).toBeNull();
  });
  it("skip marks it skipped", () => {
    ins("b", "2026-W46");
    resolveOverdue("b", "skip", "2026-11-17");
    expect(overdueProject("2026-11-17")).toBeNull();
    expect((getDb().prepare("SELECT status FROM projects WHERE id='b'").get() as { status: string }).status).toBe("skipped");
  });
});

describe("estimate sanity", () => {
  it("a day over 2x the estimate makes the next plan for those tracks lighter", () => {
    ans("E-001-1", true, "2026-11-13", 30 * 60_000); // 30 min on a 12-min lesson
    expect(slowLastTime(["E", "K"], "2026-11-17")).toMatchObject({ date: "2026-11-13", actual: 30, est: 12 });
    const p = buildPlan("2026-11-17"); // Tuesday = E + K
    expect(p.note?.en).toMatch(/lighter/);
    expect(p.lessons.reduce((a, l) => a + l.minutes, 0)).toBeLessThanOrEqual(24);
  });
  it("normal pace: no change", () => {
    ans("E-001-1", true, "2026-11-13", 10 * 60_000);
    expect(slowLastTime(["E", "K"], "2026-11-17")).toBeNull();
  });
});
