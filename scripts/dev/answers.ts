// Dev/E2E helper: print the items (with correct answers) the UI will generate
// for an exercise and seed. Usage: tsx scripts/dev/answers.ts <exerciseId> <seed> [count] [ctx JSON]
import { loadCurriculum } from "../../src/lib/curriculum/loader";
import { generateItems } from "../../src/lib/curriculum/items";
const [exId, seed, count, ctxJson] = process.argv.slice(2);
const c = loadCurriculum();
const ex = [...c.lessons.flatMap((l) => l.exercises), ...(c.placement?.sections.flatMap((s) => s.exercises) ?? [])].find((e) => e.id === exId);
if (!ex) throw new Error(`no exercise ${exId}`);
const items = generateItems(ex, seed, count ? Number(count) : undefined, ctxJson ? JSON.parse(ctxJson) : {}).map((it) => {
  let playSec = 0;
  if (it.play) {
    const beat = 60 / it.play.tempo;
    playSec = it.play.mode === "harmonic" ? beat * 2 : it.play.mode === "chords" ? (it.play.chords?.length ?? 0) * beat * 1.5 : (it.play.notes?.length ?? 0) * beat;
  }
  return { ...it, playSec };
});
console.log(JSON.stringify({ exercise: { id: ex.id, type: ex.type, pass: ex.pass }, items }));
