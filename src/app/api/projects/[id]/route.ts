import { getProject } from "@/lib/server/projects";
import { json } from "@/lib/server/http";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const p = getProject((await ctx.params).id);
  return p ? json({ project: p }) : json({ error: "not found" }, 404);
}
