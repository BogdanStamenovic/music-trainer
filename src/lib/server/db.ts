import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config";

// Migrations are forward-only and ADDITIVE (new tables/columns, never drop or
// rename). `ownbox rollback` runs an older build against a DB that may already
// be migrated forward; additive changes keep that safe. A DB newer than this
// build is opened as-is with a warning instead of failing.
const MIGRATIONS: string[] = [
  // 1
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE day_plans (date TEXT PRIMARY KEY, plan TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE lesson_progress (lesson_id TEXT PRIMARY KEY, status TEXT NOT NULL, score REAL, source TEXT NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE exercise_state (exercise_id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL, best REAL NOT NULL, last REAL NOT NULL,
     passed INTEGER NOT NULL, attempts INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE attempts (id INTEGER PRIMARY KEY, uuid TEXT NOT NULL, date TEXT NOT NULL, context TEXT NOT NULL,
     lesson_id TEXT, exercise_id TEXT NOT NULL, item_id TEXT NOT NULL, seed TEXT NOT NULL, response TEXT NOT NULL,
     score REAL NOT NULL, detail TEXT NOT NULL, client_score REAL, created_at INTEGER NOT NULL);
   CREATE UNIQUE INDEX attempts_uuid_item ON attempts(uuid, item_id);
   CREATE INDEX attempts_date ON attempts(date);
   CREATE TABLE srs (exercise_id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL, ease REAL NOT NULL, interval INTEGER NOT NULL,
     reps INTEGER NOT NULL, lapses INTEGER NOT NULL, due TEXT NOT NULL, last_score REAL, updated_at INTEGER NOT NULL);
   CREATE TABLE placement_results (id INTEGER PRIMARY KEY, taken_at INTEGER NOT NULL, result TEXT NOT NULL);
   CREATE TABLE submissions (uuid TEXT PRIMARY KEY, received_at INTEGER NOT NULL, result TEXT NOT NULL);`,
  // 2: voice recordings (files live in <data>/recordings) and per-day voice rest
  `CREATE TABLE recordings (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, date TEXT NOT NULL, lesson_id TEXT,
     exercise_id TEXT NOT NULL, item_id TEXT NOT NULL, file TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
     params TEXT NOT NULL, server_analysis TEXT, browser_analysis TEXT, status TEXT NOT NULL, error TEXT);
   CREATE INDEX recordings_created ON recordings(created_at);
   CREATE TABLE voice_days (date TEXT PRIMARY KEY, state TEXT NOT NULL, at INTEGER NOT NULL);`,
  // 3: weekly projects and the background job queue (claude -p reviews)
  `CREATE TABLE projects (id TEXT PRIMARY KEY, week TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL,
     assigned_at INTEGER NOT NULL, status TEXT NOT NULL, locale TEXT, submission TEXT, submitted_at INTEGER,
     auto TEXT, self TEXT, ai TEXT, ai_status TEXT, score REAL, final INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
   CREATE UNIQUE INDEX projects_week ON projects(week);
   CREATE TABLE jobs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref_id TEXT NOT NULL, payload TEXT NOT NULL,
     status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, result TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_run_at INTEGER NOT NULL);
   CREATE INDEX jobs_due ON jobs(status, next_run_at);`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

let db: Database.Database | null = null;

function backup(conn: Database.Database, dir: string, from: number) {
  const bdir = path.join(dir, "backups");
  fs.mkdirSync(bdir, { recursive: true });
  const file = path.join(bdir, `trainer-v${from}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  conn.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = fs.readdirSync(bdir).filter((f) => f.startsWith("trainer-")).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 10))) fs.unlinkSync(path.join(bdir, f));
  return file;
}

/** Apply pending migrations (backing up first). Exported for the CLI/update path. */
export function migrate(conn: Database.Database, dir: string): { from: number; to: number; backup?: string } {
  const from = conn.pragma("user_version", { simple: true }) as number;
  if (from > SCHEMA_VERSION) {
    console.warn(`[db] schema v${from} is newer than this build (v${SCHEMA_VERSION}); running without migrating`);
    return { from, to: from };
  }
  if (from === SCHEMA_VERSION) return { from, to: from };
  const bk = from > 0 ? backup(conn, dir, from) : undefined;
  for (let v = from; v < SCHEMA_VERSION; v++) {
    conn.transaction(() => {
      conn.exec(MIGRATIONS[v]);
      conn.pragma(`user_version = ${v + 1}`);
    })();
  }
  return { from, to: SCHEMA_VERSION, backup: bk };
}

export function openDb(dir = dataDir()): Database.Database {
  const conn = new Database(path.join(dir, "trainer.db"));
  conn.pragma("journal_mode = WAL");
  conn.pragma("busy_timeout = 5000");
  conn.pragma("foreign_keys = ON");
  const r = migrate(conn, dir);
  if (r.from !== r.to) console.log(`[db] migrated v${r.from} -> v${r.to}${r.backup ? ` (backup ${r.backup})` : ""}`);
  return conn;
}

export function getDb(): Database.Database {
  if (!db) db = openDb();
  return db;
}

/** For tests: use a specific connection. */
export function setDb(conn: Database.Database | null) {
  db = conn;
}

export const now = () => Date.now();
