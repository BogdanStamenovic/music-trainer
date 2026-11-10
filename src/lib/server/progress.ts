import { getDb, now } from "./db";
import { getCurriculum } from "../curriculum/loader";
import { generateItems, Item } from "../curriculum/items";
import { grade, exerciseScore, Response, Grade } from "../grading";
import type { Exercise, Lesson } from "../curriculum/schema";

export type Context = "lesson" | "review" | "placement" | "test";

export interface Submission {
  uuid: string; // client-generated; makes offline re-sync idempotent
  date: string; // the plan date the work belongs to
  context: Context;
  lessonId: string | null;
  exerciseId: string;
  seed: string;
  count?: number; // item count used for generated exercises (reviews use fewer)
  responses: { itemId: string; response: Response; clientScore?: number }[];
}

export interface SubmissionResult {
  exerciseId: string;
  score: number;
  pass: boolean;
  items: { itemId: string; score: number; pass: boolean; detail: Record<string, unknown>; clientScore?: number }[];
  lessonPassed?: boolean;
  srsDue?: string;
}

export function findExercise(exerciseId: string): { ex: Exercise; lesson: Lesson | null; skips: string[] } | null {
  const c = getCurriculum();
  for (const l of c.lessons) {
    const ex = l.exercises.find((e) => e.id === exerciseId);
    if (ex) return { ex, lesson: l, skips: [] };
  }
  for (const s of c.placement?.sections ?? []) {
    const ex = s.exercises.find((e) => e.id === exerciseId);
    if (ex) return { ex, lesson: null, skips: ex.skips };
  }
  return null;
}

