"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { Placement } from "@/lib/curriculum/schema";
import { useI18n } from "@/lib/client/i18n";
import { getJson } from "@/lib/client/api";
import { ExerciseQueue } from "@/components/ExerciseQueue";

interface Status {
  finished: boolean;
  pending: string[];
  sections: { id: string; total: number; done: string[] }[];
}

export default function PlacementPage() {
  return (
    <Suspense>
      <PlacementInner />
    </Suspense>
  );
}

/**
 * Placement resumes from what the server has stored (every answer is saved as it is
 * given), so a reload or a break loses nothing. Any section can be put off with
 * "do this later": placement then finishes for the other sections, and the deferred
 * one stays pending (its track starts from lesson 1) until it is done.
 * ?section=<id> runs just one (pending) section.
 */
function PlacementInner() {
  const { t, l } = useI18n();
  const only = useSearchParams().get("section");
  const [p, setP] = useState<Placement | null>(null);
  const [st, setSt] = useState<Status | null>(null);
  const [sec, setSec] = useState<number | null>(null);
  const [deferred, setDeferred] = useState<string[]>([]);
  const [result, setResult] = useState<{ skipped: string[]; deferred: string[] } | null>(null);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Belgrade" }).format(new Date());

  useEffect(() => {
    Promise.all([getJson<{ placement: Placement }>("/api/lesson/placement"), fetch("/api/placement").then((r) => r.json() as Promise<Status>)])
      .then(([{ data }, s]) => {
        setP(data.placement);
        setSt(s);
        const secs = data.placement.sections;
        if (only) setSec(Math.max(0, secs.findIndex((x) => x.id === only)));
        else {
          // resume at the first section with unanswered exercises
          const first = secs.findIndex((x) => {
            const ss = s.sections.find((y) => y.id === x.id);
            return !ss || ss.done.length < x.exercises.length;
          });
          setSec(first === -1 ? secs.length : first);
        }
      })
      .catch(() => {});
  }, [only]);

  const finalize = async (defer: string[]) => {
    const body = only ? { completeSection: only } : { finalize: true, deferred: defer };
    const res = await fetch("/api/placement", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setResult(await res.json());
  };

  if (!p || !st || sec === null) return <p className="muted">…</p>;
  if (result)
    return (
      <section className="card" data-testid="placement-done">
        <h1>{t("placement")}</h1>
        <p>
          {t("placementResult")} {result.skipped.length ? result.skipped.join(", ") : t("none")}
        </p>
        {result.deferred.length ? (
          <p className="note" data-testid="placement-pending">
            {t("placementLaterNote")}: {result.deferred.map((id) => l(p.sections.find((s) => s.id === id)?.title)).join(", ")}
          </p>
        ) : null}
        <Link className="button primary" href="/">
          {t("backToday")}
        </Link>
      </section>
    );

  const next = (defer: string[]) => {
    if (only) return void finalize([]);
    const n = sec + 1;
    if (n < p.sections.length) setSec(n);
    else void finalize(defer);
  };
  if (sec >= p.sections.length) {
    // everything answered already (e.g. reload after the last answer): just finish
    return (
      <section className="card">
        <h1>{t("placement")}</h1>
        <button type="button" className="primary" onClick={() => void finalize(deferred)}>
          {t("finish")}
        </button>
      </section>
    );
  }
  const s = p.sections[sec];
  const done = st.sections.find((x) => x.id === s.id)?.done ?? [];
  const startAt = Math.max(0, s.exercises.findIndex((e) => !done.includes(e.id)));
  return (
    <div>
      <h1>{t("placement")}</h1>
      <p className="muted">
        {t("section")} {only ? "" : `${sec + 1}/${p.sections.length}: `}
        <strong>{l(s.title)}</strong>
      </p>
      <p>{l(s.intro)}</p>
      {!only ? (
        <p>
          <button
            type="button"
            className="secondary"
            data-testid="placement-later"
            onClick={() => {
              const d = [...deferred, s.id];
              setDeferred(d);
              next(d);
            }}
          >
            ⏭ {t("placementLater")}
          </button>
        </p>
      ) : null}
      <ExerciseQueue key={s.id} entries={s.exercises.map((ex) => ({ ex, lessonId: null }))} context="placement" date={date} startAt={startAt} onFinished={() => next(deferred)} />
    </div>
  );
}
