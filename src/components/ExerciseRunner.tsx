"use client";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { Exercise } from "@/lib/curriculum/schema";
import { generateItems, Item, MidiItem, GenCtx } from "@/lib/curriculum/items";
import { SingInput, RangeInput, CheckinInput, SingFeedback } from "./VoiceInputs";
import { ComposeInput, WriteInput, ImprovInput } from "./LessonInputs";
import { grade, Response, MidiEvent, heldChord, clusterChords } from "@/lib/grading";
import { midiToNote, noteName, parseNote } from "@/lib/music/pitch";
import { midi } from "@/lib/client/midi";
import { send } from "@/lib/client/queue";
import { track } from "@/lib/client/events";
import { useI18n } from "@/lib/client/i18n";
import { Abc } from "./Abc";
import { Keyboard } from "./Keyboard";
import type { SubmissionResult, Context } from "@/lib/server/progress";

export function uuid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface RunnerDone {
  exerciseId: string;
  score: number;
  pass: boolean;
  queued: boolean;
  server?: SubmissionResult | null;
}

interface Props {
  ex: Exercise & { skips?: string[] };
  seed: string;
  count?: number;
  context: Context;
  date: string;
  lessonId: string | null;
  ctx?: GenCtx;
  onDone: (r: RunnerDone) => void;
}

export function ExerciseRunner({ ex, seed, count, context, date, lessonId, ctx, onDone }: Props) {
  const { t, l } = useI18n();
  const items = useMemo(() => generateItems(ex, seed, count, ctx ?? {}), [ex, seed, count, ctx]);
  const [idx, setIdx] = useState(0);
  const [results, setResults] = useState<{ itemId: string; response: Response; clientScore: number }[]>([]);
  const [final, setFinal] = useState<RunnerDone | null>(null);
  const sentRef = useRef(false);
  // time on task (calibration): from first render of the exercise to its submission
  const startRef = useRef(0);
  useEffect(() => {
    startRef.current = Date.now();
    track("exercise_start", date, lessonId, ex.id);
  }, [date, lessonId, ex.id, seed]);

  const record = useCallback((itemId: string, response: Response, clientScore: number) => {
    setResults((r) => [...r.filter((x) => x.itemId !== itemId), { itemId, response, clientScore }]);
  }, []);

  const finish = useCallback(
    async (all: typeof results) => {
      if (sentRef.current) return;
      sentRef.current = true;
      const local = all.reduce((a, r) => a + r.clientScore, 0) / Math.max(1, items.length);
      const { result, queued } = await send({ uuid: uuid(), date, context, lessonId, exerciseId: ex.id, seed, count: ex.type === "generated" ? items.length : undefined, ctx, ms: Date.now() - startRef.current, responses: all });
      const score = result?.score ?? local;
      const done: RunnerDone = { exerciseId: ex.id, score, pass: result?.pass ?? local >= ex.pass, queued, server: result };
      setFinal(done);
      onDone(done);
    },
    [items.length, date, context, lessonId, ex.id, ex.type, ex.pass, seed, onDone, ctx],
  );

  if (final)
    return (
      <div className={`result ${final.pass ? "good" : "bad"}`} data-testid="exercise-result">
        <strong>
          {t("score")}: {Math.round(final.score * 100)}% · {final.pass ? t("passed") : t("notPassed")}
        </strong>
        {final.queued ? <p className="muted">{t("offlineQueued")}</p> : null}
      </div>
    );

  const item = items[idx];
  const advance = () => {
    if (idx + 1 < items.length) setIdx(idx + 1);
    else void finish(results);
  };
  return (
    <div className="runner">
      <div className="muted small">
        {l(ex.prompt)} · {idx + 1} {t("of")} {items.length}
      </div>
      <ItemView key={`${seed}-${item.id}`} item={item} pass={ex.pass} meta={{ date, lessonId }} onAnswer={(resp, score) => record(item.id, resp, score)} onNext={advance} last={idx + 1 === items.length} />
    </div>
  );
}

function names(ms: number[], locale: "en" | "sr") {
  return ms.map((m) => noteName(midiToNote(m), locale, true)).join(" ");
}

