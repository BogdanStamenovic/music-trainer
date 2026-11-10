import { findExercise } from "@/lib/server/progress";
import { enqueue } from "@/lib/server/jobs";
import "@/lib/server/feedback";
import { json, fail } from "@/lib/server/http";

/** Ask for AI feedback on a writing exercise draft. Returns a job id; never affects the grade. */
export async function POST(req: Request) {
  try {
    const { exerciseId, text, locale } = (await req.json()) as { exerciseId: string; text: string; locale: "en" | "sr" };
    const f = findExercise(exerciseId);
    if (!f || f.ex.type !== "write") throw new Error("not a writing exercise");
    if (!text?.trim()) throw new Error("empty text");
    const id = enqueue("feedback", exerciseId, { exerciseId, text: text.slice(0, 8000), locale: locale === "sr" ? "sr" : "en" });
    return json({ jobId: id });
  } catch (e) {
    return fail(e);
  }
}
