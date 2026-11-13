"use client";
/** Calibration events: fire-and-forget; lost when offline (only submissions are queued). */
export function track(kind: "lesson_open" | "exercise_start" | "exercise_retry" | "voice_cooldown" | "voice_warm_reuse", date: string, lessonId: string | null, exerciseId?: string | null, detail?: Record<string, unknown>) {
  void fetch("/api/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, date, lessonId, exerciseId, detail }) }).catch(() => {});
}
