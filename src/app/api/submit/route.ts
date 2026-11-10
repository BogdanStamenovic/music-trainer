import { submit, Submission } from "@/lib/server/progress";
import { json, fail } from "@/lib/server/http";

// Accepts one submission or a batch (offline queue flush). Each is idempotent by uuid.
export async function POST(req: Request) {
  let body: Submission | Submission[];
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const list = Array.isArray(body) ? body : [body];
  const results = list.map((s) => {
    try {
      return { uuid: s.uuid, ok: true, result: submit(s) };
    } catch (e) {
      // a permanently bad submission must not block the queue: report it, client drops it
      return { uuid: s?.uuid, ok: false, error: (e as Error).message };
    }
  });
  if (!Array.isArray(body)) {
    const r = results[0];
    return r.ok ? json(r.result) : fail(r.error, 422);
  }
  return json({ results });
}
