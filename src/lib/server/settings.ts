import { getDb } from "./db";
import type { Track } from "../curriculum/schema";

export type Focus = Track | "test" | "rest";
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export interface Settings {
  locale: "en" | "sr";
  schedule: Record<Weekday, Focus[]>;
  focusMinutes: number; // target for the focus block, clamped 25..50
  maintenance: boolean; // daily <=10 min SRS review + vocal warm-up
  reviewLimit: number; // max review exercises per day
  placementSkipped: boolean;
  playback: "auto" | "midi" | "webaudio";
  midiIn: string | null; // input id, null = all inputs
  midiOut: string | null;
}

// Default weekly schedule from Bogdan (2026-11-10, relayed by manager-15).
export const DEFAULTS: Settings = {
  locale: "en",
  schedule: { mon: ["T"], tue: ["E", "K"], wed: ["V"], thu: ["T"], fri: ["E", "K"], sat: ["V", "C", "L"], sun: ["test"] },
  focusMinutes: 35,
  maintenance: true,
  reviewLimit: 6,
  placementSkipped: false,
  playback: "auto",
  midiIn: null,
  midiOut: null,
};

export function getSettings(): Settings {
  const rows = getDb().prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const s: Record<string, unknown> = { ...DEFAULTS };
  for (const r of rows) if (r.key in DEFAULTS) s[r.key] = JSON.parse(r.value);
  return s as unknown as Settings;
}

const TRACKS = new Set(["T", "E", "K", "V", "C", "L", "test", "rest"]);

/** Validate and store a partial update; unknown keys and bad values are rejected. */
export function updateSettings(patch: Partial<Settings>): Settings {
  const clean: Partial<Settings> = {};
  if (patch.locale === "en" || patch.locale === "sr") clean.locale = patch.locale;
  if (patch.schedule) {
    const sch = {} as Record<Weekday, Focus[]>;
    for (const d of WEEKDAYS) {
      const v = patch.schedule[d];
      if (!Array.isArray(v) || v.length === 0 || !v.every((x) => TRACKS.has(x))) throw new Error(`bad schedule for ${d}`);
      sch[d] = v;
    }
    clean.schedule = sch;
  }
  if (typeof patch.focusMinutes === "number") clean.focusMinutes = Math.max(25, Math.min(50, Math.round(patch.focusMinutes)));
  if (typeof patch.maintenance === "boolean") clean.maintenance = patch.maintenance;
  if (typeof patch.reviewLimit === "number") clean.reviewLimit = Math.max(0, Math.min(20, Math.round(patch.reviewLimit)));
  if (typeof patch.placementSkipped === "boolean") clean.placementSkipped = patch.placementSkipped;
  if (patch.playback && ["auto", "midi", "webaudio"].includes(patch.playback)) clean.playback = patch.playback;
  if (patch.midiIn !== undefined) clean.midiIn = patch.midiIn;
  if (patch.midiOut !== undefined) clean.midiOut = patch.midiOut;
  const st = getDb().prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [k, v] of Object.entries(clean)) st.run(k, JSON.stringify(v));
  return getSettings();
}
