import { getDb } from "./db";
import { getCurriculum } from "../curriculum/loader";
import { lessonStatuses, placementStatus } from "./progress";

// Read-only usage summary for calibrating waves 4-9 against real use: pace (time on
// task vs the lesson's estimate), pass rates and retries, abandoned exercises, and the
// days (focus, no-piano, voice rest). Times come from the client and are approximate.

interface Ev {
  at: number;
  date: string;
  kind: string;
  lesson_id: string | null;
  exercise_id: string | null;
  detail: string | null;
}

export function calibration() {
  const db = getDb();
  const c = getCurriculum();
  const st = lessonStatuses();
  const ev = db.prepare("SELECT at, date, kind, lesson_id, exercise_id, detail FROM events ORDER BY at").all() as Ev[];
  const done = ev.filter((e) => e.kind === "exercise_done").map((e) => ({ ...e, d: JSON.parse(e.detail ?? "{}") as { ms: number | null; score: number; pass: boolean; context: string } }));
  const starts = ev.filter((e) => e.kind === "exercise_start");

  // abandoned: an exercise started on a date with no submission for it on that date afterwards
  const abandoned = starts.filter((s) => !done.some((d) => d.exercise_id === s.exercise_id && d.date === s.date && d.at >= s.at));

  const lessons = c.lessons
    .filter((l) => !l.tags.includes("maintenance"))
    .map((l) => {
      const subs = done.filter((d) => d.lesson_id === l.id);
      const lessonSubs = subs.filter((d) => d.d.context === "lesson");
      const ms = lessonSubs.reduce((a, d) => a + (d.d.ms ?? 0), 0);
      const perEx = l.exercises.map((x) => {
        const s = lessonSubs.filter((d) => d.exercise_id === x.id);
        return { id: x.id, submissions: s.length, passed: s.some((d) => d.d.pass), retries: Math.max(0, s.length - 1), best: s.length ? Math.max(...s.map((d) => d.d.score)) : null };
      });
      return {
        id: l.id,
        track: l.track,
        status: st.get(l.id)?.status ?? "new",
        source: st.get(l.id)?.source ?? null,
        estMin: l.minutes,
        actualMin: ms ? Math.round(ms / 6000) / 10 : null,
        submissions: lessonSubs.length,
        passRate: lessonSubs.length ? Math.round((lessonSubs.filter((d) => d.d.pass).length / lessonSubs.length) * 100) / 100 : null,
        retries: perEx.reduce((a, x) => a + x.retries, 0),
        hardest: perEx.filter((x) => x.retries > 0 || (x.submissions && !x.passed)).sort((a, b) => b.retries - a.retries).slice(0, 3),
        abandoned: abandoned.filter((a) => a.lesson_id === l.id).length,
        opened: ev.filter((e) => e.kind === "lesson_open" && e.lesson_id === l.id).length,
        reviewSubs: subs.filter((d) => d.d.context === "review").length,
      };
    })
    .filter((x) => x.status !== "new" || x.submissions || x.opened);

  const plans = db.prepare("SELECT date, plan FROM day_plans ORDER BY date").all() as { date: string; plan: string }[];
  const rest = new Map((db.prepare("SELECT date, state FROM voice_days").all() as { date: string; state: string }[]).map((r) => [r.date, r.state]));
  const dates = [...new Set([...plans.map((p) => p.date), ...done.map((d) => d.date)])].sort();
  const days = dates.map((date) => {
    const p = plans.find((x) => x.date === date);
    const plan = p ? JSON.parse(p.plan) : null;
    const dd = done.filter((d) => d.date === date);
    return {
      date,
      weekday: plan?.weekday ?? null,
      focus: plan?.focusUsed ?? null,
      noPiano: !!plan?.noPiano || ev.some((e) => e.date === date && e.kind === "no_piano_on"),
      voiceRest: rest.get(date) && rest.get(date) !== "fine" ? rest.get(date) : null,
      minutes: Math.round(dd.reduce((a, d) => a + (d.d.ms ?? 0), 0) / 6000) / 10,
      submissions: dd.length,
      planned: plan?.lessons?.map((l: { id: string }) => l.id) ?? [],
      passedThatDay: [...new Set(dd.filter((d) => d.d.context === "lesson" && d.d.pass).map((d) => d.lesson_id))],
    };
  });

  // pace by track: actual minutes / estimated minutes over lessons passed through lessons
  const pace: Record<string, { lessons: number; est: number; actual: number; ratio: number | null }> = {};
  for (const l of lessons) {
    if (l.status !== "passed" || l.source !== "lesson" || l.actualMin == null) continue;
    const t = (pace[l.track] ??= { lessons: 0, est: 0, actual: 0, ratio: null });
    t.lessons++;
    t.est += l.estMin;
    t.actual += l.actualMin;
  }
  for (const t of Object.values(pace)) t.ratio = t.est ? Math.round((t.actual / t.est) * 100) / 100 : null;

  const projects = db.prepare("SELECT week, project_id, status, score, ai_status FROM projects ORDER BY week").all();
  return {
    generatedAt: new Date().toISOString(),
    placement: placementStatus(),
    totals: {
      daysActive: days.filter((d) => d.submissions).length,
      lessonsPassed: lessons.filter((l) => l.status === "passed" && l.source === "lesson").length,
      lessonsSkippedByPlacement: lessons.filter((l) => l.status === "skipped").length,
      submissions: done.length,
      minutes: Math.round(done.reduce((a, d) => a + (d.d.ms ?? 0), 0) / 60000),
      abandoned: abandoned.length,
      noPianoDays: days.filter((d) => d.noPiano).length,
      voiceRestDays: [...rest.values()].filter((s) => s !== "fine").length,
    },
    pace,
    lessons,
    days,
    projects,
    note: "Times are client-measured (from showing an exercise to submitting it), so they include pauses. Events made offline other than submissions are not recorded.",
  };
}
