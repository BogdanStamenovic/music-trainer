import { randomUUID } from "node:crypto";
import { getDb, now } from "./db";
import { getCurriculum } from "../curriculum/loader";
import type { Project } from "../curriculum/schema";
import { registerJob, enqueue, jobsFor, type JobRow, type JobResult } from "./jobs";
import { review, rubricScore, type Review, type ReviewRequest } from "./claude";
import { runRules, type RulesOutcome } from "./rules";
import { gradeSing, type MidiEvent } from "../grading";
import { vocalItem, gradeByEar, lyricsStats } from "../projects";
import { getRecording, bestAnalysis } from "./recordings";
import { parseNote, toMidi } from "../music/pitch";
import { isoWeek } from "./planner";
export { isoWeek };

// One project per ISO week, rotating composition -> lyrics -> vocal -> by-ear.
// Grade = deterministic part (music21 rules / voice metrics / MIDI) + rubric part.
// The rubric part is the claude -p review for composition and lyrics (the learner's
// self-assessment stands in, marked provisional, until the review arrives or if it
// cannot run), and the learner's self-assessment for vocal and by-ear pieces
// (an LLM reading text cannot judge a performance it did not hear).

export const ROTATION = ["composition", "lyrics", "vocal", "byear"] as const;
export type Kind = (typeof ROTATION)[number];

export interface ProjectRow {
  id: string;
  week: string;
  project_id: string;
  kind: Kind;
  assigned_at: number;
  status: "open" | "submitted" | "graded";
  locale: string | null;
  submission: string | null;
  submitted_at: number | null;
  auto: string | null;
  self: string | null;
  ai: string | null;
  ai_status: string | null;
  score: number | null;
  final: number;
  updated_at: number;
}

function rowOf(id: string): ProjectRow | undefined {
  return getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
}

export function projectDef(projectId: string): Project | undefined {
  return getCurriculum().projects.find((p) => p.id === projectId);
}

/** The project for the week containing `date`, assigned on first request. */
export function weekProject(date: string): { row: ProjectRow; def: Project } | null {
  const { week } = isoWeek(date);
  const db = getDb();
  let row = db.prepare("SELECT * FROM projects WHERE week = ?").get(week) as ProjectRow | undefined;
  const all = getCurriculum().projects;
  if (!row) {
    if (!all.length) return null;
    const past = db.prepare("SELECT project_id, kind FROM projects ORDER BY week").all() as { project_id: string; kind: Kind }[];
    // rotate by kind; skip kinds that have no content
    let kind: Kind | null = null;
    for (let k = 0; k < ROTATION.length && !kind; k++) {
      const cand = ROTATION[(past.length + k) % ROTATION.length];
      if (all.some((p) => p.kind === cand)) kind = cand;
    }
    if (!kind) return null;
    const ofKind = all.filter((p) => p.kind === kind).sort((a, b) => a.order - b.order);
    const used = new Set(past.map((p) => p.project_id));
    const pick = ofKind.find((p) => !used.has(p.id)) ?? ofKind[past.filter((p) => p.kind === kind).length % ofKind.length];
    const id = randomUUID();
    db.prepare("INSERT INTO projects(id, week, project_id, kind, assigned_at, status, updated_at) VALUES (?,?,?,?,?, 'open', ?)").run(id, week, pick.id, kind, now(), now());
    row = rowOf(id)!;
  }
  const def = all.find((p) => p.id === row!.project_id);
  return def ? { row, def } : null;
}

export function listProjects(): ProjectRow[] {
  return getDb().prepare("SELECT * FROM projects ORDER BY week DESC").all() as ProjectRow[];
}

// ---------- submission ----------
type Common = { self: Record<string, number>; locale: "en" | "sr"; notes?: string }; // notes: the learner's own remarks
export type SubmissionBody =
  | ({ kind: "composition"; abc: string } & Common)
  | ({ kind: "lyrics"; text: string; language: "en" | "sr" } & Common)
  | ({ kind: "vocal"; recordingId: string } & Common)
  | ({ kind: "byear"; events: MidiEvent[] } & Common);

