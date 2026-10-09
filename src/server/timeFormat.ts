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

// A shipment's scheduled delivery, from the fields MDR sends on each
// shipment: `estimated_delivery_date` ("YYYY-MM-DD", optionally with a time)
// and `delivery_appointment` ("08:00", "8:00 AM", "08:00:00"). Used as the
// reference for ETA answers like "2 hours late" or "same as before" instead
// of the call time (MDR feedback 2026-10-08). Taken as UTC, like every
// other spoken/received time here.
//
// A date earlier than today (UTC) is stale test/old data, not a usable
// schedule — a driver can't be "2 hours late" for a date that has already
// passed — so it's ignored and the caller falls back to the call time.
export interface ScheduledDelivery {
  date: string | null; // YYYY-MM-DD
  time: string | null; // HH:MM:SS, only when a date is also known
}

export function parseScheduledDelivery(
  shipment: { estimated_delivery_date?: unknown; delivery_appointment?: unknown },
  now: Date,
): ScheduledDelivery {
  return parseSchedule(shipment.estimated_delivery_date, shipment.delivery_appointment, now);
}

// Scheduled pickup (PICKUP_TODAY ETAs): `pickup_date` is either a plain date
// or, as MDR will send it (2026-10-09), "YYYY-MM-DD HH:MM:SS" with the time.
export function parseScheduledPickup(shipment: { pickup_date?: unknown }, now: Date): ScheduledDelivery {
  return parseSchedule(shipment.pickup_date, undefined, now);
}

function parseSchedule(rawDate: unknown, rawTime: unknown, now: Date): ScheduledDelivery {
  const none: ScheduledDelivery = { date: null, time: null };

  if (typeof rawDate !== "string") return none;
  const dm = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(rawDate.trim());
  if (!dm) return none;

  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return none;
  const date = `${dm[1]}-${dm[2]}-${dm[3]}`;
  if (date < formatMdrTimestamp(now).slice(0, 10)) return none; // stale

  // Appointment time wins; a time embedded in estimated_delivery_date is the fallback.
  let time: string | null = null;
  if (typeof rawTime === "string") {
    const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(rawTime.trim());
    if (tm) {
      let h = Number(tm[1]);
      const mi = Number(tm[2]);
      const s = tm[3] ? Number(tm[3]) : 0;
      const meridiem = tm[4]?.toLowerCase();
      if (meridiem === "pm" && h < 12) h += 12;
      if (meridiem === "am" && h === 12) h = 0;
      if (h <= 23 && mi <= 59 && s <= 59) time = `${pad(h)}:${pad(mi)}:${pad(s)}`;
    }
  }
  if (!time && dm[4] !== undefined) {
    const h = Number(dm[4]);
    const mi = Number(dm[5]);
    if (h <= 23 && mi <= 59) time = `${pad(h)}:${pad(mi)}:${pad(dm[6] ? Number(dm[6]) : 0)}`;
  }

  return { date, time };
}
