import type { Lesson, Check, Exercise, Placement, Project, Melody } from "./schema";
import { Check as CheckSchema } from "./schema";
import type { z } from "zod";
import { derive, generateItems } from "./items";
import { parseNote, pcName, noteStr, toMidi } from "../music/pitch";
import { intervalBetween, ivStr } from "../music/interval";
import { scale, keySignature, romanNumeral, romanNumeral7, CHORDS } from "../music/harmony";
import { syllables } from "../projects";

/** Run one content assertion; returns an error message or null. */
export function runCheck(input: z.input<typeof CheckSchema>): string | null {
  const c: Check = CheckSchema.parse(input);
  if ("interval" in c) {
    const got = ivStr(intervalBetween(parseNote(c.interval.from), parseNote(c.interval.to)));
    return got === c.interval.is ? null : `interval ${c.interval.from}-${c.interval.to} is ${got}, content says ${c.interval.is}`;
  }
  if ("semitones" in c) {
    const got = Math.abs(toMidi(parseNote(c.semitones.to)) - toMidi(parseNote(c.semitones.from)));
    return got === c.semitones.is ? null : `${c.semitones.from}-${c.semitones.to} is ${got} semitones, content says ${c.semitones.is}`;
  }
  if ("chord" in c) {
    // Judged by SPELLING from the stated root (not by pitch-class identification, which
    // cannot tell Dm7 from F6): every note is a chord member above the root, the member
    // set matches the quality (shell voicings without the 5th allowed for 7th chords), and
    // the lowest note gives the inversion.
    const notes = c.chord.notes.map((n) => parseNote(n));
    const root = notes.find((n) => pcName(n) === c.chord.root);
    if (!root) return `chord ${c.chord.notes.join(" ")} does not contain spelled root ${c.chord.root}`;
    const steps = (n: { octave: number; letter: number }) => n.octave * 7 + n.letter;
    const members = new Set<string>();
    for (const n of notes) {
      if (n.letter === root.letter && n.acc === root.acc) continue;
      const m = { ...n };
      while (steps(m) <= steps(root)) m.octave++;
      while (steps(m) - steps(root) > 7) m.octave--;
      let iv: string;
      try {
        iv = ivStr(intervalBetween(root, m));
      } catch {
        return `chord ${c.chord.notes.join(" ")}: ${noteStr(n)} is not spellable above ${c.chord.root}`;
      }
      // 9ths are written as 2nds within the octave
      members.add(iv.replace(/^(m|M|A)2$/, "$19").replace(/^P4$/, "P4"));
    }
    const shape = CHORDS[c.chord.quality].slice(1).map((x) => x);
    const want = new Set<string>(shape);
    const got = [...members];
    const isShell = c.chord.quality.includes("7") && !members.has("P5") && !members.has("d5") && !members.has("A5") && shape.filter((x) => !/5$/.test(x)).every((x) => members.has(x));
    if (!(got.every((g) => want.has(g)) && (shape.every((x) => members.has(x)) || isShell)))
      return `chord ${c.chord.notes.join(" ")} spelled from ${c.chord.root} has ${got.join(",")}, a ${c.chord.quality} chord needs ${shape.join(",")}`;
    const bass = notes.reduce((a, b) => (toMidi(a) <= toMidi(b) ? a : b));
    const order: string[] = ["P1", ...shape];
    let inv = 0;
    if (!(bass.letter === root.letter && bass.acc === root.acc)) {
      const b = { ...bass };
      while (steps(b) <= steps(root)) b.octave++;
      while (steps(b) - steps(root) > 7) b.octave--;
      inv = order.indexOf(ivStr(intervalBetween(root, b)).replace(/^(m|M|A)2$/, "$19"));
    }
    return inv === c.chord.inversion ? null : `chord ${c.chord.notes.join(" ")} is in inversion ${inv}, content says ${c.chord.inversion}`;
  }
  if ("scale" in c) {
    const got = scale(parseNote(c.scale.tonic), c.scale.type).map((n) => pcName(n));
    return JSON.stringify(got) === JSON.stringify(c.scale.is) ? null : `${c.scale.tonic} ${c.scale.type} is ${got.join(" ")}, content says ${c.scale.is.join(" ")}`;
  }
  if ("keysig" in c) {
    const got = keySignature(parseNote(c.keysig.key), c.keysig.mode);
    return got === c.keysig.is ? null : `${c.keysig.key} ${c.keysig.mode} signature is ${got}, content says ${c.keysig.is}`;
  }
  if ("roman" in c) {
    const got = c.roman.seventh ? romanNumeral7(parseNote(c.roman.key), c.roman.type, c.roman.degree) : romanNumeral(parseNote(c.roman.key), c.roman.type, c.roman.degree);
    return got === c.roman.is ? null : `degree ${c.roman.degree} in ${c.roman.key} ${c.roman.type} is ${got}, content says ${c.roman.is}`;
  }
  if ("syllables" in c) {
    const got = c.syllables.text.split(/\s+/).filter(Boolean).reduce((a, w) => a + syllables(w, "sr"), 0);
    return got === c.syllables.is ? null : `"${c.syllables.text}" has ${got} syllables (vowels + syllabic r), content says ${c.syllables.is}`;
  }
  return "unknown check";
}

