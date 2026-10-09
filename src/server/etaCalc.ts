import {
  formatMdrTimestamp,
  normalizeMdrTimestamp,
  parseScheduledDelivery,
  parseScheduledPickup,
} from "./timeFormat.js";

// Computes the final `eta` in code instead of trusting the extraction model
// to do date arithmetic. A real call (2026-10-08) had the caller say "2
// hours late" for a shipment scheduled 2026-10-09 08:00 UTC; the model was
// given that schedule and still returned call time + 2h. So the model now
// only CLASSIFIES what the caller said (eta_kind) plus the raw numbers, and
// this turns them into the timestamp MDR asked for (confirmed 2026-10-08):
//
//   explicit    caller gave a specific date AND time        -> eta as stated
//   late        "2 hours late"                              -> scheduled delivery
//                                                             (estimated_delivery_date
//                                                             + delivery_appointment) + delay;
//                                                             PICKUP_TODAY: scheduled pickup
//                                                             (pickup_date + its time) + delay;
//                                                             no schedule -> call time + delay
//   same        "same as before" / "on time"                -> scheduled delivery; none -> null
//   from_now    "in 2 hours"                                -> call time + amount
//   clock_time  "5 PM" (no day)                             -> that time on the scheduled
//                                                             DATE, else the call's date
//
// A scheduled date earlier than the call date is stale and ignored (see
// timeFormat.ts's parseScheduledDelivery). Everything is UTC.
export interface EtaFields {
  eta_kind?: unknown;
  eta?: unknown;
  eta_offset_minutes?: unknown;
  eta_clock_time?: unknown;
}

export interface EtaShipment {
  status?: unknown;
  pickup_date?: unknown;
  estimated_delivery_date?: unknown;
  delivery_appointment?: unknown;
}

// For a PICKUP_TODAY shipment the ETA the caller gives is the driver's ETA to
// PICKUP, so "1 hour late" / "same as before" / a bare clock time are
// measured against the scheduled PICKUP (pickup_date, with its time), not the
// delivery schedule (MDR feedback 2026-10-09).
function isPickupShipment(shipment: EtaShipment): boolean {
  return (
    typeof shipment.status === "string" &&
    shipment.status.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_") === "PICKUP_TODAY"
  );
}

const MAX_OFFSET_MINUTES = 60 * 24 * 30; // 30 days — anything bigger is a mis-extraction

function offsetMinutes(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_OFFSET_MINUTES
    ? Math.round(value)
    : null;
}

function addMinutes(base: Date, minutes: number): string {
  return formatMdrTimestamp(new Date(base.getTime() + minutes * 60_000));
}

export function computeEta(fields: EtaFields, shipment: EtaShipment, callTime: Date): string | null {
  const kind = typeof fields.eta_kind === "string" ? fields.eta_kind.trim().toLowerCase() : null;
  const scheduled = isPickupShipment(shipment)
    ? parseScheduledPickup(shipment, callTime)
    : parseScheduledDelivery(shipment, callTime);
  const scheduledAt =
    scheduled.date && scheduled.time ? new Date(`${scheduled.date}T${scheduled.time}Z`) : null;

  switch (kind) {
    case "explicit":
      return normalizeMdrTimestamp(fields.eta, "eta");

    case "late": {
      const delay = offsetMinutes(fields.eta_offset_minutes);
      if (delay === null) return null;
      return addMinutes(scheduledAt ?? callTime, delay);
    }

    case "same":
      return scheduledAt ? formatMdrTimestamp(scheduledAt) : null;

    case "from_now": {
      const amount = offsetMinutes(fields.eta_offset_minutes);
      return amount === null ? null : addMinutes(callTime, amount);
    }

    case "clock_time": {
      const m = /^(\d{1,2}):(\d{2})$/.exec(typeof fields.eta_clock_time === "string" ? fields.eta_clock_time.trim() : "");
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
      const date = scheduled.date ?? formatMdrTimestamp(callTime).slice(0, 10);
      return `${date} ${String(Number(m[1])).padStart(2, "0")}:${m[2]}:00`;
    }

    default:
      // No classification (or an unknown one): fall back to a fully
      // formatted eta from the model, validated; anything else is null.
      return normalizeMdrTimestamp(fields.eta, "eta");
  }
}
