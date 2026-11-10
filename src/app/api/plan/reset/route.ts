import { resetPlan, todayIn, getPlan } from "@/lib/server/planner";
import { json, fail } from "@/lib/server/http";
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const date = body.date || todayIn();
    resetPlan(date);
    return json({ plan: getPlan(date) });
  } catch (e) {
    return fail(e);
  }
}
