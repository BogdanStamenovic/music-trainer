import { getDb } from "./db";
import { getSettings } from "./settings";

// A singing session (Bogdan, 2026-11-13: "I do the first one and immediately after one
// lesson start the next. So warming up is a waste of time then"): the warm-up runs once,
// stays valid while voice work continues (window since the last voice activity), and one
// cool-down closes the session. Built from the events table, so it needs no state of its own.

export interface VoiceSession {
  warm: boolean; // a warm-up is still valid now
  warmAt: number | null;
  lastVoiceAt: number | null;
  cooledAt: number | null;
  needsCooldown: boolean; // voice work today that no cool-down has closed yet
  windowMinutes: number;
}

export function voiceSession(date: string, nowMs = Date.now(), windowMinutes = getSettings().voiceSessionMinutes): VoiceSession {
  const ev = getDb()
    .prepare("SELECT at, kind, lesson_id FROM events WHERE date = ? AND kind IN ('voice_warmup', 'voice_cooldown', 'exercise_done') ORDER BY at")
    .all(date) as { at: number; kind: string; lesson_id: string | null }[];
  let warmAt: number | null = null;
  let cooledAt: number | null = null;
  let lastVoiceAt: number | null = null;
  for (const e of ev) {
    if (e.kind === "voice_warmup") warmAt = lastVoiceAt = e.at;
    else if (e.kind === "voice_cooldown") cooledAt = e.at;
    else if (e.lesson_id?.startsWith("V-")) lastVoiceAt = e.at;
  }
  const warm = warmAt !== null && lastVoiceAt !== null && nowMs - lastVoiceAt <= windowMinutes * 60_000 && (cooledAt === null || cooledAt < warmAt);
  const needsCooldown = lastVoiceAt !== null && (cooledAt === null || cooledAt < lastVoiceAt);
  return { warm, warmAt, lastVoiceAt, cooledAt, needsCooldown, windowMinutes };
}
