import type { CONTACT_TYPES, EVENT_TYPES } from "../db/models/CallRequest.js";

export type ContactType = (typeof CONTACT_TYPES)[number];
export type EventType = (typeof EVENT_TYPES)[number];

export interface Contact {
  type: ContactType;
  name: string;
  phone: string;
}

// One shipment within an inbound SHIPMENT_GROUP call request. Left
// permissive (indexable, only a few fields typed) — MDR may send
// additional TAI shipment/reference fields beyond the confirmed example,
// same philosophy as the old singular `shipment` field.
export interface ShipmentInput {
  shipment_id?: string;
  // MDR's own free-text status label (e.g. "Out for Delivery", "In
  // Transit", "Dispatched") — used only to pick this shipment's default
  // question set (src/server/callVariables.ts's status matching against
  // prompt.ts's STATUS_QUESTIONS) and echoed back unmodified in the
  // response under the same key, for MDR's own internal bookkeeping.
  // Confirmed 2026-09-28: never validated/enum-checked or otherwise acted
  // on beyond that.
  status?: string;
  // Per-shipment prior context and question list. CHANGED 2026-09-28: MDR
  // moved from one shipment per call request to multiple shipments per
  // call (`shipments[]` below), so these — previously call-level fields —
  // are now scoped to each shipment instead.
  questions?: string[];
  previous_summary?: string | null;
  open_issue?: string | null;
  [key: string]: unknown;
}

// What MDR sends inbound on POST /mdr/call-requests, per the confirmed
// "MDR Agent 3 – Voice API Integration Guide" (§3), UPDATED 2026-09-28 for
// MDR's multi-shipment format: `shipment` (singular) is retired in favor
// of `shipments[]`, so details for all of them can be collected in one
// call (sometimes still just one shipment).
//
// `call_type` is still sent (currently always "SHIPMENT_GROUP") but is
// explicitly MDR-internal and "may change" per MDR — deliberately typed as
// a plain string, never validated against a fixed set or acted on beyond
// being stored/echoed back. See src/server/mdrCallRequest.ts.
export interface CallRequestPayload {
  mdr_call_id: string;
  call_type: string;
  contact: Contact;
  // Name of the company Everly says she is calling on behalf of / from
  // (spoken in the introduction and when asked). Optional.
  calling_from?: string;
  shipments: ShipmentInput[];
}

// The immediate ack, returned synchronously from POST /mdr/call-requests
// before the call has actually happened (integration guide §4). MDR saves
// all three fields.
export interface StartCallAck {
  success: true;
  mdr_call_id: string;
  voice_call_id: string;
  status: "QUEUED";
}

export interface ContactInfo {
  name: string | null;
  phone: string | null;
  email: string | null;
}

// One common result shape shared by every shipment on a call (integration
// guide §7A: "Use one common CALL_COMPLETED response structure ... Do not
// change the field names or response structure for different call
// types") — now applied PER SHIPMENT rather than once per call, since one
// call can cover several shipments. Every field nullable: true = confirmed
// yes, false = confirmed no, null = unknown/not asked/not applicable
// (§7A) — never fabricated.
//
// `next_action` is kept even though it's absent from the one worked
// CALL_COMPLETED example in the guide, because the guide's own prose
// (§7, listing what the client requires) names it explicitly alongside
// every other field that IS in the example. Flagged as unconfirmed in
// docs/requirements-tracker.md — drop it if MDR says it's not wanted.
export interface CommonCallResult {
  driver_confirmed: boolean | null;
  driver_assigned: boolean | null;
  equipment_assigned: boolean | null;
  pickup_completed: boolean | null;
  pickup_completed_at: string | null;
  delivery_completed: boolean | null;
  // Added 2026-10-06 — when delivery happened, "YYYY-MM-DD HH:MM:SS" in UTC
  // (same format as eta/pickup_completed_at, see server/timeFormat.ts).
  // Null unless delivery_completed is true and a time was given.
  delivery_completed_at: string | null;
  // Added 2026-09-29 — DISPATCHED's "Is the scheduled pickup date still
  // correct?" question had no matching field until now (see
  // resultSchema.ts's header comment for the invented-field-name issue
  // this caused).
  scheduled_pickup_date_correct: boolean | null;
  current_location: string | null;
  eta: string | null;
  delay: boolean | null;
  delay_minutes: number | null;
  delay_reason: string | null;
  issue_type: string | null;
  appointment_status: "CONFIRMED" | "NOT_CONFIRMED" | "COMPLETED" | "MISSED" | "UNKNOWN" | null;
  // Per-shipment now, sourced ONLY from the post-call structured
  // extraction (see src/server/webhookHandlers.ts's buildCommonResult) —
  // NOT OR'd with the mid-call flagHumanEscalation tool the way it used to
  // be. That tool is call-level (tools.ts's hard "never accept an
  // LLM-supplied ID" rule means it can't say WHICH shipment), so merging
  // it into every shipment's result would falsely mark every shipment on
  // the call as escalated when only one actually had an issue. The tool
  // flag is still stored on CallRequest.tool_flags for internal
  // visibility/audit.
  human_escalation_required: boolean;
  escalation_reason: string | null;
  // NOT nullable, unlike every field above — these are the AI's own
  // assessment of this shipment's portion of the call (see
  // resultSchema.ts), always populated even when every data field came
  // back null.
  confidence_score: number;
  // Named call_summary (not summary) at MDR's explicit request 2026-09-16,
  // so they can copy this value directly into the matching shipment's
  // previous_summary on their NEXT call request, without remapping field
  // names on their side.
  call_summary: string;
  next_action: string | null;
  // Requested by MDR 2026-09-16, so this shipment's unresolved issue can
  // be pushed forward and echoed back as that shipment's open_issue on
  // MDR's NEXT call request. Null if this call raised no outstanding issue
  // needing follow-up for this shipment.
  open_issue: string | null;
  // Folded in 2026-09-28 from the retired CONTACT_UPDATE_REQUEST call type
  // (it no longer exists as its own call type — see CLAUDE.md's "Contact
  // update requests" section) — now available on ANY shipment's result,
  // since MDR merged contact-detail collection into the general
  // SHIPMENT_GROUP format instead of keeping it a separate call type. Null
  // unless this shipment's questions actually asked for driver/dispatcher
  // contact info.
  driver: ContactInfo | null;
  dispatcher: ContactInfo | null;
  contacts_confirmed: boolean | null;
}

