import fs from "node:fs";
import { getRecording, absPath } from "@/lib/server/recordings";
import { json } from "@/lib/server/http";
export const dynamic = "force-dynamic";

/** Streams a recording; supports Range so the audio element can seek. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const row = getRecording(id);
  if (!row) return json({ error: "not found" }, 404);
  const file = absPath(row);
  if (!fs.existsSync(file)) return json({ error: "file missing" }, 410);
  const size = fs.statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") ?? "");
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    const body = fs.readFileSync(file).subarray(start, end + 1);
    return new Response(body, { status: 206, headers: { "Content-Type": row.mime, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": String(body.length) } });
  }
  return new Response(fs.readFileSync(file), { headers: { "Content-Type": row.mime, "Accept-Ranges": "bytes", "Content-Length": String(size) } });
}
