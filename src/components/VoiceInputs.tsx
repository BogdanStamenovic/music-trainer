"use client";
import { useEffect, useRef, useState } from "react";
import type { SingItem, RangeItem } from "@/lib/curriculum/items";
import { takeQuality, type Response, type VoiceAnalysis } from "@/lib/grading";
import { record, analyzeTake } from "@/lib/client/voice";
import { midi } from "@/lib/client/midi";
import { useI18n } from "@/lib/client/i18n";
import { midiToNote, noteName, parseNote, toMidi } from "@/lib/music/pitch";

type Meta = { date: string; lessonId: string | null };

function Meter({ level }: { level: number }) {
  return (
    <div className="meter" aria-hidden>
      <i style={{ width: `${Math.round(level * 100)}%` }} />
    </div>
  );
}

/** Record one take; returns the blob. Auto-stops after maxSeconds. */
function useRecorder() {
  const [state, setState] = useState<"idle" | "recording" | "analyzing">("idle");
  const [level, setLevel] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const start = async (maxSeconds: number): Promise<Blob | null> => {
    setErr(null);
    midi().stop();
    try {
      const r = await record(maxSeconds, setLevel);
      stopRef.current = r.stop;
      setState("recording");
      const take = await r.done;
      setLevel(0);
      setState("analyzing");
      return take.blob;
    } catch (e) {
      setErr((e as Error).message);
      setState("idle");
      return null;
    }
  };
  return { state, setState, level, err, start, stop: () => stopRef.current?.() };
}

export function SingInput({ item, meta, onSubmit, disabled }: { item: SingItem; meta: Meta; onSubmit: (r: Response) => void; disabled: boolean }) {
  const { t, locale } = useI18n();
  const rec = useRecorder();
  const [url, setUrl] = useState<string | null>(null);
  const beatS = item.tempo ? 60 / item.tempo : 1;
  const expected = item.layout ? item.layout.reduce((a, e) => a + e.beats, 0) * beatS : item.beats ? item.beats.reduce((a, b) => a + b, 0) * beatS : item.sustain ?? 2;
  const go = async () => {
    // voice-score accepts up to 60 s
    const blob = await rec.start(Math.min(58, expected + 4));
    if (!blob) return;
    setUrl(URL.createObjectURL(blob));
    const params = {
      targets: item.layout
        ? item.layout.map((e) => (e.midi != null ? { midi: e.midi, beats: e.beats } : { rest: true as const, beats: e.beats }))
        : item.targets.map((m, i) => (item.beats ? { midi: m, beats: item.beats[i] } : { midi: m })),
      tempo_bpm: item.beats ? item.tempo : undefined,
      pass_cents: item.tolerance,
      octave_agnostic: item.octaveAgnostic,
    };
    const out = await analyzeTake(blob, params, { ...meta, exerciseId: item.exerciseId, itemId: item.id });
    rec.setState("idle");
    if (!out.analysis && out.reason === "nothing-voiced") {
      rec.setState("idle");
      alertNoVoice();
      return;
    }
    onSubmit({ kind: "sing", recordingId: out.recordingId, analysis: out.analysis, reason: out.reason ?? (out.source === "browser" ? "browser" : undefined) });
  };
  const [noVoice, setNoVoice] = useState(false);
  const alertNoVoice = () => setNoVoice(true);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return (
    <div className="sing">
      <p className="targets">
        🎵 {item.targets.map((m) => noteName(midiToNote(m), locale, true)).join(" – ")}
        {item.sustain ? ` · ${item.sustain} s` : ""}
        {item.tempo && item.beats ? ` · ♩=${item.tempo}` : ""}
      </p>
      {!disabled ? (
        <div className="row">
          {rec.state === "recording" ? (
            <button type="button" className="primary rec" onClick={rec.stop} data-testid="stop">
              {t("stop")}
            </button>
          ) : (
            <button type="button" className="primary" onClick={() => { setNoVoice(false); void go(); }} disabled={rec.state === "analyzing"} data-testid="record">
              {t("record")}
            </button>
          )}
          <span className="muted small">{rec.state === "recording" ? t("recording") : rec.state === "analyzing" ? t("analyzing") : t("listenFirst")}</span>
        </div>
      ) : null}
      {rec.state === "recording" ? <Meter level={rec.level} /> : null}
      {rec.err ? <p className="bad small">{t("micDenied")} ({rec.err})</p> : null}
      {noVoice ? <p className="bad small" data-testid="no-voice">{t("noVoice")}</p> : null}
      {url ? (
        <div className="row small">
          {t("yourTake")}: <audio controls src={url} />
        </div>
      ) : null}
    </div>
  );
}

/** Recording-quality warnings from voice-score, in plain words. */
export function TakeWarnings({ analysis, graded = true }: { analysis: VoiceAnalysis | null | undefined; graded?: boolean }) {
  const { t } = useI18n();
  const q = takeQuality(analysis);
  if (!q.lowLevel && !q.noisy) return null;
  return (
    <div className="warn small" data-testid="take-warnings">
      {q.lowLevel ? <p>⚠ {t("takeLowLevel")}</p> : null}
      {q.noisy ? <p>⚠ {t("takeNoisy")}</p> : null}
      {graded ? <p>{t("takeUnreliable")}</p> : null}
    </div>
  );
}

