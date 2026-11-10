import { registerJob } from "./jobs";
import { review } from "./claude";
import { findExercise } from "./progress";

// AI feedback on writing-exercise drafts: same locked-down claude -p reviewer, same
// rubric shape, but advisory only (the grade is the learner's own rubric rating).
registerJob("feedback", async (payload) => {
  const p = payload as { exerciseId: string; text: string; locale: "en" | "sr" };
  const f = findExercise(p.exerciseId);
  if (!f || f.ex.type !== "write") return { ok: false, error: "exercise gone", permanent: true };
  const ex = f.ex;
  const r = await review({
    kind: "lyrics",
    locale: p.locale,
    title: ex.prompt.en,
    brief: `${ex.prompt.en}${ex.lines ? ` (${ex.lines[0]}-${ex.lines[1]} lines)` : ""}. This is a short lesson exercise, not a finished song: give practical, specific feedback.`,
    rubric: ex.rubric.map((c) => ({ ...c, weight: c.weight ?? 1 })),
    submission: p.text,
  });
  if (r.ok) return { ok: true, result: r.review };
  return { ok: false, error: r.error, unavailable: r.unavailable };
});
