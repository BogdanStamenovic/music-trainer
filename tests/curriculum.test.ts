import { describe, it, expect } from "vitest";
import { loadCurriculum } from "@/lib/curriculum/loader";
import { generateItems } from "@/lib/curriculum/items";
import { grade } from "@/lib/grading";
import path from "node:path";

const c = loadCurriculum(path.join(import.meta.dirname, "..", "curriculum"));

describe("curriculum content", () => {
  it("loads with no schema, theory-check or generation errors", () => {
    expect(c.errors).toEqual([]);
  });
  it("every item is answerable: the correct answer grades 1.0", () => {
    const exercises = [...c.lessons.flatMap((l) => l.exercises), ...(c.placement?.sections.flatMap((s) => s.exercises) ?? [])];
    for (const ex of exercises)
      for (const seed of ["s1", "s2", "s3", "s4"])
        for (const it of generateItems(ex, seed)) {
          let r;
          if (it.kind === "mcq") r = { kind: "mcq" as const, choice: it.answer };
          else if (it.kind === "names") r = { kind: "names" as const, text: it.expect.join(" "), locale: "en" as const };
          else if (it.kind === "practice") r = { kind: "practice" as const, selfScore: 1 };
          else if (it.kind === "checkin") r = { kind: "checkin" as const, state: "fine" as const };
          else if (it.kind === "range") r = { kind: "range" as const, recordingIds: [], lowMidi: 45, highMidi: 67 };
          else if (it.kind === "sing") r = { kind: "sing" as const, recordingId: "x", analysis: { tracker: "test", notes: it.targets.map((t, i) => ({ index: i, target_midi: t, cents_error: 3, sustain_s: (it.sustain ?? 0) + 0.5 })) } };
          else {
            const evs: { t: number; type: "on" | "off"; note: number }[] = [];
            const beat = it.tempo ? 60000 / it.tempo : 500;
            if (it.mode === "chord") it.expect.forEach((n, i) => evs.push({ t: i * 10, type: "on", note: n }));
            else if (it.mode === "chords") it.expectChords!.forEach((ch, k) => ch.forEach((n, i) => { evs.push({ t: k * beat + i * 5, type: "on", note: n }); evs.push({ t: k * beat + beat * 0.9, type: "off", note: n }); }));
            else it.expect.forEach((n, i) => { evs.push({ t: i * beat, type: "on", note: n }); evs.push({ t: i * beat + beat * 0.8, type: "off", note: n }); });
            r = { kind: "midi" as const, events: evs };
          }
          const g = grade(it, r);
          expect(g.score, `${it.id} seed ${seed}: ${JSON.stringify(g.detail)}`).toBe(1);
        }
  });
  it("Serbian text present and differs from English for titles", () => {
    for (const l of c.lessons) expect(l.title.sr, l.id).not.toBe(l.title.en);
  });
});
