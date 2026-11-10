import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Client for the music21 rule-check worker (worker/, a uv project). The venv lives
// off the root disk (MT_WORKER_VENV, set by the installer); if the worker or uv is
// missing, results come back as "unavailable" and grading falls back to the rubric.

export interface RuleCheck {
  id: string;
  pass: boolean;
  score: number;
  weight: number;
  detail: string;
  bars?: number[];
}
export interface RulesResult {
  ok: true;
  music21?: string;
  parsed?: { voices: number; notes: number; bars: number; key_detected?: string; meter?: string };
  checks: RuleCheck[];
  score: number;
}
export type RulesOutcome = RulesResult | { ok: false; error: string; unavailable?: boolean };

export interface RulesRequest {
  abc: string;
  key: string;
  meter: string;
  bars: number;
  rules: string[];
  range?: [number, number];
}

export function workerDir(): string {
  return process.env.MT_WORKER_DIR || path.join(process.cwd(), "worker");
}

function uvBin(): string | null {
  for (const c of [process.env.MT_UV_BIN, "/usr/bin/uv", "/usr/local/bin/uv", ...(process.env.PATH ?? "").split(":").map((d) => d && path.join(d, "uv"))])
    if (c && fs.existsSync(c)) return c;
  return null;
}

export function runRules(req: RulesRequest, timeoutMs = 90_000): Promise<RulesOutcome> {
  const dir = workerDir();
  if (!fs.existsSync(path.join(dir, "pyproject.toml"))) return Promise.resolve({ ok: false, error: `worker not found at ${dir}`, unavailable: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Preferred: the venv's python directly (synced once by the installer; no uv at request time).
  // Fallback: `uv run --no-sync` (never resolves, downloads or changes the venv per request).
  const venv = process.env.MT_WORKER_VENV;
  const py = venv ? path.join(venv, "bin", "python") : null;
  let cmd: string;
  let args: string[];
  if (py && fs.existsSync(py)) {
    cmd = py;
    args = ["-m", "mtworker", "check"];
  } else {
    const uv = uvBin();
    if (!uv) return Promise.resolve({ ok: false, error: "uv not found and no worker venv", unavailable: true });
    if (venv) env.UV_PROJECT_ENVIRONMENT = venv;
    if (process.env.MT_UV_CACHE) env.UV_CACHE_DIR = process.env.MT_UV_CACHE;
    cmd = uv;
    args = ["run", "--project", dir, "--frozen", "--offline", "--no-sync", "python", "-m", "mtworker", "check"];
  }
  return new Promise((resolve) => {
    // turbopackIgnore: see claude.ts (dynamic executable path)
    const child = spawn(/*turbopackIgnore: true*/ cmd, args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, error: `rule check timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message, unavailable: true });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        if (j.ok) resolve(j as RulesResult);
        else resolve({ ok: false, error: String(j.error ?? "worker error") });
      } catch {
        resolve({ ok: false, error: `worker exit ${code}: ${(err || out).slice(-400)}`, unavailable: code === 127 || /No such file|not found|venv/i.test(err) });
      }
    });
    child.stdin.end(JSON.stringify(req));
  });
}
