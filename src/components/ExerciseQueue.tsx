"use client";
import { useState } from "react";
import type { Exercise } from "@/lib/curriculum/schema";
import { ExerciseRunner, RunnerDone } from "./ExerciseRunner";
import { useI18n } from "@/lib/client/i18n";
import type { Context } from "@/lib/server/progress";

export interface QueueEntry {
  ex: Exercise & { skips?: string[] };
  lessonId: string | null;
  label?: string;
}

/** Runs exercises one after another; failed ones can be retried with fresh items. */
export function ExerciseQueue({ entries, context, date, count, onFinished, startAt = 0, initial = {} }: { entries: QueueEntry[]; context: Context; date: string; count?: number; onFinished?: (r: RunnerDone[]) => void; startAt?: number; initial?: Record<string, { best: number; passed: number }> }) {
  // placement measures a first attempt; retrying would defeat it
  const allowRetry = context !== "placement";
  const { t, l } = useI18n();
  const [i, setI] = useState(startAt);
  const [attempt, setAttempt] = useState<Record<string, number>>({});
  const [done, setDone] = useState<Record<string, RunnerDone>>({});
  const [current, setCurrent] = useState<RunnerDone | null>(null);
  const finished = i >= entries.length;
  const e = entries[i];
  const onDone = (r: RunnerDone) => {
    setCurrent(r);
    setDone((d) => ({ ...d, [r.exerciseId]: r }));
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
  return (
    <div className="queue">
      <ol className="steps">
        {entries.map((x, k) => {
          const d = done[x.ex.id];
          const prev = initial[x.ex.id];
          const cls = d ? (d.pass ? "good" : "bad") : prev?.passed ? "good" : "";
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
          <ExerciseRunner key={`${e.ex.id}:${attempt[e.ex.id] ?? 0}`} ex={e.ex} seed={`${date}:${attempt[e.ex.id] ?? 0}`} count={e.ex.type === "generated" ? count : undefined} context={context} date={date} lessonId={e.lessonId} onDone={onDone} />
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
