"use client";
import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";
import type { Loc } from "../curriculum/schema";

export type Locale = "en" | "sr";

const D = {
  today: ["Today", "Danas"],
  progress: ["Progress", "Napredak"],
  settings: ["Settings", "Podešavanja"],
  placement: ["Placement test", "Test plasmana"],
  focus: ["Focus", "Fokus"],
  maintenance: ["Daily maintenance", "Dnevno održavanje"],
  reviews: ["Reviews", "Ponavljanje"],
  warmup: ["Vocal warm-up", "Vokalno zagrevanje"],
  start: ["Start", "Počni"],
  continue: ["Continue", "Nastavi"],
  again: ["Again", "Ponovo"],
  done: ["Done", "Gotovo"],
  next: ["Next", "Dalje"],
  check: ["Check", "Proveri"],
  play: ["Play", "Pusti"],
  replay: ["Play again", "Pusti ponovo"],
  reset: ["Reset", "Poništi"],
  skip: ["Skip", "Preskoči"],
  min: ["min", "min"],
  correct: ["Correct", "Tačno"],
  wrong: ["Not quite", "Nije tačno"],
  expected: ["Expected", "Očekivano"],
  youPlayed: ["You played", "Odsvirao si"],
  score: ["Score", "Rezultat"],
  passed: ["Passed", "Položeno"],
  notPassed: ["Not passed yet", "Još nije položeno"],
  skipped: ["Skipped (placement)", "Preskočeno (plasman)"],
  started: ["In progress", "U toku"],
  new: ["New", "Novo"],
  lessonDone: ["Lesson passed", "Lekcija položena"],
  exercise: ["Exercise", "Vežba"],
  of: ["of", "od"],
  backToday: ["Back to today", "Nazad na danas"],
  offlineQueued: ["Saved offline; will sync when the server is reachable.", "Sačuvano oflajn; sinhronizuje se kad server bude dostupan."],
  pending: ["pending sync", "čeka sinhronizaciju"],
  online: ["online", "onlajn"],
  offline: ["offline", "oflajn"],
  midiNone: ["No MIDI device: use the on-screen keys", "Nema MIDI uređaja: koristi klavijaturu na ekranu"],
  midiUnsupported: ["This browser has no Web MIDI (use Chrome). On-screen keys work.", "Ovaj pregledač nema Web MIDI (koristi Chrome). Klavijatura na ekranu radi."],
  listening: ["Listening… play now", "Slušam… sviraj"],
  typeNotes: ["Type note names separated by spaces", "Upiši imena nota odvojena razmakom"],
  selfRate: ["How did it go?", "Kako je prošlo?"],
  selfBad: ["Couldn't", "Nije išlo"],
  selfOk: ["Partly", "Delimično"],
  selfGood: ["Did it", "Uradio sam"],
  aheadOfTheory: ["Ahead of theory", "Ispred teorije"],
  weeklyTest: ["Weekly test", "Nedeljni test"],
  restDay: ["Rest day", "Dan odmora"],
  allDone: ["All done for today.", "Sve za danas je gotovo."],
  language: ["Language", "Jezik"],
  schedule: ["Weekly schedule", "Nedeljni raspored"],
  focusMinutes: ["Focus minutes", "Minuta fokusa"],
  maintenanceOn: ["Daily maintenance block (reviews + warm-up, ≤10 min)", "Dnevni blok održavanja (ponavljanje + zagrevanje, ≤10 min)"],
  save: ["Save", "Sačuvaj"],
  saved: ["Saved", "Sačuvano"],
  midiIn: ["MIDI input", "MIDI ulaz"],
  midiOut: ["Playback", "Reprodukcija"],
  allInputs: ["All inputs", "Svi ulazi"],
  voiceScore: ["Voice analysis service", "Servis za analizu glasa"],
  up: ["up", "radi"],
  down: ["down: in-browser fallback", "ne radi: rezerva u pregledaču"],
  testSound: ["Test sound", "Probaj zvuk"],
  redoPlacement: ["Take placement test again", "Ponovi test plasmana"],
  skipPlacement: ["Skip placement (start from lesson 1)", "Preskoči plasman (kreni od 1. lekcije)"],
  replan: ["Rebuild today's plan", "Ponovo napravi današnji plan"],
  section: ["Section", "Deo"],
  finish: ["Finish", "Završi"],
  placementResult: ["Placement done. Lessons skipped:", "Plasman završen. Preskočene lekcije:"],
  none: ["none", "nijedna"],
  history: ["History", "Istorija"],
  dueReviews: ["review items due", "stavki za ponavljanje"],
  noReviews: ["No reviews due.", "Nema ničega za ponavljanje."],
  explain: ["Lesson", "Lekcija"],
  exercises: ["Exercises", "Vežbe"],
  retryExercise: ["Retry exercise", "Ponovi vežbu"],
  mon: ["Mon", "Pon"], tue: ["Tue", "Uto"], wed: ["Wed", "Sre"], thu: ["Thu", "Čet"], fri: ["Fri", "Pet"], sat: ["Sat", "Sub"], sun: ["Sun", "Ned"],
  T: ["Theory", "Teorija"], E: ["Ear", "Sluh"], K: ["Keys", "Klavir"], V: ["Voice", "Glas"], C: ["Composition", "Kompozicija"], L: ["Lyrics", "Tekstovi"], test: ["Test", "Test"], rest: ["Rest", "Odmor"],
} as const;
export type Key = keyof typeof D;

interface Ctx {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (k: Key) => string;
  l: (x: Loc | string | undefined) => string;
}
const C = createContext<Ctx>({ locale: "en", setLocale: () => {}, t: (k) => D[k][0], l: (x) => (typeof x === "string" ? x : x?.en ?? "") });

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setL] = useState<Locale>("en");
  useEffect(() => {
    try {
      const s = localStorage.getItem("locale");
      if (s === "en" || s === "sr") setL(s);
    } catch {}
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale === "sr" ? "sr-Latn" : "en";
  }, [locale]);
  const setLocale = useCallback((l: Locale) => {
    setL(l);
    try {
      localStorage.setItem("locale", l);
    } catch {}
    void fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale: l }) }).catch(() => {});
  }, []);
  const t = useCallback((k: Key) => D[k][locale === "sr" ? 1 : 0], [locale]);
  const l = useCallback((x: Loc | string | undefined) => (x === undefined ? "" : typeof x === "string" ? x : x[locale]), [locale]);
  return <C.Provider value={{ locale, setLocale, t, l }}>{children}</C.Provider>;
}

export const useI18n = () => useContext(C);
