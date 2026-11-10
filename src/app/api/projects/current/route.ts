import { weekProject, getProject } from "@/lib/server/projects";
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
    const wp = weekProject(date);
    if (!wp) return json({ project: null, reason: "no projects" });
    return json({ project: getProject(wp.row.id), due: isoWeek(date).sunday });
  } catch (e) {
    return fail(e, 500);
  }
}
