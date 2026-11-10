import { getCurriculum } from "@/lib/curriculum/loader";
import { exerciseStates, lessonStatuses } from "@/lib/server/progress";
import { json } from "@/lib/server/http";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const c = getCurriculum();
  if (id === "placement") return c.placement ? json({ placement: c.placement }) : json({ error: "no placement test" }, 404);
  const lesson = c.byId.get(id);
  if (!lesson) return json({ error: `no lesson ${id}` }, 404);
  return json({ lesson, status: lessonStatuses().get(id) ?? null, exercises: exerciseStates(id) });
}
