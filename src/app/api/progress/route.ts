import { getDb } from "@/lib/server/db";
import { getCurriculum } from "@/lib/curriculum/loader";
import { lessonStatuses } from "@/lib/server/progress";
import { json } from "@/lib/server/http";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  const c = getCurriculum();
  const st = lessonStatuses();
  const lessons = c.lessons
    .filter((l) => !l.tags.includes("maintenance"))
    .map((l) => ({ id: l.id, track: l.track, order: l.order, title: l.title, status: st.get(l.id)?.status ?? "new", score: st.get(l.id)?.score ?? null, source: st.get(l.id)?.source ?? null }));
  const daily = db
    .prepare("SELECT date, context, count(*) n, avg(score) avg FROM attempts GROUP BY date, context ORDER BY date DESC LIMIT 120")
    .all();
  const byTrack = db
    .prepare("SELECT substr(exercise_id,1,1) track, date, avg(score) avg, count(*) n FROM attempts WHERE context != 'placement' GROUP BY track, date ORDER BY date")
    .all();
  const srs = db.prepare("SELECT count(*) total, sum(due <= date('now')) due FROM srs").get();
  const placement = db.prepare("SELECT taken_at, result FROM placement_results ORDER BY id DESC LIMIT 1").get() as { taken_at: number; result: string } | undefined;
  return json({ lessons, daily, byTrack, srs, placement: placement ? { takenAt: placement.taken_at, ...JSON.parse(placement.result) } : null });
}
