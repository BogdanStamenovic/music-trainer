"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/client/i18n";
import { midiToNote, noteName } from "@/lib/music/pitch";
import type { VoiceAnalysis } from "@/lib/grading";

interface Rec {
  id: string;
  createdAt: number;
  date: string;
  lessonId: string | null;
  exerciseId: string;
  params: { targets?: { midi: number }[] };
  status: string;
  serverAnalysis: VoiceAnalysis | null;
  browserAnalysis: VoiceAnalysis | null;
  audioUrl: string;
}
interface S {
  voiceRange: { low: number; high: number; comfortLow: number; comfortHigh: number; measuredAt: number } | null;
  shareRecordings: boolean;
  shareConsentAt: number | null;
}

export default function VoicePage() {
  const { t, locale } = useI18n();
  const [recs, setRecs] = useState<Rec[] | null>(null);
  const [s, setS] = useState<S | null>(null);
  const nm = (m: number) => noteName(midiToNote(m), locale, true);
  useEffect(() => {
    fetch("/api/voice/recordings?limit=100").then((r) => r.json()).then((j) => setRecs(j.recordings)).catch(() => setRecs([]));
    fetch("/api/settings").then((r) => r.json()).then(setS).catch(() => {});
  }, []);
  const share = async (on: boolean) => {
    const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shareRecordings: on }) });
    setS(await r.json());
  };
  return (
    <div>
      <h1>{t("voice")}</h1>
      <section className="card">
        <h2>{t("rangeResult")}</h2>
        {s?.voiceRange ? (
          <p data-testid="stored-range">
            {nm(s.voiceRange.low)} – {nm(s.voiceRange.high)} · {t("comfortable")} {nm(s.voiceRange.comfortLow)} – {nm(s.voiceRange.comfortHigh)}
            <span className="muted small"> ({new Date(s.voiceRange.measuredAt).toISOString().slice(0, 10)})</span>
          </p>
        ) : (
          <p className="muted">—</p>
        )}
      </section>
      <section className="card">
        <h2>{t("shareTitle")}</h2>
        <p className="small">{t("shareText")}</p>
        <label className="row">
          <input type="checkbox" checked={!!s?.shareRecordings} onChange={(e) => void share(e.target.checked)} data-testid="share-toggle" />
          {s?.shareRecordings && s.shareConsentAt ? `${t("shareOn")} ${new Date(s.shareConsentAt).toLocaleString()}` : t("shareTitle")}
        </label>
      </section>
      <section className="card">
        <h2>{t("history")}</h2>
        {!recs ? <p className="muted">…</p> : !recs.length ? <p className="muted">{t("noRecordings")}</p> : null}
        <ul className="recs">
          {recs?.map((r) => {
            const a = r.serverAnalysis ?? r.browserAnalysis;
            const targets = r.params.targets?.map((x) => nm(x.midi)).join(" ") ?? "";
            const sung = a?.notes?.map((n) => (n.cents_error == null ? "—" : `${n.cents_error > 0 ? "+" : ""}${Math.round(n.cents_error)}`)).join(" ") ?? "";
            return (
              <li key={r.id} data-testid="recording">
                <div className="small">
                  <span className="tag">{r.exerciseId}</span> {new Date(r.createdAt).toLocaleString()} · {r.status}
                  {a ? ` · ${a.tracker}` : ""}
                </div>
                {targets ? (
                  <div className="small">
                    {t("target")}: {targets} · {t("cents")}: {sung}
                  </div>
                ) : a?.summary?.range ? (
                  <div className="small">
                    {a.summary.range.low_note} – {a.summary.range.high_note}
                  </div>
                ) : null}
                <audio controls preload="none" src={r.audioUrl} />
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
