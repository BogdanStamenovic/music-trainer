import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Every compose exercise ships with a model answer; run each through the REAL music21
// worker with the exercise's own key/meter/bars/rules and require it to pass. This is
// what proves an exercise is passable. Skipped (loudly) when the worker venv is absent.
const repo = path.join(import.meta.dirname, "..");
process.env.MT_WORKER_DIR = path.join(repo, "worker");
const DEV_VENV = "/mnt/offload/music-trainer/worker-venv";
if (!process.env.MT_WORKER_VENV && fs.existsSync(DEV_VENV)) process.env.MT_WORKER_VENV = DEV_VENV;

const { runRules } = await import("@/lib/server/rules");
const { loadCurriculum } = await import("@/lib/curriculum/loader");
const { parseNote, toMidi } = await import("@/lib/music/pitch");
const c = loadCurriculum(path.join(repo, "curriculum"));
const compose = c.lessons.flatMap((l) => l.exercises).filter((e) => e.type === "compose");
const up = (await runRules({ abc: "X:1\nM:4/4\nL:1/4\nK:C\nC D E C |]", key: "C major", meter: "4/4", bars: 1, rules: ["bars"] })).ok;
if (!up) console.warn("[compose-examples] music21 worker unavailable: model answers NOT checked");

describe.skipIf(!up)("compose model answers pass their own rules", () => {
  for (const ex of compose) {
    it(ex.id, async () => {
      if (ex.type !== "compose" || !ex.example) throw new Error("missing example");
      const r = await runRules({ abc: ex.example, key: ex.key, meter: ex.meter, bars: ex.bars, rules: ex.rules, range: ex.range ? [toMidi(parseNote(ex.range[0])), toMidi(parseNote(ex.range[1]))] : undefined });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (r.ok) expect(r.score, JSON.stringify(r.checks.filter((k) => !k.pass))).toBeGreaterThanOrEqual(ex.pass);
    });
  }
});
