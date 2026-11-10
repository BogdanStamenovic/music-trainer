import { getDb, now } from "./db";
import { getCurriculum } from "../curriculum/loader";
import { getSettings, Settings, WEEKDAYS, Weekday, Focus } from "./settings";
import { lessonStatuses, dueReviews, placementDone, addDays } from "./progress";
import { config } from "./config";
import type { Lesson, Track } from "../curriculum/schema";
import { needsPiano } from "../curriculum/items";
export { needsPiano };
import { voiceRest } from "./recordings";

// One focus part per day, picked by weekday (spec change 2026-11-10), plus an
// optional short maintenance block (SRS reviews + vocal warm-up).

export interface PlanLesson {
  id: string;
  track: Track;
  minutes: number;
  status: string; // new | started | passed | skipped
  aheadOfTheory?: string[]; // unmet cross-track prereqs (soft)
}
export interface DayPlan {
  date: string;
  weekday: Weekday;
  kind: "placement" | "focus" | "test" | "rest";
  focus: Focus[];
  focusUsed: Track[]; // tracks actually planned (after fallback)
  note?: { en: string; sr: string };
  lessons: PlanLesson[];
  focusMinutes: number;
  maintenance: null | { reviews: { exerciseId: string; lessonId: string }[]; warmup: string | null; minutes: number };
  test: null | { exercises: { exerciseId: string; lessonId: string }[] };
  noPiano?: boolean; // "no piano today": non-piano focus, no piano-only reviews (this day only)
  createdAt: number;
}

/**
 * Theory is "ahead of schedule" when the learner has done at least one T-day's worth
 * (~3 lessons) more than the T days on the schedule since the first planned day.
 */
export function theoryAhead(date: string, s: Settings): boolean {
  const c = getCurriculum();
  const st = lessonStatuses();
  const doneT = c.lessons.filter((l) => l.track === "T" && done(st.get(l.id)?.status)).length;
  const first = (getDb().prepare("SELECT min(date) d FROM day_plans").get() as { d: string | null }).d ?? date;
  let tDays = 0;
  for (let d = first; d < date; d = addDays(d, 1)) if (s.schedule[weekdayOf(d)].includes("T")) tDays++;
  return doneT >= tDays * 3 + 3;
}

export function todayIn(tz = config.timezone, d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function weekdayOf(date: string): Weekday {
  const js = new Date(date + "T12:00:00Z").getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(js + 6) % 7];
}

const done = (s?: string) => s === "passed" || s === "skipped";

/** Lessons of a track that are next in line: in-track prereqs met, not done. Cross-track prereqs are soft. */
export function available(track: Track, statuses: Map<string, { status: string }>): { lesson: Lesson; ahead: string[] }[] {
  const c = getCurriculum();
  const out: { lesson: Lesson; ahead: string[] }[] = [];
  for (const l of c.lessons) {
    if (l.track !== track || l.tags.includes("maintenance") || done(statuses.get(l.id)?.status)) continue;
    const unmet = l.prereqs.filter((p) => !done(statuses.get(p)?.status));
    const inTrack = unmet.filter((p) => c.byId.get(p)?.track === track);
    if (inTrack.length) continue;
    out.push({ lesson: l, ahead: unmet });
  }
  // started first, then fully unlocked before "ahead of theory", then course order
  return out.sort(
    (a, b) =>
      Number(statuses.get(b.lesson.id)?.status === "started") - Number(statuses.get(a.lesson.id)?.status === "started") ||
      a.ahead.length - b.ahead.length ||
      a.lesson.order - b.lesson.order,
  );
}

/**
 * Fill the focus block with consecutive lessons, round-robin across the day's
 * focus tracks, until the target minutes are reached (never past 50 min unless
 * a single lesson is longer). Lessons chain: a lesson planned today counts as
 * done for unlocking the next one, since it will be done before it.
 */
