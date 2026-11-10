import { analyze } from "@/lib/server/voiceScore";
import { json } from "@/lib/server/http";

// Proxy so the PWA only ever talks to its own origin (voice-score is localhost-only).
export async function POST(req: Request) {
  const fd = await req.formData();
  const audio = fd.get("audio");
  if (!(audio instanceof Blob)) return json({ ok: false, reason: "bad-input", error: "audio missing" }, 400);
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(String(fd.get("params") ?? "{}"));
  } catch {
    return json({ ok: false, reason: "bad-input", error: "params not JSON" }, 400);
  }
  const r = await analyze(audio, (audio as File).name || "take.webm", params);
  return json(r, r.ok ? 200 : r.reason === "down" ? 503 : 422);
}
