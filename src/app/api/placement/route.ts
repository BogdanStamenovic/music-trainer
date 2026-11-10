import { finishPlacement } from "@/lib/server/progress";
import { resetPlan, todayIn } from "@/lib/server/planner";
import { json, fail } from "@/lib/server/http";

export async function POST(req: Request) {
  try {
    const { results } = (await req.json()) as { results: { exerciseId: string; score: number; pass: boolean }[] };
    const r = finishPlacement(results);
    resetPlan(todayIn());
    return json(r);
  } catch (e) {
    return fail(e);
  }
}
