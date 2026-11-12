"use client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type { Project, Criterion } from "@/lib/curriculum/schema";
import { useI18n } from "@/lib/client/i18n";
import { getJson } from "@/lib/client/api";
import { Markdown } from "@/components/Markdown";
import { Composer } from "@/components/Composer";
import { Keyboard } from "@/components/Keyboard";
import { SingInput, CheckinInput } from "@/components/VoiceInputs";
import { midi } from "@/lib/client/midi";
import { lyricsStats, melodyPlay, vocalItem } from "@/lib/projects";
import { romanChord } from "@/lib/music/harmony";
import { parseKey } from "@/lib/projects";
import { toMidi } from "@/lib/music/pitch";
import type { MidiEvent, Response } from "@/lib/grading";

interface ProjectView {
  id: string;
  week: string;
  kind: Project["kind"];
  status: string;
  score: number | null;
  final: number;
  ai_status: string | null;
  submission: Record<string, unknown> | null;
  auto: Record<string, unknown> | null;
  self: Record<string, number> | null;
  ai: { criteria: { id: string; score: number; comment: string }[]; summary: string; next_steps: string[] } | null;
  def: Project;
  jobs: { status: string; attempts: number; error: string | null }[];
}

function SelfRubric({ rubric, value, onChange }: { rubric: Criterion[]; value: Record<string, number>; onChange: (v: Record<string, number>) => void }) {
  const { l, t } = useI18n();
  return (
    <div className="rubric">
      <p className="small muted">{t("selfAssess")}</p>
      {rubric.map((c) => (
        <div key={c.id} className="crit">
          <div>
            <strong>{l(c.label)}</strong> <span className="muted small">×{c.weight}</span>
            <div className="muted small">4 = {l(c.top)}</div>
          </div>
          <div className="row">
            {[0, 1, 2, 3, 4].map((n) => (
              <button key={n} type="button" className={value[c.id] === n ? "primary" : "secondary"} onClick={() => onChange({ ...value, [c.id]: n })} data-testid={`self-${c.id}-${n}`}>
                {n}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Result({ p }: { p: ProjectView }) {
  const { t, l } = useI18n();
  const parts = (p.auto?.parts as Record<string, number> | undefined) ?? {};
  const rules = p.auto?.rules as { ok: boolean; checks?: { id: string; pass: boolean; score: number; detail: string }[]; error?: string } | undefined;
  const aiLabel: Record<string, string> = { pending: t("aiPending"), unavailable: t("aiUnavailable"), failed: t("aiFailed"), done: t("aiDone"), "n/a": t("aiNA") };
  return (
    <section className="card" data-testid="project-result">
      <h2>
        {t("score")}: {p.score != null ? `${Math.round(p.score * 100)}%` : "—"}{" "}
        <span className={`pill ${p.final ? "ok" : "warn"}`}>{p.final ? t("final") : t("provisional")}</span>
      </h2>
      <p className="small">
        {Object.entries(parts).map(([k, v]) => `${t(("part_" + k) as "part_rules")}: ${Math.round(v * 100)}%`).join(" · ")}
      </p>
      <p className="small" data-testid="ai-status">
        {t("aiReview")}: {aiLabel[p.ai_status ?? "n/a"] ?? p.ai_status}
        {p.ai_status === "unavailable" || p.ai_status === "failed" ? <span className="muted"> ({p.jobs.at(-1)?.error})</span> : null}
      </p>
      {rules ? (
        <details open={!rules.ok || rules.checks?.some((c) => !c.pass)}>
          <summary>{t("ruleChecks")}</summary>
          {rules.ok ? (
            <ul className="checks">
              {rules.checks!.map((c) => (
                <li key={c.id} className={c.pass ? "good" : "bad"}>
                  {c.pass ? "✓" : "✕"} <strong>{c.id}</strong> {Math.round(c.score * 100)}% <span className="small">{c.detail}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">{rules.error}</p>
          )}
        </details>
      ) : null}
      {p.auto?.stats ? (
        <p className="small muted">
          {JSON.stringify(p.auto.stats)}
        </p>
      ) : null}
      {p.kind === "byear" && p.auto ? (
        <p className="small">
          {t("part_pitch")}: {Math.round((p.auto.pitch as number) * 100)}% · {t("part_rhythm")}: {Math.round((p.auto.rhythm as number) * 100)}%
          {p.auto.transpose != null ? ` · ${t("transposed")} ${p.auto.transpose as number} ${t("semitones")}` : ""}
        </p>
      ) : null}
      {p.ai ? (
        <div className="ai" data-testid="ai-review">
          <p>{p.ai.summary}</p>
          <ul>
            {p.ai.criteria.map((c) => (
              <li key={c.id}>
                <strong>{l(p.def.rubric.find((r) => r.id === c.id)?.label)}</strong>: {c.score}/4 · {c.comment}
              </li>
            ))}
          </ul>
          {p.ai.next_steps.length ? (
            <>
              <h3>{t("nextSteps")}</h3>
              <ul>
                {p.ai.next_steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ByEar({ def, onEvents }: { def: Extract<Project, { kind: "byear" }>; onEvents: (e: MidiEvent[]) => void }) {
  const { t } = useI18n();
  const [plays, setPlays] = useState(0);
  const [events, setEvents] = useState<MidiEvent[]>([]);
  const ev = useRef<MidiEvent[]>([]);
  useEffect(() => {
    const un = midi().subscribe((e) => {
      ev.current = [...ev.current, e];
      setEvents(ev.current);
      onEvents(ev.current);
    }, { expect: true });
    return () => void un();
  }, [onEvents]);
  // no notation here on purpose: the point is to find the tune by ear
  return (
    <div>
      <div className="row">
        <button type="button" className="secondary" onClick={() => { setPlays(plays + 1); void midi().play(melodyPlay(def.melody)); }} data-testid="byear-listen">
          ▶ {t("listen")} {plays ? `(${plays})` : ""}
        </button>
        <button type="button" className="secondary" onClick={() => { ev.current = []; setEvents([]); onEvents([]); }}>
          {t("reset")}
        </button>
        <span className="muted small">
          {events.filter((e) => e.type === "on").length} {t("notesPlayed")}
        </span>
      </div>
      <Keyboard from={48} to={84} />
    </div>
  );
}

export default function ProjectPage() {
  return (
    <Suspense>
      <ProjectInner />
    </Suspense>
  );
}

/** Earlier submissions of the same kind (e.g. the lyric to rewrite in a later project). */
function EarlierWork({ kind, currentId }: { kind: string; currentId: string }) {
  const { t, l } = useI18n();
  const [rows, setRows] = useState<ProjectView[] | null>(null);
  useEffect(() => {
    (async () => {
      const { data } = await getJson<{ projects: { id: string; kind: string; status: string }[] }>("/api/history");
      const ids = data.projects.filter((x) => x.kind === kind && x.id !== currentId && x.status !== "open").map((x) => x.id);
      const full = await Promise.all(ids.map((id) => getJson<{ project: ProjectView }>(`/api/projects/${id}`).then((r) => r.data.project)));
      setRows(full);
    })().catch(() => setRows([]));
  }, [kind, currentId]);
  if (!rows?.length) return null;
  return (
    <section className="card" data-testid="earlier-work">
      <h2>{t("earlierWork")}</h2>
      {rows.map((r) => {
        const sub = r.submission as { text?: string; abc?: string } | null;
        return (
          <details key={r.id}>
            <summary>
              {r.week} · {l(r.def.title)} · {r.score != null ? `${Math.round(r.score * 100)}%` : r.status}
            </summary>
            {sub?.text ? <pre className="lyrics-view">{sub.text}</pre> : null}
            {sub?.abc ? <pre className="lyrics-view">{sub.abc}</pre> : null}
            {r.ai?.summary ? <p className="small muted">{r.ai.summary}</p> : null}
            <Link href={`/project?id=${r.id}`}>{t("open")} →</Link>
          </details>
        );
      })}
    </section>
  );
}

function ProjectInner() {
  const viewId = useSearchParams().get("id");
  const { t, l, locale } = useI18n();
  const [p, setP] = useState<ProjectView | null>(null);
  const [due, setDue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [selfScores, setSelf] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState("");
  const [abc, setAbc] = useState("");
  const [text, setText] = useState("");
  const [lang, setLang] = useState<"en" | "sr">("en");
  const [events, setEvents] = useState<MidiEvent[]>([]);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [checkin, setCheckin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Belgrade" }).format(new Date());

  const load = useCallback(async () => {
    // ?id=<project row> views an earlier week's project (read-only); otherwise this week's
    const { data } = viewId
      ? await getJson<{ project: ProjectView | null; due: string; reason?: string }>(`/api/projects/${viewId}`).then((r) => ({ data: { ...r.data, due: "" } }))
      : await getJson<{ project: ProjectView | null; due: string; reason?: string }>("/api/projects/current");
    if (!data.project) return setErr(data.reason ?? "no project");
    setP(data.project);
    setDue(data.due);
    const s = data.project.submission as Record<string, unknown> | null;
    if (s) {
      if (typeof s.abc === "string") setAbc(s.abc);
      if (typeof s.text === "string") setText(s.text);
      if (s.language === "en" || s.language === "sr") setLang(s.language);
      if (typeof s.notes === "string") setNotes(s.notes);
    }
    if (data.project.self) setSelf(data.project.self);
    if (data.project.def.kind === "lyrics" && data.project.def.lyrics.language !== "either") setLang(data.project.def.lyrics.language);
  }, [viewId]);
  useEffect(() => {
    void load().catch((e) => setErr(String(e)));
    // a voice-rest day (from any check-in today) blocks the vocal project too
    fetch(`/api/voice/rest?date=${date}`).then((r) => r.json()).then((j) => j.rest && setCheckin(j.rest)).catch(() => {});
  }, [load, date]);
  // poll while the AI review is pending
  useEffect(() => {
    if (!p || p.ai_status !== "pending") return;
    const h = setInterval(() => void load(), 5000);
    return () => clearInterval(h);
  }, [p, load]);

  if (err) return <p className="muted">{err === "placement" ? t("placementFirst") : err}</p>;
  if (!p) return <p className="muted">…</p>;
  const def = p.def;
  const complete = def.rubric.every((c) => selfScores[c.id] != null);
  const ready =
    complete &&
    ((def.kind === "composition" && abc.trim()) || (def.kind === "lyrics" && text.trim()) || (def.kind === "vocal" && recordingId) || (def.kind === "byear" && events.some((e) => e.type === "on")));
  const submit = async () => {
    setBusy(true);
    const base = { self: selfScores, locale, notes: notes || undefined };
    const body =
      def.kind === "composition" ? { kind: "composition", abc, ...base } : def.kind === "lyrics" ? { kind: "lyrics", text, language: lang, ...base } : def.kind === "vocal" ? { kind: "vocal", recordingId, ...base } : { kind: "byear", events, ...base };
    const r = await fetch(`/api/projects/${p.id}/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    setBusy(false);
    if (!r.ok) return setErr(j.error);
    setP(j.project);
  };
  const stats = def.kind === "lyrics" && text.trim() ? lyricsStats(text, lang) : null;

  return (
    <div className="project">
      <p>
        <Link href="/">← {t("backToday")}</Link>
      </p>
      <h1>
        <span className="tag">{def.id}</span> {l(def.title)}
      </h1>
      <p className="muted small">
        {t(("kind_" + def.kind) as "kind_composition")} · {p.week} · {t("due")} {due} · ~{def.minutes} {t("min")}
      </p>
      <details className="card explain" open={!p.submission}>
        <summary>{t("brief")}</summary>
        <Markdown text={l(def.brief)} />
      </details>

      {viewId ? null : (
      <section className="card">
        <h2>{t("yourWork")}</h2>
        {def.kind === "composition" ? (
          <>
            {def.composition.chords ? (
              <div className="row small">
                {t("givenChords")}: <span className="tag">{def.composition.chords.join(" ")}</span>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    const { tonic, mode } = parseKey(def.composition.key);
                    const chords = def.composition.chords!.map((r) => romanChord({ ...tonic, octave: 3 }, mode === "major" ? "major" : "harmonic-minor", r).map(toMidi));
                    void midi().play({ mode: "chords", chords, tempo: 60 });
                  }}
                >
                  ▶ {t("play")}
                </button>
              </div>
            ) : null}
            <Composer keyName={def.composition.key} meter={def.composition.meter} bars={def.composition.bars} voices={def.composition.voices as 1 | 2} value={abc} onChange={setAbc} />
          </>
        ) : null}
        {def.kind === "lyrics" ? (
          <>
            <p className="small muted">
              {l(def.lyrics.genre)} · {l(def.lyrics.structure)} · {def.lyrics.lines[0]}–{def.lyrics.lines[1]} {t("lines")}
            </p>
            {def.lyrics.language === "either" ? (
              <div className="row small">
                <button type="button" className={lang === "en" ? "primary" : "secondary"} onClick={() => setLang("en")}>English</button>
                <button type="button" className={lang === "sr" ? "primary" : "secondary"} onClick={() => setLang("sr")}>Srpski</button>
              </div>
            ) : null}
            <textarea className="lyrics" rows={16} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("lyricsPlaceholder")} data-testid="lyrics-text" />
            {stats ? (
              <p className="small muted" data-testid="lyrics-stats">
                {stats.lines} {t("lines")} · {t("syllables")}: {stats.syllablesPerLine.join(" ")} · {t("rhyme")}: {stats.rhymeScheme} <em>({t("heuristic")})</em>
              </p>
            ) : null}
          </>
        ) : null}
        {def.kind === "vocal" ? (
          !checkin ? (
            <>
              <p>{t("checkinFirst")}</p>
              <CheckinInput
                onSubmit={(r: Response) => {
                  const state = r.kind === "checkin" ? r.state : "fine";
                  setCheckin(state);
                  void fetch("/api/voice/rest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state, date }) });
                }}
                disabled={false}
              />
            </>
          ) : checkin !== "fine" ? (
            <p className="bad" data-testid="voice-rest">🛑 {t("voiceRestToday")}</p>
          ) : (
            <SingInput item={vocalItem(def.melody, def.tolerance, def.id)} meta={{ date, lessonId: null }} onSubmit={(r: Response) => r.kind === "sing" && setRecordingId(r.recordingId)} disabled={false} />
          )
        ) : null}
        {def.kind === "byear" ? <ByEar def={def} onEvents={setEvents} /> : null}
        <label className="small muted" htmlFor="learner-notes">
          {t("yourNotes")}
        </label>
        <textarea id="learner-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <SelfRubric rubric={def.rubric} value={selfScores} onChange={setSelf} />
        <button type="button" className="primary" disabled={!ready || busy} onClick={() => void submit()} data-testid="project-submit">
          {busy ? t("analyzing") : p.submission ? t("resubmit") : t("submit")}
        </button>
        {!complete ? <span className="muted small"> {t("rateAll")}</span> : null}
      </section>
      )}
      {p.submission ? <Result p={p} /> : null}
      {!viewId ? <EarlierWork kind={def.kind} currentId={p.id} /> : null}
    </div>
  );
}
