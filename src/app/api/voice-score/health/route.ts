import { voiceHealth } from "@/lib/server/voiceScore";
import { json } from "@/lib/server/http";
export const dynamic = "force-dynamic";
export async function GET() {
  return json(await voiceHealth());
}
