"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/client/i18n";
import { getJson } from "@/lib/client/api";

interface H {
  trend: { track: string; week: string; avg: number; n: number }[];
  tests: { week: string; avg: number; n: number; date: string }[];
  projects: { id: string; week: string; projectId: string; kind: string; title: { en: string; sr: string } | null; status: string; score: number | null; final: boolean; aiStatus: string | null; parts: Record<string, number> | null }[];
}
const COLORS: Record<string, string> = { T: "var(--c-t)", E: "var(--c-e)", K: "var(--c-k)", V: "var(--c-v)", test: "var(--fg)" };

/** Weekly averages per track (lines) + weekly test score; inline SVG, no chart lib. */
function Trends({ h }: { h: H }) {
  const { t } = useI18n();
  const weeks = [...new Set([...h.trend.map((r) => r.week), ...h.tests.map((r) => r.week)])].sort().slice(-16);
  if (!weeks.length) return <p className="muted">—</p>;
  const W = 640, H = 200, pad = 28;
  const x = (w: string) => pad + (weeks.length === 1 ? (W - 2 * pad) / 2 : (weeks.indexOf(w) / (weeks.length - 1)) * (W - 2 * pad));
  const y = (v: number) => H - pad - v * (H - 2 * pad);
  const series: [string, { week: string; avg: number; n: number }[]][] = [...["T", "E", "K", "V"].map((tr) => [tr, h.trend.filter((r) => r.track === tr && weeks.includes(r.week))] as [string, { week: string; avg: number; n: number }[]]), ["test", h.tests.filter((r) => weeks.includes(r.week))]];
  return (
    <figure className="chart" data-testid="trends">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="weekly average score per track">
        {[0, 0.5, 0.8, 1].map((v) => (
          <g key={v}>
            <line x1={pad} x2={W - pad} y1={y(v)} y2={y(v)} className="grid" />
            <text x={2} y={y(v) + 4} className="axis">{Math.round(v * 100)}</text>
          </g>
        ))}
        {weeks.map((w) => (
          <text key={w} x={x(w)} y={H - 8} className="axis" textAnchor="middle">{w.slice(5)}</text>
        ))}
        {series.filter(([, pts]) => pts.length).map(([tr, pts]) => (
          <g key={tr}>
            <polyline fill="none" stroke={COLORS[tr]} strokeWidth={tr === "test" ? 3 : 2} strokeDasharray={tr === "test" ? "6 4" : undefined} points={pts.map((r) => `${x(r.week)},${y(r.avg)}`).join(" ")} />
            {pts.map((r) => <circle key={r.week} cx={x(r.week)} cy={y(r.avg)} r={3.5} fill={COLORS[tr]}><title>{`${tr} ${r.week}: ${Math.round(r.avg * 100)}% (${r.n})`}</title></circle>)}
          </g>
        ))}
      </svg>
      <figcaption>
        {series.filter(([, pts]) => pts.length).map(([tr]) => (
          <span key={tr} className="legend"><i style={{ background: COLORS[tr] }} /> {tr === "test" ? t("weeklyTest") : t(tr as "T")}</span>
        ))}
      </figcaption>
    </figure>
  );
}

export default function HistoryPage() {
  const { t, l } = useI18n();
  const [h, setH] = useState<H | null>(null);
  useEffect(() => {
    getJson<H>("/api/history").then(({ data }) => setH(data)).catch(() => {});
  }, []);
  if (!h) return <p className="muted">…</p>;
  return (
    <div>
      <h1>{t("history2")}</h1>
      <section className="card">
        <h2>{t("history")}</h2>
        <Trends h={h} />
      </section>
      <section className="card">
        <h2>{t("weeklyTest")}</h2>
        {h.tests.length ? (
          <table className="small">
            <tbody>
              {h.tests.map((r) => (
                <tr key={r.week}><td>{r.week}</td><td>{Math.round(r.avg * 100)}%</td><td className="muted">{r.n} items</td></tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">—</p>}
      </section>
      <section className="card">
        <h2>{t("project")}</h2>
        {h.projects.length ? (
          <table className="small" data-testid="project-history">
            <tbody>
              {h.projects.map((p) => (
                <tr key={p.id}>
                  <td>{p.week}</td>
                  <td>{t(("kind_" + p.kind) as "kind_composition")}</td>
                  <td>{p.title ? l(p.title) : p.projectId}</td>
                  <td>{p.score != null ? `${Math.round(p.score * 100)}%` : p.status}</td>
                  <td className="muted">{p.score != null ? (p.final ? t("final") : t("provisional")) : ""} {p.parts ? Object.entries(p.parts).map(([k, v]) => `${k} ${Math.round(v * 100)}`).join(" · ") : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">—</p>}
        <p><Link href="/project">{t("open")} →</Link></p>
      </section>
    </div>
  );
}
