import { NextResponse } from "next/server";
export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
export function fail(e: unknown, status = 400) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("[api]", msg);
  return json({ error: msg }, status);
}
