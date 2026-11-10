import { attachBrowserAnalysis } from "@/lib/server/recordings";
import { json, fail } from "@/lib/server/http";

/** Browser fallback (voice-score-lite) result for a recording made while the service was down. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { analysis } = await req.json();
    if (!analysis || !Array.isArray(analysis.notes)) throw new Error("analysis.notes missing");
    attachBrowserAnalysis(id, analysis);
    return json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
