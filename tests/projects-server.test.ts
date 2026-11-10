import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const repo = path.join(import.meta.dirname, "..");
process.env.MT_CURRICULUM_DIR = path.join(repo, "curriculum");
process.env.MT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mt-proj-"));
process.env.MT_CLAUDE_BIN = path.join(repo, "tests/fixtures/fake-claude.py");
process.env.MT_WORKER_DIR = path.join(repo, "worker");
const DEV_VENV = "/mnt/offload/music-trainer/worker-venv";
if (fs.existsSync(DEV_VENV)) process.env.MT_WORKER_VENV = DEV_VENV;

const { setDb, migrate, getDb } = await import("@/lib/server/db");
const { weekProject, submitProject, getProject } = await import("@/lib/server/projects");
const { tick, enqueue, registerJob, MAX_ATTEMPTS } = await import("@/lib/server/jobs");
const { runRules } = await import("@/lib/server/rules");
const { extractJson, rubricScore } = await import("@/lib/server/claude");
const { loadCurriculum } = await import("@/lib/curriculum/loader");

const c = loadCurriculum(process.env.MT_CURRICULUM_DIR!);
const workerUp = (await runRules({ abc: "X:1\nM:4/4\nL:1/4\nK:C\nC D E C |]", key: "C major", meter: "4/4", bars: 1, rules: ["bars"] })).ok;

beforeAll(() => {
  const conn = new Database(":memory:");
  migrate(conn, os.tmpdir());
  setDb(conn);
});
beforeEach(() => {
  process.env.FAKE_CLAUDE_MODE = "ok";
  process.env.MT_CLAUDE_BIN = path.join(repo, "tests/fixtures/fake-claude.py");
});

/** Run due jobs ignoring backoff (tests do not wait minutes). */
async function drain() {
  for (let i = 0; i < 10; i++) {
    getDb().prepare("UPDATE jobs SET next_run_at = 0 WHERE status IN ('queued','waiting')").run();
    if (!(await tick())) break;
  }
}

const self = (id: string, v = 2) => Object.fromEntries(c.projects.find((p) => p.id === id)!.rubric.map((r) => [r.id, v]));

