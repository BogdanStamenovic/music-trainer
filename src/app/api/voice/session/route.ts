import { voiceSession } from "@/lib/server/voiceSession";
import { getPlan, todayIn } from "@/lib/server/planner";
import { json, fail } from "@/lib/server/http";
export const dynamic = "force-dynamic";
/** Voice session state for a date, plus today's planned V lessons not yet passed (cool-down placement). */
export async function GET(req: Request) {
  try {
    const date = new URL(req.url).searchParams.get("date") || todayIn();
    const plan = getPlan(date);
    const openV = plan.lessons.filter((l) => l.track === "V" && l.status !== "passed").map((l) => l.id);
    return json({ date, ...voiceSession(date), openV });
  } catch (e) {
    return fail(e);
  }
}