export function fillFocus(tracks: Track[], target: number, statuses: Map<string, { status: string }>): PlanLesson[] {
  const sim = new Map(statuses);
  const picked: PlanLesson[] = [];
  let minutes = 0;
  const cap = 50;
  for (let guard = 0; guard < 40 && minutes < target; guard++) {
    let progressed = false;
    for (const t of tracks) {
      if (minutes >= target) break;
      const next = available(t, sim).find((a) => !picked.some((p) => p.id === a.lesson.id));
      if (!next) continue;
      if (picked.length > 0 && minutes + next.lesson.minutes > cap) continue;
      picked.push({ id: next.lesson.id, track: t, minutes: next.lesson.minutes, status: statuses.get(next.lesson.id)?.status ?? "new", aheadOfTheory: next.ahead.length ? next.ahead : undefined });
      sim.set(next.lesson.id, { status: "passed" });
      minutes += next.lesson.minutes;
      progressed = true;
    }
    if (!progressed) break;
  }
  return picked;
}

const TRACK_NAMES: Record<string, { en: string; sr: string }> = {
  T: { en: "Theory", sr: "Teorija" },
  E: { en: "Ear", sr: "Sluh" },
  K: { en: "Keys", sr: "Klavir" },
  V: { en: "Voice", sr: "Glas" },
  C: { en: "Composition", sr: "Kompozicija" },
  L: { en: "Lyrics", sr: "Tekstovi" },
};

export function buildPlan(date: string, s: Settings = getSettings(), opts: { noPiano?: boolean } = {}): DayPlan {
  const c = getCurriculum();
  const weekday = weekdayOf(date);
  const focus = s.schedule[weekday];
  const statuses = lessonStatuses();
  const base: DayPlan = { date, weekday, kind: "focus", focus, focusUsed: [], lessons: [], focusMinutes: s.focusMinutes, maintenance: null, test: null, createdAt: now() };

  if (!placementDone() && !s.placementSkipped) return { ...base, kind: "placement" };

  const maintenance = (): DayPlan["maintenance"] => {
    if (!s.maintenance) return null;
    let due = dueReviews(date, opts.noPiano ? 100 : s.reviewLimit);
    if (opts.noPiano) due = due.filter((r) => { const ex = c.byId.get(r.lesson_id)?.exercises.find((e) => e.id === r.exercise_id); return ex && !needsPiano(ex); }).slice(0, s.reviewLimit);
    const reviews = due.map((r) => ({ exerciseId: r.exercise_id, lessonId: r.lesson_id }));
    const warm = c.lessons.find((l) => l.tags.includes("maintenance") && l.tags.includes("warmup"));
    return { reviews, warmup: warm?.id ?? null, minutes: Math.min(10, reviews.length * 1 + (warm ? 4 : 0)) };
  };

  if (focus.includes("rest")) return { ...base, kind: "rest", maintenance: maintenance() };

  if (opts.noPiano) {
    // theory unless it is ahead of schedule (then voice); voice never on a voice-rest day
    let tracks: Track[] = theoryAhead(date, s) && !voiceRest(date) ? ["V"] : ["T"];
    let lessons = fillFocus(tracks, s.focusMinutes, statuses);
    if (!lessons.length) {
      const alt: Track[] = tracks[0] === "T" && !voiceRest(date) ? ["V"] : ["T"];
      const got = fillFocus(alt, s.focusMinutes, statuses);
      if (got.length) [tracks, lessons] = [alt, got];
    }
    const name = tracks.map((t) => TRACK_NAMES[t]);
    return {
      ...base,
      noPiano: true,
      focusUsed: tracks,
      lessons,
      maintenance: maintenance(),
      note: {
        en: `No piano today: ${name.map((x) => x.en).join(" + ")} instead of the scheduled part. Exercises that need the keyboard are left for later.`,
        sr: `Danas bez klavira: ${name.map((x) => x.sr).join(" + ")} umesto zakazanog dela. Vežbe kojima treba klavijatura ostaju za kasnije.`,
      },
    };
  }

  if (focus.includes("test")) {
    // Weekly test (M1 version): one exercise from each lesson passed in the last 7 days.
    const since = Date.now() - 7 * 86400_000;
    const rows = getDb().prepare("SELECT lesson_id FROM lesson_progress WHERE status = 'passed' AND source = 'lesson' AND updated_at >= ?").all(since) as { lesson_id: string }[];
    const exercises: { exerciseId: string; lessonId: string }[] = [];
    for (const r of rows) {
      const l = c.byId.get(r.lesson_id);
      // voice is assessed by recorded projects (M3), not in the quick weekly test
      if (!l || l.track === "V") continue;
      const graded = l.exercises.filter((e) => e.type !== "practice" && e.type !== "checkin");
      // prefer generated exercises: fresh items test the skill, not memory of the item
      const pick = graded.find((e) => e.type === "generated") ?? graded[0];
      if (pick) exercises.push({ exerciseId: pick.id, lessonId: l.id });
    }
    if (exercises.length) return { ...base, kind: "test", test: { exercises }, maintenance: maintenance() };
    base.note = { en: "Nothing passed this week yet, so no weekly test: regular lessons instead.", sr: "Ove nedelje još ništa nije položeno, pa nema testa: danas obične lekcije." };
  }

  // Focus tracks with content; otherwise walk the week forward to the next day that has some.
  const tracksOf = (f: Focus[]) => f.filter((x): x is Track => !["test", "rest"].includes(x));
  let tracks = tracksOf(focus);
  let lessons = fillFocus(tracks, s.focusMinutes, statuses);
  if (lessons.length === 0) {
    const idx = WEEKDAYS.indexOf(weekday);
    for (let k = 1; k <= 7 && lessons.length === 0; k++) {
      const alt = tracksOf(s.schedule[WEEKDAYS[(idx + k) % 7]]);
      if (!alt.length || alt.join() === tracks.join()) continue;
      const got = fillFocus(alt, s.focusMinutes, statuses);
      if (got.length) {
        const from = tracks.map((t) => TRACK_NAMES[t]);
        const to = alt.map((t) => TRACK_NAMES[t]);
        base.note = {
          en: `${from.map((x) => x.en).join(" + ") || "Today's part"} has no lessons available yet${tracks.includes("V") || tracks.includes("C") || tracks.includes("L") ? " (it arrives in a later milestone)" : ""}, so today is ${to.map((x) => x.en).join(" + ")}.`,
          sr: `${from.map((x) => x.sr).join(" + ") || "Današnji deo"} još nema dostupnih lekcija${tracks.includes("V") || tracks.includes("C") || tracks.includes("L") ? " (stiže u kasnijoj fazi)" : ""}, pa je danas ${to.map((x) => x.sr).join(" + ")}.`,
        };
        tracks = alt;
        lessons = got;
      }
    }
  }
  if (lessons.length === 0 && !base.note) base.note = { en: "You have finished every available lesson. Reviews only today.", sr: "Završio si sve dostupne lekcije. Danas samo ponavljanje." };
  return { ...base, focusUsed: tracks, lessons, maintenance: maintenance() };
}

