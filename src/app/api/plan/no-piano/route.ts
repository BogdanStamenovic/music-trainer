import { setNoPiano, todayIn } from "@/lib/server/planner";
import { json, fail } from "@/lib/server/http";

/** {on: boolean, date?} rebuilds that day's plan with or without the "no piano today" override. */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { on?: boolean; date?: string };
    const date = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : todayIn();
    return json({ plan: setNoPiano(date, !!body.on) });
  } catch (e) {
    return fail(e);
  }
}