export interface ShipmentResult {
  shipment_id: string;
  // Echoed back exactly as MDR sent it on the matching inbound shipment —
  // see ShipmentInput.status. Never derived/computed.
  status: string | null;
  result: CommonCallResult;
}

// Same as ShipmentResult but for CALL_DROPPED/CALL_HANG, where a shipment
// may not have been reached at all before the call ended — its `result`
// is then effectively all-null/not-discussed rather than a completed
// extraction. NOTE: the exact shape MDR wants for a partial multi-shipment
// drop/hang hasn't been confirmed with a worked example (the old
// single-shipment `partial_result` shape doesn't cover this case) — this
// mirrors CALL_COMPLETED's per-shipment shape as the most consistent
// assumption. Flag in docs/requirements-tracker.md; confirm with MDR.
export interface PartialShipmentResult {
  shipment_id: string;
  status: string | null;
  result: Partial<CommonCallResult>;
}

interface WebhookEventBase {
  mdr_call_id: string;
  voice_call_id: string | null;
}

// The single MDR webhook (integration guide §5, §10, §13) takes a
// different payload shape per event_type — this is NOT one universal
// envelope with a status enum. VOICEMAIL/BUSY/CALL_FAILED are assumed to
// share NO_ANSWER's minimal shape (the guide lists them together in §5 but
// only shows a worked example for NO_ANSWER) — flagged as an assumption in
// docs/requirements-tracker.md.
//
// UPDATED 2026-09-28: event_type is now truly call-level (one event per
// call, confirmed by the user — matches MDR's example response), and
// CALL_COMPLETED carries a `shipments[]` array instead of one `result` —
// see ShipmentResult above. The old separate CONTACT_UPDATE_REQUEST
// CALL_COMPLETED variant is retired along with that call type; there is
// now only one CALL_COMPLETED shape.
export type VoiceWebhookEvent =
  | (WebhookEventBase & { event_type: "NO_ANSWER" })
  | (WebhookEventBase & { event_type: "VOICEMAIL" })
  | (WebhookEventBase & { event_type: "BUSY" })
  | (WebhookEventBase & { event_type: "CALL_FAILED" })
  | (WebhookEventBase & {
      event_type: "CALL_DROPPED";
      shipments: PartialShipmentResult[];
      call_summary: string | null;
    })
  // Same shape as CALL_DROPPED, confirmed by the user 2026-09-24 — see
  // CallRequest.ts's EVENT_TYPES comment for why these are two separate
  // event types now instead of one.
  | (WebhookEventBase & {
      event_type: "CALL_HANG";
      shipments: PartialShipmentResult[];
      call_summary: string | null;
    })
  | (WebhookEventBase & {
      event_type: "CALLBACK_REQUESTED";
      callback_after_minutes: number | null;
      call_summary: string | null;
    })
  | (WebhookEventBase & {
      event_type: "WRONG_CONTACT";
      // Nullable, not "": if the LLM called the tool without actually
      // capturing a name/phone (e.g. it responded before the caller
      // finished speaking), that's "we don't know," not "we asked and got
      // an empty answer" — never paper over it with an empty string.
      referred_contact: { name: string | null; phone: string | null };
    })
  | (WebhookEventBase & {
      event_type: "CALL_COMPLETED";
      // Echoed back exactly as MDR sent it (currently always
      // "SHIPMENT_GROUP") — see CallRequestPayload.call_type.
      call_type: string;
      call_status: "COMPLETED";
      shipments: ShipmentResult[];
      recording_url: string | null;
      transcript: string | null;
    });
