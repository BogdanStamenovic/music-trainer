"use client";
// Web MIDI in/out. Input: all inputs or a selected one; note on/off, velocity,
// sustain pedal (CC64), timestamps in the performance.now() domain.
// Output: send playback to the piano (Arius) when available, else Web Audio.

import { synthNote, unlockAudio } from "./audio";
import type { MidiEvent } from "../grading";
import type { PlaySpec } from "../curriculum/items";

type Listener = (e: MidiEvent) => void;
const THRU = /through|thru/i;
export interface Port {
  id: string;
  name: string;
  /** Web MIDI connection: "open" | "pending" | "closed". */
  connection?: string;
}

export class MidiManager {
  access: MIDIAccess | null = null;
  status: "unsupported" | "pending" | "denied" | "ready" = "pending";
  inputs: Port[] = [];
  outputs: Port[] = [];
  inputId: string | null = null;
  outputId: string | null = null;
  playback: "auto" | "midi" | "webaudio" = "auto";
  held = new Set<number>();
  private listeners = new Set<Listener>();
  private changeListeners = new Set<() => void>();
  private muteUntil = 0; // ignore echo from the piano while we are playing to it
  private timers: number[] = [];
  /** performance.now() of the last message from hardware (or an on-screen key); 0 = none yet. */
  lastActivity = 0;
  private pedalDown = false;
  /** Exercises waiting for MIDI input: start time of the oldest open one, for the "nothing arrives" hint. */
  private expecting = 0;
  expectSince = 0;
  private reopenTimer: number | null = null;
  private openTried = new Map<string, number>();

  async init() {
    if (typeof navigator === "undefined" || !("requestMIDIAccess" in navigator)) {
      this.status = "unsupported";
      this.emitChange();
      return;
    }
    try {
      this.bind(await navigator.requestMIDIAccess({ sysex: false }));
    } catch {
      this.status = "denied";
      this.emitChange();
    }
  }

  private bind(access: MIDIAccess) {
    if (this.access && this.access !== access) {
      this.access.onstatechange = null;
      for (const inp of this.access.inputs.values()) inp.onmidimessage = null;
    }
    this.access = access;
    this.status = "ready";
    access.onstatechange = () => this.refresh();
    this.refresh();
  }

  /**
   * Drop the current MIDIAccess, ask for a new one and rebind every input.
   * ALSA rawmidi is exclusive: if another process held the port when Chrome
   * opened it, Chrome's input stays silent until the port is reopened. Called
   * when the user taps the MIDI indicator.
   */
  async reconnect() {
    if (typeof navigator === "undefined" || !("requestMIDIAccess" in navigator)) return;
    if (this.access) {
      for (const inp of this.access.inputs.values()) {
        inp.onmidimessage = null;
        try {
          await inp.close();
        } catch {
          /* already closed */
        }
      }
    }
    this.held.clear();
    this.pedalDown = false;
    this.openTried.clear();
    this.status = "pending";
    this.emitChange();
    try {
      this.bind(await navigator.requestMIDIAccess({ sysex: false }));
    } catch {
      this.status = "denied";
      this.emitChange();
    }
  }

  private refresh() {
    if (!this.access) return;
    const ins = [...this.access.inputs.values()];
    this.inputs = ins.map((p) => ({ id: p.id, name: p.name ?? p.id, connection: p.connection }));
    this.outputs = [...this.access.outputs.values()].map((p) => ({ id: p.id, name: p.name ?? p.id, connection: p.connection }));
    for (const inp of ins) {
      inp.onmidimessage = (m) => this.onMessage(inp.id, m);
      // A present device whose connection did not open (port busy, replugged):
      // open it explicitly and keep retrying until it does.
      // Throttled: open() itself fires statechange, which lands back here.
      const now = Date.now();
      if (inp.state === "connected" && inp.connection !== "open" && now - (this.openTried.get(inp.id) ?? 0) > 2000) {
        this.openTried.set(inp.id, now);
        void inp.open().catch(() => {});
      }
    }
    const stuck = ins.some((p) => p.state === "connected" && p.connection !== "open" && !THRU.test(p.name ?? ""));
    if (stuck && this.reopenTimer === null && typeof window !== "undefined")
      this.reopenTimer = window.setTimeout(() => {
        this.reopenTimer = null;
        this.refresh();
      }, 3000);
    this.emitChange();
  }

  /** Raw MIDI bytes from port `portId`; public for tests. */
  onMessage(portId: string, m: { data: Uint8Array | null; timeStamp: number }) {
    if (this.inputId && portId !== this.inputId) return;
    const d = m.data;
    if (!d || d.length < 2 || d[0] >= 0xf0) return; // system/realtime (active sensing, clock)
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    this.lastActivity = now;
    this.emitChange(); // indicator blink
    const cmd = d[0] & 0xf0;
    const t = m.timeStamp || now;
    if (t < this.muteUntil && this.usingMidiOut()) return;
    if (cmd === 0x90 && d[2] > 0) this.inject({ t, type: "on", note: d[1], vel: d[2] });
    else if (cmd === 0x80 || (cmd === 0x90 && d[2] === 0)) this.inject({ t, type: "off", note: d[1] });
    else if (cmd === 0xb0 && d[1] === 64) {
      // Continuous (half-)pedals send a stream of values per press (Arius: 6, 45, 76,
      // 127, 79, 32, 0). Only a crossing of 64 is an event.
      const down = d[2] >= 64;
      if (down === this.pedalDown) return;
      this.pedalDown = down;
      this.inject({ t, type: "pedal", note: down ? 1 : 0 });
    }
  }

