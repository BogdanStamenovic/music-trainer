import { getDb, now } from "./db";
import { getCurriculum } from "../curriculum/loader";
import { getSettings, Settings, WEEKDAYS, Weekday, Focus } from "./settings";
import { lessonStatuses, dueReviews, placementDone, addDays, logEvent } from "./progress";
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
  test: null | { exercises: { exerciseId: string; lessonId: string; source: "week" | "review" }[] };
  practice?: { exerciseId: string; lessonId: string }[]; // drills from passed lessons when new content runs short
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
export function fillFocus(tracks: Track[], target: number, statuses: Map<string, { status: string }>, opts?: { date?: string; maxNewVoice?: number }): PlanLesson[] {
  const sim = new Map(statuses);
  const picked: PlanLesson[] = [];
  let minutes = 0;
  const cap = 50;
  for (let guard = 0; guard < 40 && minutes < target; guard++) {
    let progressed = false;
    for (const t of tracks) {
      if (minutes >= target) break;
      const c = getCurriculum();
      const heavy = (tags: string[]) => tags.includes("distortion") || tags.includes("belt");
      const heavyPicked = picked.some((p) => heavy(c.byId.get(p.id)?.tags ?? []));
      // voice safety: at most one belt/distortion lesson a day, never on a voice-rest day
      const next = available(t, sim).find(
        (a) => !picked.some((p) => p.id === a.lesson.id) && !(heavy(a.lesson.tags) && (heavyPicked || (opts?.date && voiceRest(opts.date)))),
      );
      if (!next) continue;
      if (picked.length > 0 && minutes + next.lesson.minutes > cap) continue;
      // vocal load: a cap on new V lessons per day (default 3); the rest of a V day goes to T/E practice
      if (t === "V" && opts?.maxNewVoice !== undefined && picked.filter((p) => p.track === "V").length >= opts.maxNewVoice) continue;
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
    let lessons = fillFocus(tracks, s.focusMinutes, statuses, { date, maxNewVoice: s.maxNewVoiceLessons });
    if (!lessons.length) {
      const alt: Track[] = tracks[0] === "T" && !voiceRest(date) ? ["V"] : ["T"];
      const got = fillFocus(alt, s.focusMinutes, statuses, { date, maxNewVoice: s.maxNewVoiceLessons });
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
    const test = weeklyTest(date);
    if (test.exercises.length) return { ...base, kind: "test", test, maintenance: maintenance() };
    base.note = { en: "Nothing practised this week yet, so no weekly test: regular lessons instead.", sr: "Ove nedelje još ništa nije vežbano, pa nema testa: danas obične lekcije." };
  }

  // Focus tracks with content; otherwise walk the week forward to the next day that has some.
  const tracksOf = (f: Focus[]) => f.filter((x): x is Track => !["test", "rest"].includes(x));
  let tracks = tracksOf(focus);
  let lessons = fillFocus(tracks, s.focusMinutes, statuses, { date, maxNewVoice: s.maxNewVoiceLessons });
  if (lessons.length === 0) {
    const idx = WEEKDAYS.indexOf(weekday);
    for (let k = 1; k <= 7 && lessons.length === 0; k++) {
      const alt = tracksOf(s.schedule[WEEKDAYS[(idx + k) % 7]]);
      if (!alt.length || alt.join() === tracks.join()) continue;
      const got = fillFocus(alt, s.focusMinutes, statuses, { date, maxNewVoice: s.maxNewVoiceLessons });
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
  // practice fill never adds voice: on a V day the spare time goes to T/E drills
  const fillTracks: Track[] = tracks.includes("V") ? [...new Set<Track>([...tracks.filter((t) => t !== "V"), "T", "E"])] : tracks;
  const practice = practiceFill(fillTracks, s.focusMinutes - lessons.reduce((a, l) => a + l.minutes, 0), date);
  return { ...base, focusUsed: tracks, lessons, maintenance: maintenance(), practice: practice.length ? practice : undefined };
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
  logEvent(date, on ? "no_piano_on" : "no_piano_off", null, null);
  const plan = buildPlan(date, getSettings(), { noPiano: on });
  if (plan.kind !== "placement") getDb().prepare("INSERT OR REPLACE INTO day_plans(date, plan, created_at) VALUES (?,?,?)").run(date, JSON.stringify(plan), now());
  return getPlan(date);
}

export function resetPlan(date: string) {
  getDb().prepare("DELETE FROM day_plans WHERE date = ?").run(date);
}

export { addDays };

/** ISO week id and its Monday/Sunday for a date. */
export function isoWeek(date: string): { week: string; monday: string; sunday: string } {
  const d = new Date(date + "T12:00:00Z");
  const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  const monday = addDays(date, -day);
  const sunday = addDays(monday, 6);
  const thursday = new Date(addDays(monday, 3) + "T12:00:00Z");
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const wk = Math.ceil(((thursday.getTime() - yearStart) / 86400000 + 1) / 7);
  return { week: `${thursday.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`, monday, sunday };
}

export const WEEK_TEST_MAX = 8;
export const REVIEW_TEST_MAX = 4;

/**
 * Sunday test. Weighted to the week's material: up to 2 exercises from each lesson
 * practised this week (generated ones first: fresh items test the skill, not memory
 * of an item), capped at 8, most-practised lessons first; plus up to 4 items the
 * learner keeps failing (SRS lapses or a last score under the pass mark), worst first.
 * Voice is assessed by recorded projects, not here; piano-free alternatives are not
 * substituted (the test is meant for the piano day).
 */
export function weeklyTest(date: string): { exercises: { exerciseId: string; lessonId: string; source: "week" | "review" }[] } {
  const c = getCurriculum();
  const { monday, sunday } = isoWeek(date);
  const db = getDb();
  const rows = db
    .prepare("SELECT lesson_id, count(*) n FROM attempts WHERE context IN ('lesson','review') AND date BETWEEN ? AND ? AND lesson_id IS NOT NULL GROUP BY lesson_id ORDER BY n DESC")
    .all(monday, sunday) as { lesson_id: string; n: number }[];
  const out: { exerciseId: string; lessonId: string; source: "week" | "review" }[] = [];
  for (const r of rows) {
    const l = c.byId.get(r.lesson_id);
    if (!l || l.track === "V" || l.tags.includes("maintenance")) continue;
    const graded = l.exercises.filter((e) => e.type !== "practice" && e.type !== "checkin");
    const picks = [...graded.filter((e) => e.type === "generated"), ...graded.filter((e) => e.type !== "generated")].slice(0, 2);
    for (const e of picks) if (out.length < WEEK_TEST_MAX) out.push({ exerciseId: e.id, lessonId: l.id, source: "week" });
  }
  const weak = db
    .prepare("SELECT exercise_id, lesson_id FROM srs WHERE lapses > 0 OR last_score < 0.8 ORDER BY last_score ASC, lapses DESC")
    .all() as { exercise_id: string; lesson_id: string }[];
  let n = 0;
  for (const w of weak) {
    if (n >= REVIEW_TEST_MAX) break;
    const l = c.byId.get(w.lesson_id);
    if (!l || l.track === "V" || !l.exercises.some((e) => e.id === w.exercise_id) || out.some((o) => o.exerciseId === w.exercise_id)) continue;
    out.push({ exerciseId: w.exercise_id, lessonId: w.lesson_id, source: "review" });
    n++;
  }
  return { exercises: out };
}

/**
 * When a focus track has fewer unlocked minutes than the target, top the day up with
 * drills: generated exercises from lessons already passed in that track (fresh items
 * each time), least recently practised first. ~1.5 min per drill (3 items).
 */
export function practiceFill(tracks: Track[], minutesLeft: number, date: string): { exerciseId: string; lessonId: string }[] {
  if (minutesLeft < 5) return [];
  const c = getCurriculum();
  const st = lessonStatuses();
  const last = new Map(
    (getDb().prepare("SELECT exercise_id, max(date) d FROM attempts GROUP BY exercise_id").all() as { exercise_id: string; d: string }[]).map((r) => [r.exercise_id, r.d]),
  );
  const pool: { exerciseId: string; lessonId: string; last: string }[] = [];
  for (const l of c.lessons) {
    if (!tracks.includes(l.track) || !done(st.get(l.id)?.status) || l.tags.includes("maintenance") || l.tags.includes("distortion") || l.tags.includes("belt")) continue;
    for (const e of l.exercises) if (e.type === "generated") pool.push({ exerciseId: e.id, lessonId: l.id, last: last.get(e.id) ?? "" });
  }
  pool.sort((a, b) => a.last.localeCompare(b.last));
  return pool.slice(0, Math.min(10, Math.floor(minutesLeft / 1.5))).map(({ exerciseId, lessonId }) => ({ exerciseId, lessonId }));
}

/** Belt/distortion lessons: another one already attempted today blocks this one (daily cap, SPEC voice safety). */
export function distortionBlocked(lessonId: string, date: string): string | null {
  const c = getCurriculum();
  const heavy = (id: string) => !!c.byId.get(id)?.tags.some((t) => t === "distortion" || t === "belt");
  if (!heavy(lessonId)) return null;
  if (voiceRest(date)) return "voice-rest";
  const others = getDb().prepare("SELECT DISTINCT lesson_id FROM attempts WHERE date = ? AND lesson_id IS NOT NULL AND lesson_id != ?").all(date, lessonId) as { lesson_id: string }[];
  return others.some((o) => heavy(o.lesson_id)) ? "daily-cap" : null;
}
