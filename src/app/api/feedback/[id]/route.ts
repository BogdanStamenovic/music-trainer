import { getDb } from "@/lib/server/db";
import { json } from "@/lib/server/http";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number((await ctx.params).id);
  const j = getDb().prepare("SELECT status, last_error, result FROM jobs WHERE id = ? AND kind = 'feedback'").get(id) as { status: string; last_error: string | null; result: string | null } | undefined;
  if (!j) return json({ error: "not found" }, 404);
  return json({ status: j.status, error: j.last_error, review: j.result ? JSON.parse(j.result) : null });
}