function ItemView({ item, pass, meta, onAnswer, onNext, last }: { item: Item; pass: number; meta: { date: string; lessonId: string | null }; onAnswer: (r: Response, score: number) => void; onNext: () => void; last: boolean }) {
  const { t, l, locale } = useI18n();
  const [fb, setFb] = useState<null | { score: number; detail: Record<string, unknown>; resp: Response }>(null);
  const answer = (resp: Response) => {
    if (fb) return;
    const g = grade(item, resp, pass);
    setFb({ score: g.score, detail: g.detail, resp });
    onAnswer(resp, g.score);
  };
  const play = useCallback(() => (item.play ? midi().play(item.play) : Promise.resolve()), [item.play]);
  useEffect(() => {
    // improvisation starts its backing on demand, with a count-in
    if (item.play && !(item.kind === "midi" && item.mode === "improv")) void play();
    return () => midi().stop();
  }, [item.id, item.play, play, item]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Enter" && fb && (e.target as HTMLElement)?.tagName !== "INPUT") onNext();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [fb, onNext]);

  return (
    <div className="item" data-testid="item" data-kind={item.kind}>
      <p className="prompt">{l(item.prompt)}</p>
      {item.abc ? <Abc abc={item.abc} /> : null}
      {item.play && !(item.kind === "midi" && item.mode === "improv") ? (
        <button type="button" className="secondary" onClick={() => void play()}>
          ▶ {t("replay")}
        </button>
      ) : null}
      {item.kind === "mcq" ? (
        <div className="options">
          {item.options.map((o, i) => (
            <button
              type="button"
              key={i}
              data-testid="option"
              className={`option ${fb ? (i === item.answer ? "right" : (fb.resp as { choice: number }).choice === i ? "wrongpick" : "") : ""}`}
              onClick={() => answer({ kind: "mcq", choice: i })}
              disabled={!!fb}
            >
              {l(o)}
            </button>
          ))}
        </div>
      ) : null}
      {item.kind === "names" ? <NamesInput onSubmit={(text) => answer({ kind: "names", text, locale })} disabled={!!fb} /> : null}
      {item.kind === "midi" && item.mode === "improv" ? <ImprovInput item={item} onSubmit={answer} disabled={!!fb} /> : null}
      {item.kind === "midi" && item.mode !== "improv" ? <MidiInput item={item} onSubmit={(events) => answer({ kind: "midi", events })} disabled={!!fb} /> : null}
      {item.kind === "compose" ? <ComposeInput item={item} onSubmit={answer} disabled={!!fb} /> : null}
      {item.kind === "write" ? <WriteInput item={item} onSubmit={answer} disabled={!!fb} /> : null}
      {item.kind === "sing" ? <SingInput item={item} meta={meta} onSubmit={answer} disabled={!!fb} /> : null}
      {item.kind === "range" ? <RangeInput item={item} meta={meta} onSubmit={answer} disabled={!!fb} /> : null}
      {item.kind === "checkin" ? <CheckinInput onSubmit={answer} disabled={!!fb} /> : null}
      {item.kind === "practice" ? (
        <div className="practice">
          <p className="muted">
            ~{item.minutes} {t("min")} · {t("selfRate")}
          </p>
          <div className="options three">
            <button type="button" onClick={() => answer({ kind: "practice", selfScore: 0 })} disabled={!!fb}>
              {t("selfBad")}
            </button>
            <button type="button" onClick={() => answer({ kind: "practice", selfScore: 0.5 })} disabled={!!fb}>
              {t("selfOk")}
            </button>
            <button type="button" onClick={() => answer({ kind: "practice", selfScore: 1 })} disabled={!!fb}>
              {t("selfGood")}
            </button>
          </div>
        </div>
      ) : null}
      {fb ? (
        <div className={`feedback ${fb.score >= pass ? "good" : "bad"}`} data-testid="feedback">
          <strong>{item.kind === "practice" || item.kind === "checkin" || item.kind === "range" || item.kind === "write" ? t("saved") : item.kind === "compose" && !(fb.resp as { rules?: unknown }).rules ? t("checkedOnServer") : fb.score >= 0.999 ? t("correct") : fb.score >= pass ? `${Math.round(fb.score * 100)}%` : t("wrong")}</strong>
          {item.kind === "midi" && (item.mode === "improv" || item.mode === "rhythm") ? <div className="small">{JSON.stringify(fb.detail)}</div> : null}
          {item.kind === "midi" && item.mode !== "improv" && item.mode !== "rhythm" && fb.score < 0.999 ? (
            <>
              <div>
                {t("expected")}: {item.noteLabels ? l(item.noteLabels) : names(item.expect, locale)}
              </div>
              <div>
                {t("youPlayed")}: {Array.isArray(fb.detail.played) ? (fb.detail.played as (number | number[])[]).map((p) => (Array.isArray(p) ? names(p, locale) : names([p], locale))).join(item.mode === "chords" ? " | " : " ") : ""}
              </div>
              {fb.detail.timing ? <div className="muted small">timing: {JSON.stringify(fb.detail.timing)}</div> : null}
            </>
          ) : null}
          {item.kind === "midi" && fb.score >= 0.999 && item.noteLabels ? <div className="muted">{l(item.noteLabels)}</div> : null}
          {item.kind === "sing" ? <SingFeedback item={item} detail={fb.detail} resp={fb.resp} /> : null}
          {item.kind === "names" && fb.score < 0.999 ? (
            <div>
              {t("expected")}: {(fb.detail.expect as string[]).map((n) => noteName(parseNote(n), locale)).join(" ")}
            </div>
          ) : null}
          <button type="button" className="primary" onClick={onNext} data-testid="next" autoFocus>
            {last ? t("finish") : t("next")} →
          </button>
        </div>
      ) : null}
    </div>
  );
}

function NamesInput({ onSubmit, disabled }: { onSubmit: (s: string) => void; disabled: boolean }) {
  const { t, locale } = useI18n();
  const [v, setV] = useState("");
  return (
    <form
      className="names"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onSubmit(v);
      }}
    >
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder={locale === "sr" ? "npr. D E Fis G" : "e.g. D E F# G"} aria-label={t("typeNotes")} disabled={disabled} autoCapitalize="characters" autoComplete="off" />
      <button type="submit" className="primary" disabled={disabled}>
        {t("check")}
      </button>
      <div className="muted small">{t("typeNotes")}</div>
    </form>
  );
}

