import { describe, it, expect } from "vitest";
import { MidiManager } from "../src/lib/client/midi";
import type { MidiEvent } from "../src/lib/grading";

const msg = (...b: number[]) => ({ data: new Uint8Array(b), timeStamp: 1 });

describe("MidiManager input", () => {
  it("emits a pedal event only when CC64 crosses 64 (Arius half-pedal stream)", () => {
    const m = new MidiManager();
    const got: MidiEvent[] = [];
    m.subscribe((e) => got.push(e));
    for (const v of [6, 45, 76, 127, 79, 32, 0]) m.onMessage("p", msg(0xb0, 64, v));
    expect(got.map((e) => [e.type, e.note])).toEqual([
      ["pedal", 1],
      ["pedal", 0],
    ]);
  });

  it("ignores system realtime bytes but counts channel messages as activity", () => {
    const m = new MidiManager();
    const got: MidiEvent[] = [];
    m.subscribe((e) => got.push(e));
    m.onMessage("p", msg(0xfe, 0)); // active sensing
    expect(m.lastActivity).toBe(0);
    m.onMessage("p", msg(0x90, 60, 70));
    m.onMessage("p", msg(0x90, 60, 0));
    expect(got.map((e) => e.type)).toEqual(["on", "off"]);
    expect(m.lastActivity).toBeGreaterThan(0);
  });

  it("hints when an exercise waits with a device connected and nothing arrives", () => {
    const m = new MidiManager();
    m.inputs = [{ id: "a", name: "Midi Through Port-0" }];
    const un = m.subscribe(() => {}, { expect: true });
    const t0 = m.expectSince;
    expect(m.silent(t0 + 20000)).toBe(false); // only a Through port: nothing to reconnect
    m.inputs.push({ id: "b", name: "Arius", connection: "open" });
    expect(m.silent(t0 + 5000)).toBe(false);
    expect(m.silent(t0 + 20000)).toBe(true);
    m.onMessage("b", msg(0x90, 60, 70));
    expect(m.silent(performance.now() + 20000)).toBe(false);
    un();
    un(); // idempotent
    expect(m.expectSince).toBe(0);
    m.subscribe(() => {}); // a display-only subscriber does not expect input
    expect(m.expectSince).toBe(0);
  });
});
