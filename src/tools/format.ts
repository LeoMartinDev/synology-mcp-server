/** Keys DSM uses for Unix timestamps: atime, up_time, created, StartedTs, timestamp… */
const TIME_KEY = /(time|^created|Ts|^timestamp)$/;

// Plausible dates, 2000 → 2100, in seconds; durations and counters under the same keys stay below.
const MIN_SECONDS = 946_684_800;
const MAX_SECONDS = 4_102_444_800;

/** Rewrites Unix timestamps (seconds or milliseconds) under time-like keys as ISO dates, which agents misread less. */
export function humanizeTimes(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => humanizeTimes(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, humanizeTimes(v, k)]));
  }
  if (typeof value === "number" && TIME_KEY.test(key)) {
    const ms =
      value >= MIN_SECONDS && value < MAX_SECONDS
        ? value * 1000
        : value >= MIN_SECONDS * 1000 && value < MAX_SECONDS * 1000
          ? value
          : undefined;
    if (ms !== undefined) return new Date(ms).toISOString().replace(".000Z", "Z");
  }
  return value;
}

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

export function formatBytes(bytes: number | string): string {
  let n = Number(bytes);
  let unit = 0;
  while (Math.abs(n) >= 1024 && unit < UNITS.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${unit === 0 ? n : n.toFixed(2)} ${UNITS[unit]}`;
}

export const percent = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 1000) / 10 : 0);