function clampSelf(def: Project, self: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of def.rubric) if (typeof self?.[c.id] === "number") out[c.id] = Math.max(0, Math.min(4, Math.round(self[c.id])));
  return out;
}

/** Combine parts into the stored score. Rubric = AI review when present, else self-assessment (provisional). */
function computeScore(def: Project, auto: Record<string, unknown> | null, self: Record<string, number>, ai: Review | null): { score: number; parts: Record<string, number> } {
  const rubricScores = ai ? Object.fromEntries(ai.criteria.map((c) => [c.id, c.score])) : self;
  const rub = rubricScore(def.rubric, rubricScores);
  if (def.kind === "composition") {
    const rules = auto && (auto.rules as RulesOutcome | undefined)?.ok ? ((auto.rules as { score: number }).score) : null;
    if (rules == null) return { score: rub, parts: { rubric: rub } }; // worker unavailable: rubric only
    const w = def.weights;
    return { score: (w.rules * rules + w.rubric * rub) / (w.rules + w.rubric), parts: { rules, rubric: rub } };
  }
  if (def.kind === "lyrics") return { score: rub, parts: { rubric: rub } };
  if (def.kind === "vocal") {
    const pitch = (auto?.pitch as number) ?? 0;
    const w = def.weights;
    return { score: (w.pitch * pitch + w.rubric * rub) / (w.pitch + w.rubric), parts: { pitch, rubric: rub } };
  }
  const w = def.weights;
  const pitch = (auto?.pitch as number) ?? 0;
  const rhythm = (auto?.rhythm as number) ?? 0;
  return { score: (w.pitch * pitch + w.rhythm * rhythm + w.rubric * rub) / (w.pitch + w.rhythm + w.rubric), parts: { pitch, rhythm, rubric: rub } };
}

