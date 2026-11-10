import { getDb } from "@/lib/server/db";
import { listProjects, projectDef } from "@/lib/server/projects";
import { json } from "@/lib/server/http";
export const dynamic = "force-dynamic";

/**
 * Grade history: per-track weekly averages (lessons + reviews), weekly test
 * scores, and project grades with their parts.
 */
export async function GET() {
  const db = getDb();
  // week of a date: Monday of that ISO week (SQLite: weekday 0 = Sunday)
  const monday = "date(date, '-' || ((cast(strftime('%w', date) as integer) + 6) % 7) || ' days')";
  const trend = db
    .prepare(`SELECT substr(exercise_id, 1, 1) track, ${monday} week, avg(score) avg, count(*) n FROM attempts WHERE context IN ('lesson','review') GROUP BY track, week ORDER BY week`)
    .all();
  const tests = db.prepare(`SELECT ${monday} week, avg(score) avg, count(*) n, max(date) date FROM attempts WHERE context = 'test' GROUP BY week ORDER BY week`).all();
  const projects = listProjects().map((p) => {
    const d = projectDef(p.project_id);
    return {
      id: p.id,
      week: p.week,
      projectId: p.project_id,
      kind: p.kind,
      title: d?.title ?? null,
      status: p.status,
      score: p.score,
      final: !!p.final,
      aiStatus: p.ai_status,
      parts: p.auto ? JSON.parse(p.auto).parts ?? null : null,
    };
  });
  return json({ trend, tests, projects });
}
