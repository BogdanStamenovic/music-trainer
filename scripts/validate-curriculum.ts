import { loadCurriculum } from "../src/lib/curriculum/loader";
const c = loadCurriculum();
const byTrack: Record<string, number> = {};
for (const l of c.lessons) byTrack[l.track] = (byTrack[l.track] ?? 0) + 1;
console.log(`lessons: ${c.lessons.length} ${JSON.stringify(byTrack)}; placement: ${c.placement ? "yes" : "no"}`);
if (c.errors.length) {
  console.error(c.errors.join("\n"));
  process.exit(1);
}
console.log("curriculum OK");