  /** Also used by the on-screen keyboard. */
  inject(e: MidiEvent) {
    if (e.type === "on") this.held.add(e.note);
    if (e.type === "off") this.held.delete(e.note);
    if (typeof performance !== "undefined") this.lastActivity = Math.max(this.lastActivity, performance.now());
    this.listeners.forEach((l) => l(e));
  }

  /**
   * `expect: true` marks an exercise waiting for the learner to play; the
   * indicator hints "reconnect" if a device is connected but nothing arrives.
   */
  subscribe(l: Listener, opts: { expect?: boolean } = {}) {
    this.listeners.add(l);
    if (opts.expect) {
      if (this.expecting++ === 0) this.expectSince = typeof performance !== "undefined" ? performance.now() : 0;
      this.emitChange();
    }
    let done = false;
    return () => {
      this.listeners.delete(l);
      if (opts.expect && !done) {
        done = true;
        if (--this.expecting === 0) this.expectSince = 0;
        this.emitChange();
      }
    };
  }

  /** Real (non-"Through") inputs. */
  realInputs(): Port[] {
    return this.inputs.filter((i) => !THRU.test(i.name));
  }

  /** True when a device is connected, an exercise has waited `ms`, and nothing came in since it started. */
  silent(now: number, ms = 15000): boolean {
    if (!this.expectSince || !this.realInputs().length) return false;
    return now - this.expectSince >= ms && this.lastActivity < this.expectSince;
  }
  onChange(l: () => void) {
    this.changeListeners.add(l);
    return () => this.changeListeners.delete(l);
  }
  private emitChange() {
    this.changeListeners.forEach((l) => l());
  }

  private output(): MIDIOutput | null {
    if (!this.access) return null;
    const outs = [...this.access.outputs.values()];
    if (this.outputId) return outs.find((o) => o.id === this.outputId) ?? null;
    // auto: first output that is not a software "Through" port
    return outs.find((o) => !THRU.test(o.name ?? "")) ?? null;
  }
  usingMidiOut(): boolean {
    return this.playback !== "webaudio" && !!this.output();
  }
  outputName(): string {
    return this.usingMidiOut() ? this.output()!.name ?? "MIDI" : "Web Audio";
  }

  stop() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
    const out = this.output();
    if (out) for (let ch = 0; ch < 1; ch++) out.send([0xb0 | ch, 123, 0]); // all notes off
  }

  /** Play a spec; resolves when finished. */
  play(spec: PlaySpec, opts: { muteInput?: boolean } = {}): Promise<void> {
    unlockAudio();
    this.stop();
    const events = playEvents(spec);
    const total = events.length ? Math.max(...events.map((e) => e.at + e.dur)) : 0;
    const out = this.playback !== "webaudio" ? this.output() : null;
    if (out) {
      const now = performance.now();
      for (const e of events)
        for (const n of e.notes) {
          out.send([0x90, n, e.vel ?? 80], now + e.at * 1000);
          out.send([0x80, n, 0], now + (e.at + e.dur) * 1000);
        }
      if (opts.muteInput !== false) this.muteUntil = now + total * 1000 + 250;
    } else if (this.playback !== "midi") {
      for (const e of events) for (const n of e.notes) synthNote(n, e.at, e.dur, (e.vel ?? 80) / 115);
    }
    return new Promise((res) => {
      this.timers.push(window.setTimeout(res, total * 1000 + 100));
    });
  }
}

type PlayEvent = { at: number; notes: number[]; dur: number; vel?: number };
/** Seconds-based note events for a PlaySpec; "layers" start together (melody louder than chords). */
export function playEvents(spec: PlaySpec, vel?: number): PlayEvent[] {
  const beat = 60 / spec.tempo;
  const events: PlayEvent[] = [];
  if (spec.mode === "layers") {
    (spec.layers ?? []).forEach((l, i) => events.push(...playEvents(l, i === 0 ? 92 : 58)));
    return events;
  }
  if (spec.mode === "harmonic") events.push({ at: 0, notes: spec.notes ?? [], dur: beat * 2, vel });
  else if (spec.mode === "chords") {
    // with durations (backing tracks): chords back to back; without: spaced for listening
    let at = 0;
    (spec.chords ?? []).forEach((c, i) => {
      const d = spec.durations ? spec.durations[i] * beat : beat * 1.5;
      events.push({ at, notes: c, dur: spec.durations ? d * 0.97 : beat * 1.4, vel });
      at += d;
    });
  } else {
    let at = 0;
    (spec.notes ?? []).forEach((n, i) => {
      const d = (spec.durations?.[i] ?? 1) * beat;
      if (n >= 0) events.push({ at, notes: [n], dur: d * 0.95, vel });
      at += d;
    });
  }
  return events;
}

let mgr: MidiManager | null = null;
export function midi(): MidiManager {
  if (!mgr) {
    mgr = new MidiManager();
    if (typeof window !== "undefined") void mgr.init();
  }
  return mgr;
}
