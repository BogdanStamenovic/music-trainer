"use client";
import { useEffect, useRef, useState } from "react";
import type { MidiEvent } from "@/lib/grading";
import { midi } from "@/lib/client/midi";
import { useI18n } from "@/lib/client/i18n";
import { quantize, toAbc, type QNote } from "@/lib/projects";
import { Abc } from "./Abc";
import { Keyboard } from "./Keyboard";

// Record a melody (optionally + bass) on the MIDI piano against a metronome, quantize
// it to the grid, and turn it into ABC. The ABC text is the submission: it can be
// edited after recording to fix mistakes, or typed from scratch instead.

function click(ac: AudioContext, at: number, accent: boolean) {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.frequency.value = accent ? 1600 : 1000;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(0.4, at + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
  o.connect(g).connect(ac.destination);
  o.start(at);
  o.stop(at + 0.06);
}

export function Composer({ keyName, meter, bars, voices, value, onChange }: { keyName: string; meter: string; bars: number; voices: 1 | 2; value: string; onChange: (abc: string) => void }) {
  const { t } = useI18n();
  const [tempo, setTempo] = useState(80);
  const [grid, setGrid] = useState(2);
  const [twoHands, setTwoHands] = useState(voices === 2);
  const [state, setState] = useState<"idle" | "countin" | "recording">("idle");
  const [notes, setNotes] = useState<QNote[] | null>(null);
  const [shown, setShown] = useState(value);
  const evRef = useRef<MidiEvent[]>([]);
  const t0Ref = useRef(0);
  const acRef = useRef<AudioContext | null>(null);
  const timer = useRef<number | null>(null);
  const [num, den] = meter.split("/").map(Number);
  const beatsPerBar = num * (4 / den);

  // debounce rendering of hand edits
  useEffect(() => {
    const h = setTimeout(() => setShown(value), 400);
    return () => clearTimeout(h);
  }, [value]);

  const start = () => {
    midi().stop();
    const ac = acRef.current ?? new AudioContext();
    acRef.current = ac;
    void ac.resume();
    const beat = 60 / tempo;
    const now = ac.currentTime + 0.1;
    const total = beatsPerBar * (bars + 1); // one count-in bar
    for (let i = 0; i < total; i++) click(ac, now + i * beat, i % beatsPerBar === 0);
    // performance.now() of beat 1 of bar 1 (after the count-in)
    t0Ref.current = performance.now() + (0.1 + beatsPerBar * beat) * 1000;
    evRef.current = [];
    setState("countin");
    window.setTimeout(() => setState("recording"), (0.1 + beatsPerBar * beat) * 1000);
    timer.current = window.setTimeout(() => stop(), (0.1 + total * beat) * 1000 + 300);
  };
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    setState("idle");
    acRef.current?.suspend();
    const q = quantize(evRef.current, { t0: t0Ref.current, tempo, grid, voices: twoHands ? 2 : 1, split: 55 });
    setNotes(q);
    if (q.length) onChange(toAbc(q, { key: keyName, meter, grid }));
  };
  useEffect(() => {
    const un = midi().subscribe((e) => {
      if (state !== "idle") evRef.current.push(e);
    });
    return () => void un();
  }, [state]);

  const play = () => {
    if (!notes?.length) return;
    // melody only, with its rhythm (gaps become rests)
    const mel = notes.filter((n) => n.voice === 1).sort((a, b) => a.start - b.start);
    const seq: number[] = [];
    const dur: number[] = [];
    let at = 0;
    for (const n of mel) {
      if (n.start > at) {
        seq.push(-1);
        dur.push((n.start - at) / grid);
      }
      seq.push(n.midi);
      dur.push(n.dur / grid);
      at = n.start + n.dur;
    }
    void midi().play({ mode: "melodic", notes: seq, durations: dur, tempo });
  };

  return (
    <div className="composer">
      <div className="row small">
        <label>
          ♩= <input type="number" min={40} max={160} value={tempo} onChange={(e) => setTempo(Number(e.target.value))} />
        </label>
        <label>
          {t("grid")}:{" "}
          <select value={grid} onChange={(e) => setGrid(Number(e.target.value))}>
            <option value={1}>♩</option>
            <option value={2}>♪</option>
            <option value={4}>𝅘𝅥𝅯</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={twoHands} onChange={(e) => setTwoHands(e.target.checked)} /> {t("twoHands")}
        </label>
        <span className="muted">
          {keyName} · {meter} · {bars} {t("bars")}
        </span>
      </div>
      <div className="row">
        {state === "idle" ? (
          <button type="button" className="primary" onClick={start} data-testid="compose-record">
            {t("record")}
          </button>
        ) : (
          <button type="button" className="primary rec" onClick={stop} data-testid="compose-stop">
            {t("stop")} {state === "countin" ? `(${t("countIn")})` : ""}
          </button>
        )}
        {notes?.length ? (
          <button type="button" className="secondary" onClick={play}>
            ▶ {t("play")}
          </button>
        ) : null}
        <span className="muted small">{t("composeHint")}</span>
      </div>
      {state !== "idle" ? <Keyboard from={36} to={84} /> : null}
      <label className="small muted" htmlFor="abc-text">
        ABC
      </label>
      <textarea id="abc-text" className="abc-text" rows={8} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} data-testid="abc-text" />
      {shown.trim() ? <Abc abc={shown} scale={1} /> : null}
    </div>
  );
}