function save(id: string, fields: Partial<ProjectRow>) {
  const keys = Object.keys(fields);
  getDb()
    .prepare(`UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => (fields as Record<string, unknown>)[k] as never), now(), id);
}

export async function submitProject(id: string, body: SubmissionBody) {
  const row = rowOf(id);
  if (!row) throw new Error(`no project ${id}`);
  const def = projectDef(row.project_id);
  if (!def) throw new Error(`project ${row.project_id} is not in the curriculum`);
  if (def.kind !== body.kind) throw new Error(`project is ${def.kind}, got ${body.kind}`);
  const self = clampSelf(def, body.self);
  const submittedAt = now();
  let auto: Record<string, unknown> = {};
  let reviewReq: ReviewRequest | null = null;
  const brief = def.brief.en;
  if (body.kind === "composition" && def.kind === "composition") {
    if (!body.abc?.trim()) throw new Error("empty composition");
    const c = def.composition;
    const rules = await runRules({ abc: body.abc, key: c.key, meter: c.meter, bars: c.bars, rules: c.rules, range: c.range ? [toMidi(parseNote(c.range[0])), toMidi(parseNote(c.range[1]))] : undefined });
    auto = { rules };
    const ctx = rules.ok ? rules.checks.map((k) => `- ${k.id}: ${k.pass ? "pass" : "FAIL"} (${Math.round(k.score * 100)}%) ${k.detail}`).join("\n") : `(rule checks unavailable: ${rules.error})`;
    reviewReq = { kind: "composition", locale: body.locale, title: def.title.en, brief, rubric: def.rubric, submission: body.abc, context: `Key ${c.key}, meter ${c.meter}, ${c.bars} bars${c.chords ? `, given chords ${c.chords.join(" ")}` : ""}.\n${ctx}${body.notes ? `\nLearner's own notes: ${body.notes.slice(0, 1000)}` : ""}` };
  } else if (body.kind === "lyrics" && def.kind === "lyrics") {
    if (!body.text?.trim()) throw new Error("empty lyrics");
    const stats = lyricsStats(body.text, body.language);
    auto = { stats };
    reviewReq = {
      kind: "lyrics",
      locale: body.locale,
      title: def.title.en,
      brief,
      rubric: def.rubric,
      submission: body.text,
      context: `Genre: ${def.lyrics.genre.en}. Required structure: ${def.lyrics.structure.en}; ${def.lyrics.lines[0]}-${def.lyrics.lines[1]} lines. Written in ${body.language === "sr" ? "Serbian" : "English"}.\nHeuristic stats (approximate): ${stats.lines} lines, syllables per line ${stats.syllablesPerLine.join(",")}, rhyme scheme by spelling ${stats.rhymeScheme}.${body.notes ? `\nLearner's own notes: ${body.notes.slice(0, 1000)}` : ""}`,
    };
  } else if (body.kind === "vocal" && def.kind === "vocal") {
    const rec = getRecording(body.recordingId);
    if (!rec) throw new Error("recording not found (upload it first)");
    const item = vocalItem(def.melody, def.tolerance, def.id);
    const g = gradeSing(item, { analysis: bestAnalysis(rec) });
    auto = { pitch: g.score, notes: g.detail, recordingId: body.recordingId };
  } else if (body.kind === "byear" && def.kind === "byear") {
    const g = gradeByEar(def.melody, body.events ?? []);
    auto = { ...g };
  }
  const { score, parts } = computeScore(def, auto, self, null);
  auto.parts = parts;
  const needsAi = !!reviewReq;
  save(id, {
    status: needsAi ? "submitted" : "graded",
    locale: body.locale,
    submission: JSON.stringify(body),
    submitted_at: submittedAt,
    auto: JSON.stringify(auto),
    self: JSON.stringify(self),
    ai: null,
    ai_status: needsAi ? "pending" : "n/a",
    score,
    final: needsAi ? 0 : 1,
  });
  if (reviewReq) enqueue("review", id, { projectRowId: id, submittedAt, req: reviewReq });
  return getProject(id);
}

export function getProject(id: string) {
  const row = rowOf(id);
  if (!row) return null;
  const parse = (s: string | null) => (s ? JSON.parse(s) : null);
  return {
    ...row,
    submission: parse(row.submission),
    auto: parse(row.auto),
    self: parse(row.self),
    ai: parse(row.ai),
    def: projectDef(row.project_id) ?? null,
    jobs: jobsFor(id).map((j) => ({ id: j.id, status: j.status, attempts: j.attempts, error: j.last_error, nextRunAt: j.next_run_at })),
  };
}

// ---------- review job ----------
interface ReviewPayload {
  projectRowId: string;
  submittedAt: number;
  req: ReviewRequest;
}

export function onReviewFinished(job: JobRow, r: JobResult) {
  const p = JSON.parse(job.payload) as ReviewPayload;
  const row = rowOf(p.projectRowId);
  if (!row || row.submitted_at !== p.submittedAt) return; // superseded by a newer submission
  const def = projectDef(row.project_id);
  if (!def) return;
  if (r.ok) {
    const rv = r.result as Review;
    const auto = row.auto ? JSON.parse(row.auto) : {};
    const { score, parts } = computeScore(def, auto, JSON.parse(row.self ?? "{}"), rv);
    auto.parts = parts;
    save(row.id, { ai: JSON.stringify(rv), ai_status: "done", score, final: 1, status: "graded", auto: JSON.stringify(auto) });
  } else if (job.status === "waiting") {
    save(row.id, { ai_status: "unavailable" }); // keeps the provisional self-assessed score; retried hourly
  } else {
    save(row.id, { ai_status: "failed", status: "graded" }); // self-assessment stands
  }
}

registerJob(
  "review",
  async (payload) => {
    const p = payload as ReviewPayload;
    const row = rowOf(p.projectRowId);
    if (!row || row.submitted_at !== p.submittedAt) return { ok: false, error: "superseded", permanent: true };
    const r = await review(p.req);
    if (r.ok) return { ok: true, result: { ...r.review, ms: r.ms, costUsd: r.costUsd } };
    return { ok: false, error: r.error, unavailable: r.unavailable };
  },
  onReviewFinished,
);
