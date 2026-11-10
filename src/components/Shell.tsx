"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, ReactNode } from "react";
import { LocaleProvider, useI18n } from "@/lib/client/i18n";
import { MidiStatus } from "./MidiStatus";
import { startSync, onQueueChange, queued } from "@/lib/client/queue";
import { midi } from "@/lib/client/midi";
import { flushUploads } from "@/lib/client/voice";

function Bar() {
  const { t, locale, setLocale } = useI18n();
  const path = usePathname();
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  useEffect(() => {
    startSync();
    void flushUploads();
    midi();
    const upd = () => void queued().then((q) => setPending(q.length)).catch(() => {});
    upd();
    const un = onQueueChange(upd);
    const on = () => setOnline(navigator.onLine);
    on();
    window.addEventListener("online", on);
    window.addEventListener("offline", on);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    // apply stored MIDI routing
    fetch("/api/settings").then((r) => r.json()).then((s) => {
      const m = midi();
      m.inputId = s.midiIn ?? null;
      m.outputId = s.midiOut ?? null;
      m.playback = s.playback ?? "auto";
      if ((s.locale === "en" || s.locale === "sr") && !localStorage.getItem("locale")) setLocale(s.locale);
    }).catch(() => {});
    return () => {
      un();
      window.removeEventListener("online", on);
      window.removeEventListener("offline", on);
    };
  }, [setLocale]);
  const nav: [string, "today" | "progress" | "settings" | "voice"][] = [["/", "today"], ["/progress", "progress"], ["/voice", "voice"], ["/settings", "settings"]];
  return (
    <header className="bar">
      <Link href="/" className="brand">♪ music-trainer</Link>
      <nav>
        {nav.map(([href, k]) => (
          <Link key={href} href={href} className={path === href ? "active" : ""}>
            {t(k)}
          </Link>
        ))}
      </nav>
      <div className="status">
        <MidiStatus />
        {!online ? <span className="pill warn">{t("offline")}</span> : null}
        {pending ? <span className="pill warn">{pending} {t("pending")}</span> : null}
        <button type="button" className="lang" onClick={() => setLocale(locale === "en" ? "sr" : "en")} aria-label={t("language")}>
          {locale === "en" ? "SR" : "EN"}
        </button>
      </div>
    </header>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <LocaleProvider>
      <Bar />
      <main>{children}</main>
    </LocaleProvider>
  );
}
