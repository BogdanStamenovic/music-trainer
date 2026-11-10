"use client";
// Web MIDI in/out. Input: all inputs or a selected one; note on/off, velocity,
// sustain pedal (CC64), timestamps in the performance.now() domain.
// Output: send playback to the piano (Arius) when available, else Web Audio.

import { synthNote, unlockAudio } from "./audio";
import type { MidiEvent } from "../grading";
import type { PlaySpec } from "../curriculum/items";

type Listener = (e: MidiEvent) => void;
export interface Port {
  id: string;
  name: string;
}

class MidiManager {
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

  async init() {
    if (typeof navigator === "undefined" || !("requestMIDIAccess" in navigator)) {
      this.status = "unsupported";
      this.emitChange();
      return;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.status = "ready";
      this.access.onstatechange = () => this.refresh();
      this.refresh();
    } catch {
      this.status = "denied";
      this.emitChange();
    }
  }

  private refresh() {
    if (!this.access) return;
    this.inputs = [...this.access.inputs.values()].map((p) => ({ id: p.id, name: p.name ?? p.id }));
    this.outputs = [...this.access.outputs.values()].map((p) => ({ id: p.id, name: p.name ?? p.id }));
    for (const inp of this.access.inputs.values()) inp.onmidimessage = (m) => this.onMessage(inp.id, m);
    this.emitChange();
  }

  private onMessage(portId: string, m: MIDIMessageEvent) {
    if (this.inputId && portId !== this.inputId) return;
    const d = m.data;
    if (!d || d.length < 2) return;
    const cmd = d[0] & 0xf0;
    const t = m.timeStamp || performance.now();
    if (t < this.muteUntil && this.usingMidiOut()) return;
    if (cmd === 0x90 && d[2] > 0) this.inject({ t, type: "on", note: d[1], vel: d[2] });
    else if (cmd === 0x80 || (cmd === 0x90 && d[2] === 0)) this.inject({ t, type: "off", note: d[1] });
    else if (cmd === 0xb0 && d[1] === 64) this.inject({ t, type: "pedal", note: d[2] >= 64 ? 1 : 0 });
  }

  /** Also used by the on-screen keyboard. */
  inject(e: MidiEvent) {
    if (e.type === "on") this.held.add(e.note);
    if (e.type === "off") this.held.delete(e.note);
    this.listeners.forEach((l) => l(e));
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
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
    return outs.find((o) => !/through|thru/i.test(o.name ?? "")) ?? null;
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
  play(spec: PlaySpec): Promise<void> {
    unlockAudio();
    this.stop();
    const beat = 60 / spec.tempo;
    const events: { at: number; notes: number[]; dur: number }[] = [];
    if (spec.mode === "harmonic") events.push({ at: 0, notes: spec.notes ?? [], dur: beat * 2 });
    else if (spec.mode === "chords") (spec.chords ?? []).forEach((c, i) => events.push({ at: i * beat * 1.5, notes: c, dur: beat * 1.4 }));
    else {
      let at = 0;
      (spec.notes ?? []).forEach((n, i) => {
        const d = (spec.durations?.[i] ?? 1) * beat;
        if (n >= 0) events.push({ at, notes: [n], dur: d * 0.95 });
        at += d;
      });
    }
    const total = events.length ? Math.max(...events.map((e) => e.at + e.dur)) : 0;
    const out = this.playback !== "webaudio" ? this.output() : null;
    if (out) {
      const now = performance.now();
      for (const e of events)
        for (const n of e.notes) {
          out.send([0x90, n, 80], now + e.at * 1000);
          out.send([0x80, n, 0], now + (e.at + e.dur) * 1000);
        }
      this.muteUntil = now + total * 1000 + 250;
    } else if (this.playback !== "midi") {
      for (const e of events) for (const n of e.notes) synthNote(n, e.at, e.dur);
    }
    return new Promise((res) => {
      this.timers.push(window.setTimeout(res, total * 1000 + 100));
    });
  }
}

let mgr: MidiManager | null = null;
export function midi(): MidiManager {
  if (!mgr) {
    mgr = new MidiManager();
    if (typeof window !== "undefined") void mgr.init();
  }
  return mgr;
}
