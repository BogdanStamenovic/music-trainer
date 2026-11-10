"use client";
// Offline submission queue in IndexedDB. Every submission is tried online first;
// if the server is unreachable it is queued and flushed later (on load, on the
// `online` event, every 60 s). The server dedupes by uuid, so resending is safe.

import type { Submission, SubmissionResult } from "../server/progress";

const DB = "music-trainer";
const STORE = "queue";

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "uuid" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = f(t.objectStore(STORE));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function queued(): Promise<Submission[]> {
  return tx("readonly", (s) => s.getAll() as IDBRequest<Submission[]>);
}

export async function send(sub: Submission): Promise<{ result: SubmissionResult | null; queued: boolean; error?: string }> {
  try {
    const r = await fetch("/api/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub) });
    if (r.ok) return { result: await r.json(), queued: false };
    if (r.status === 422) return { result: null, queued: false, error: (await r.json()).error };
    throw new Error(`HTTP ${r.status}`);
  } catch {
    await tx("readwrite", (s) => s.put(sub));
    notify();
    return { result: null, queued: true };
  }
}

export async function flush(): Promise<number> {
  const items = await queued().catch(() => []);
  if (!items.length) return 0;
  try {
    const r = await fetch("/api/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(items) });
    if (!r.ok) return items.length;
    const { results } = (await r.json()) as { results: { uuid: string; ok: boolean }[] };
    // drop both successes and permanent failures; keep nothing that would loop forever
    for (const x of results) await tx("readwrite", (s) => s.delete(x.uuid));
    notify();
    return 0;
  } catch {
    return items.length;
  }
}

const subs = new Set<() => void>();
function notify() {
  subs.forEach((f) => f());
}
export function onQueueChange(f: () => void) {
  subs.add(f);
  return () => subs.delete(f);
}

let started = false;
export function startSync() {
  if (started || typeof window === "undefined") return;
  started = true;
  void flush();
  window.addEventListener("online", () => void flush());
  setInterval(() => void flush(), 60000);
}