describe("weekly projects", () => {
  it("rotates composition -> lyrics -> vocal -> by-ear by ISO week, stable within a week", () => {
    const kinds = ["2026-11-10", "2026-11-17", "2026-11-24", "2026-12-01", "2026-12-08"].map((d) => weekProject(d)!.row.kind);
    expect(kinds).toEqual(["composition", "lyrics", "vocal", "byear", "composition"]);
    expect(weekProject("2026-11-15")!.row.id).toBe(weekProject("2026-11-10")!.row.id);
    expect(weekProject("2026-12-08")!.def.id).toBe("PC-002"); // second composition, not a repeat
  });

  it.skipIf(!workerUp)("composition: music21 rules now, claude review later; provisional -> final", async () => {
    const wp = weekProject("2026-11-10")!;
    const abc = "X:1\nM:4/4\nL:1/4\nK:C\nC D E F | G2 E C | D E F A | G4 | E F G E | A G F E | D E D B, | C4 |]";
    let p = (await submitProject(wp.row.id, { kind: "composition", abc, self: self(wp.def.id, 2), locale: "en", notes: "first try" }))!;
    expect(p.status).toBe("submitted");
    expect(p.ai_status).toBe("pending");
    expect(p.final).toBe(0);
    expect(p.auto.rules.ok).toBe(true);
    const ruleIds = p.auto.rules.checks.map((k: { id: string }) => k.id);
    expect(ruleIds).toContain("half-cadence");
    const provisional = p.score!;
    await drain();
    p = getProject(wp.row.id)!;
    expect(p.ai_status).toBe("done");
    expect(p.final).toBe(1);
    expect(p.ai.criteria.every((k: { score: number }) => k.score === 3)).toBe(true);
    expect(p.score).not.toBe(provisional); // self 2/4 replaced by review 3/4
  });

  it("lyrics: review unavailable keeps the self-assessed provisional grade and waits", async () => {
    const wp = weekProject("2026-11-17")!;
    process.env.MT_CLAUDE_BIN = "/nonexistent/claude";
    let p = (await submitProject(wp.row.id, { kind: "lyrics", text: "[Verse]\nline one here\nline two there", language: "en", self: self(wp.def.id, 4), locale: "sr" }))!;
    expect(p.score).toBe(1); // self 4/4
    await drain();
    p = getProject(wp.row.id)!;
    expect(p.ai_status).toBe("unavailable");
    expect(p.final).toBe(0);
    expect(p.jobs[0].status).toBe("waiting");
    // claude comes back: the waiting job runs on its next turn
    process.env.MT_CLAUDE_BIN = path.join(repo, "tests/fixtures/fake-claude.py");
    await drain();
    p = getProject(wp.row.id)!;
    expect(p.ai_status).toBe("done");
    expect(p.score).toBe(0.75);
  });

  it("garbage replies are retried, then fail permanently; the self-assessment stands", async () => {
    process.env.FAKE_CLAUDE_MODE = "garbage";
    const id = getDb().prepare("SELECT id FROM projects WHERE kind='lyrics'").get() as { id: string };
    await submitProject(id.id, { kind: "lyrics", text: "a\nb\nc", language: "en", self: self("PL-001", 1), locale: "en" });
    await drain();
    const p = getProject(id.id)!;
    expect(p.jobs.at(-1)!.status).toBe("failed");
    expect(p.jobs.at(-1)!.attempts).toBe(MAX_ATTEMPTS);
    expect(p.ai_status).toBe("failed");
    expect(p.status).toBe("graded");
  });

  it("a resubmission supersedes the pending review of the old one", async () => {
    const id = (getDb().prepare("SELECT id FROM projects WHERE kind='lyrics'").get() as { id: string }).id;
    process.env.MT_CLAUDE_BIN = "/nonexistent/claude";
    await submitProject(id, { kind: "lyrics", text: "old", language: "en", self: self("PL-001", 1), locale: "en" });
    await new Promise((r) => setTimeout(r, 5));
    process.env.MT_CLAUDE_BIN = path.join(repo, "tests/fixtures/fake-claude.py");
    await submitProject(id, { kind: "lyrics", text: "new", language: "en", self: self("PL-001", 1), locale: "en" });
    await drain();
    const p = getProject(id)!;
    expect(p.submission.text).toBe("new");
    expect(p.ai_status).toBe("done");
  });

  it("by-ear: graded immediately from MIDI, key-independent", async () => {
    const wp = weekProject("2026-12-01")!;
    if (wp.def.kind !== "byear") throw new Error("expected byear");
    const m = wp.def.melody;
    const { melodyLayout } = await import("@/lib/projects");
    let t = 0;
    const evs = melodyLayout(m).flatMap((e) => {
      const on = t;
      t += e.beats * 500;
      return e.midi == null ? [] : [{ t: on, type: "on" as const, note: e.midi + 3 }, { t: t - 30, type: "off" as const, note: e.midi + 3 }];
    });
    const p = (await submitProject(wp.row.id, { kind: "byear", events: evs, self: self(wp.def.id, 4), locale: "en" }))!;
    expect(p.final).toBe(1);
    expect(p.auto.pitch).toBe(1);
    expect(p.auto.transpose).toBe(3);
    expect(p.score).toBeGreaterThan(0.95);
  });

  it("job queue: claims atomically and backs off", async () => {
    let calls = 0;
    registerJob("flaky", async () => (++calls < 2 ? { ok: false, error: "boom" } : { ok: true, result: 42 }));
    enqueue("flaky", "x", {});
    await drain();
    const j = getDb().prepare("SELECT status, attempts, result FROM jobs WHERE kind='flaky'").get();
    expect(j).toEqual({ status: "done", attempts: 2, result: "42" });
  });

  it("helpers", () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(rubricScore([{ id: "a", weight: 1, label: { en: "", sr: "" }, top: { en: "", sr: "" } }, { id: "b", weight: 3, label: { en: "", sr: "" }, top: { en: "", sr: "" } }], { a: 4, b: 0 })).toBe(0.25);
  });
});
