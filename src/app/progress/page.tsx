"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/client/i18n";
import { getJson } from "@/lib/client/api";

interface Prog {
  lessons: { id: string; track: string; title: { en: string; sr: string }; status: string; score: number | null }[];
  byTrack: { track: string; date: string; avg: number; n: number }[];
  srs: { total: number; due: number | null };
}

const COLORS: Record<string, string> = { T: "var(--c-t)", E: "var(--c-e)", K: "var(--c-k)", V: "var(--c-v)", P: "var(--muted)" };

/** Daily average score per track as a small line chart (inline SVG, no chart lib). */
function Chart({ rows }: { rows: Prog["byTrack"] }) {
  const { t } = useI18n();
  const dates = [...new Set(rows.map((r) => r.date))].sort().slice(-30);
  if (dates.length < 1) return null;
  const W = 600, H = 160, pad = 24;
  const x = (d: string) => pad + (dates.length === 1 ? (W - 2 * pad) / 2 : (dates.indexOf(d) / (dates.length - 1)) * (W - 2 * pad));
  const y = (v: number) => H - pad - v * (H - 2 * pad);
  const tracks = [...new Set(rows.map((r) => r.track))].filter((tr) => tr !== "P");
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="daily average score per track">
        {[0, 0.5, 0.8, 1].map((v) => (
          <g key={v}>
            <line x1={pad} x2={W - pad} y1={y(v)} y2={y(v)} className="grid" />
            <text x={2} y={y(v) + 4} className="axis">{Math.round(v * 100)}</text>
          </g>
        ))}
        {tracks.map((tr) => {
          const pts = rows.filter((r) => r.track === tr && dates.includes(r.date));
          return (
            <g key={tr}>
              <polyline fill="none" stroke={COLORS[tr]} strokeWidth={2} points={pts.map((r) => `${x(r.date)},${y(r.avg)}`).join(" ")} />
              {pts.map((r) => <circle key={r.date} cx={x(r.date)} cy={y(r.avg)} r={3} fill={COLORS[tr]}><title>{`${tr} ${r.date}: ${Math.round(r.avg * 100)}% (${r.n})`}</title></circle>)}
            </g>
          );
        })}
      </svg>
      <figcaption>
        {tracks.map((tr) => (
          <span key={tr} className="legend"><i style={{ background: COLORS[tr] }} /> {t(tr as "T")}</span>
        ))}
      </figcaption>
    </figure>
  );
}

export default function ProgressPage() {
  const { t, l } = useI18n();
  const [d, setD] = useState<Prog | null>(null);
  useEffect(() => {
    getJson<Prog>("/api/progress").then(({ data }) => setD(data)).catch(() => {});
  }, []);
  if (!d) return <p className="muted">…</p>;
  const ORDER = "TEKVCL";
  const tracks = [...new Set(d.lessons.map((x) => x.track))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  return (
    <div>
      <h1>{t("progress")}</h1>
      <p className="muted">SRS: {d.srs.total ?? 0} · {d.srs.due ?? 0} {t("dueReviews")}</p>
      <section className="card">
        <h2>{t("history")}</h2>
        <Chart rows={d.byTrack} />
      </section>
      {tracks.map((tr) => {
        const ls = d.lessons.filter((x) => x.track === tr);
        const doneN = ls.filter((x) => x.status === "passed" || x.status === "skipped").length;
        return (
          <section key={tr} className="card">
            <h2>{t(tr as "T")} <span className="muted small">{doneN}/{ls.length}</span></h2>
            <ul className="lessons">
              {ls.map((x) => (
                <li key={x.id} className={x.status}>
                  <Link href={`/lesson/${x.id}`}><span className="tag">{x.id}</span> {l(x.title)}</Link>
                  <span className="muted small"> {t(x.status as "new")}{x.score != null ? ` · ${Math.round(x.score * 100)}%` : ""}</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
