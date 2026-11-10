// Pure helpers for weekly projects, shared by client (feedback, quantize) and server (grading).

import type { Melody } from "./curriculum/schema";
import type { SingItem, PlaySpec } from "./curriculum/items";
import { align, type MidiEvent } from "./grading";
import { parseNote, toMidi, midiToNote, noteStr, LETTERS, type Note } from "./music/pitch";
import { scale, keySignature } from "./music/harmony";
import { noteToAbc } from "./music/abc";

// ---------- melodies ----------
export function melodyLayout(m: Melody): { midi?: number; beats: number }[] {
  return m.notes.map((n, i) => (n === "r" ? { beats: m.beats[i] } : { midi: toMidi(parseNote(n)), beats: m.beats[i] }));
}

/** Playback spec with real rhythm (rests included). */
export function melodyPlay(m: Melody): PlaySpec {
  const lay = melodyLayout(m);
  return { mode: "melodic", notes: lay.map((e) => e.midi ?? -1), durations: lay.map((e) => e.beats), tempo: m.tempo };
}

export function vocalItem(m: Melody, tolerance: number, id: string): SingItem {
  const lay = melodyLayout(m);
  const notes = lay.filter((e) => e.midi != null);
  return {
    id: `${id}#0`,
    exerciseId: id,
    kind: "sing",
    prompt: m.title,
    targets: notes.map((e) => e.midi!),
    beats: notes.map((e) => e.beats),
    tempo: m.tempo,
    tolerance,
    octaveAgnostic: true,
    layout: lay,
    noteLabels: { en: m.title.en, sr: m.title.sr },
    play: melodyPlay(m),
  };
}

/**
 * Play-a-song-by-ear grade, key-independent: pitch = edit distance between the
 * reference and played INTERVAL sequences; rhythm = for matched notes, how far
 * each inter-onset ratio is from the reference (after fitting one tempo factor).
 */
export function gradeByEar(m: Melody, events: MidiEvent[]) {
  const lay = melodyLayout(m);
  const ref: { midi: number; onset: number }[] = [];
  let t = 0;
  for (const e of lay) {
    if (e.midi != null) ref.push({ midi: e.midi, onset: t });
    t += e.beats;
  }
  const played = events.filter((e) => e.type === "on").sort((a, b) => a.t - b.t).map((e) => ({ midi: e.note, t: e.t }));
  if (played.length < 2) return { pitch: 0, rhythm: 0, transpose: null as number | null, detail: { played: played.length, expected: ref.length } };
  const rI = ref.slice(1).map((r, i) => r.midi - ref[i].midi);
  const pI = played.slice(1).map((p, i) => p.midi - played[i].midi);
  const { pairs, edits } = align(rI, pI, (a, b) => a === b);
  const pitch = Math.max(0, 1 - edits / rI.length);
  // rhythm over matched intervals: reference beats vs played ms between the two notes
  const ratios = pairs.map(([i, j]) => ({ beats: ref[i + 1].onset - ref[i].onset, ms: played[j + 1].t - played[j].t })).filter((x) => x.beats > 0 && x.ms > 0);
  let rhythm = 0;
  if (ratios.length >= 2) {
    const scales = ratios.map((x) => x.ms / x.beats).sort((a, b) => a - b);
    const k = scales[Math.floor(scales.length / 2)]; // median ms per beat
    const errs = ratios.map((x) => Math.abs(Math.log2(x.ms / k / x.beats)));
    rhythm = errs.reduce((a, e) => a + Math.max(0, 1 - e / 0.5), 0) / errs.length; // half an octave of ratio (x1.41) = 0
  }
  const first = pairs[0];
  const transpose = first ? played[first[1]].midi - ref[first[0]].midi : null;
  return { pitch, rhythm, transpose, detail: { matchedIntervals: pairs.length, intervals: rI.length, edits, played: played.length, expected: ref.length } };
}

