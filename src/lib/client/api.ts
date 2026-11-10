"use client";
// GET with a localStorage fallback: the service worker caches responses too, but
// keeping the last good copy here makes the day's lesson work offline even if
// the SW was not installed yet when it was first loaded.
export async function getJson<T>(url: string): Promise<{ data: T; stale: boolean }> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()) as T;
    try {
      localStorage.setItem(`cache:${url}`, JSON.stringify(data));
    } catch {}
    return { data, stale: false };
  } catch (e) {
    const c = typeof localStorage !== "undefined" ? localStorage.getItem(`cache:${url}`) : null;
    if (c) return { data: JSON.parse(c) as T, stale: true };
    throw e;
  }
}
