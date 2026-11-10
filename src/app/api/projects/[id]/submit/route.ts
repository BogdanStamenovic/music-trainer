import { submitProject, type SubmissionBody } from "@/lib/server/projects";
import { json, fail } from "@/lib/server/http";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const body = (await req.json()) as SubmissionBody;
    return json({ project: await submitProject((await ctx.params).id, body) });
  } catch (e) {
    return fail(e);
  }
}
