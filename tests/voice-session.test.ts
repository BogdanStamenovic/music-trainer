import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-vs-"));
const v = (n: number) =>
  JSON.stringify({
    id: `V-00${n}`, track: "V", order: n, title: { en: "v", sr: "v" }, prereqs: [], minutes: 10, tags: [], explain: { en: "x", sr: "x" },
    exercises: [
      { id: `V-00${n}-1`, type: "checkin", prompt: { en: "q", sr: "q" } },
      { id: `V-00${n}-2`, type: "practice", role: "warmup", minutes: 2, prompt: { en: "Warm-up", sr: "Zagrevanje" } },
      { id: `V-00${n}-3`, type: "mcq", prompt: { en: "q", sr: "q" }, options: ["a", "b"], answer: 0, keepOrder: true },
      { id: `V-00${n}-4`, type: "practice", role: "cooldown", minutes: 1, prompt: { en: "Cool-down", sr: "Hlađenje" } },
    ],
  });
for (const n of [1, 2, 3]) fs.writeFileSync(path.join(dir, `V${n}.json`), v(n));
process.env.MT_CURRICULUM_DIR = dir;

const { setDb, migrate, getDb } = await import("@/lib/server/db");
const { submit, logEvent } = await import("@/lib/server/progress");
const { voiceSession } = await import("@/lib/server/voiceSession");
const { buildPlan } = await import("@/lib/server/planner");
const { updateSettings } = await import("@/lib/server/settings");

beforeEach(() => {
  const conn = new Database(":memory:");
  migrate(conn, os.tmpdir());
  setDb(conn);
  updateSettings({ placementSkipped: true });
});
const D = "2026-11-18";
const at = (kind: string, ms: number, lesson: string | null = "V-001") =>
  getDb().prepare("INSERT INTO events(at, date, kind, lesson_id, exercise_id, detail) VALUES (?,?,?,?,?,?)").run(ms, D, kind, lesson, null, "{}");

describe("singing session", () => {
  it("a lesson's warm-up submission is a session event; it stays valid within the window of the last voice activity", () => {
    submit({ uuid: "w1", date: D, context: "lesson", lessonId: "V-001", exerciseId: "V-001-2", seed: "s", ms: 120_000, responses: [{ itemId: "V-001-2#0", response: { kind: "practice", selfScore: 1 } }] });
    const kinds = getDb().prepare("SELECT kind, detail FROM events WHERE kind = 'voice_warmup'").all() as { detail: string }[];
    expect(kinds).toHaveLength(1);
    expect(JSON.parse(kinds[0].detail).ms).toBe(120_000);
    expect(voiceSession(D).warm).toBe(true);
  });
  it("window counts from the last voice activity; a cool-down ends the session", () => {
    at("voice_warmup", 1_000_000);
    at("exercise_done", 1_000_000 + 30 * 60_000); // singing 30 min later keeps it warm
    expect(voiceSession(D, 1_000_000 + 70 * 60_000, 45).warm).toBe(true);
    expect(voiceSession(D, 1_000_000 + 80 * 60_000, 45).warm).toBe(false);
    expect(voiceSession(D, 1_000_000 + 40 * 60_000, 45).needsCooldown).toBe(true);
    at("voice_cooldown", 1_000_000 + 41 * 60_000, null);
    const s = voiceSession(D, 1_000_000 + 42 * 60_000, 45);
    expect(s.warm).toBe(false);
    expect(s.needsCooldown).toBe(false);
  });
  it("planner counts the warm-up once per day", () => {
    const p = buildPlan("2026-11-18"); // Wednesday = V
    expect(p.lessons.map((l) => l.minutes)).toEqual([10, 8, 8]);
  });
});
