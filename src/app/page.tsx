"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/client/i18n";
import { getJson } from "@/lib/client/api";
import type { DayPlan } from "@/lib/server/planner";

interface Today {
  plan: DayPlan;
  titles: Record<string, { en: string; sr: string }>;
  placementDone: boolean;
}

export default function TodayPage() {
  const { t, l } = useI18n();
  const [d, setD] = useState<Today | null>(null);
  const [stale, setStale] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () =>
    getJson<Today>("/api/today")
      .then(({ data, stale }) => {
        setD(data);
        setStale(stale);
        // warm the offline cache with everything today's plan needs
        const ids = new Set<string>([...data.plan.lessons.map((x) => x.id), ...(data.plan.maintenance?.reviews.map((r) => r.lessonId) ?? []), ...(data.plan.test?.exercises.map((r) => r.lessonId) ?? [])]);
        if (data.plan.maintenance?.warmup) ids.add(data.plan.maintenance.warmup);
        if (data.plan.kind === "placement") ids.add("placement");
        ids.forEach((id) => {
          void getJson(`/api/lesson/${id}`).catch(() => {});
          // page HTML too, so the service worker has it for offline use
          if (id !== "placement") void fetch(`/lesson/${id}`).catch(() => {});
        });
      })
      .catch((e) => setErr(String(e)));
  useEffect(() => {
    void load();
  }, []);
  if (err) return <p className="bad">{err}</p>;
  if (!d) return <p className="muted">…</p>;
  const p = d.plan;
  const skipPlacement = async () => {
    await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ placementSkipped: true }) });
    await load();
  };
  const totalFocus = p.lessons.reduce((a, x) => a + x.minutes, 0);
  return (
    <div className="today">
      <h1>
        {t(p.weekday)} {p.date}
        {p.kind === "focus" && p.focusUsed.length ? <span className="muted"> · {p.focusUsed.map((x) => t(x)).join(" + ")}</span> : null}
      </h1>
      {stale ? <p className="pill warn">{t("offline")}</p> : null}
      {p.note ? <p className="note">{l(p.note)}</p> : null}

      {p.kind === "placement" ? (
        <section className="card">
          <h2>{t("placement")}</h2>
          <p>
            {l({
              en: "Day one: a short placement test finds what you already know (notation, theory, ear) so lessons you have mastered are skipped. Voice baseline comes with the voice module (M2).",
              sr: "Prvi dan: kratak test plasmana utvrđuje šta već znaš (notacija, teorija, sluh), pa se savladane lekcije preskaču. Početna procena glasa stiže sa modulom za glas (M2).",
            })}
          </p>
          <div className="row">
            <Link className="button primary" href="/placement" data-testid="start-placement">
              {t("start")}
            </Link>
            <button type="button" className="secondary" onClick={skipPlacement}>
              {t("skipPlacement")}
            </button>
          </div>
        </section>
      ) : null}

      {p.kind === "rest" ? <p>{t("restDay")}</p> : null}

      {p.kind === "test" && p.test ? (
        <section className="card">
          <h2>{t("weeklyTest")}</h2>
          <p className="muted">{p.test.exercises.length} × {t("exercise").toLowerCase()}</p>
          <Link className="button primary" href="/test">
            {t("start")}
          </Link>
        </section>
      ) : null}

      {p.lessons.length ? (
        <section className="card">
          <h2>
            {t("focus")} <span className="muted small">~{totalFocus} {t("min")}</span>
          </h2>
          <ul className="lessons">
            {p.lessons.map((x) => (
              <li key={x.id} className={x.status}>
                <Link href={`/lesson/${x.id}?date=${p.date}`} data-testid="lesson-link">
                  <span className="tag">{x.id}</span> {l(d.titles[x.id])}
                </Link>
                <span className="muted small">
                  {" "}
                  {x.minutes} {t("min")} · {t(x.status as "new")}
                </span>
                {x.aheadOfTheory ? (
                  <span className="pill warn small" title={x.aheadOfTheory.join(", ")}>
                    {t("aheadOfTheory")}: {x.aheadOfTheory.join(", ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {p.lessons.every((x) => x.status === "passed" || x.status === "skipped") ? <p className="good">{t("allDone")}</p> : null}
        </section>
      ) : null}

      {p.maintenance ? (
        <section className="card">
          <h2>
            {t("maintenance")} <span className="muted small">≤{Math.max(p.maintenance.minutes, 3)} {t("min")}</span>
          </h2>
          <ul className="lessons">
            {p.maintenance.warmup ? (
              <li>
                <Link href={`/lesson/${p.maintenance.warmup}?date=${p.date}`}>{t("warmup")}</Link>
              </li>
            ) : null}
            <li>
              {p.maintenance.reviews.length ? (
                <Link href="/review" data-testid="review-link">
                  {t("reviews")}: {p.maintenance.reviews.length} {t("dueReviews")}
                </Link>
              ) : (
                <span className="muted">{t("noReviews")}</span>
              )}
            </li>
          </ul>
        </section>
      ) : null}
    </div>
  );
}
