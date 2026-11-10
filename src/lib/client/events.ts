"use client";
/** Calibration events: fire-and-forget; lost when offline (only submissions are queued). */
export function track(kind: "lesson_open" | "exercise_start" | "exercise_retry", date: string, lessonId: string | null, exerciseId?: string | null) {
  void fetch("/api/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, date, lessonId, exerciseId }) }).catch(() => {});
}