function checkExercise(ex: Exercise, where: string): string[] {
  const errs: string[] = [];
  for (const c of ex.checks) {
    try {
      const e = runCheck(c);
      if (e) errs.push(`${where}: ${e}`);
    } catch (e) {
      errs.push(`${where}: check threw ${(e as Error).message}`);
    }
  }
  if (ex.type === "compose" && !ex.example) errs.push(`${where}: compose exercises need an \`example\` model answer (tests run it through the music21 worker)`);
  if (ex.type === "mcq" && ex.play?.durations && ex.play.notes && ex.play.durations.length !== ex.play.notes.length) errs.push(`${where}: play.durations length != notes length`);
  if (ex.type === "sing-phrase" && !ex.notes && !ex.derive) errs.push(`${where}: sing-phrase needs notes or derive`);
  if (ex.type === "sing-phrase" && ex.beats && ex.notes && ex.beats.length !== ex.notes.length) errs.push(`${where}: beats length != notes length`);
  if (ex.type === "sing-phrase" && ex.notes && ex.notes.every((n) => n === "r")) errs.push(`${where}: a phrase of only rests`);
  if (ex.type === "mcq" && ex.answer >= ex.options.length) errs.push(`${where}: answer index ${ex.answer} out of range`);
  if ((ex.type === "midi-play" || ex.type === "midi-echo" || ex.type === "notation-input") && !ex.derive && !ex.expect && !("expectChords" in ex && ex.expectChords))
    errs.push(`${where}: needs expect or derive`);
  // typed expectation and derived expectation must agree when both are given
  if ((ex.type === "midi-play" || ex.type === "midi-echo") && ex.derive && (ex.expect || ex.expectChords)) {
    const d = derive(ex.derive).map((c) => c.map((n) => noteStr(n)));
    const typed = ex.expectChords ?? [ex.expect!];
    if (JSON.stringify(d) !== JSON.stringify(typed)) errs.push(`${where}: expect ${JSON.stringify(typed)} != derived ${JSON.stringify(d)}`);
  }
  if (ex.type === "notation-input" && ex.derive && ex.expect) {
    const d = derive(ex.derive)[0].map((n) => pcName(n));
    if (JSON.stringify(d) !== JSON.stringify(ex.expect)) errs.push(`${where}: expect ${ex.expect.join(" ")} != derived ${d.join(" ")}`);
  }
  for (const [seed, ctx] of [["a", {}], ["b", { voiceRange: [45, 64] as [number, number] }], ["c", { voiceRange: [57, 76] as [number, number] }]] as const) {
    try {
      const items = generateItems(ex, seed, undefined, ctx);
      if (items.length === 0) errs.push(`${where}: generated no items`);
    } catch (e) {
      errs.push(`${where}: generation failed: ${(e as Error).message}`);
    }
  }
  return errs;
}

