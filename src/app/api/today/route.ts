import { getPlan, todayIn } from "@/lib/server/planner";
import { getCurriculum } from "@/lib/curriculum/loader";
import { getSettings } from "@/lib/server/settings";
import { placementDone } from "@/lib/server/progress";
import { voiceRest } from "@/lib/server/recordings";
import { json, fail } from "@/lib/server/http";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const date = new URL(req.url).searchParams.get("date") || todayIn();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("bad date");
    const plan = getPlan(date);
    const c = getCurriculum();
    const titles: Record<string, { en: string; sr: string }> = {};
    for (const l of c.lessons) titles[l.id] = l.title;
    return json({ plan, titles, settings: getSettings(), placementDone: placementDone(), voiceRest: voiceRest(date), curriculumErrors: c.errors.length });
  } catch (e) {
    return fail(e, 500);
  }
}