// ---------- lyrics helpers (shown to the learner and the reviewer; not graded) ----------
export function syllables(word: string, lang: "en" | "sr"): number {
  const w = word.toLowerCase().replace(/[^a-zčćšžđ']/g, "");
  if (!w) return 0;
  if (lang === "sr") {
    let n = (w.match(/[aeiou]/g) ?? []).length;
    // syllabic r: between consonants or word-initial before a consonant (srce, prst, rđa)
    n += (w.match(/(^|[^aeiou])r(?=[^aeiour]|$)/g) ?? []).length;
    return Math.max(1, n);
  }
  let n = (w.match(/[aeiouy]+/g) ?? []).length;
  if (/[^aeiouy]e$/.test(w) && !/[^aeiouy]le$/.test(w) && n > 1) n--; // silent final e
  return Math.max(1, n);
}

/**
 * Rhyme key by spelling. English: the last vowel group and what follows (masculine
 * rhyme). Serbian leans on feminine rhymes and is spelled phonetically, so it uses
 * the last two vowel groups (cveta / leta -> "eta"). Apostrophes (doć') are dropped.
 */
function rhymeKey(line: string, lang: "en" | "sr"): string {
  const words = line.toLowerCase().replace(/'/g, "").replace(/[^a-zčćšžđ\s]/g, " ").trim().split(/\s+/);
  const last = words[words.length - 1] ?? "";
  const re = lang === "sr" ? /[aeiou]+[^aeiou]*[aeiou]+[^aeiou]*$|[aeiou]+[^aeiou]*$/ : /[aeiouy]+[^aeiouy]*$/;
  const m = re.exec(last);
  return m ? m[0] : last;
}

export function lyricsStats(text: string, lang: "en" | "sr") {
  const lines = text.split("\n").map((l) => l.trim());
  const sung = lines.filter((l) => l && !/^\[.*\]$/.test(l)); // [Chorus] style headers are not lines
  const keys: string[] = [];
  const letters: string[] = [];
  for (const l of sung) {
    const k = rhymeKey(l, lang);
    let idx = keys.indexOf(k);
    if (idx < 0) {
      keys.push(k);
      idx = keys.length - 1;
    }
    letters.push(String.fromCharCode(65 + (idx % 26)));
  }
  return {
    lines: sung.length,
    sections: lines.filter((l) => /^\[.*\]$/.test(l)).length,
    syllablesPerLine: sung.map((l) => l.split(/\s+/).reduce((a, w) => a + syllables(w, lang), 0)),
    rhymeScheme: letters.join(""),
    words: sung.join(" ").split(/\s+/).filter(Boolean).length,
  };
}

// ---------- MIDI -> quantized notes -> ABC ----------
export interface QNote {
  midi: number;
  start: number; // in grid units from the downbeat of bar 1
  dur: number; // grid units
  voice: 1 | 2;
}

/**
 * Quantize a recorded performance. `t0` is the time (ms) of beat 1 of bar 1 (end
 * of the count-in). Onsets and offsets snap to the grid (`grid` subdivisions per
 * quarter note: 2 = eighths, 4 = sixteenths). Each voice is made monophonic: a note
 * is cut where the next one in the same voice starts. Notes below `split` go to
 * voice 2 (bass) when `voices` is 2.
 */
export function quantize(events: MidiEvent[], o: { t0: number; tempo: number; grid: number; voices: 1 | 2; split?: number }): QNote[] {
  const unit = 60000 / o.tempo / o.grid;
  const open = new Map<number, number>();
  const raw: { midi: number; on: number; off: number }[] = [];
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (e.type === "on") open.set(e.note, e.t);
    else if (e.type === "off" && open.has(e.note)) {
      raw.push({ midi: e.note, on: open.get(e.note)!, off: e.t });
      open.delete(e.note);
    }
  }
  const lastT = events.length ? Math.max(...events.map((e) => e.t)) : 0;
  for (const [midi, on] of open) raw.push({ midi, on, off: Math.max(on + unit, lastT) });
  const notes: QNote[] = raw
    .map((r) => {
      const start = Math.max(0, Math.round((r.on - o.t0) / unit));
      const end = Math.max(start + 1, Math.round((r.off - o.t0) / unit));
      return { midi: r.midi, start, dur: end - start, voice: (o.voices === 2 && r.midi < (o.split ?? 55) ? 2 : 1) as 1 | 2 };
    })
    .sort((a, b) => a.start - b.start || b.midi - a.midi);
  // monophonic per voice: keep the top note for melody / bottom for bass at equal onsets, cut overlaps
  const out: QNote[] = [];
  for (const v of [1, 2] as const) {
    const vs = notes.filter((n) => n.voice === v);
    const dedup: QNote[] = [];
    for (const n of vs) {
      const prev = dedup[dedup.length - 1];
      if (prev && prev.start === n.start) {
        if ((v === 1 && n.midi > prev.midi) || (v === 2 && n.midi < prev.midi)) dedup[dedup.length - 1] = n;
        continue;
      }
      if (prev && prev.start + prev.dur > n.start) prev.dur = n.start - prev.start;
      dedup.push(n);
    }
    out.push(...dedup);
  }
  return out;
}

/** Spell a MIDI note in a key: scale tones by the scale's spelling, others sharp in sharp keys, flat in flat keys. */
export function spellInKey(midi: number, tonic: Note, mode: "major" | "minor"): Note {
  const sc = scale(tonic, mode === "major" ? "major" : "natural-minor").concat(mode === "minor" ? scale(tonic, "harmonic-minor").slice(6) : []);
  const pc = ((midi % 12) + 12) % 12;
  const hit = sc.find((n) => ((toMidi({ ...n, octave: 4 }) % 12) + 12) % 12 === pc);
  if (hit) {
    // pick the octave that makes the spelled note equal the MIDI pitch
    const base = toMidi({ ...hit, octave: 0 });
    return { ...hit, octave: Math.round((midi - base) / 12) };
  }
  return midiToNote(midi, keySignature(tonic, mode) < 0);
}

export function parseKey(key: string): { tonic: Note; mode: "major" | "minor"; abcKey: string } {
  const m = /^([A-G](?:#|b)?) (major|minor)$/.exec(key.trim());
  if (!m) throw new Error(`bad key ${key}`);
  const tonic = parseNote(m[1], 4);
  return { tonic, mode: m[2] as "major" | "minor", abcKey: m[1] + (m[2] === "minor" ? "m" : "") };
}

/** Accidentals implied by the key signature, per letter index. */
function sigAccidentals(tonic: Note, mode: "major" | "minor"): number[] {
  const acc = [0, 0, 0, 0, 0, 0, 0];
  for (const n of scale(tonic, mode === "major" ? "major" : "natural-minor")) acc[n.letter] = n.acc;
  return acc;
}

/**
 * Quantized notes -> ABC (one or two voices). Durations are written in grid units
 * (L:1/(4*grid)); notes crossing a bar line are split and tied. Accidentals are
 * written relative to the key signature and the accidentals already used in the bar.
 */
export function toAbc(notes: QNote[], o: { key: string; meter: string; grid: number; title?: string }): string {
  const { tonic, mode, abcKey } = parseKey(o.key);
  const [num, den] = o.meter.split("/").map(Number);
  const barUnits = Math.round(num * (4 / den) * o.grid);
  const sig = sigAccidentals(tonic, mode);
  const end = Math.max(barUnits, ...notes.map((n) => n.start + n.dur));
  const bars = Math.ceil(end / barUnits);
  const voices = notes.some((n) => n.voice === 2) ? [1, 2] : [1];
  const len = (u: number) => (u === 1 ? "" : String(u));
  const lines: string[] = [`X:1`, `T:${o.title ?? "Composition"}`, `M:${o.meter}`, `L:1/${4 * o.grid}`, `K:${abcKey}`];
  for (const v of voices) {
    const vs = notes.filter((n) => n.voice === v).sort((a, b) => a.start - b.start);
    let out = "";
    for (let b = 0; b < bars; b++) {
      const bStart = b * barUnits;
      const bEnd = bStart + barUnits;
      const used = new Map<string, number>(); // letter+octave -> accidental in effect this bar
      let t = bStart;
      const parts: string[] = [];
      for (const n of vs) {
        const s = Math.max(n.start, bStart);
        const e = Math.min(n.start + n.dur, bEnd);
        if (e <= s) continue;
        if (s > t) parts.push("z" + len(s - t));
        const sp = spellInKey(n.midi, tonic, mode);
        const k = `${sp.letter}:${sp.octave}`;
        const inEffect = used.has(k) ? used.get(k)! : sig[sp.letter];
        const marks = sp.acc === inEffect ? "" : sp.acc === 0 ? "=" : sp.acc > 0 ? "^".repeat(sp.acc) : "_".repeat(-sp.acc);
        used.set(k, sp.acc);
        const tie = n.start + n.dur > bEnd ? "-" : "";
        parts.push(marks + noteToAbc({ ...sp, acc: 0 }) + len(e - s) + tie);
        t = e;
      }
      if (t < bEnd) parts.push("z" + len(bEnd - t));
      out += parts.join(" ") + (b === bars - 1 ? " |]" : " | ");
      if ((b + 1) % 4 === 0 && b !== bars - 1) out += "\n";
    }
    if (voices.length > 1) lines.push(`V:${v}${v === 2 ? " clef=bass" : ""}`);
    lines.push(out);
  }
  return lines.join("\n");
}

export { noteStr, LETTERS };
