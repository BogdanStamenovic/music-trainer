import { findExercise } from "@/lib/server/progress";
import { runRules } from "@/lib/server/rules";
import { parseNote, toMidi } from "@/lib/music/pitch";
import { json, fail } from "@/lib/server/http";

/** Check a draft against a compose exercise's rules before submitting (the learner's feedback loop). */
export async function POST(req: Request) {
  try {
    const { exerciseId, abc } = (await req.json()) as { exerciseId: string; abc: string };
    const f = findExercise(exerciseId);
    if (!f || f.ex.type !== "compose") throw new Error("not a compose exercise");
    const ex = f.ex;
    return json(await runRules({ abc, key: ex.key, meter: ex.meter, bars: ex.bars, rules: ex.rules, range: ex.range ? [toMidi(parseNote(ex.range[0])), toMidi(parseNote(ex.range[1]))] : undefined }));
  } catch (e) {
    return fail(e);
  }
}
