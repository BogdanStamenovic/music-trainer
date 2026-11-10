import { voiceRest } from "@/lib/server/recordings";
import { todayIn } from "@/lib/server/planner";
import { json } from "@/lib/server/http";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const date = new URL(req.url).searchParams.get("date") || todayIn();
  return json({ date, rest: voiceRest(date) });
}
