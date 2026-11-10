import fs from "node:fs";
import path from "node:path";

// Runtime config comes from the environment (the systemd unit loads
// ~/.config/music-trainer/env). Defaults are for `npm run dev` in the repo.
export const config = {
  port: Number(process.env.PORT || 3310),
  voiceScoreUrl: (process.env.MT_VOICE_SCORE_URL || "http://127.0.0.1:3311").replace(/\/$/, ""),
  timezone: process.env.MT_TZ || "Europe/Belgrade",
};

/**
 * The data dir must already exist when configured explicitly. Creating it here
 * would silently write the DB onto the root disk when /mnt/windows is not
 * mounted (the mountpoint directory exists either way), which the spec forbids.
 */
export function dataDir(): string {
  const configured = process.env.MT_DATA_DIR;
  if (configured) {
    if (!fs.existsSync(configured)) throw new Error(`MT_DATA_DIR ${configured} does not exist (is its disk mounted?). Refusing to create it.`);
    return configured;
  }
  const dev = path.join(process.cwd(), "data");
  fs.mkdirSync(dev, { recursive: true });
  return dev;
}
