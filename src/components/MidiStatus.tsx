"use client";
import { useEffect, useState } from "react";
import { midi } from "@/lib/client/midi";
import { useI18n } from "@/lib/client/i18n";

export function useMidiState() {
  const [, set] = useState(0);
  useEffect(() => {
    const un = midi().onChange(() => set((x) => x + 1));
    return () => void un();
  }, []);
  return midi();
}

export function MidiStatus() {
  const m = useMidiState();
  const { t } = useI18n();
  if (m.status === "unsupported" || m.status === "denied") return <span className="pill warn" title={t("midiUnsupported")}>MIDI ✕</span>;
  if (m.status === "pending") return <span className="pill">MIDI …</span>;
  if (!m.inputs.length) return <span className="pill warn" title={t("midiNone")}>MIDI 0</span>;
  return <span className="pill ok" title={m.inputs.map((i) => i.name).join(", ")}>🎹 {m.inputs[0].name}</span>;
}
