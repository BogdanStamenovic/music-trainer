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

const BLINK_MS = 140;

/**
 * Persistent input indicator: device name and a dot that lights on every
 * incoming message. Tapping it re-requests MIDI access and rebinds the inputs,
 * which recovers a port that was busy (ALSA rawmidi is exclusive) when the page
 * opened it.
 */
export function MidiStatus() {
  const m = useMidiState();
  const { t } = useI18n();
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const last = m.lastActivity;
  useEffect(() => {
    const n = performance.now();
    setNow(n);
    if (last && n - last < BLINK_MS) {
      const id = window.setTimeout(() => setNow(performance.now()), BLINK_MS);
      return () => clearTimeout(id);
    }
  }, [last]);
  const waiting = m.expectSince > 0;
  useEffect(() => {
    if (!waiting) return;
    const id = window.setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(id);
  }, [waiting]);

  if (m.status === "unsupported" || m.status === "denied") return <span className="pill warn" title={t("midiUnsupported")}>MIDI ✕</span>;
  const reconnect = async () => {
    setBusy(true);
    try {
      await m.reconnect();
    } finally {
      setBusy(false);
    }
  };
  if (m.status === "pending" || busy) return <span className="pill">MIDI …</span>;
  const real = m.realInputs();
  const port = (m.inputId && real.find((i) => i.id === m.inputId)) || real[0];
  if (!port)
    return (
      <button type="button" className="pill warn midi-ind" title={`${t("midiNone")} · ${t("midiTapReconnect")}`} onClick={reconnect} data-testid="midi-indicator">
        <span className="dot" /> {t("midiNoInput")}
      </button>
    );
  const lit = last > 0 && now - last < BLINK_MS;
  const notOpen = port.connection !== undefined && port.connection !== "open";
  const silent = m.silent(now);
  const warn = notOpen || silent;
  return (
    <>
      <button
        type="button"
        className={`pill midi-ind ${warn ? "warn" : "ok"}`}
        title={`${m.inputs.map((i) => `${i.name} (${i.connection ?? "?"})`).join(", ")} · ${t("midiTapReconnect")}`}
        onClick={reconnect}
        data-testid="midi-indicator"
      >
        <span className={`dot${lit ? " lit" : ""}`} /> {port.name}
        {notOpen ? ` · ${port.connection}` : ""}
      </button>
      {silent ? (
        <button type="button" className="pill warn" onClick={reconnect} data-testid="midi-silent-hint">
          {t("midiSilent")}
        </button>
      ) : null}
    </>
  );
}
