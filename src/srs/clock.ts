/**
 * App clock. Everything that needs "now" or "today" goes through here so the
 * debug HUD can time-travel and tests can pin the time.
 */
let offsetMs = 0;
let fixed: number | null = null;

export const clock = {
  now(): Date {
    return new Date((fixed ?? Date.now()) + offsetMs);
  },
  /** Shift the clock forward (time travel); cumulative. */
  advance(ms: number): void {
    offsetMs += ms;
  },
  reset(): void {
    offsetMs = 0;
    fixed = null;
  },
  /** Pin the clock to a fixed time (tests). */
  set(date: Date): void {
    fixed = date.getTime();
    offsetMs = 0;
  },
  get offsetMs(): number {
    return offsetMs;
  },
};

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Day number for a time, where days start at `dayStartHour` local time (Anki style):
 * 03:59 belongs to the previous day when dayStartHour is 4.
 */
export function dayIndex(t: Date, dayStartHour: number): number {
  const shifted = new Date(t.getTime() - dayStartHour * HOUR);
  return Math.round(Date.UTC(shifted.getFullYear(), shifted.getMonth(), shifted.getDate()) / DAY);
}

/** Local time at which day `day` starts. */
export function dayStart(day: number, dayStartHour: number): Date {
  const d = new Date(day * DAY);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), dayStartHour);
}
