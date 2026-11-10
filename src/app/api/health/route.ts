import { getDb, SCHEMA_VERSION } from "@/lib/server/db";
import { dataDir } from "@/lib/server/config";
import { getCurriculum } from "@/lib/curriculum/loader";
import { json } from "@/lib/server/http";
import pkg from "../../../../package.json";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const v = getDb().pragma("user_version", { simple: true });
    const c = getCurriculum();
    return json({ ok: true, version: pkg.version, schema: v, schemaBuild: SCHEMA_VERSION, dataDir: dataDir(), lessons: c.lessons.length, curriculumErrors: c.errors });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 503);
  }
}