// ---------- SRS (SM-2) ----------
export function addDays(date: string, n: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function sm2Quality(score: number, pass: number): number {
  if (score >= 0.95) return 5;
  if (score >= 0.85) return 4;
  if (score >= pass) return 3;
  if (score >= 0.5) return 2;
  return 1;
}

export function sm2(card: { ease: number; interval: number; reps: number; lapses: number }, q: number) {
  let { ease, interval, reps, lapses } = card;
  if (q < 3) {
    reps = 0;
    interval = 1;
    lapses++;
  } else {
    reps++;
    interval = reps === 1 ? 1 : reps === 2 ? 3 : Math.round(interval * ease);
  }
  ease = Math.max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  return { ease, interval, reps, lapses };
}

function updateSrs(exerciseId: string, lessonId: string, score: number, pass: number, date: string): string {
  const db = getDb();
  const row = db.prepare("SELECT ease, interval, reps, lapses FROM srs WHERE exercise_id = ?").get(exerciseId) as
    | { ease: number; interval: number; reps: number; lapses: number }
    | undefined;
  const next = sm2(row ?? { ease: 2.5, interval: 0, reps: 0, lapses: 0 }, sm2Quality(score, pass));
  const due = addDays(date, next.interval);
  db.prepare(
    `INSERT INTO srs(exercise_id, lesson_id, ease, interval, reps, lapses, due, last_score, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(exercise_id) DO UPDATE SET ease=excluded.ease, interval=excluded.interval, reps=excluded.reps, lapses=excluded.lapses,
     due=excluded.due, last_score=excluded.last_score, updated_at=excluded.updated_at`,
  ).run(exerciseId, lessonId, next.ease, next.interval, next.reps, next.lapses, due, score, now());
  return due;
}

export function dueReviews(date: string, limit: number): { exercise_id: string; lesson_id: string; due: string }[] {
  const c = getCurriculum();
  const rows = getDb().prepare("SELECT exercise_id, lesson_id, due FROM srs WHERE due <= ? ORDER BY due, last_score").all(date) as {
    exercise_id: string;
    lesson_id: string;
    due: string;
  }[];
  // drop cards whose exercise no longer exists in the curriculum
  return rows.filter((r) => c.byId.get(r.lesson_id)?.exercises.some((e) => e.id === r.exercise_id)).slice(0, limit);
}

// ---------- lesson progress ----------
export function lessonStatuses(): Map<string, { status: string; score: number | null; source: string }> {
  const rows = getDb().prepare("SELECT lesson_id, status, score, source FROM lesson_progress").all() as { lesson_id: string; status: string; score: number | null; source: string }[];
  return new Map(rows.map((r) => [r.lesson_id, r]));
}

export function exerciseStates(lessonId: string) {
  return getDb().prepare("SELECT exercise_id, best, last, passed, attempts FROM exercise_state WHERE lesson_id = ?").all(lessonId) as {
    exercise_id: string;
    best: number;
    last: number;
    passed: number;
    attempts: number;
  }[];
}

function setLesson(lessonId: string, status: string, score: number | null, source: string) {
  getDb()
    .prepare(
      `INSERT INTO lesson_progress(lesson_id, status, score, source, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(lesson_id) DO UPDATE SET status=excluded.status, score=excluded.score, source=excluded.source, updated_at=excluded.updated_at`,
    )
    .run(lessonId, status, score, source, now());
}

/** Lesson passes when every non-practice exercise has passed at least once. */
function refreshLesson(lesson: Lesson): boolean {
  const st = new Map(exerciseStates(lesson.id).map((r) => [r.exercise_id, r]));
  const graded = lesson.exercises.filter((e) => e.type !== "practice");
  const passed = graded.every((e) => st.get(e.id)?.passed);
  const cur = lessonStatuses().get(lesson.id);
  const mean = graded.length ? graded.reduce((a, e) => a + (st.get(e.id)?.best ?? 0), 0) / graded.length : 1;
  if (passed) {
    if (cur?.status !== "passed") setLesson(lesson.id, "passed", mean, "lesson");
    else setLesson(lesson.id, "passed", mean, cur.source);
  } else if (!cur || cur.status === "started") setLesson(lesson.id, "started", mean, "lesson");
  return passed;
}

export function markLessons(ids: string[], status: "skipped" | "passed", source: string) {
  const cur = lessonStatuses();
  for (const id of ids) if (cur.get(id)?.status !== "passed") setLesson(id, status, null, source);
}

/**
 * Grade a submission authoritatively: regenerate the items from (exercise, seed),
 * grade each response, persist attempts and update progress + SRS. Idempotent per uuid.
 */
export function submit(sub: Submission): SubmissionResult {
  const db = getDb();
  const prev = db.prepare("SELECT result FROM submissions WHERE uuid = ?").get(sub.uuid) as { result: string } | undefined;
  if (prev) return JSON.parse(prev.result);
  const found = findExercise(sub.exerciseId);
  if (!found) throw new Error(`unknown exercise ${sub.exerciseId}`);
  const { ex, lesson } = found;
  const count = ex.type === "generated" ? Math.max(1, Math.min(30, sub.count ?? ex.count)) : undefined;
  const items = generateItems(ex, sub.seed, count);
  const byId = new Map<string, Item>(items.map((i) => [i.id, i]));
  const graded: SubmissionResult["items"] = [];
  const ins = db.prepare(
    `INSERT OR IGNORE INTO attempts(uuid, date, context, lesson_id, exercise_id, item_id, seed, response, score, detail, client_score, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let result!: SubmissionResult;
  db.transaction(() => {
    for (const r of sub.responses) {
      const it = byId.get(r.itemId);
      if (!it) throw new Error(`item ${r.itemId} not in ${sub.exerciseId} for seed ${sub.seed}`);
      const g: Grade = grade(it, r.response, ex.pass);
      graded.push({ itemId: r.itemId, score: g.score, pass: g.pass, detail: g.detail, clientScore: r.clientScore });
      ins.run(sub.uuid, sub.date, sub.context, lesson?.id ?? null, ex.id, it.id, sub.seed, JSON.stringify(r.response), g.score, JSON.stringify(g.detail), r.clientScore ?? null, now());
    }
    // unanswered items count as 0
    const score = exerciseScore([...graded.map((g) => g.score), ...items.filter((i) => !sub.responses.some((r) => r.itemId === i.id)).map(() => 0)]);
    const pass = score >= ex.pass;
    result = { exerciseId: ex.id, score: Math.round(score * 1000) / 1000, pass, items: graded };
    if (lesson && (sub.context === "lesson" || sub.context === "review" || sub.context === "test")) {
      db.prepare(
        `INSERT INTO exercise_state(exercise_id, lesson_id, best, last, passed, attempts, updated_at) VALUES (?,?,?,?,?,1,?)
         ON CONFLICT(exercise_id) DO UPDATE SET best=max(best, excluded.best), last=excluded.last, passed=max(passed, excluded.passed),
         attempts=attempts+1, updated_at=excluded.updated_at`,
      ).run(ex.id, lesson.id, score, score, pass ? 1 : 0, now());
      if (ex.type !== "practice" && !lesson.tags.includes("maintenance")) result.srsDue = updateSrs(ex.id, lesson.id, score, ex.pass, sub.date);
      result.lessonPassed = refreshLesson(lesson);
    }
    db.prepare("INSERT INTO submissions(uuid, received_at, result) VALUES (?,?,?)").run(sub.uuid, now(), JSON.stringify(result));
  })();
  return result;
}

/** Placement: apply skip mappings for every placement exercise that passed. */
export function finishPlacement(results: { exerciseId: string; score: number; pass: boolean }[]) {
  const skip = new Set<string>();
  for (const r of results) {
    const f = findExercise(r.exerciseId);
    if (f && r.pass) f.skips.forEach((s) => skip.add(s));
  }
  // a lesson is only skipped if all its prereqs are passed/skipped too (keeps the chain sane)
  const c = getCurriculum();
  const status = lessonStatuses();
  const ok = (id: string) => skip.has(id) || ["passed", "skipped"].includes(status.get(id)?.status ?? "");
  const final = [...skip].filter((id) => (c.byId.get(id)?.prereqs ?? []).every(ok));
  markLessons(final, "skipped", "placement");
  getDb().prepare("INSERT INTO placement_results(taken_at, result) VALUES (?, ?)").run(now(), JSON.stringify({ results, skipped: final }));
  return { skipped: final };
}

export function placementDone(): boolean {
  return !!getDb().prepare("SELECT 1 FROM placement_results LIMIT 1").get();
}