/**
 * Collects MIDI events for one item and decides when the learner is finished:
 * chord: all keys released after holding at least the expected number of notes;
 * sequence/chords: enough onsets, keys released, then a short silence.
 */
function MidiInput({ item, onSubmit, disabled }: { item: MidiItem; onSubmit: (e: MidiEvent[]) => void; disabled: boolean }) {
  const { t, locale } = useI18n();
  const [events, setEvents] = useState<MidiEvent[]>([]);
  const evRef = useRef<MidiEvent[]>([]);
  const timer = useRef<number | null>(null);
  const doneRef = useRef(false);
  const submit = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onSubmit(evRef.current);
  }, [onSubmit]);
  useEffect(() => {
    if (disabled) return;
    const un = midi().subscribe((e) => {
      evRef.current = [...evRef.current, e];
      setEvents(evRef.current);
      if (timer.current) clearTimeout(timer.current);
      const ev = evRef.current;
      const allUp = midi().held.size === 0;
      if (!allUp) return;
      if (item.mode === "chord") {
        if (heldChord(ev).length >= item.expect.length) timer.current = window.setTimeout(submit, 250);
      } else if (item.mode === "sequence" || item.mode === "rhythm") {
        if (ev.filter((x) => x.type === "on").length >= item.expect.length) timer.current = window.setTimeout(submit, 900);
      } else if (clusterChords(ev).length >= (item.expectChords?.length ?? 1)) timer.current = window.setTimeout(submit, 1200);
    }, { expect: true });
    return () => {
      un();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [item, submit, disabled]);
  const ons = events.filter((e) => e.type === "on").map((e) => e.note);
  const lo = Math.min(48, ...item.expect, ...(item.expectChords?.flat() ?? []), ...ons) ;
  const hi = Math.max(84, ...item.expect, ...(item.expectChords?.flat() ?? []), ...ons);
  const from = lo - (lo % 12);
  const to = hi + (11 - (hi % 12));
  return (
    <div className="midi-input">
      <div className="live" data-testid="live">
        {disabled ? null : ons.length ? names(ons.slice(-12), locale) : <span className="muted">{t("listening")}</span>}
      </div>
      <Keyboard from={Math.max(21, from)} to={Math.min(108, to)} marks={item.showNotes ? item.expect : []} />
      {!disabled ? (
        <div className="row">
          <button
            type="button"
            className="secondary"
            onClick={() => {
              evRef.current = [];
              setEvents([]);
            }}
          >
            {t("reset")}
          </button>
          <button type="button" className="primary" onClick={submit} disabled={!events.length} data-testid="midi-done">
            {t("done")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
