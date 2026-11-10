import { config } from "./config";

// Client for the separate voice-score service (M2, repo voice-score). The trainer
// must keep working when it is down: every call resolves to a typed "down"
// result instead of throwing, and callers fall back to in-browser metrics.

export interface VoiceHealth {
  up: boolean;
  url: string;
  version?: string;
  trackers?: string[];
  error?: string;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function voiceHealth(): Promise<VoiceHealth> {
  const url = config.voiceScoreUrl;
  try {
    const r = await fetchWithTimeout(`${url}/health`, {}, 3000);
    if (!r.ok) return { up: false, url, error: `HTTP ${r.status}` };
    const j = await r.json();
    return { up: !!j.ok, url, version: j.version, trackers: j.trackers };
  } catch (e) {
    return { up: false, url, error: (e as Error).name === "AbortError" ? "timeout" : (e as Error).message };
  }
}

export type AnalyzeResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; reason: "down" | "nothing-voiced" | "bad-input" | "too-large"; error: string };

/** Forward a recording + params to voice-score /analyze. */
export async function analyze(audio: Blob, filename: string, params: Record<string, unknown>): Promise<AnalyzeResult> {
  const fd = new FormData();
  fd.append("audio", audio, filename);
  fd.append("params", JSON.stringify(params));
  try {
    const r = await fetchWithTimeout(`${config.voiceScoreUrl}/analyze`, { method: "POST", body: fd }, 30000);
    const j = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, data: j };
    if (r.status === 422) return { ok: false, reason: "nothing-voiced", error: j.error ?? "nothing voiced" };
    if (r.status === 413) return { ok: false, reason: "too-large", error: j.error ?? "too large" };
    if (r.status === 400) return { ok: false, reason: "bad-input", error: j.error ?? "bad input" };
    return { ok: false, reason: "down", error: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, reason: "down", error: (e as Error).message };
  }
}
