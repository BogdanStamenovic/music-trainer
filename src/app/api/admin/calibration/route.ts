import { calibration } from "@/lib/server/calibration";
import { json } from "@/lib/server/http";
export const dynamic = "force-dynamic";
/** Read-only calibration summary (curriculum pace, pass rates, abandoned work, days). */
export async function GET() {
  return json(calibration());
}