export function validateLessons(lessons: Lesson[]): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  const exIds = new Set<string>();
  for (const l of lessons) {
    if (ids.has(l.id)) errs.push(`duplicate lesson id ${l.id}`);
    ids.add(l.id);
    if (!l.id.startsWith(l.track + "-")) errs.push(`${l.id}: id does not match track ${l.track}`);
    // Voice safety (spec): every voice lesson opens with the fatigue/hoarseness check-in,
    // which can end the block, followed by a warm-up.
    if (l.track === "V") {
      if (l.exercises[0]?.type !== "checkin") errs.push(`${l.id}: voice lessons must start with a checkin exercise`);
      if (!l.tags.includes("maintenance") && l.exercises[1]?.type !== "practice") errs.push(`${l.id}: voice lessons need a warm-up (practice) right after the check-in`);
    }
    for (const ex of l.exercises)
      if (["sing-pitch", "sing-phrase", "voice-range", "checkin"].includes(ex.type) || (ex.type === "generated" && ["pitch-match", "phrase-sing"].includes(ex.gen.kind)))
        if (l.track !== "V") errs.push(`${ex.id}: singing exercises belong in the V track (check-in + warm-up rules)`);
    for (const ex of l.exercises) {
      if (exIds.has(ex.id)) errs.push(`duplicate exercise id ${ex.id}`);
      exIds.add(ex.id);
      if (!ex.id.startsWith(l.id + "-")) errs.push(`${ex.id}: exercise id must start with ${l.id}-`);
      errs.push(...checkExercise(ex, ex.id));
    }
  }
  for (const l of lessons) for (const p of l.prereqs) if (!ids.has(p)) errs.push(`${l.id}: unknown prereq ${p}`);
  // Voice safety (SPEC): distortion work unlocks only after support + onset units, and
  // every distortion lesson states the stop protocol in both languages.
  const byIdV = new Map(lessons.map((l) => [l.id, l]));
  const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
    for (const p of byIdV.get(id)?.prereqs ?? []) if (!seen.has(p)) { seen.add(p); ancestors(p, seen); }
    return seen;
  };
  for (const l of lessons) {
    if (!l.tags.includes("distortion")) continue;
    if (l.track !== "V") errs.push(`${l.id}: distortion lessons belong in V`);
    const anc = [...ancestors(l.id)].map((a) => byIdV.get(a)).filter(Boolean);
    if (!anc.some((a) => a!.tags.includes("support"))) errs.push(`${l.id}: distortion lesson must (transitively) require a lesson tagged "support"`);
    if (!anc.some((a) => a!.tags.includes("onset"))) errs.push(`${l.id}: distortion lesson must (transitively) require a lesson tagged "onset"`);
    if (!/stop/i.test(l.explain.en) || !/prekin|stani/i.test(l.explain.sr)) errs.push(`${l.id}: distortion lesson must state the stop protocol (EN "stop", SR "prekini/stani")`);
  }
  // prereq cycles
  const byId = new Map(lessons.map((l) => [l.id, l]));
  const state = new Map<string, number>();
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      errs.push(`prereq cycle: ${[...path, id].join(" -> ")}`);
      return;
    }
    state.set(id, 1);
    for (const p of byId.get(id)?.prereqs ?? []) visit(p, [...path, id]);
    state.set(id, 2);
  };
  for (const l of lessons) visit(l.id, []);
  return errs;
}

export function validatePlacement(p: Placement, lessonIds: Set<string>): string[] {
  const errs: string[] = [];
  for (const s of p.sections)
    for (const ex of s.exercises) {
      errs.push(...checkExercise(ex, `placement/${ex.id}`));
      for (const sk of ex.skips) if (!lessonIds.has(sk)) errs.push(`placement/${ex.id}: skips unknown lesson ${sk}`);
    }
  return errs;
}

const KEY_RE = /^([A-G](#|b)?) (major|minor)$/;

/** Melody sanity: one duration per note, bar arithmetic adds up, notes parse. */
export function validateMelody(m: Melody, where: string): string[] {
  const errs: string[] = [];
  if (m.notes.length !== m.beats.length) errs.push(`${where}: ${m.notes.length} notes but ${m.beats.length} beats`);
  if (!KEY_RE.test(m.key)) errs.push(`${where}: key "${m.key}" must look like "D major" / "A minor"`);
  const [num, den] = m.meter.split("/").map(Number);
  const bar = num * (4 / den); // in quarter-note beats
  const total = m.beats.reduce((a, b) => a + b, 0) - m.pickup;
  // a pickup is usually balanced by a short last bar; accept either a whole number of bars
  // or whole bars minus the pickup
  const ok = (x: number) => Math.abs(x / bar - Math.round(x / bar)) < 1e-6;
  if (!ok(total) && !ok(total + m.pickup)) errs.push(`${where}: ${total} beats after the pickup is not a whole number of ${m.meter} bars`);
  for (const n of m.notes) {
    if (n === "r") continue;
    try {
      parseNote(n);
    } catch {
      errs.push(`${where}: bad note ${n}`);
    }
  }
  return errs;
}

export function validateProjects(projects: Project[], lessonIds: Set<string>): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  const prefix = { composition: "PC", lyrics: "PL", vocal: "PV", byear: "PE" } as const;
  for (const p of projects) {
    if (ids.has(p.id)) errs.push(`duplicate project id ${p.id}`);
    ids.add(p.id);
    if (!p.id.startsWith(prefix[p.kind])) errs.push(`${p.id}: id prefix must be ${prefix[p.kind]} for ${p.kind}`);
    for (const pr of p.prereqs) if (!lessonIds.has(pr)) errs.push(`${p.id}: unknown prereq ${pr}`);
    const rid = new Set<string>();
    for (const c of p.rubric) {
      if (rid.has(c.id)) errs.push(`${p.id}: duplicate rubric id ${c.id}`);
      rid.add(c.id);
    }
    if (p.kind === "composition" && !KEY_RE.test(p.composition.key)) errs.push(`${p.id}: key "${p.composition.key}" must look like "C major"`);
    if (p.kind === "composition" && p.composition.chords && p.composition.chords.length !== p.composition.bars) errs.push(`${p.id}: ${p.composition.chords.length} chords for ${p.composition.bars} bars`);
    if (p.kind === "vocal" || p.kind === "byear") errs.push(...validateMelody(p.melody, p.id));
  }
  return errs;
}
