"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Placement } from "@/lib/curriculum/schema";
import { useI18n } from "@/lib/client/i18n";
import { getJson } from "@/lib/client/api";
import { ExerciseQueue } from "@/components/ExerciseQueue";
import { RunnerDone } from "@/components/ExerciseRunner";

export default function PlacementPage() {
  const { t, l } = useI18n();
  const [p, setP] = useState<Placement | null>(null);
  const [sec, setSec] = useState(0);
  const [all, setAll] = useState<RunnerDone[]>([]);
  const [skipped, setSkipped] = useState<string[] | null>(null);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Belgrade" }).format(new Date());
  useEffect(() => {
    getJson<{ placement: Placement }>("/api/lesson/placement").then(({ data }) => setP(data.placement)).catch(() => {});
  }, []);
  if (!p) return <p className="muted">…</p>;
  const finishSection = async (r: RunnerDone[]) => {
    const merged = [...all, ...r];
    setAll(merged);
    if (sec + 1 < p.sections.length) setSec(sec + 1);
    else {
      const res = await fetch("/api/placement", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ results: merged.map((x) => ({ exerciseId: x.exerciseId, score: x.score, pass: x.pass })) }) });
      setSkipped(((await res.json()).skipped as string[]) ?? []);
    }
  };
  if (skipped)
    return (
      <section className="card" data-testid="placement-done">
        <h1>{t("placement")}</h1>
        <p>
          {t("placementResult")} {skipped.length ? skipped.join(", ") : t("none")}
        </p>
        <Link className="button primary" href="/">
          {t("backToday")}
        </Link>
      </section>
    );
  const s = p.sections[sec];
  return (
    <div>
      <h1>{t("placement")}</h1>
      <p className="muted">
        {t("section")} {sec + 1}/{p.sections.length}: <strong>{l(s.title)}</strong>
      </p>
      <p>{l(s.intro)}</p>
      <ExerciseQueue key={s.id} entries={s.exercises.map((ex) => ({ ex, lessonId: null }))} context="placement" date={date} onFinished={finishSection} />
    </div>
  );
}
