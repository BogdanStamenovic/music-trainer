// Deterministic grading for T (answers), E/K (MIDI performance, optional timing).
// Shared by client (instant feedback, offline) and server (authoritative re-grade).

import type { Item, MidiItem } from "./curriculum/items";
import { parseNoteLoose, pcName, Locale } from "./music/pitch";

export interface MidiEvent {
  t: number; // ms, monotonic
  type: "on" | "off" | "pedal";
  note: number; // MIDI note; for pedal: 1 down, 0 up
  vel?: number;
}

export type Response =
  | { kind: "mcq"; choice: number }
  | { kind: "names"; text: string; locale: Locale }
  | { kind: "midi"; events: MidiEvent[] }
  | { kind: "practice"; selfScore: number }; // 0..1

export interface Grade {
  score: number; // 0..1
  pass: boolean;
  detail: Record<string, unknown>;
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));

export function grade(item: Item, r: Response, pass = 0.8): Grade {
  const g = gradeRaw(item, r);
  const score = Math.round(clamp(g.score) * 1000) / 1000;
  return { score, pass: score >= pass, detail: g.detail };
}

function gradeRaw(item: Item, r: Response): { score: number; detail: Record<string, unknown> } {
  if (item.kind !== r.kind) return { score: 0, detail: { error: `response kind ${r.kind} for item ${item.kind}` } };
  switch (item.kind) {
    case "mcq": {
      const choice = (r as { choice: number }).choice;
      return { score: choice === item.answer ? 1 : 0, detail: { choice, answer: item.answer } };
    }
    case "names":
      return gradeNames(item.expect, (r as { text: string; locale: Locale }).text, (r as { locale: Locale }).locale, item.ordered);
    case "midi":
      return gradeMidi(item, (r as { events: MidiEvent[] }).events);
    case "practice":
      return { score: (r as { selfScore: number }).selfScore, detail: { self: true } };
  }
}

/** Split free text into note names: "F# G A", "F#, G, A", "Fis G A". */
export function splitNames(text: string): string[] {
  return text
    .split(/[\s,;\-–|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function gradeNames(expect: string[], text: string, locale: Locale, ordered: boolean) {
  const got = splitNames(text).map((s) => {
    const n = parseNoteLoose(s, locale);
    return n ? pcName(n) : `?${s}`;
  });
  if (ordered) {
    let ok = 0;
    for (let i = 0; i < expect.length; i++) if (got[i] === expect[i]) ok++;
    const extra = Math.max(0, got.length - expect.length);
    return { score: (ok - extra) / expect.length, detail: { got, expect } };
  }
  const e = new Set(expect);
  const g = new Set(got);
  const inter = [...g].filter((x) => e.has(x)).length;
  return { score: (2 * inter) / (e.size + g.size || 1), detail: { got, expect } };
}

// ---------- MIDI ----------
interface Onset {
  t: number;
  note: number;
  vel: number;
}
function onsets(events: MidiEvent[]): Onset[] {
  return events.filter((e) => e.type === "on").map((e) => ({ t: e.t, note: e.note, vel: e.vel ?? 64 })).sort((a, b) => a.t - b.t);
}

/** Largest set of keys held simultaneously (latest such moment on ties). */
export function heldChord(events: MidiEvent[]): number[] {
  const held = new Set<number>();
  let best: number[] = [];
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (e.type === "on") held.add(e.note);
    else if (e.type === "off") held.delete(e.note);
    if (held.size >= best.length && held.size > 0) best = [...held].sort((a, b) => a - b);
  }
  return best;
}

/** Group onsets into chords: notes starting within `win` ms of the group's first onset. */
export function clusterChords(events: MidiEvent[], win = 120): { t: number; notes: number[] }[] {
  const out: { t: number; notes: number[] }[] = [];
  for (const o of onsets(events)) {
    const last = out[out.length - 1];
    if (last && o.t - last.t <= win) last.notes.push(o.note);
    else out.push({ t: o.t, notes: [o.note] });
  }
  return out.map((c) => ({ t: c.t, notes: [...new Set(c.notes)].sort((a, b) => a - b) }));
}

const pc = (m: number) => ((m % 12) + 12) % 12;

function setF1(a: number[], b: number[]): number {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  return A.size + B.size === 0 ? 1 : (2 * inter) / (A.size + B.size);
}

export function chordScore(played: number[], expect: number[], octave: "exact" | "any", bass: boolean): number {
  if (played.length === 0) return 0;
  if (octave === "exact") return setF1(played, expect);
  let s = setF1(played.map(pc), expect.map(pc));
  if (bass && pc(Math.min(...played)) !== pc(Math.min(...expect))) s *= 0.5; // wrong inversion
  return s;
}

/** Edit-distance alignment; returns matched index pairs and the edit count. */
export function align<T>(exp: T[], got: T[], eq: (a: T, b: T) => boolean): { pairs: [number, number][]; edits: number } {
  const n = exp.length,
    m = got.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (eq(exp[i - 1], got[j - 1]) ? 0 : 1));
  const pairs: [number, number][] = [];
  let i = n,
    j = m;
  while (i > 0 && j > 0) {
    if (d[i][j] === d[i - 1][j - 1] + (eq(exp[i - 1], got[j - 1]) ? 0 : 1)) {
      if (eq(exp[i - 1], got[j - 1])) pairs.unshift([i - 1, j - 1]);
      i--;
      j--;
    } else if (d[i][j] === d[i - 1][j] + 1) i--;
    else j--;
  }
  return { pairs, edits: d[n][m] };
}

/**
 * Timing evenness against a beat grid. Fits played onset = a + b * beat by least
 * squares, so a steady but slightly different tempo is not punished; the residual
 * (in beats) measures unevenness, and a tempo off by more than 15% costs extra.
 */
export function timingScore(beats: number[], times: number[], tempo: number) {
  if (beats.length < 3) return { score: 1, rmsBeats: 0, playedBpm: null as number | null };
  const n = beats.length;
  const mb = beats.reduce((a, b) => a + b, 0) / n;
  const mt = times.reduce((a, b) => a + b, 0) / n;
  let sxy = 0,
    sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (beats[i] - mb) * (times[i] - mt);
    sxx += (beats[i] - mb) ** 2;
  }
  const b = sxy / sxx; // ms per beat
  const a = mt - b * mb;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += ((times[i] - (a + b * beats[i])) / b) ** 2;
  const rmsBeats = Math.sqrt(ss / n);
  const playedBpm = b > 0 ? 60000 / b : null;
  let score = clamp(1 - rmsBeats / 0.25); // 0.25 beat RMS jitter = 0
  if (playedBpm) {
    const ratio = playedBpm / tempo;
    const off = Math.abs(Math.log(ratio)); // symmetric
    if (off > Math.log(1.15)) score *= clamp(1 - (off - Math.log(1.15)) / Math.log(1.5));
  }
  return { score, rmsBeats: Math.round(rmsBeats * 1000) / 1000, playedBpm: playedBpm && Math.round(playedBpm) };
}

