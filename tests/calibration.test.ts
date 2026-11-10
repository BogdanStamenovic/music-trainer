import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// fixture curriculum: one T lesson with two mcq exercises (10 min estimate)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-cal-"));
fs.writeFileSync(path.join(dir, "T1.json"), JSON.stringify({ id: "T-001", track: "T", order: 1, title: { en: "t", sr: "t s" }, prereqs: [], minutes: 10, tags: [], explain: { en: "x", sr: "x" },
  exercises: [1, 2].map((n) => ({ id: `T-001-${n}`, type: "mcq", prompt: { en: "q", sr: "q" }, options: ["a", "b"], answer: 0, keepOrder: true })) }));
process.env.MT_CURRICULUM_DIR = dir;
const { setDb, migrate } = await import("@/lib/server/db");
const { submit, logEvent } = await import("@/lib/server/progress");
const { setNoPiano } = await import("@/lib/server/planner");
const { updateSettings } = await import("@/lib/server/settings");
const { setVoiceDay } = await import("@/lib/server/recordings");
const { calibration } = await import("@/lib/server/calibration");

beforeAll(() => {
  const conn = new Database(":memory:");
  migrate(conn, os.tmpdir());
  setDb(conn);
  updateSettings({ placementSkipped: true });
});

const ans = (uuid: string, ex: string, right: boolean, ms: number, date = "2026-11-17") =>
  submit({ uuid, date, context: "lesson", lessonId: "T-001", exerciseId: ex, seed: "s", ms, responses: [{ itemId: `${ex}#0`, response: { kind: "mcq", choice: right ? 0 : 1 } }] });

describe("calibration view", () => {
  it("pace, retries, abandoned, no-piano and voice-rest days", () => {
    logEvent("2026-11-17", "lesson_open", "T-001", null);
    logEvent("2026-11-17", "exercise_start", "T-001", "T-001-1");
    ans("a1", "T-001-1", false, 120_000);
    logEvent("2026-11-17", "exercise_start", "T-001", "T-001-1");
    ans("a2", "T-001-1", true, 90_000);
    logEvent("2026-11-17", "exercise_start", "T-001", "T-001-2");
    ans("a3", "T-001-2", true, 390_000);
    logEvent("2026-11-18", "exercise_start", "T-001", "T-001-2"); // opened again next day, never submitted
    setNoPiano("2026-11-18", true);
    setVoiceDay("2026-11-19", "hoarse");
    const c = calibration();
    const l = c.lessons.find((x) => x.id === "T-001")!;
    expect(l.status).toBe("passed");
    expect(l.submissions).toBe(3);
    expect(l.retries).toBe(1);
    expect(l.passRate).toBeCloseTo(0.67, 2);
    expect(l.actualMin).toBe(10); // 120+90+390 s
    expect(l.abandoned).toBe(1);
    expect(l.hardest[0].id).toBe("T-001-1");
    expect(c.pace.T).toEqual({ lessons: 1, est: 10, actual: 10, ratio: 1 });
    expect(c.totals.noPianoDays).toBe(1);
    expect(c.totals.voiceRestDays).toBe(1);
    expect(c.days.find((d) => d.date === "2026-11-18")?.noPiano).toBe(true);
  });
});
