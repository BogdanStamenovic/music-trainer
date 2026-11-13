"use client";
import { useEffect, useRef, useState } from "react";
import type { GenCtx } from "@/lib/curriculum/items";
import type { Exercise } from "@/lib/curriculum/schema";
import { gatesLesson } from "@/lib/curriculum/items";
import { ExerciseRunner, RunnerDone } from "./ExerciseRunner";
import { useI18n } from "@/lib/client/i18n";
import type { Context } from "@/lib/server/progress";
import { track } from "@/lib/client/events";

export interface QueueEntry {
  ex: Exercise & { skips?: string[] };
  lessonId: string | null;
  label?: string;
}

/** Runs exercises one after another; failed ones can be retried with fresh items. */
export function ExerciseQueue({ entries, context, date, count, onFinished, startAt = 0, initial = {}, ctx, voiceLesson = false }: { entries: QueueEntry[]; context: Context; date: string; count?: number; onFinished?: (r: RunnerDone[]) => void; startAt?: number; initial?: Record<string, { best: number; passed: number }>; ctx?: GenCtx; voiceLesson?: boolean }) {
  // placement measures a first attempt; retrying would defeat it
  const allowRetry = context !== "placement";
  const { t, l } = useI18n();
  const [i, setI] = useState(startAt);
  const [attempt, setAttempt] = useState<Record<string, number>>({});
  const [done, setDone] = useState<Record<string, RunnerDone>>({});
  const [current, setCurrent] = useState<RunnerDone | null>(null);
  // Voice safety: a check-in of "tired"/"hoarse" (today, anywhere) ends voice work for the day.
  const [rest, setRest] = useState<string | null>(null);
  const checkRest = () => {
    if (!voiceLesson) return;
    fetch(`/api/voice/rest?date=${date}`).then((r) => r.json()).then((j) => setRest(j.rest)).catch(() => {});
  };
  useEffect(checkRest, [voiceLesson, date]); // eslint-disable-line react-hooks/exhaustive-deps
  // Singing session: one warm-up per session, one cool-down at its end (voiceSession.ts)
  const [session, setSession] = useState<{ warm: boolean; warmAt: number | null; openV: string[] } | null>(null);
  const [forceRun, setForceRun] = useState<Set<string>>(new Set());
  const loadSession = () => {
    if (!voiceLesson || context !== "lesson") return;
    fetch(`/api/voice/session?date=${date}`).then((r) => r.json()).then(setSession).catch(() => {});
  };
  useEffect(loadSession, [voiceLesson, context, date]); // eslint-disable-line react-hooks/exhaustive-deps
  const skipOf = (x: QueueEntry): "warm" | "later" | null => {
    if (!session || forceRun.has(x.ex.id)) return null;
    if (x.ex.role === "warmup" && session.warm) return "warm";
    if (x.ex.role === "cooldown" && session.openV.some((id) => id !== x.lessonId)) return "later";
    return null;
  };
  const reused = useRef(false);
  const finished = i >= entries.length;
  const e = entries[i];
  const onDone = (r: RunnerDone) => {
    setCurrent(r);
    setDone((d) => ({ ...d, [r.exerciseId]: r }));
    if (entries[i]?.ex.type === "checkin") checkRest();
    loadSession();
  };
  const next = () => {
    setCurrent(null);
    const ni = i + 1;
    setI(ni);
    if (ni >= entries.length) onFinished?.(entries.map((x) => done[x.ex.id]).filter(Boolean));
  };
  const retry = () => {
    setCurrent(null);
    setAttempt((a) => ({ ...a, [e.ex.id]: (a[e.ex.id] ?? 0) + 1 }));
  };
  if (rest)
    return (
      <div className="card rest" data-testid="voice-rest">
        <p>🛑 {t("voiceRestToday")}</p>
      </div>
    );
  return (
    <div className="queue">
      <ol className="steps">
        {entries.map((x, k) => {
          const d = done[x.ex.id];
          const prev = initial[x.ex.id];
          const cls = d ? (d.pass ? "good" : "bad") : prev?.passed || skipOf(x) ? "good" : "";
          return (
            <li key={x.ex.id} className={`${cls} ${k === i ? "current" : ""}`}>
              <button type="button" className="linkish" onClick={() => { setCurrent(null); setI(k); }}>
                {x.label ?? l(x.ex.prompt)}
              </button>
              {d ? <span className="muted small"> {Math.round(d.score * 100)}%</span> : prev ? <span className="muted small"> best {Math.round(prev.best * 100)}%</span> : null}
            </li>
          );
        })}
      </ol>
      {!finished && e ? (
        <section className="card" data-testid="exercise" data-exercise={e.ex.id}>
          <h3>
            {t("exercise")} {i + 1}/{entries.length}
          </h3>
          {skipOf(e) ? (
            <SessionSkip
              kind={skipOf(e)!}
              warmAt={session?.warmAt ?? null}
              prompt={l(e.ex.prompt)}
              onShow={() => {
                if (skipOf(e) === "warm" && !reused.current) {
                  reused.current = true;
                  track("voice_warm_reuse", date, e.lessonId, e.ex.id);
                }
              }}
              onRun={() => setForceRun((f) => new Set(f).add(e.ex.id))}
              onNext={next}
              last={i + 1 >= entries.length}
            />
          ) : (
            <ExerciseRunner key={`${e.ex.id}:${attempt[e.ex.id] ?? 0}`} ex={e.ex} seed={`${date}:${attempt[e.ex.id] ?? 0}`} count={e.ex.type === "generated" ? count : undefined} context={context} date={date} lessonId={e.lessonId} ctx={ctx} onDone={onDone} compactCheckin={!!session?.warm && e.ex.type === "checkin"} />
          )}
          {current && !current.pass && context === "lesson" && e.lessonId && !gatesLesson(e.ex, e.lessonId[0]) && e.ex.type !== "practice" && e.ex.type !== "checkin" ? (
            <p className="muted small" data-testid="not-gating">{t("notGating")}</p>
          ) : null}
          {current ? (
            <div className="row">
              {!current.pass && allowRetry ? (
                <button type="button" className="secondary" onClick={retry}>
                  ↻ {t("retryExercise")}
                </button>
              ) : null}
              <button type="button" className="primary" onClick={next} data-testid="next-exercise">
                {i + 1 < entries.length ? t("next") : t("finish")} →
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/** A session part this lesson does not need now: already warmed up, or the cool-down comes at the end. */
function SessionSkip({ kind, warmAt, prompt, onShow, onRun, onNext, last }: { kind: "warm" | "later"; warmAt: number | null; prompt: string; onShow: () => void; onRun: () => void; onNext: () => void; last: boolean }) {
  const { t, locale } = useI18n();
  useEffect(onShow, []); // eslint-disable-line react-hooks/exhaustive-deps
  const hhmm = warmAt ? new Date(warmAt).toLocaleTimeString(locale === "sr" ? "sr-Latn-RS" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Belgrade" }) : "";
  return (
    <div data-testid="session-skip" data-kind={kind}>
      <p className="good">✓ {kind === "warm" ? t("warmedUpAt").replace("{time}", hhmm) : t("cooldownLater")}</p>
      <details className="small">
        <summary>{t("thisLessonsVersion")}</summary>
        <p>{prompt}</p>
      </details>
      <div className="row">
        <button type="button" className="secondary" onClick={onRun} data-testid="session-run-anyway">
          {t("doItAnyway")}
        </button>
        <button type="button" className="primary" onClick={onNext} data-testid="next-exercise">
          {last ? t("finish") : t("next")} →
        </button>
      </div>
    </div>
  );
}