/** Today's plan is built once and kept stable for the day; statuses are refreshed on read. */
export function getPlan(date: string): DayPlan {
  const db = getDb();
  const row = db.prepare("SELECT plan FROM day_plans WHERE date = ?").get(date) as { plan: string } | undefined;
  let plan: DayPlan;
  if (row) plan = JSON.parse(row.plan);
  else {
    plan = buildPlan(date);
    // a placement plan is not stored: it turns into a real plan once placement is finished
    if (plan.kind !== "placement") db.prepare("INSERT OR REPLACE INTO day_plans(date, plan, created_at) VALUES (?,?,?)").run(date, JSON.stringify(plan), now());
  }
  const st = lessonStatuses();
  for (const l of plan.lessons) l.status = st.get(l.id)?.status ?? "new";
  return plan;
}

/** Rebuild one day's plan with/without the "no piano today" override (the weekly schedule is untouched). */
export function setNoPiano(date: string, on: boolean): DayPlan {
  const plan = buildPlan(date, getSettings(), { noPiano: on });
  if (plan.kind !== "placement") getDb().prepare("INSERT OR REPLACE INTO day_plans(date, plan, created_at) VALUES (?,?,?)").run(date, JSON.stringify(plan), now());
  return getPlan(date);
}

export function resetPlan(date: string) {
  getDb().prepare("DELETE FROM day_plans WHERE date = ?").run(date);
}

export { addDays };
