// MDR's required timestamp format for ETA-style fields, confirmed
// 2026-10-06: "YYYY-MM-DD H:i:s" (PHP date() notation — 24-hour,
// zero-padded, e.g. "2026-10-06 14:30:00"), always in UTC.
const MDR_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

const pad = (n: number) => String(n).padStart(2, "0");

export function formatMdrTimestamp(date: Date): string {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

// Reference "now" handed to the model (call prompt + post-call extraction)
// so relative answers ("in 2 hours", "tomorrow 3 PM") resolve against a
// real date — includes the weekday so "on Friday" resolves correctly too.
export function describeUtcNow(date: Date): string {
  const weekday = date.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return `${weekday}, ${formatMdrTimestamp(date)} UTC`;
}

// Enforces MDR's exact format on whatever the extraction pass returned.
// The extraction model can still occasionally emit free text ("5 PM") or a
// slightly different shape ("2026-10-06T14:30:00Z"); MDR asked for the
// exact format, so anything that doesn't match (or isn't a real date) is
// sent as null rather than as a value MDR can't parse.
export function normalizeMdrTimestamp(value: unknown, field: string): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const trimmed = value.trim();

  const m = MDR_TIMESTAMP.exec(trimmed);
  if (m) {
    const [, y, mo, d, h, mi, s] = m.map(Number);
    const check = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
    const real =
      check.getUTCFullYear() === y &&
      check.getUTCMonth() === mo - 1 &&
      check.getUTCDate() === d &&
      check.getUTCHours() === h &&
      check.getUTCMinutes() === mi &&
      check.getUTCSeconds() === s;
    if (real) return trimmed;
  }

  console.warn(`[timeFormat] ${field} "${trimmed}" is not YYYY-MM-DD HH:mm:ss — sending null`);
  return null;
}
