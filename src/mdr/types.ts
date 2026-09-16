import type { CALL_TYPES, CONTACT_TYPES, EVENT_TYPES } from "../db/models/CallRequest.js";

export type CallType = (typeof CALL_TYPES)[number];
export type ContactType = (typeof CONTACT_TYPES)[number];
export type EventType = (typeof EVENT_TYPES)[number];

export interface Contact {
  type: ContactType;
  name: string;
  phone: string;
}

// What MDR sends inbound on POST /mdr/call-requests, per the confirmed
// "MDR Agent 3 – Voice API Integration Guide" (§3). Shipment is left
// permissive — MDR may send additional TAI shipment/reference fields
// beyond the worked example.
export interface CallRequestPayload {
  mdr_call_id: string;
  call_type: CallType;
  contact: Contact;
  shipment: Record<string, unknown> & {
    shipment_id?: string;
  };
  // MDR now tells us explicitly which questions to prioritize on this call,
  // in addition to the call type's default set (see prompt.ts).
  questions?: string[];
  previous_summary?: string;
  open_issue?: string;
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

// One common result shape shared by every call type (integration guide
// §7A: "Use one common CALL_COMPLETED response structure ... Do not change
// the field names or response structure for different call types"). Every
// field nullable: true = confirmed yes, false = confirmed no, null =
// unknown/not asked/not applicable (§7A) — never fabricated.
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
  current_location: string | null;
  eta: string | null;
  delay: boolean | null;
  delay_minutes: number | null;
  delay_reason: string | null;
  issue_type: string | null;
  appointment_status: "CONFIRMED" | "NOT_CONFIRMED" | "COMPLETED" | "MISSED" | "UNKNOWN" | null;
  human_escalation_required: boolean;
  escalation_reason: string | null;
  // NOT nullable, unlike every field above — these are the AI's own
  // assessment of the call (see resultSchema.ts), always populated even
  // when every data field came back null.
  confidence_score: number;
  // Named call_summary (not summary) at MDR's explicit request 2026-09-16,
  // so they can copy this value directly into CallRequestPayload's
  // previous_summary field on their NEXT call request for this
  // shipment/contact, without remapping field names on their side.
  call_summary: string;
  next_action: string | null;
  // Requested by MDR 2026-09-16, so this call's unresolved issue can be
  // pushed forward and echoed back as CallRequestPayload.open_issue on
  // MDR's NEXT call request for this shipment (mirrors that inbound
  // field's name deliberately, to make the round-trip obvious). Null if
  // this call raised no outstanding issue needing follow-up — distinct
  // from delay_reason/issue_type, which describe the cause of a delay
  // rather than what still needs following up.
  open_issue: string | null;
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
export type VoiceWebhookEvent =
  | (WebhookEventBase & { event_type: "NO_ANSWER" })
  | (WebhookEventBase & { event_type: "VOICEMAIL" })
  | (WebhookEventBase & { event_type: "BUSY" })
  | (WebhookEventBase & { event_type: "CALL_FAILED" })
  | (WebhookEventBase & {
      event_type: "CALL_DROPPED";
      partial_result: Partial<CommonCallResult>;
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
      call_type: CallType;
      call_status: "COMPLETED";
      result: CommonCallResult;
      recording_url: string | null;
      transcript: string | null;
    });
