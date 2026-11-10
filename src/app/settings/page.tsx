"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/client/i18n";
import { useMidiState } from "@/components/MidiStatus";
import { Keyboard } from "@/components/Keyboard";
import type { Settings, Weekday, Focus } from "@/lib/server/settings";

const DAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const OPTS: Focus[] = ["T", "E", "K", "V", "C", "L", "test", "rest"];

export default function SettingsPage() {
  const { t, locale, setLocale } = useI18n();
  const m = useMidiState();
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState("");
  const [voice, setVoice] = useState<{ up: boolean; url: string; version?: string; error?: string } | null>(null);
  useEffect(() => {
    fetch("/api/settings").then((r) => r.json()).then(setS);
    fetch("/api/voice-score/health").then((r) => r.json()).then(setVoice).catch(() => setVoice({ up: false, url: "?" }));
  }, []);
  if (!s) return <p className="muted">…</p>;
  const save = async (patch: Partial<Settings>) => {
    const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    const j = await r.json();
    if (r.ok) {
      setS(j);
      m.inputId = j.midiIn;
      m.outputId = j.midiOut;
      m.playback = j.playback;
      setMsg(t("saved"));
      setTimeout(() => setMsg(""), 1500);
    } else setMsg(j.error);
  };
  const toggle = (d: Weekday, f: Focus) => {
    const cur = s.schedule[d];
    let next = cur.includes(f) ? cur.filter((x) => x !== f) : [...cur.filter((x) => x !== "rest" && x !== "test"), f];
    if (f === "rest" || f === "test") next = cur.includes(f) ? cur.filter((x) => x !== f) : [f];
    if (!next.length) return;
    void save({ schedule: { ...s.schedule, [d]: next } });
  };
  const replan = async () => {
    await fetch("/api/plan/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    setMsg(t("saved"));
  };
  return (
    <div className="settings">
      <h1>{t("settings")} {msg ? <span className="pill ok">{msg}</span> : null}</h1>
      <section className="card">
        <h2>{t("language")}</h2>
        <div className="row">
          <button type="button" className={locale === "en" ? "primary" : "secondary"} onClick={() => setLocale("en")}>English</button>
          <button type="button" className={locale === "sr" ? "primary" : "secondary"} onClick={() => setLocale("sr")}>Srpski</button>
        </div>
      </section>
      <section className="card">
        <h2>{t("schedule")}</h2>
        <table className="schedule">
          <thead>
            <tr><th />{OPTS.map((o) => <th key={o}>{t(o as "T")}</th>)}</tr>
          </thead>
          <tbody>
            {DAYS.map((d) => (
              <tr key={d}>
                <th>{t(d)}</th>
                {OPTS.map((o) => (
                  <td key={o}><input type="checkbox" aria-label={`${d} ${o}`} checked={s.schedule[d].includes(o)} onChange={() => toggle(d, o)} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <label className="row">
          {t("focusMinutes")}: <input type="number" min={25} max={50} value={s.focusMinutes} onChange={(e) => void save({ focusMinutes: Number(e.target.value) })} />
        </label>
        <label className="row">
          <input type="checkbox" checked={s.maintenance} onChange={(e) => void save({ maintenance: e.target.checked })} data-testid="maintenance-toggle" /> {t("maintenanceOn")}
        </label>
        <button type="button" className="secondary" onClick={replan}>{t("replan")}</button>
      </section>
      <section className="card">
        <h2>MIDI</h2>
        <p className="muted small">Web MIDI: {m.status}{m.status === "ready" ? ` · in: ${m.inputs.map((i) => i.name).join(", ") || "—"} · out: ${m.outputs.map((o) => o.name).join(", ") || "—"}` : ""}</p>
        <label className="row">
          {t("midiIn")}:
          <select value={s.midiIn ?? ""} onChange={(e) => void save({ midiIn: e.target.value || null })}>
            <option value="">{t("allInputs")}</option>
            {m.inputs.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </label>
        <label className="row">
          {t("midiOut")}:
          <select value={s.playback === "webaudio" ? "webaudio" : s.midiOut ?? ""} onChange={(e) => void save(e.target.value === "webaudio" ? { playback: "webaudio" } : { playback: "auto", midiOut: e.target.value || null })}>
            <option value="">auto ({m.outputName()})</option>
            <option value="webaudio">Web Audio</option>
            {m.outputs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <button type="button" className="secondary" onClick={() => void m.play({ mode: "chords", chords: [[60, 64, 67], [60, 65, 69], [59, 62, 67], [60, 64, 67]], tempo: 90 })}>{t("testSound")}</button>
        </label>
        <Keyboard from={48} to={84} />
      </section>
      <section className="card">
        <h2>{t("voiceScore")}</h2>
        <p data-testid="voice-status">{voice ? (voice.up ? `✓ ${t("up")} · ${voice.url} · v${voice.version}` : `✕ ${t("down")} (${voice.url}${voice.error ? `: ${voice.error}` : ""})`) : "…"}</p>
      </section>
      <section className="card">
        <h2>{t("placement")}</h2>
        <a className="button secondary" href="/placement">{t("redoPlacement")}</a>
      </section>
    </div>
  );
}
