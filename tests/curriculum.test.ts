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
          else if (it.kind === "compose") r = { kind: "compose" as const, abc: "X:1\nK:C\nC |]", rules: { ok: true, score: 1, checks: [] } };
          else if (it.kind === "write") r = { kind: "write" as const, text: "a line", self: Object.fromEntries(it.rubric.map((c) => [c.id, 4])) };
          else if (it.kind === "midi" && it.mode === "rhythm") {
            const beat = 60000 / (it.tempo ?? 80);
            r = { kind: "midi" as const, events: it.rhythm!.flatMap((b, i) => [{ t: b * beat, type: "on" as const, note: 60 + (i % 3) }, { t: b * beat + 50, type: "off" as const, note: 60 + (i % 3) }]) };
          } else if (it.kind === "midi" && it.mode === "improv") {
            // chord root on every beat: in scale (when the scale holds the roots), on the changes, active
            const im = it.improv!;
            const beat = 60000 / (it.tempo ?? 80);
            const evs: { t: number; type: "on" | "off"; note: number }[] = [];
            for (let k = 0; k < im.chords.length * im.loops; k++)
              for (let b = 0; b < im.beatsPerChord; b++) {
                const pcs = im.chords[k % im.chords.length].filter((p) => im.scale.includes(p));
                const n = 60 + (pcs.length ? pcs[b % pcs.length] : im.scale[b % im.scale.length]);
                const t = (k * im.beatsPerChord + b) * beat;
                evs.push({ t, type: "on", note: n }, { t: t + beat * 0.8, type: "off", note: n });
              }
            r = { kind: "midi" as const, events: evs };
          }
          else if (it.kind === "sing") r = { kind: "sing" as const, recordingId: "x", analysis: { tracker: "test", notes: it.targets.map((t, i) => ({ index: i, target_midi: t, cents_error: 3, sustain_s: (it.sustain ?? 0) + 0.5 })) } };
          else {
            const evs: { t: number; type: "on" | "off"; note: number }[] = [];
            const beat = it.tempo ? 60000 / it.tempo : 500;
            if (it.mode === "chord") it.expect.forEach((n, i) => evs.push({ t: i * 10, type: "on", note: n }));
            else if (it.mode === "chords") it.expectChords!.forEach((ch, k) => ch.forEach((n, i) => { evs.push({ t: k * beat + i * 5, type: "on", note: n }); evs.push({ t: k * beat + beat * 0.9, type: "off", note: n }); }));
            else it.expect.forEach((n, i) => { evs.push({ t: i * beat, type: "on", note: n }); evs.push({ t: i * beat + beat * 0.8, type: "off", note: n }); });
            r = { kind: "midi" as const, events: evs };
          }
          const g = grade(it, r!);
          if (it.kind === "midi" && it.mode === "improv") {
            // improv is a screen with taste involved: a chord-tone line must clearly pass, not be perfect
            expect(g.score, `${it.id}: ${JSON.stringify(g.detail)}`).toBeGreaterThanOrEqual(0.8);
            continue;
          }
          expect(g.score, `${it.id} seed ${seed}: ${JSON.stringify(g.detail)}`).toBe(1);
        }
  });
  it("Serbian text present and differs from English for titles", () => {
    for (const l of c.lessons) expect(l.title.sr, l.id).not.toBe(l.title.en);
  });
});
