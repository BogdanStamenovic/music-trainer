import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// Real data dir in tmp; curriculum = the repo's (needs V-001 for exercise lookup).
const data = fs.mkdtempSync(path.join(os.tmpdir(), "mt-voice-"));
process.env.MT_DATA_DIR = data;
process.env.MT_CURRICULUM_DIR = path.join(import.meta.dirname, "..", "curriculum");

const { setDb, migrate } = await import("@/lib/server/db");
const { saveRecording, getRecording, attachBrowserAnalysis, voiceRest, absPath } = await import("@/lib/server/recordings");
const { voiceHealth } = await import("@/lib/server/voiceScore");
const { submit } = await import("@/lib/server/progress");
const { getSettings } = await import("@/lib/server/settings");
const { generateItems } = await import("@/lib/curriculum/items");
const { loadCurriculum } = await import("@/lib/curriculum/loader");

/** 16-bit mono WAV of a sine (with light vibrato-free envelope). */
function wav(freq: number, seconds: number, sr = 16000): Blob {
  const n = Math.floor(seconds * sr);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / (0.05 * sr), (n - i) / (0.05 * sr));
    // a few harmonics so it is voice-like enough for the tracker
    const t = i / sr;
    const v = 0.5 * Math.sin(2 * Math.PI * freq * t) + 0.25 * Math.sin(4 * Math.PI * freq * t) + 0.12 * Math.sin(6 * Math.PI * freq * t);
    b.writeInt16LE(Math.round(env * v * 0.6 * 32767), 44 + i * 2);
  }
  return new Blob([b], { type: "audio/wav" });
}

beforeAll(() => {
  const conn = new Database(":memory:");
  const m = migrate(conn, data);
  setDb(conn);
  const t = (conn.prepare("select group_concat(name) n from sqlite_master where type='table'").get() as { n: string }).n;
  if (!t.includes("recordings")) throw new Error(`migrate ${JSON.stringify(m)} tables ${t}`);
});

const c = loadCurriculum(process.env.MT_CURRICULUM_DIR!);
const pitchEx = c.byId.get("V-001")!.exercises.find((e) => e.type === "generated")!;

describe("voice: recordings, grading, safety", async () => {
  const up = (await voiceHealth()).up;

  it.skipIf(!up)("real voice-score: a sung (synth) target is stored on the data disk, analyzed and graded", async () => {
    const [item] = generateItems(pitchEx, "seed", 1, { voiceRange: [55, 60] });
    if (item.kind !== "sing") throw new Error("expected sing item");
    const hz = 440 * Math.pow(2, (item.targets[0] - 69) / 12);
    const { row, analysis, reason } = await saveRecording(
      { id: "rec-test-0001", date: "2026-11-11", lessonId: "V-001", exerciseId: pitchEx.id, itemId: item.id, params: { targets: [{ midi: item.targets[0] }], pass_cents: 50 } },
      wav(hz, 3),
    );
    expect(reason).toBe("analyzed");
    expect(fs.existsSync(absPath(row))).toBe(true);
    expect(absPath(row).startsWith(data)).toBe(true);
    expect(analysis?.notes[0].cents_error).not.toBeNull();
    expect(Math.abs(analysis!.notes[0].cents_error!)).toBeLessThan(20);
    const r = submit({ uuid: "s-1", date: "2026-11-11", context: "lesson", lessonId: "V-001", exerciseId: pitchEx.id, seed: "seed", count: 1, ctx: { voiceRange: [55, 60] },
      responses: [{ itemId: item.id, response: { kind: "sing", recordingId: row.id, analysis: null } }] });
    expect(r.items[0].score).toBe(1);
  });

  it.skipIf(!up)("off-pitch (a semitone sharp) fails", async () => {
    const [item] = generateItems(pitchEx, "seed2", 1, { voiceRange: [55, 60] });
    if (item.kind !== "sing") throw new Error();
    const hz = 440 * Math.pow(2, (item.targets[0] + 1 - 69) / 12);
    const { row } = await saveRecording({ id: "rec-test-0002", date: "2026-11-11", lessonId: "V-001", exerciseId: pitchEx.id, itemId: item.id, params: { targets: [{ midi: item.targets[0] }], pass_cents: 50 } }, wav(hz, 3));
    const r = submit({ uuid: "s-2", date: "2026-11-11", context: "lesson", lessonId: "V-001", exerciseId: pitchEx.id, seed: "seed2", count: 1, ctx: { voiceRange: [55, 60] },
      responses: [{ itemId: item.id, response: { kind: "sing", recordingId: row.id, analysis: null } }] });
    expect(r.items[0].score).toBeLessThan(0.5);
  });

  it("voice-score down: recording kept pending, browser analysis attached and used for grading", async () => {
    const old = process.env.MT_VOICE_SCORE_URL;
    const { config } = await import("@/lib/server/config");
    const prev = config.voiceScoreUrl;
    config.voiceScoreUrl = "http://127.0.0.1:9"; // nothing listens there
    const [item] = generateItems(pitchEx, "seed3", 1, {});
    if (item.kind !== "sing") throw new Error();
    const { row, reason } = await saveRecording({ id: "rec-test-0003", date: "2026-11-11", lessonId: "V-001", exerciseId: pitchEx.id, itemId: item.id, params: {} }, wav(220, 2));
    expect(reason).toBe("down");
    expect(getRecording(row.id)!.status).toBe("pending");
    attachBrowserAnalysis(row.id, { tracker: "swiftf0-web", notes: [{ index: 0, target_midi: item.targets[0], cents_error: 12, sustain_s: 2.5 }] });
    const r = submit({ uuid: "s-3", date: "2026-11-11", context: "lesson", lessonId: "V-001", exerciseId: pitchEx.id, seed: "seed3", count: 1,
      responses: [{ itemId: item.id, response: { kind: "sing", recordingId: row.id, analysis: null } }] });
    expect(r.items[0].score).toBe(1);
    config.voiceScoreUrl = prev;
    process.env.MT_VOICE_SCORE_URL = old;
  });

  it("check-in 'hoarse' makes the day a voice-rest day; a later 'fine' does not undo it", () => {
    const ck = c.byId.get("V-001")!.exercises[0];
    submit({ uuid: "c-1", date: "2026-11-12", context: "lesson", lessonId: "V-001", exerciseId: ck.id, seed: "x", responses: [{ itemId: `${ck.id}#0`, response: { kind: "checkin", state: "hoarse" } }] });
    expect(voiceRest("2026-11-12")).toBe("hoarse");
    submit({ uuid: "c-2", date: "2026-11-12", context: "lesson", lessonId: "V-001", exerciseId: ck.id, seed: "x", responses: [{ itemId: `${ck.id}#0`, response: { kind: "checkin", state: "fine" } }] });
    expect(voiceRest("2026-11-12")).toBe("hoarse");
    expect(voiceRest("2026-11-13")).toBeNull();
  });

  it("recording ids are validated (no path tricks)", async () => {
    await expect(saveRecording({ id: "../../etc", date: "2026-11-11", lessonId: null, exerciseId: "x", itemId: "x", params: {} }, wav(220, 0.5))).rejects.toThrow(/bad recording id/);
  });

  it("settings start with no range and sharing off", () => {
    expect(getSettings().voiceRange).toBeNull();
    expect(getSettings().shareRecordings).toBe(false);
  });
});
