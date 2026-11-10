import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

process.env.MT_CURRICULUM_DIR = path.join(import.meta.dirname, "..", "curriculum");
const { setDb, migrate } = await import("@/lib/server/db");
const { submit, finalizePlacement, completePlacementSection, placementStatus, lessonStatuses, placementDone } = await import("@/lib/server/progress");
const { getSettings, updateSettings } = await import("@/lib/server/settings");
const { buildPlan } = await import("@/lib/server/planner");
const { generateItems } = await import("@/lib/curriculum/items");
const { loadCurriculum } = await import("@/lib/curriculum/loader");
import type { Response } from "@/lib/grading";

const c = loadCurriculum(process.env.MT_CURRICULUM_DIR!);
const sec = (id: string) => c.placement!.sections.find((s) => s.id === id)!;

/** Answer a placement exercise right or wrong through the real submit path. */
function answer(exId: string, right: boolean, n: number) {
  const ex = c.placement!.sections.flatMap((s) => s.exercises).find((e) => e.id === exId)!;
  const items = generateItems(ex, "2026-11-10:0");
  const responses = items.map((it) => {
    let r: Response;
    if (it.kind === "mcq") r = { kind: "mcq", choice: right ? it.answer : (it.answer + 1) % it.options.length };
    else if (it.kind === "names") r = { kind: "names", text: right ? it.expect.join(" ") : "C C C", locale: "en" };
    else if (it.kind === "midi") {
      const notes = it.mode === "chords" ? it.expectChords!.flat() : it.expect;
      r = { kind: "midi", events: notes.flatMap((m, i) => [{ t: i * 700, type: "on" as const, note: right ? m : m + 1 }, { t: i * 700 + 500, type: "off" as const, note: right ? m : m + 1 }]) };
    } else throw new Error(it.kind);
    return { itemId: it.id, response: r };
  });
  return submit({ uuid: `u-${exId}-${n}`, date: "2026-11-10", context: "placement", lessonId: null, exerciseId: exId, seed: "2026-11-10:0", responses });
}

beforeAll(() => {
  const conn = new Database(":memory:");
  migrate(conn, os.tmpdir());
  setDb(conn);
});

describe("placement: do a section later (Bogdan, 2026-11-10)", () => {
  it("notation right + theory wrong, ear deferred: finalizes from stored attempts, ear pending", () => {
    let n = 0;
    for (const e of sec("notation").exercises) answer(e.id, true, n++);
    for (const e of sec("theory").exercises) answer(e.id, false, n++);
    const st = placementStatus();
    expect(st.finished).toBe(false);
    expect(st.sections.find((s) => s.id === "theory")!.done.length).toBe(sec("theory").exercises.length);
    expect(st.sections.find((s) => s.id === "ear")!.done.length).toBe(0);
    expect(buildPlan("2026-11-11").kind).toBe("placement");

    const r = finalizePlacement(["ear"]);
    expect(r.skipped).toEqual(["T-001"]);
    expect(r.deferred).toEqual(["ear"]);
    expect(placementDone()).toBe(true);
    expect(getSettings().placementPending).toEqual(["ear"]);
    // the planner no longer blocks on placement; ear is unplaced: E starts at E-001
    updateSettings({ focusMinutes: 35 });
    const plan = buildPlan("2026-11-11"); // Wednesday (V) falls back to another track; check Tuesday-like E day
    expect(plan.kind).not.toBe("placement");
    const tue = buildPlan("2026-11-17");
    expect(tue.lessons.map((l) => l.id)).toContain("E-001");
    expect(lessonStatuses().get("E-001")).toBeUndefined();
  });

  it("the deferred ear section done later applies its skips and clears pending", () => {
    let n = 100;
    for (const e of sec("ear").exercises) answer(e.id, e.id === "P-003-1", n++);
    const r = completePlacementSection("ear");
    expect(r.skipped).toEqual(["E-001"]);
    expect(r.deferred).toEqual([]);
    expect(getSettings().placementPending).toEqual([]);
    expect(lessonStatuses().get("E-001")?.status).toBe("skipped");
    expect(lessonStatuses().get("T-001")?.status).toBe("skipped"); // earlier sections untouched
  });

  it("the latest attempt of an exercise wins (a redo counts)", () => {
    answer("P-002-1", true, 999);
    const st = placementStatus();
    expect(st.pending).toEqual([]);
  });
});
