"use client";
import { useEffect, useRef, useState } from "react";
import type { ComposeItem, WriteItem, MidiItem } from "@/lib/curriculum/items";
import type { Response, MidiEvent } from "@/lib/grading";
import { useI18n } from "@/lib/client/i18n";
import { midi } from "@/lib/client/midi";
import { Composer } from "./Composer";
import { Abc } from "./Abc";
import { Keyboard } from "./Keyboard";

type Rules = { ok: boolean; score?: number; checks?: { id: string; pass: boolean; score: number; detail: string }[]; error?: string; unavailable?: boolean };

/** Compose exercise: draft in ABC (record or type), check against the rules as often as wanted, then submit. */
export function ComposeInput({ item, onSubmit, disabled }: { item: ComposeItem; onSubmit: (r: Response) => void; disabled: boolean }) {
  const { t } = useI18n();
  const [abc, setAbc] = useState(item.given ?? "");
  const [rules, setRules] = useState<Rules | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/compose-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exerciseId: item.exerciseId, abc }) });
      setRules(await r.json());
    } catch {
      setRules({ ok: false, error: "offline: checked when you are back online", unavailable: true });
    }
    setBusy(false);
  };
  return (
    <div className="compose">
      {item.given ? (
        <div>
          <p className="small muted">{t("givenStart")}</p>
          <Abc abc={item.given} scale={1} />
        </div>
      ) : null}
      <Composer keyName={item.key} meter={item.meter} bars={item.bars} voices={item.voices} value={abc} onChange={setAbc} />
      {!disabled ? (
        <div className="row">
          <button type="button" className="secondary" onClick={() => void check()} disabled={busy || !abc.trim()} data-testid="compose-check">
            {busy ? t("analyzing") : t("checkRules")}
          </button>
          <button type="button" className="primary" onClick={() => onSubmit({ kind: "compose", abc, rules })} disabled={!abc.trim()} data-testid="compose-submit">
            {t("submit")}
          </button>
        </div>
      ) : null}
      {rules ? (
        rules.ok ? (
          <ul className="checks" data-testid="compose-checks">
            {rules.checks!.map((c) => (
              <li key={c.id} className={c.pass ? "good" : "bad"}>
                {c.pass ? "✓" : "✕"} <strong>{c.id}</strong> {Math.round(c.score * 100)}% <span className="small">{c.detail}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">{rules.error}</p>
        )
      ) : null}
    </div>
  );
}

/** Writing exercise: text + own rubric rating (the grade); AI feedback is optional and only advisory. */
export function WriteInput({ item, onSubmit, disabled }: { item: WriteItem; onSubmit: (r: Response) => void; disabled: boolean }) {
  const { t, l, locale } = useI18n();
  const [text, setText] = useState("");
  const [self, setSelf] = useState<Record<string, number>>({});
  const [fb, setFb] = useState<{ status: string; review?: { criteria: { id: string; score: number; comment: string }[]; summary: string; next_steps: string[] } | null; error?: string | null } | null>(null);
  const poll = useRef<number | null>(null);
  useEffect(() => () => void (poll.current && clearInterval(poll.current)), []);
  const ask = async () => {
    const r = await fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exerciseId: item.exerciseId, text, locale }) });
    const { jobId } = await r.json();
    setFb({ status: "queued" });
    poll.current = window.setInterval(async () => {
      const j = await (await fetch(`/api/feedback/${jobId}`)).json();
      setFb(j);
      if (j.status !== "queued" && j.status !== "running") clearInterval(poll.current!);
    }, 3000);
  };
  const lines = text.split("\n").filter((x) => x.trim() && !/^\[.*\]$/.test(x.trim())).length;
  const complete = item.rubric.every((c) => self[c.id] != null);
  return (
    <div className="write">
      <textarea className="lyrics" rows={10} value={text} onChange={(e) => setText(e.target.value)} disabled={disabled} data-testid="write-text" />
      <p className="small muted">
        {lines} {t("lines")}
        {item.lines ? ` (${item.lines[0]}–${item.lines[1]})` : ""}
        {item.language !== "either" ? ` · ${item.language === "sr" ? "srpski" : "English"}` : ""}
      </p>
      {!disabled ? (
        <>
          <button type="button" className="secondary" disabled={!text.trim() || fb?.status === "queued" || fb?.status === "running"} onClick={() => void ask()} data-testid="write-feedback">
            {t("aiFeedback")}
          </button>
          {fb ? (
            <div className="ai small" data-testid="write-feedback-result">
              {fb.review ? (
                <>
                  <p>{fb.review.summary}</p>
                  <ul>
                    {fb.review.criteria.map((c) => (
                      <li key={c.id}>
                        {l(item.rubric.find((r) => r.id === c.id)?.label)}: {c.score}/4 · {c.comment}
                      </li>
                    ))}
                  </ul>
                </>
              ) : fb.status === "waiting" || fb.status === "failed" ? (
                <p className="muted">{t("aiUnavailable")}</p>
              ) : (
                <p className="muted">{t("aiPending")}</p>
              )}
            </div>
          ) : null}
          <div className="rubric">
            <p className="small muted">{t("selfAssessShort")}</p>
            {item.rubric.map((c) => (
              <div key={c.id} className="crit">
                <div>
                  <strong>{l(c.label)}</strong>
                  <div className="muted small">4 = {l(c.top)}</div>
                </div>
                <div className="row">
                  {[0, 1, 2, 3, 4].map((n) => (
                    <button key={n} type="button" className={self[c.id] === n ? "primary" : "secondary"} onClick={() => setSelf({ ...self, [c.id]: n })} data-testid={`wself-${c.id}-${n}`}>
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <button type="button" className="primary" disabled={!text.trim() || !complete} onClick={() => onSubmit({ kind: "write", text, self })} data-testid="write-submit">
            {t("submit")}
          </button>
        </>
      ) : null}
    </div>
  );
}

/** Improvise over a backing loop: one silent bar to get ready, then the backing plays (input not muted). */
export function ImprovInput({ item, onSubmit, disabled }: { item: MidiItem; onSubmit: (r: Response) => void; disabled: boolean }) {
  const { t } = useI18n();
  const [state, setState] = useState<"idle" | "count" | "playing">("idle");
  const [count, setCount] = useState(0);
  const ev = useRef<MidiEvent[]>([]);
  const t0 = useRef(0);
  const active = useRef(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    const un = midi().subscribe((e) => {
      if (!active.current) return;
      ev.current.push({ ...e, t: e.t - t0.current });
      if (e.type === "on") setN((x) => x + 1);
    }, { expect: true });
    return () => void un();
  }, []);
  const start = async () => {
    ev.current = [];
    setN(0);
    const beatMs = 60000 / (item.tempo ?? 80);
    setState("count");
    for (let i = 4; i > 0; i--) {
      setCount(i);
      await new Promise((r) => setTimeout(r, beatMs));
    }
    setState("playing");
    t0.current = performance.now();
    active.current = true;
    await midi().play(item.play!, { muteInput: false });
    await new Promise((r) => setTimeout(r, 800));
    active.current = false;
    setState("idle");
    onSubmit({ kind: "midi", events: ev.current });
  };
  return (
    <div className="improv">
      {!disabled ? (
        <button type="button" className="primary" onClick={() => void start()} disabled={state !== "idle"} data-testid="improv-start">
          {state === "count" ? `${count}…` : state === "playing" ? `${t("playNow")} (${n})` : `▶ ${t("startBacking")}`}
        </button>
      ) : null}
      <Keyboard from={48} to={84} />
    </div>
  );
}
