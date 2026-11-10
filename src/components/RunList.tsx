"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Exercise, Lesson } from "@/lib/curriculum/schema";
import { useI18n } from "@/lib/client/i18n";
import { getJson } from "@/lib/client/api";
import { ExerciseQueue, QueueEntry } from "./ExerciseQueue";
import type { DayPlan } from "@/lib/server/planner";
import type { Context } from "@/lib/server/progress";

/** Review / weekly test: exercises from several lessons, fewer items each. */
export function RunList({ pick, context, title }: { pick: (p: DayPlan) => { exerciseId: string; lessonId: string }[]; context: Context; title: string }) {
  const { t, l } = useI18n();
  const [entries, setEntries] = useState<QueueEntry[] | null>(null);
  const [date, setDate] = useState("");
  const [fin, setFin] = useState(false);
  useEffect(() => {
    (async () => {
      const { data } = await getJson<{ plan: DayPlan }>("/api/today");
      setDate(data.plan.date);
      const list = pick(data.plan);
      const lessons = new Map<string, Lesson>();
      for (const id of new Set(list.map((x) => x.lessonId))) lessons.set(id, (await getJson<{ lesson: Lesson }>(`/api/lesson/${id}`)).data.lesson);
      setEntries(
        list
          .map((x): QueueEntry | null => {
            const les = lessons.get(x.lessonId);
            const ex = les?.exercises.find((e) => e.id === x.exerciseId) as Exercise | undefined;
            return ex && les ? { ex, lessonId: les.id, label: `${les.id} · ${l(ex.prompt)}` } : null;
          })
          .filter((x): x is QueueEntry => !!x),
      );
    })().catch(() => setEntries([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!entries) return <p className="muted">…</p>;
  return (
    <div>
      <p>
        <Link href="/">← {t("backToday")}</Link>
      </p>
      <h1>{title}</h1>
      {entries.length ? <ExerciseQueue entries={entries} context={context} date={date} count={3} onFinished={() => setFin(true)} /> : <p className="muted">{t("noReviews")}</p>}
      {fin ? (
        <p className="good" data-testid="runlist-finished">
          {t("allDone")} <Link href="/">{t("backToday")}</Link>
        </p>
      ) : null}
    </div>
  );
}
