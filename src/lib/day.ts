// The "training day": the local date in the learner's time zone, but a new day starts at
// `startHour` (default 02:00), so work done after midnight still counts for the evening
// before (Bogdan, 2026-11-14: "make it so i can do one days work till 2 am next day").
// Wall-clock based, so DST changes need no special case. Shared by server and client.

export const DEFAULT_DAY_START_HOUR = 2;

function localParts(tz: string, d: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

function prevDate(date: string): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function trainingDate(tz: string, startHour = DEFAULT_DAY_START_HOUR, d: Date = new Date()): string {
  const { date, hour } = localParts(tz, d);
  return hour < startHour ? prevDate(date) : date;
}

/** Client side: the start hour from settings, cached by the shell (falls back to the default). */
export function clientDayStartHour(): number {
  try {
    const v = Number(globalThis.localStorage?.getItem("dayStartHour"));
    return Number.isInteger(v) && v >= 0 && v <= 6 && globalThis.localStorage?.getItem("dayStartHour") !== null ? v : DEFAULT_DAY_START_HOUR;
  } catch {
    return DEFAULT_DAY_START_HOUR;
  }
}

/** Today's training date in the browser (Europe/Belgrade, the app's configured zone). */
export function clientToday(): string {
  return trainingDate("Europe/Belgrade", clientDayStartHour());
}
