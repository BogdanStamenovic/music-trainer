import { listRecordings, absPath, publicRow } from "@/lib/server/recordings";
import { getSettings } from "@/lib/server/settings";
import { json } from "@/lib/server/http";
export const dynamic = "force-dynamic";

/**
 * For voice-score's validation: the learner's FIRST recordings (oldest first), with
 * absolute file paths on this machine, the targets sent, and both analyses.
 * Only while the learner has consented in Settings (shareRecordings).
 */
export async function GET(req: Request) {
  const s = getSettings();
  if (!s.shareRecordings) return json({ error: "no consent: the learner has not allowed sharing recordings (Settings > Voice)" }, 403);
  const limit = Math.min(500, Number(new URL(req.url).searchParams.get("limit") ?? 100));
  const rows = listRecordings(limit, 0, true);
  return json({ consentAt: s.shareConsentAt, voiceRange: s.voiceRange, recordings: rows.map((r) => ({ ...publicRow(r), path: absPath(r) })) });
}
