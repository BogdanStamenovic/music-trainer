import { submit, findExercise, Submission } from "@/lib/server/progress";
import { runRules } from "@/lib/server/rules";
import { generateItems } from "@/lib/curriculum/items";
import { parseNote, toMidi } from "@/lib/music/pitch";
import { json, fail } from "@/lib/server/http";

/**
 * Compose answers are graded from the music21 worker, which is async; run it here,
 * before the (synchronous, transactional) submit. Any client-supplied rules are
 * replaced, so a client cannot grade itself.
 */
async function attachRules(s: Submission) {
  const found = findExercise(s.exerciseId);
  if (!found || found.ex.type !== "compose") return;
  const ex = found.ex;
  const item = generateItems(ex, s.seed)[0];
  for (const r of s.responses) {
    if (r.response.kind !== "compose" || r.itemId !== item.id) continue;
    r.response.rules = await runRules({ abc: r.response.abc, key: ex.key, meter: ex.meter, bars: ex.bars, rules: ex.rules, range: ex.range ? [toMidi(parseNote(ex.range[0])), toMidi(parseNote(ex.range[1]))] : undefined });
  }
}

// Accepts one submission or a batch (offline queue flush). Each is idempotent by uuid.
export async function POST(req: Request) {
  let body: Submission | Submission[];
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const list = Array.isArray(body) ? body : [body];
  const results = [];
  for (const s of list) {
    try {
      await attachRules(s);
      results.push({ uuid: s.uuid, ok: true, result: submit(s) });
    } catch (e) {
      // a permanently bad submission must not block the queue: report it, client drops it
      results.push({ uuid: s?.uuid, ok: false, error: (e as Error).message });
    }
  }
  if (!Array.isArray(body)) {
    const r = results[0];
    return r.ok ? json(r.result) : fail(r.error, 422);
  }
  return json({ results });
}
