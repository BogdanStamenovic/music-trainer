#!/usr/bin/env node
// `music-trainer calibrate [--json]`: read-only usage summary from the running server.
const url = process.env.MT_URL || "http://127.0.0.1:3310/api/admin/calibration";
const r = await fetch(url).catch((e) => {
  console.error(`cannot reach ${url}: ${e.message}`);
  process.exit(1);
});
const j = await r.json();
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(j, null, 2));
  process.exit(0);
}
const t = j.totals;
console.log(`music-trainer calibration (${j.generatedAt})`);
console.log(`placement: ${j.placement.finished ? "done" : "not done"}${j.placement.pending.length ? `, pending: ${j.placement.pending.join(", ")}` : ""}`);
console.log(`active days ${t.daysActive} · lessons passed ${t.lessonsPassed} (+${t.lessonsSkippedByPlacement} skipped by placement) · submissions ${t.submissions} · ~${t.minutes} min · abandoned ${t.abandoned} · no-piano days ${t.noPianoDays} · voice-rest days ${t.voiceRestDays}`);
console.log("\npace (actual / estimated minutes, passed lessons):");
for (const [k, v] of Object.entries(j.pace)) console.log(`  ${k}: ${v.lessons} lessons, ${v.actual} / ${v.est} min = x${v.ratio}`);
console.log("\nlessons:");
console.log("  id      status    est  actual  subs  pass%  retries  abandoned  hardest");
for (const l of j.lessons)
  console.log(
    `  ${l.id.padEnd(7)} ${l.status.padEnd(8)} ${String(l.estMin).padStart(4)} ${String(l.actualMin ?? "-").padStart(7)} ${String(l.submissions).padStart(5)} ${String(l.passRate == null ? "-" : Math.round(l.passRate * 100)).padStart(6)} ${String(l.retries).padStart(8)} ${String(l.abandoned).padStart(10)}  ${l.hardest.map((h) => `${h.id}(${h.retries})`).join(" ")}`,
  );
console.log("\ndays:");
for (const d of j.days)
  console.log(`  ${d.date} ${String(d.weekday ?? "").padEnd(3)} ${(d.focus ?? []).join("+").padEnd(6)} ${d.noPiano ? "no-piano " : ""}${d.voiceRest ? `voice-rest(${d.voiceRest}) ` : ""}${d.minutes} min, ${d.submissions} subs, passed ${d.passedThatDay.join(" ") || "-"}`);
if (j.projects.length) {
  console.log("\nprojects:");
  for (const p of j.projects) console.log(`  ${p.week} ${p.project_id} ${p.status} ${p.score == null ? "" : Math.round(p.score * 100) + "%"} ${p.ai_status ?? ""}`);
}
console.log(`\n${j.note}`);
