import type { CALL_STATUSES, CALL_TYPES, CONTACT_TYPES } from "../db/models/CallRequest.js";

export type CallType = (typeof CALL_TYPES)[number];
export type ContactType = (typeof CONTACT_TYPES)[number];
export type CallStatus = (typeof CALL_STATUSES)[number];

export interface Contact {
  type: ContactType;
  name: string;
  phone: string;
}

// What MDR sends inbound on POST /mdr/call-requests. Shipment is left
// permissive — MDR may send additional TAI shipment/reference fields
// beyond this example (the client requires MDR to have shipment,
// references, pickup/delivery, carrier, driver, timing, alert and document
// information available, but doesn't fix the exact wire shape).
export interface CallRequestPayload {
  mdr_call_id: string;
  call_type: CallType;
  contact: Contact;
  shipment: Record<string, unknown> & {
    shipment_id?: string;
    shipment_type?: string;
  };
  previous_interactions?: Array<{
    date: string;
    contact_type: ContactType;
    summary: string;
  }>;
  open_items?: string[];
}

// The result envelope pushed back to MDR once a call finishes. This shape
// is dictated by the client's own spec (§19 "Common Response Format"), not
// by MDR's internal API — it should stay stable even once the real
// endpoint/auth details in mdr/client.ts and mdr/api.ts are filled in.
// Every result.* field is nullable: unknown must be null, never fabricated.
export interface CallResultPayload {
  mdr_call_id: string;
  voice_call_id: string;
  call_type: CallType;
  call_status: CallStatus;
  answered: boolean;
  contact: Contact;
  result: {
    driver_confirmed: boolean | null;
    driver_assigned: boolean | null;
    equipment_assigned: boolean | null;
    pickup_date_confirmed: boolean | null;

    location: string | null;
    eta: string | null;
    previous_eta: string | null;
    eta_changed: boolean | null;

    delay: boolean | null;
    delay_minutes: number | null;
    delay_reason: string | null;
    traffic_issue: boolean | null;
    weather_issue: boolean | null;
    mechanical_issue: boolean | null;
    issue_type: string | null;

    appointment_status: "CONFIRMED" | "AT_RISK" | "UNKNOWN" | null;

    // Special-case outcome fields (mirrors CallRequest.tool_flags — set
    // mid-call via the LLM tools in src/assistant/tools.ts).
    referred_contact: { name: string; phone: string } | null;
    callback_requested: boolean | null;
    callback_time: string | null;
    email_requested: boolean | null;
    requested_email: string | null;

    // Partial capture for CALL_DROPPED — whatever was collected before the
    // disconnect, not backfilled or guessed.
    conversation_complete: boolean | null;
    information_collected: Record<string, unknown> | null;

    human_escalation_required: boolean | null;
    confidence_score: number | null;
    summary: string | null;
    next_action: string | null;
  };
  recording_url: string | null;
  transcript: string | null;
  started_at: string | null;
  ended_at: string | null;
}
