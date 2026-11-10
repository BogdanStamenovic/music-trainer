import { getSettings, updateSettings } from "@/lib/server/settings";
import { json, fail } from "@/lib/server/http";
export const dynamic = "force-dynamic";
export async function GET() {
  return json(getSettings());
}
export async function PUT(req: Request) {
  try {
    return json(updateSettings(await req.json()));
  } catch (e) {
    return fail(e);
  }
}
