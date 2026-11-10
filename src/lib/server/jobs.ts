import { getDb, now } from "./db";

// A small persistent job queue in SQLite, run inside the server process.
// One job at a time (claude -p is the expensive step); a crashed or restarted
// server picks up where it left off because state lives in the DB.
//
// Status: queued -> running -> done | failed (attempts exhausted)
//         queued -> waiting (dependency unavailable, e.g. no claude binary; retried hourly, no attempt used)

export type JobResult = { ok: true; result: unknown } | { ok: false; error: string; unavailable?: boolean; permanent?: boolean };
export type Handler = (payload: unknown, jobId: number) => Promise<JobResult>;

export interface JobRow {
  id: number;
  kind: string;
  ref_id: string;
  payload: string;
  status: string;
  attempts: number;
  last_error: string | null;
  result: string | null;
  created_at: number;
  updated_at: number;
  next_run_at: number;
}

export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000];
const UNAVAILABLE_RETRY_MS = 60 * 60_000;

const handlers = new Map<string, Handler>();
const finishers = new Map<string, (job: JobRow, r: JobResult) => void>();

/** Register a handler and an optional callback that runs when a job finishes (success or final failure). */
export function registerJob(kind: string, h: Handler, onFinish?: (job: JobRow, r: JobResult) => void) {
  handlers.set(kind, h);
  if (onFinish) finishers.set(kind, onFinish);
}

export function enqueue(kind: string, refId: string, payload: unknown): number {
  const t = now();
  const r = getDb()
    .prepare("INSERT INTO jobs(kind, ref_id, payload, status, created_at, updated_at, next_run_at) VALUES (?,?,?, 'queued', ?,?,?)")
    .run(kind, refId, JSON.stringify(payload), t, t, t);
  setTimeout(() => void tick(), 10);
  return Number(r.lastInsertRowid);
}

export function jobsFor(refId: string): JobRow[] {
  return getDb().prepare("SELECT * FROM jobs WHERE ref_id = ? ORDER BY id").all(refId) as JobRow[];
}

let busy = false;

/** Run at most one due job. Exported for tests. */
export async function tick(): Promise<JobRow | null> {
  if (busy) return null;
  busy = true;
  try {
    const db = getDb();
    const job = db
      .prepare("SELECT * FROM jobs WHERE status IN ('queued','waiting') AND next_run_at <= ? ORDER BY next_run_at, id LIMIT 1")
      .get(now()) as JobRow | undefined;
    if (!job) return null;
    const h = handlers.get(job.kind);
    if (!h) {
      db.prepare("UPDATE jobs SET status='failed', last_error=?, updated_at=? WHERE id=?").run(`no handler for ${job.kind}`, now(), job.id);
      return job;
    }
    // atomic claim: Next compiles instrumentation and route handlers into separate bundles,
    // so several copies of this module (and of `busy`) can exist in one process
    const claimed = db.prepare("UPDATE jobs SET status='running', updated_at=? WHERE id=? AND status IN ('queued','waiting')").run(now(), job.id);
    if (claimed.changes !== 1) return null;
    let r: JobResult;
    try {
      r = await h(JSON.parse(job.payload), job.id);
    } catch (e) {
      r = { ok: false, error: (e as Error).message };
    }
    const t = now();
    if (r.ok) {
      db.prepare("UPDATE jobs SET status='done', result=?, last_error=NULL, attempts=attempts+1, updated_at=? WHERE id=?").run(JSON.stringify(r.result), t, job.id);
    } else if (r.unavailable) {
      db.prepare("UPDATE jobs SET status='waiting', last_error=?, updated_at=?, next_run_at=? WHERE id=?").run(r.error, t, t + UNAVAILABLE_RETRY_MS, job.id);
    } else {
      const attempts = job.attempts + 1;
      const final = r.permanent || attempts >= MAX_ATTEMPTS;
      db.prepare("UPDATE jobs SET status=?, attempts=?, last_error=?, updated_at=?, next_run_at=? WHERE id=?").run(final ? "failed" : "queued", attempts, r.error, t, t + (BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]), job.id);
    }
    const after = db.prepare("SELECT * FROM jobs WHERE id=?").get(job.id) as JobRow;
    if (after.status === "done" || after.status === "failed" || after.status === "waiting") finishers.get(job.kind)?.(after, r);
    return after;
  } finally {
    busy = false;
  }
}

/** Jobs left 'running' by a crashed/restarted server go back to the queue. */
export function recoverStale() {
  getDb().prepare("UPDATE jobs SET status='queued', updated_at=? WHERE status='running'").run(now());
}

let started = false;
export function startJobLoop(intervalMs = 15_000) {
  if (started) return;
  started = true;
  recoverStale();
  setInterval(() => void tick(), intervalMs).unref?.();
  setTimeout(() => void tick(), 1000);
}
