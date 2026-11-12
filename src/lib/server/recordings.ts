import fs from "node:fs";
import path from "node:path";
import { getDb, now } from "./db";
import { dataDir } from "./config";
import { analyze, voiceHealth } from "./voiceScore";
import type { VoiceAnalysis } from "../grading";

// Recordings live under <data dir>/recordings/YYYY-MM/<id>.<ext>. The data dir is
// on /mnt/windows by default; nothing is written to the root disk.

export interface RecordingMeta {
  id: string; // client uuid: re-uploads after an offline period are idempotent
  date: string;
  lessonId: string | null;
  exerciseId: string;
  itemId: string;
  params: Record<string, unknown>; // what was sent to voice-score (targets, tempo...)
  mic?: Record<string, unknown> | null; // MediaTrackSettings the browser applied
}

const MIC_KEYS = ["deviceId", "groupId", "label", "echoCancellation", "noiseSuppression", "autoGainControl", "sampleRate", "channelCount", "latency", "sampleSize", "voiceIsolation"];
/** Keep the known MediaTrackSettings fields only; the client is not trusted to send a small object. */
export function cleanMic(m: unknown): string | null {
  if (!m || typeof m !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const k of MIC_KEYS) {
    const v = (m as Record<string, unknown>)[k];
    if (typeof v === "boolean" || typeof v === "number") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 120);
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

export interface RecordingRow {
  id: string;
  created_at: number;
  date: string;
  lesson_id: string | null;
  exercise_id: string;
  item_id: string;
  file: string;
  mime: string;
  size: number;
  params: string;
  server_analysis: string | null;
  browser_analysis: string | null;
  status: string;
  error: string | null;
  mic?: string | null;
}

const EXT: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3" };

export function recordingsDir(): string {
  const d = path.join(dataDir(), "recordings");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function getRecording(id: string): RecordingRow | undefined {
  return getDb().prepare("SELECT * FROM recordings WHERE id = ?").get(id) as RecordingRow | undefined;
}

export function absPath(row: RecordingRow): string {
  return path.join(recordingsDir(), row.file);
}

/** The analysis grading should trust: the server's when present, else the browser fallback's. */
export function bestAnalysis(row: RecordingRow | undefined): VoiceAnalysis | null {
  if (!row) return null;
  const s = row.server_analysis ?? row.browser_analysis;
  return s ? (JSON.parse(s) as VoiceAnalysis) : null;
}

async function runServerAnalysis(row: RecordingRow) {
  const buf = fs.readFileSync(absPath(row));
  const params = { ...JSON.parse(row.params), contour: false };
  const r = await analyze(new Blob([buf], { type: row.mime }), path.basename(row.file), params);
  const db = getDb();
  if (r.ok) db.prepare("UPDATE recordings SET server_analysis = ?, status = 'analyzed', error = NULL WHERE id = ?").run(JSON.stringify(r.data), row.id);
  else if (r.reason === "down") db.prepare("UPDATE recordings SET status = 'pending', error = ? WHERE id = ?").run(r.error, row.id);
  else db.prepare("UPDATE recordings SET status = ?, error = ? WHERE id = ?").run(r.reason, r.error, row.id);
  return r;
}

/** Save an upload and analyze it on voice-score. A "down" result leaves it pending for later. */
export async function saveRecording(meta: RecordingMeta, audio: Blob) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(meta.id)) throw new Error("bad recording id");
  const existing = getRecording(meta.id);
  if (existing) return { row: existing, analysis: bestAnalysis(existing), reason: existing.status };
  const mime = (audio.type || "audio/webm").split(";")[0];
  const ext = EXT[mime] ?? "webm";
  const month = meta.date.slice(0, 7);
  // rel is stored in the DB; the turbopackIgnore hint keeps Next from tracing the whole repo for this dynamic path
  const rel = path.join(/*turbopackIgnore: true*/ month, `${meta.id}.${ext}`);
  const abs = path.join(recordingsDir(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const buf = Buffer.from(await audio.arrayBuffer());
  if (buf.length > 20 * 1024 * 1024) throw new Error("recording too large (20 MB max)");
  fs.writeFileSync(abs, buf);
  getDb()
    .prepare(
      `INSERT INTO recordings(id, created_at, date, lesson_id, exercise_id, item_id, file, mime, size, params, status, mic)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?)`,
    )
    .run(meta.id, now(), meta.date, meta.lessonId, meta.exerciseId, meta.itemId, rel, mime, buf.length, JSON.stringify(meta.params), cleanMic(meta.mic));
  const r = await runServerAnalysis(getRecording(meta.id)!);
  const row = getRecording(meta.id)!;
  return { row, analysis: bestAnalysis(row), reason: r.ok ? "analyzed" : r.reason };
}

/** Browser-fallback result for a recording (kept alongside any later server analysis). */
export function attachBrowserAnalysis(id: string, analysis: VoiceAnalysis) {
  const row = getRecording(id);
  if (!row) throw new Error(`no recording ${id}`);
  getDb().prepare("UPDATE recordings SET browser_analysis = ?, status = CASE WHEN server_analysis IS NULL THEN 'browser' ELSE status END WHERE id = ?").run(JSON.stringify(analysis), id);
  return getRecording(id)!;
}

/**
 * Re-analyze recordings made while voice-score was down, so every take ends up
 * with a server analysis too (and browser-vs-server pairs exist for validation).
 * Grades already given are not changed.
 */
export async function reanalyzePending(limit = 3): Promise<number> {
  const rows = getDb().prepare("SELECT * FROM recordings WHERE server_analysis IS NULL AND status IN ('pending','browser') ORDER BY created_at LIMIT ?").all(limit) as RecordingRow[];
  if (!rows.length) return 0;
  if (!(await voiceHealth()).up) return 0;
  let n = 0;
  for (const r of rows) if ((await runServerAnalysis(r)).ok) n++;
  return n;
}

export function listRecordings(limit = 50, offset = 0, oldestFirst = false): RecordingRow[] {
  return getDb().prepare(`SELECT * FROM recordings ORDER BY created_at ${oldestFirst ? "ASC" : "DESC"} LIMIT ? OFFSET ?`).all(limit, offset) as RecordingRow[];
}

// ---------- voice rest ----------
export function voiceRest(date: string): string | null {
  const r = getDb().prepare("SELECT state FROM voice_days WHERE date = ?").get(date) as { state: string } | undefined;
  return r && r.state !== "fine" ? r.state : null;
}
export function setVoiceDay(date: string, state: string) {
  // a day once marked tired/hoarse stays a rest day even if a later check-in says "fine"
  const cur = voiceRest(date);
  if (cur && state === "fine") return;
  getDb().prepare("INSERT INTO voice_days(date, state, at) VALUES (?,?,?) ON CONFLICT(date) DO UPDATE SET state = excluded.state, at = excluded.at").run(date, state, now());
}

/** JSON shape for the UI and the validation endpoint. */
export function publicRow(r: RecordingRow) {
  return {
    id: r.id,
    createdAt: r.created_at,
    date: r.date,
    lessonId: r.lesson_id,
    exerciseId: r.exercise_id,
    itemId: r.item_id,
    mime: r.mime,
    size: r.size,
    params: JSON.parse(r.params),
    status: r.status,
    error: r.error,
    serverAnalysis: r.server_analysis ? JSON.parse(r.server_analysis) : null,
    browserAnalysis: r.browser_analysis ? JSON.parse(r.browser_analysis) : null,
    audioUrl: `/api/voice/recordings/${r.id}/audio`,
  };
}

