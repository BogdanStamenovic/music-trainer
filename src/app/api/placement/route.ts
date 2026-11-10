import { finalizePlacement, completePlacementSection, placementStatus } from "@/lib/server/progress";
import { resetPlan, todayIn } from "@/lib/server/planner";
import { json, fail } from "@/lib/server/http";
export const dynamic = "force-dynamic";

export async function GET() {
  return json(placementStatus());
}

/**
 * {finalize: true, deferred: [sectionId...]}  finish placement, deferring some sections
 * {completeSection: id}                        a deferred section was done later
 * {results: [...]}                             old clients: same as finalize with nothing deferred
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { finalize?: boolean; deferred?: string[]; completeSection?: string; results?: unknown };
    const r = body.completeSection ? completePlacementSection(body.completeSection) : finalizePlacement(Array.isArray(body.deferred) ? body.deferred : []);
    resetPlan(todayIn());
    return json(r);
  } catch (e) {
    return fail(e);
  }
}
