import { logEvent } from "@/lib/server/progress";
import { json, fail } from "@/lib/server/http";

const KINDS = new Set(["lesson_open", "exercise_start", "exercise_retry"]);

/** Client usage events for calibration: {kind, date, lessonId?, exerciseId?}. Fire-and-forget. */
export async function POST(req: Request) {
  try {
    const b = (await req.json()) as { kind: string; date: string; lessonId?: string | null; exerciseId?: string | null; detail?: Record<string, unknown> };
    if (!KINDS.has(b.kind) || !/^\d{4}-\d{2}-\d{2}$/.test(b.date ?? "")) throw new Error("bad event");
    logEvent(b.date, b.kind, b.lessonId ?? null, b.exerciseId ?? null, b.detail ?? {});
    return json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
