import { voiceRest, setVoiceDay } from "@/lib/server/recordings";
import { todayIn } from "@/lib/server/planner";
import { json, fail } from "@/lib/server/http";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const date = new URL(req.url).searchParams.get("date") || todayIn();
  return json({ date, rest: voiceRest(date) });
}
/** Check-in outside a lesson (vocal projects): {state: fine|tired|hoarse, date?}. */
export async function POST(req: Request) {
  try {
    const { state, date } = (await req.json()) as { state: string; date?: string };
    if (!["fine", "tired", "hoarse"].includes(state)) throw new Error("bad state");
    const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayIn();
    setVoiceDay(d, state);
    return json({ date: d, rest: voiceRest(d) });
  } catch (e) {
    return fail(e);
  }
}
