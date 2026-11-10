"use client";
import { useEffect, useState, use, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type { Lesson } from "@/lib/curriculum/schema";
import { useI18n } from "@/lib/client/i18n";
import { getJson } from "@/lib/client/api";
import { Markdown } from "@/components/Markdown";
import { ExerciseQueue } from "@/components/ExerciseQueue";
import { RunnerDone } from "@/components/ExerciseRunner";
import { needsPiano, type GenCtx } from "@/lib/curriculum/items";

interface LessonResp {
  lesson: Lesson;
  status: { status: string } | null;
  exercises: { exercise_id: string; best: number; passed: number }[];
}

function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Belgrade" }).format(new Date());
}

export default function LessonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense>
      <LessonInner id={id} />
    </Suspense>
  );
}

function LessonInner({ id }: { id: string }) {
  const sp = useSearchParams();
  const date = sp.get("date") || today();
  const { t, l } = useI18n();
  const [d, setD] = useState<LessonResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [finished, setFinished] = useState<RunnerDone[] | null>(null);
  const [ctx, setCtx] = useState<GenCtx | null>(null);
  const [noPiano, setNoPiano] = useState<boolean | null>(null);
  useEffect(() => {
    getJson<LessonResp>(`/api/lesson/${id}`).then(({ data }) => setD(data)).catch((e) => setErr(String(e)));
    // generated voice items are fitted to the stored comfortable range
    getJson<{ plan: { date: string; noPiano?: boolean } }>("/api/today")
      .then(({ data }) => setNoPiano(!!data.plan.noPiano && data.plan.date === date))
      .catch(() => setNoPiano(false));
    getJson<{ voiceRange: { comfortLow: number; comfortHigh: number } | null }>("/api/settings")
      .then(({ data }) => setCtx(data.voiceRange ? { voiceRange: [data.voiceRange.comfortLow, data.voiceRange.comfortHigh] } : {}))
      .catch(() => setCtx({}));
  }, [id, date]);
  if (err) return <p className="bad">{err}</p>;
  if (!d || !ctx || noPiano === null) return <p className="muted">…</p>;
  const { lesson } = d;
  const initial = Object.fromEntries(d.exercises.map((e) => [e.exercise_id, e]));
  const ordered = noPiano ? [...lesson.exercises.filter((e) => !needsPiano(e)), ...lesson.exercises.filter(needsPiano)] : lesson.exercises;
  const firstOpen = Math.max(0, ordered.findIndex((e) => !initial[e.id]?.passed));
  const passedNow = finished?.some((r) => r.server?.lessonPassed);
  // "no piano today": exercises that need the keyboard go last, marked, so the rest can be done now
  const entries = (noPiano ? [...lesson.exercises.filter((e) => !needsPiano(e)), ...lesson.exercises.filter(needsPiano)] : lesson.exercises).map((ex) => ({
    ex,
    lessonId: lesson.id,
    label: noPiano && needsPiano(ex) ? `🎹 ${l(ex.prompt)} (${t("needsPiano")})` : undefined,
  }));
  return (
    <div className="lesson">
      <p>
        <Link href="/">← {t("backToday")}</Link>
      </p>
      <h1>
        <span className="tag">{lesson.id}</span> {l(lesson.title)}
      </h1>
      <p className="muted small">
        {lesson.minutes} {t("min")} · {d.status ? t(d.status.status as "new") : t("new")}
      </p>
      <details className="card explain" open={!d.status}>
        <summary>{t("explain")}</summary>
        <Markdown text={l(lesson.explain)} />
      </details>
      <h2>{t("exercises")}</h2>
      <ExerciseQueue entries={entries} context="lesson" date={date} startAt={d.status?.status === "passed" ? 0 : firstOpen === -1 ? 0 : firstOpen} initial={initial} onFinished={setFinished} ctx={ctx} voiceLesson={lesson.track === "V"} />
      {finished ? (
        <section className={`card ${passedNow ? "good" : ""}`} data-testid="lesson-finished">
          <p>{passedNow ? `✓ ${t("lessonDone")}` : t("notPassed")}</p>
          <Link className="button primary" href="/">
            {t("backToday")}
          </Link>
        </section>
      ) : null}
    </div>
  );
}
