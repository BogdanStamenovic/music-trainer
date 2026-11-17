import { weekProject, getProject, overdueProject, resolveOverdue } from "@/lib/server/projects";
import { isoWeek, todayIn } from "@/lib/server/planner";
import { placementDone } from "@/lib/server/progress";
import { getSettings } from "@/lib/server/settings";
import { json, fail } from "@/lib/server/http";
export const dynamic = "force-dynamic";

/** This week's project (assigned on first request, after placement). */
export async function GET(req: Request) {
  try {
    const date = new URL(req.url).searchParams.get("date") || todayIn();
    if (!placementDone() && !getSettings().placementSkipped) return json({ project: null, reason: "placement" });
    const od = overdueProject(date);
    if (od) {
      const p = getProject(od.id);
      return json({ project: p, overdue: { id: od.id, fromWeek: od.week }, due: isoWeek(date).sunday });
    }
    const wp = weekProject(date);
    if (!wp) return json({ project: null, reason: "no projects" });
    return json({ project: getProject(wp.row.id), due: isoWeek(date).sunday });
  } catch (e) {
    return fail(e, 500);
  }
}

/** {id, action: "continue" | "skip"} for last week's unfinished project. */
export async function POST(req: Request) {
  try {
    const b = (await req.json()) as { id: string; action: string; date?: string };
    if (b.action !== "continue" && b.action !== "skip") throw new Error("bad action");
    const date = b.date && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : todayIn();
    resolveOverdue(b.id, b.action, date);
    return json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