export function gradeMidi(item: MidiItem, events: MidiEvent[]) {
  if (item.mode === "chord") {
    const played = heldChord(events);
    return { score: chordScore(played, item.expect, item.octave, item.bass), detail: { played, expect: item.expect } };
  }
  if (item.mode === "chords") {
    const exp = item.expectChords ?? [];
    const got = clusterChords(events);
    const sc = (a: number[], b: number[]) => chordScore(b, a, item.octave, item.bass);
    // align chords by "close enough" equality, then score matched chords by F1
    const { pairs } = align(exp, got.map((g) => g.notes), (a, b) => sc(a, b) >= 0.5);
    let sum = 0;
    for (const [i, j] of pairs) sum += sc(exp[i], got[j].notes);
    const extra = Math.max(0, got.length - exp.length);
    let pitch = clamp((sum - 0.5 * extra) / exp.length);
    let timing: ReturnType<typeof timingScore> | null = null;
    if (item.tempo && pairs.length >= 3) {
      timing = timingScore(pairs.map(([i]) => i), pairs.map(([, j]) => got[j].t), item.tempo);
      pitch = 0.75 * pitch + 0.25 * timing.score;
    }
    return { score: pitch, detail: { played: got.map((g) => g.notes), expect: exp, timing } };
  }
  // sequence
  const on = onsets(events);
  const eq = item.octave === "exact" ? (a: number, b: number) => a === b : (a: number, b: number) => pc(a) === pc(b);
  const { pairs, edits } = align(item.expect, on.map((o) => o.note), eq);
  const pitch = clamp(1 - edits / item.expect.length);
  let score = pitch;
  let timing: ReturnType<typeof timingScore> | null = null;
  if (item.tempo && pairs.length >= 3) {
    timing = timingScore(pairs.map(([i]) => i), pairs.map(([, j]) => on[j].t), item.tempo);
    score = 0.7 * pitch + 0.3 * timing.score;
  }
  return { score, detail: { played: on.map((o) => o.note), expect: item.expect, pitch, timing } };
}

/** Mean of item scores; exercise passes when the mean reaches its threshold. */
export function exerciseScore(scores: number[]): number {
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
}
