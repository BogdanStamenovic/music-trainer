"use client";
// Recording + analysis with graceful degradation:
//  1. upload to /api/voice/recordings -> server analyzes on voice-score
//  2. voice-score down (or we are offline) -> analyze in the browser with the vendored
//     voice-score-lite (same SwiftF0 model, same metric code), loaded lazily
//  3. offline -> keep the take in IndexedDB and upload it (with the browser analysis) later

import type { VoiceAnalysis } from "../grading";

export interface VoiceParams {
  targets?: ({ midi: number; beats?: number } | { rest: true; beats: number })[];
  tempo_bpm?: number;
  pass_cents?: number;
  octave_agnostic?: boolean;
  contour?: boolean;
}
export interface AnalyzeOutcome {
  recordingId: string;
  analysis: VoiceAnalysis | null;
  source: "server" | "browser" | null;
  reason?: string; // nothing-voiced | down | error text
  queued: boolean;
}

// ---------- microphone ----------
let stream: MediaStream | null = null;
export async function mic(): Promise<MediaStream> {
  if (stream && stream.getTracks().every((t) => t.readyState === "live")) return stream;
  // processing off: echo cancellation / noise suppression / AGC distort pitch and level
  stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  return stream;
}

export interface Take {
  blob: Blob;
  seconds: number;
}

/** Records until stop() or maxSeconds. `onLevel` gets RMS 0..1 about 20x/s for a meter. */
export async function record(maxSeconds: number, onLevel?: (v: number) => void): Promise<{ stop: () => void; done: Promise<Take> }> {
  const s = await mic();
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
  const rec = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const ac = new AudioContext();
  const an = ac.createAnalyser();
  an.fftSize = 1024;
  ac.createMediaStreamSource(s).connect(an);
  const buf = new Float32Array(an.fftSize);
  const meter = window.setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    onLevel?.(Math.min(1, Math.sqrt(sum / buf.length) * 4));
  }, 50);
  const t0 = performance.now();
  const timer = window.setTimeout(() => rec.state === "recording" && rec.stop(), maxSeconds * 1000);
  const done = new Promise<Take>((res) => {
    rec.onstop = () => {
      clearInterval(meter);
      clearTimeout(timer);
      void ac.close();
      res({ blob: new Blob(chunks, { type: (rec.mimeType || "audio/webm").split(";")[0] }), seconds: (performance.now() - t0) / 1000 });
    };
  });
  rec.start(250);
  return { stop: () => rec.state === "recording" && rec.stop(), done };
}

// ---------- browser fallback (voice-score-lite) ----------
type Lite = { analyze: (pcm: Float32Array, params: VoiceParams) => Promise<VoiceAnalysis> };
let litePromise: Promise<{ vs: Lite; decode: (b: Blob) => Promise<Float32Array> }> | null = null;

/**
 * Load onnxruntime-web (WASM build only, served from /ort/) and the vendored lite module.
 * Imported at runtime from public/, not bundled: the files are used exactly as vendored,
 * and the 15 MB WASM is fetched only when the fallback is actually needed.
 */
export function loadLite() {
  if (!litePromise)
    litePromise = (async () => {
      const ort = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "/ort/ort.wasm.min.mjs" as string);
      ort.env.wasm.wasmPaths = "/ort/";
      ort.env.wasm.numThreads = 1; // threads need cross-origin isolation (COOP/COEP); not worth it for 2-15 s takes
      const lite = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "/voice-score/voice-score-lite.mjs" as string);
      const vs = await lite.createAnalyzer({ ort, modelUrl: "/voice-score/swift-f0.onnx" });
      return { vs, decode: lite.decodeToMono16k };
    })().catch((e) => {
      litePromise = null;
      throw e;
    });
  return litePromise;
}

async function analyzeInBrowser(blob: Blob, params: VoiceParams): Promise<{ analysis: VoiceAnalysis | null; reason?: string }> {
  try {
    const { vs, decode } = await loadLite();
    const pcm = await decode(blob);
    return { analysis: await vs.analyze(pcm, { ...params, contour: false }) };
  } catch (e) {
    const status = (e as { status?: number }).status;
    return { analysis: null, reason: status === 422 ? "nothing-voiced" : `browser analysis failed: ${(e as Error).message}` };
  }
}

// ---------- offline upload queue ----------
interface PendingUpload {
  id: string;
  blob: Blob;
  meta: Record<string, unknown>;
  analysis: VoiceAnalysis | null;
}
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open("music-trainer-voice", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("uploads", { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function store<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  return new Promise((res, rej) => {
    const q = f(db.transaction("uploads", mode).objectStore("uploads"));
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}

async function upload(id: string, blob: Blob, meta: Record<string, unknown>) {
  const fd = new FormData();
  fd.append("audio", blob, `${id}.webm`);
  fd.append("meta", JSON.stringify({ ...meta, id }));
  const r = await fetch("/api/voice/recordings", { method: "POST", body: fd });
  if (!r.ok) throw new Error(`upload HTTP ${r.status}`);
  return (await r.json()) as { id: string; analysis: VoiceAnalysis | null; reason: string; source: "server" | "browser" | null };
}

export async function flushUploads(): Promise<number> {
  let left = 0;
  const all = await store("readonly", (s) => s.getAll() as IDBRequest<PendingUpload[]>).catch(() => [] as PendingUpload[]);
  for (const p of all) {
    try {
      await upload(p.id, p.blob, p.meta);
      if (p.analysis) await fetch(`/api/voice/recordings/${p.id}/analysis`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ analysis: p.analysis }) });
      await store("readwrite", (s) => s.delete(p.id));
    } catch {
      left++;
    }
  }
  return left;
}
if (typeof window !== "undefined") window.addEventListener("online", () => void flushUploads());

/** Store + analyze a take. Never throws: degraded paths come back as source/reason. */
export async function analyzeTake(blob: Blob, params: VoiceParams, meta: { date: string; lessonId: string | null; exerciseId: string; itemId: string }): Promise<AnalyzeOutcome> {
  const id = crypto.randomUUID();
  const fullMeta = { ...meta, params: { ...params, contour: false } };
  try {
    const up = await upload(id, blob, fullMeta);
    if (up.analysis) return { recordingId: id, analysis: up.analysis, source: up.source, queued: false };
    if (up.reason !== "down") return { recordingId: id, analysis: null, source: null, reason: up.reason, queued: false };
    // saved on the server, but voice-score is down: analyze here and attach the result
    const b = await analyzeInBrowser(blob, params);
    if (b.analysis) await fetch(`/api/voice/recordings/${id}/analysis`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ analysis: b.analysis }) }).catch(() => {});
    return { recordingId: id, analysis: b.analysis, source: b.analysis ? "browser" : null, reason: b.reason, queued: false };
  } catch {
    // trainer server unreachable: analyze locally, queue the take for upload
    const b = await analyzeInBrowser(blob, params);
    await store("readwrite", (s) => s.put({ id, blob, meta: fullMeta, analysis: b.analysis } satisfies PendingUpload));
    return { recordingId: id, analysis: b.analysis, source: b.analysis ? "browser" : null, reason: b.reason, queued: true };
  }
}