export function SingFeedback({ item, detail, resp }: { item: SingItem; detail: Record<string, unknown>; resp: Response }) {
  const { t, locale } = useI18n();
  const notes = (detail.notes as { target: number; score: number; cents: number | null; sustain: number | null }[] | undefined) ?? [];
  const src = resp.kind === "sing" && resp.analysis?.tracker?.includes("web") ? t("viaBrowser") : resp.kind === "sing" && resp.analysis ? t("viaServer") : t("analysisFailed");
  return (
    <div className="sing-fb">
      <table className="small">
        <tbody>
          {notes.map((n, i) => (
            <tr key={i} className={n.score >= 0.999 ? "good" : n.score > 0 ? "" : "bad"}>
              <td>{noteName(midiToNote(n.target), locale, true)}</td>
              <td>{n.cents == null ? "—" : `${n.cents > 0 ? "+" : ""}${Math.round(n.cents)} ${t("cents")}`}</td>
              <td>{n.sustain != null ? `${t("held")} ${n.sustain.toFixed(1)} s` : ""}</td>
              <td>{Math.round(n.score * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted small">
        {src} · ±{item.tolerance} {t("cents")}
      </div>
      {resp.kind === "sing" ? <TakeWarnings analysis={resp.analysis} /> : null}
    </div>
  );
}

function rangeEnd(a: VoiceAnalysis | null, which: "low" | "high"): number | null {
  const n = which === "low" ? a?.summary?.range?.low_note : a?.summary?.range?.high_note;
  if (!n) return null;
  try {
    return toMidi(parseNote(n));
  } catch {
    return null;
  }
}

export function RangeInput({ item, meta, onSubmit, disabled }: { item: RangeItem; meta: Meta; onSubmit: (r: Response) => void; disabled: boolean }) {
  const { t, l, locale } = useI18n();
  const rec = useRecorder();
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [low, setLow] = useState<{ id: string; midi: number | null } | null>(null);
  const [high, setHigh] = useState<{ id: string; midi: number | null } | null>(null);
  const [fail, setFail] = useState(false);
  const [lastAnalysis, setLastAnalysis] = useState<VoiceAnalysis | null>(null);
  const go = async () => {
    setFail(false);
    const blob = await rec.start(12);
    if (!blob) return;
    const out = await analyzeTake(blob, {}, { ...meta, exerciseId: item.exerciseId, itemId: `${item.id}:${step === 0 ? "low" : "high"}` });
    rec.setState("idle");
    setLastAnalysis(out.analysis);
    const m = rangeEnd(out.analysis, step === 0 ? "low" : "high");
    if (m == null) {
      setFail(true);
      return;
    }
    if (step === 0) {
      setLow({ id: out.recordingId, midi: m });
      setStep(1);
    } else {
      const h = { id: out.recordingId, midi: m };
      setHigh(h);
      setStep(2);
      onSubmit({ kind: "range", recordingIds: [low!.id, h.id], lowMidi: low!.midi, highMidi: h.midi });
    }
  };
  const nm = (m: number | null) => (m == null ? "?" : noteName(midiToNote(m), locale, true));
  return (
    <div className="sing">
      {step < 2 ? <p>{t(step === 0 ? "rangeLow" : "rangeHigh")}</p> : null}
      {!disabled && step < 2 ? (
        <div className="row">
          {rec.state === "recording" ? (
            <button type="button" className="primary rec" onClick={rec.stop}>
              {t("stop")}
            </button>
          ) : (
            <button type="button" className="primary" onClick={() => void go()} disabled={rec.state === "analyzing"} data-testid="record">
              {t("record")}
            </button>
          )}
          <span className="muted small">{rec.state === "recording" ? t("recording") : rec.state === "analyzing" ? t("analyzing") : ""}</span>
        </div>
      ) : null}
      {rec.state === "recording" ? <Meter level={rec.level} /> : null}
      {fail ? <p className="bad small">{t("noVoice")}</p> : null}
      <TakeWarnings analysis={lastAnalysis} graded={false} />
      {low ? (
        <p data-testid="range-result">
          {t("rangeResult")}: {nm(low.midi)} – {nm(high?.midi ?? null)}
          {low.midi != null && high?.midi != null ? ` (${t("comfortable")} ${nm(Math.min(low.midi + 2, high.midi))} – ${nm(Math.max(high.midi - 2, low.midi))})` : ""}
        </p>
      ) : null}
      <span hidden>{l(item.prompt)}</span>
    </div>
  );
}

export function CheckinInput({ onSubmit, disabled }: { onSubmit: (r: Response) => void; disabled: boolean }) {
  const { t } = useI18n();
  return (
    <div className="options three">
      <button type="button" disabled={disabled} onClick={() => onSubmit({ kind: "checkin", state: "fine" })} data-testid="checkin-fine">
        🙂 {t("checkinFine")}
      </button>
      <button type="button" disabled={disabled} onClick={() => onSubmit({ kind: "checkin", state: "tired" })} data-testid="checkin-tired">
        😮‍💨 {t("checkinTired")}
      </button>
      <button type="button" disabled={disabled} onClick={() => onSubmit({ kind: "checkin", state: "hoarse" })} data-testid="checkin-hoarse">
        🤐 {t("checkinHoarse")}
      </button>
    </div>
  );
}
