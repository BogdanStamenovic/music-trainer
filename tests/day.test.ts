import { describe, it, expect } from "vitest";
import { trainingDate } from "@/lib/day";

const T = (iso: string, h = 2) => trainingDate("Europe/Belgrade", h, new Date(iso));

describe("training day (day starts at 02:00 Belgrade)", () => {
  it("01:59 belongs to the previous day, 02:00 starts the new one", () => {
    expect(T("2026-11-14T22:59:00Z")).toBe("2026-11-14"); // Sat 23:59 CET
    expect(T("2026-11-14T23:30:00Z")).toBe("2026-11-14"); // Sun 00:30: still Saturday's work
    expect(T("2026-11-15T00:59:00Z")).toBe("2026-11-14"); // Sun 01:59
    expect(T("2026-11-15T01:00:00Z")).toBe("2026-11-15"); // Sun 02:00
  });
  it("start hour 0 is the plain local date", () => {
    expect(T("2026-11-14T23:30:00Z", 0)).toBe("2026-11-15");
  });
  it("across month and year ends", () => {
    expect(T("2026-11-30T23:30:00Z")).toBe("2026-11-30");
    expect(T("2026-12-31T23:30:00Z")).toBe("2026-12-31"); // Jan 1 00:30 local
  });
  it("spring DST (2026-03-29, 02:00 CET -> 03:00 CEST): 01:59 is the day before, 03:00 the new day", () => {
    expect(T("2026-03-29T00:59:00Z")).toBe("2026-03-28"); // 01:59 CET
    expect(T("2026-03-29T01:00:00Z")).toBe("2026-03-29"); // 03:00 CEST (02:xx does not exist)
  });
  it("autumn DST (2026-10-25, 03:00 CEST -> 02:00 CET): both 02:30s are the new day, 01:59 the day before", () => {
    expect(T("2026-10-24T23:59:00Z")).toBe("2026-10-24"); // 01:59 CEST
    expect(T("2026-10-25T00:30:00Z")).toBe("2026-10-25"); // 02:30 CEST
    expect(T("2026-10-25T01:30:00Z")).toBe("2026-10-25"); // 02:30 CET, the repeated hour
  });
});
