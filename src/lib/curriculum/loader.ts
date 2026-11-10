import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { Lesson, Placement, Project } from "./schema";
import { validateLessons, validatePlacement, validateProjects } from "./validate";

export interface Curriculum {
  lessons: Lesson[];
  byId: Map<string, Lesson>;
  placement: Placement | null;
  projects: Project[];
  errors: string[];
  loadedAt: number;
}

export function curriculumDir(): string {
  return process.env.MT_CURRICULUM_DIR || path.join(process.cwd(), "curriculum");
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ya?ml|json)$/.test(e.name) ? [p] : [];
  });
}

/**
 * Load and validate every lesson file. Invalid files are reported in `errors`
 * and left out, so one bad lesson does not take the whole course down.
 */
export function loadCurriculum(dir = curriculumDir()): Curriculum {
  const errors: string[] = [];
  const lessons: Lesson[] = [];
  let placement: Placement | null = null;
  const projects: Project[] = [];
  for (const file of walk(dir).sort()) {
    const rel = path.relative(dir, file);
    if (path.basename(file).startsWith("_")) continue;
    let raw: unknown;
    try {
      raw = YAML.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      errors.push(`${rel}: YAML: ${(e as Error).message}`);
      continue;
    }
    if (path.basename(file).startsWith("placement.")) {
      const r = Placement.safeParse(raw);
      if (r.success) placement = r.data;
      else errors.push(`${rel}: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      continue;
    }
    if (rel.split(path.sep)[0] === "projects") {
      const r = Project.safeParse(raw);
      if (r.success) projects.push(r.data);
      else errors.push(`${rel}: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      continue;
    }
    const r = Lesson.safeParse(raw);
    if (r.success) lessons.push(r.data);
    else errors.push(`${rel}: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  errors.push(...validateLessons(lessons));
  if (placement) errors.push(...validatePlacement(placement, new Set(lessons.map((l) => l.id))));
  errors.push(...validateProjects(projects, new Set(lessons.map((l) => l.id))));
  lessons.sort((a, b) => a.track.localeCompare(b.track) || a.order - b.order);
  projects.sort((a, b) => a.kind.localeCompare(b.kind) || a.order - b.order);
  return { lessons, byId: new Map(lessons.map((l) => [l.id, l])), placement, projects, errors, loadedAt: Date.now() };
}

let cache: { c: Curriculum; stamp: string } | null = null;

function stampOf(dir: string): string {
  return walk(dir)
    .map((f) => `${f}:${fs.statSync(f).mtimeMs}`)
    .join("|");
}

/** Cached loader; reloads when any curriculum file changes (cheap stat walk). */
export function getCurriculum(): Curriculum {
  const dir = curriculumDir();
  const stamp = stampOf(dir);
  if (!cache || cache.stamp !== stamp) {
    cache = { c: loadCurriculum(dir), stamp };
    if (cache.c.errors.length) console.error(`[curriculum] ${cache.c.errors.length} problem(s):\n  ` + cache.c.errors.join("\n  "));
  }
  return cache.c;
}
