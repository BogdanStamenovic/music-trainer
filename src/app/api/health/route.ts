import { getDb, SCHEMA_VERSION } from "@/lib/server/db";
import { dataDir } from "@/lib/server/config";
import { getCurriculum } from "@/lib/curriculum/loader";
import { json } from "@/lib/server/http";
import pkg from "../../../../package.json";
import { claudeBin } from "@/lib/server/claude";
import fs from "node:fs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const v = getDb().pragma("user_version", { simple: true });
    const c = getCurriculum();
    const venv = process.env.MT_WORKER_VENV;
    return json({
      ok: true,
      version: pkg.version,
      schema: v,
      schemaBuild: SCHEMA_VERSION,
      dataDir: dataDir(),
      lessons: c.lessons.length,
      projects: c.projects.length,
      curriculumErrors: c.errors,
      reviewer: claudeBin() ? "claude CLI found" : "unavailable",
      ruleWorker: venv && fs.existsSync(`${venv}/bin/python`) ? venv : "unavailable",
    });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 503);
  }
}
