import { saveRecording, listRecordings, reanalyzePending, publicRow } from "@/lib/server/recordings";
import { json, fail } from "@/lib/server/http";
export const dynamic = "force-dynamic";

/** Upload: multipart {audio, meta(JSON)}. Returns the analysis, or reason "down" so the client falls back. */
export async function POST(req: Request) {
  try {
    const fd = await req.formData();
    const audio = fd.get("audio");
    if (!(audio instanceof Blob)) return json({ error: "audio missing" }, 400);
    const meta = JSON.parse(String(fd.get("meta") ?? "{}"));
    const { row, analysis, reason } = await saveRecording(meta, audio);
    return json({ id: row.id, analysis, reason, source: row.server_analysis ? "server" : row.browser_analysis ? "browser" : null });
  } catch (e) {
    return fail(e);
  }
}

/** History, newest first. Also opportunistically re-analyzes takes made while voice-score was down. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const limit = Math.min(200, Number(u.searchParams.get("limit") ?? 50));
  const offset = Number(u.searchParams.get("offset") ?? 0);
  const reanalyzed = await reanalyzePending(3).catch(() => 0);
  return json({ recordings: listRecordings(limit, offset).map(publicRow), reanalyzed });
}
