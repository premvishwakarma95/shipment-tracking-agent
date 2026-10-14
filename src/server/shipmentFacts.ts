import { formatMdrTimestamp, parseScheduledDelivery, parseScheduledPickup } from "./timeFormat.js";

// Turns the raw shipment fields MDR sends (added 2026-10-14: pickup_location,
// delivery_location, driver) into text the agent can say aloud.

const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "D.C.", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
  KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts",
  MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  // Canadian provinces
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick",
  NL: "Newfoundland and Labrador", NS: "Nova Scotia", ON: "Ontario", PE: "Prince Edward Island",
  QC: "Quebec", SK: "Saskatchewan",
};

const COUNTRY_SUFFIXES = new Set(["USA", "US", "U.S.", "U.S.A.", "UNITED STATES", "UNITED STATES OF AMERICA"]);

function titleCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/(^|[\s.'-])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
    .trim();
}

// "COLUMBIA,SC,USA" -> "Columbia, South Carolina"; "LAS VEGAS,NV,USA" ->
// "Las Vegas, Nevada". Anything it can't read is returned title-cased as
// given (never invented); empty/non-string -> null.
export function formatLocation(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length > 1 && COUNTRY_SUFFIXES.has(parts[parts.length - 1]!.toUpperCase())) parts.pop();
  const spoken = parts.map((p, i) => {
    const state = i > 0 ? US_STATES[p.toUpperCase()] : undefined;
    return state ?? titleCase(p);
  });
  return spoken.join(", ");
}

export interface DriverOnRecord {
  name: string | null;
  phoneLast4: string | null;
  // Full number, digits spaced for speaking ("9 1 9 8 3 6 …") — only said if the
  // caller asks for it (see callVariables.ts).
  phoneSpoken: string | null;
}

// MDR sends `driver: {name, phone}` (an array / `drivers` is accepted too —
// the first usable entry wins). The full phone number is never put in the
// prompt: the agent only needs "ending in 1234" to verify it.
export function driverOnRecord(shipment: Record<string, unknown>): DriverOnRecord | null {
  const candidates: unknown[] = [];
  for (const key of ["driver", "drivers"]) {
    const v = shipment[key];
    if (Array.isArray(v)) candidates.push(...v);
    else if (v && typeof v === "object") candidates.push(v);
  }
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const { name, phone } = c as { name?: unknown; phone?: unknown };
    const n = typeof name === "string" && name.trim() ? name.trim() : null;
    const digits = typeof phone === "string" ? phone.replace(/\D/g, "") : "";
    const last4 = digits.length >= 4 ? digits.slice(-4) : null;
    const spoken = digits.length >= 7 ? digits.split("").join(" ") : null;
    if (n || last4) return { name: n, phoneLast4: last4, phoneSpoken: spoken };
  }
  return null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10 > 3 ? 0 : n % 10]}`;
}

// "2026-10-14" relative to the call date -> "today" / "tomorrow" / "Thursday" /
// "October 20th". Plain calendar arithmetic on the dates as given (no time zone).
export function speakDate(date: string, now: Date): string {
  const today = formatMdrTimestamp(now).slice(0, 10);
  const diff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  const d = new Date(`${date}T00:00:00Z`);
  if (diff > 1 && diff <= 6) return WEEKDAYS[d.getUTCDay()]!;
  return `${MONTHS[d.getUTCMonth()]} ${ordinal(d.getUTCDate())}`;
}

// "08:00:00" -> "8 AM", "16:30:00" -> "4:30 PM"
export function speakTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const hour12 = h! % 12 === 0 ? 12 : h! % 12;
  return `${hour12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h! < 12 ? "AM" : "PM"}`;
}

export interface SpokenSchedule {
  kind: "pickup" | "delivery";
  phrase: string; // e.g. "today at 8 AM"
}

// The schedule that matters for this status: pickup for PICKUP_TODAY /
// DISPATCHED, delivery for OUT_FOR_DELIVERY / IN_TRANSIT, none otherwise (or
// when the payload has no usable, non-stale date). Times are spoken as given.
export function spokenSchedule(shipment: Record<string, unknown>, statusKey: string | null, now: Date): SpokenSchedule | null {
  let kind: "pickup" | "delivery";
  if (statusKey === "PICKUP_TODAY" || statusKey === "DISPATCHED") kind = "pickup";
  else if (statusKey === "OUT_FOR_DELIVERY" || statusKey === "IN_TRANSIT") kind = "delivery";
  else return null;
  const sched = kind === "pickup" ? parseScheduledPickup(shipment, now) : parseScheduledDelivery(shipment, now);
  if (!sched.date) return null;
  const when = speakDate(sched.date, now);
  return { kind, phrase: sched.time ? `${when} at ${speakTime(sched.time)}` : when };
}

export function idDigitCount(id: string): number {
  return id.replace(/\D/g, "").length;
}

export function spokenId(id: string): string {
  return id.replace(/\D/g, "").split("").join(" ") || id;
}

// "1 3 1 9 5 4 0 5 2, from Columbia, South Carolina to Las Vegas, Nevada,
// scheduled for pickup today at 8 AM" — the wording the agent says when it
// names a shipment (single-shipment intro, or when starting each shipment).
export function shipmentOpening(
  shipment: Record<string, unknown>,
  id: string,
  statusKey: string | null,
  now: Date,
): string {
  const from = formatLocation(shipment.pickup_location);
  const to = formatLocation(shipment.delivery_location);
  const route = from && to ? `from ${from} to ${to}` : from ? `picking up in ${from}` : to ? `delivering to ${to}` : "";
  const sched = spokenSchedule(shipment, statusKey, now);
  const when = sched ? `scheduled for ${sched.kind} ${sched.phrase}` : "";
  return [`shipment ${spokenId(id)}`, route, when].filter(Boolean).join(", ");
}
