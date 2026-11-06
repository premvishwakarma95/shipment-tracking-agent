import { CallRequest, type CallRequestDoc } from "../db/models/CallRequest.js";
import { classifyEventType } from "./callOutcome.js";
import { normalizeMdrTimestamp } from "./timeFormat.js";
import { normalizePhoneE164 } from "./phoneFormat.js";
import { computeEta } from "./etaCalc.js";
import { sendVoiceWebhookEvent } from "../mdr/api.js";
import { sayAndEndCall, endCallSilently } from "../vapi/callControl.js";
import { getCall } from "../vapi/calls.js";
import { resolveStatusKey } from "./callVariables.js";
import { WRONG_NUMBER_MESSAGE, EMAIL_RESENT_LINE, CARRIER_REP_CLOSING } from "../assistant/prompt.js";
import type {
  CommonCallResult,
  ContactInfo,
  IvrNavigation,
  IvrOutcome,
  IvrStep,
  PartialShipmentResult,
  ShipmentResult,
  VoiceWebhookEvent,
} from "../mdr/types.js";

// Vapi's inbound webhook message shapes are permissive/`any`-typed here —
// this is an external contract we don't control the exact fields of, and
// RawCapture (see mdrCallRequest.ts's inbound equivalent, wired in
// index.ts) holds the raw payload if anything here needs to be fixed up
// later.

interface VapiToolCall {
  id: string;
  function: { name: string; arguments: Record<string, unknown> };
}

// Resolves by Vapi's own call ID, never by anything the LLM supplied
// mid-conversation — same hard rule as the reference project.
async function resolveByVapiCallId(vapiCallId: string): Promise<CallRequestDoc & { save: () => Promise<unknown> } | null> {
  return CallRequest.findOne({ vapi_call_id: vapiCallId }) as unknown as
    | (CallRequestDoc & { save: () => Promise<unknown> })
    | null;
}

export async function handleToolCalls(message: {
  call: { id: string };
  toolCallList: VapiToolCall[];
}) {
  const doc = await resolveByVapiCallId(message.call.id);
  if (!doc) {
    console.error(`[webhookHandlers] no CallRequest for vapi call ${message.call.id}`);
    return { results: [] };
  }

  const results: Array<{ toolCallId: string; result: string }> = [];

  for (const call of message.toolCallList ?? []) {
    try {
      const outcome = await applyToolCall(doc, call);
      results.push({ toolCallId: call.id, result: outcome ?? "ok" });
    } catch (err) {
      // One bad tool call must not kill the rest of the batch.
      console.error(`[webhookHandlers] tool call ${call.function.name} failed`, err);
      results.push({ toolCallId: call.id, result: "error" });
    }
  }

  await doc.save();
  return { results };
}

// IVR navigation limits (2026-11-03): menu depth, total key presses.
const IVR_MAX_DEPTH = 4;
const IVR_MAX_PRESSES = 6;
const IVR_FAILURE_REASONS = ["IVR_NO_MATCH", "IVR_DEAD_END", "IVR_LOOP", "IVR_NO_ANSWER"];
// The agent's own introduction is the proof that a person came on after the menu.
// Only reliable on the FINAL transcript: Vapi's live GET /call/{id} has no transcript
// or messages while the call is running (probed 2026-11-06), so nothing can judge
// "has a person spoken yet?" mid-call. A server-side hold timer built on that ended a
// good call at 145 s (call 01a1ad03) and was removed.
const INTRO_SPOKEN = /AI:[^\n]*this is Everly/i;
// A first-menu failure report earlier than this (since the call was created) is
// premature: the greeting/extension notice comes before any option is read out
// (call 01a1a7f4 failed at ~12 s, before BBL read option 2 at ~20 s).
const IVR_MIN_SECONDS_BEFORE_FAILURE = 25;

// Path through the phone menu for the result; null when no menu was met.
function buildIvrNavigation(doc: CallRequestDoc, eventType: string): IvrNavigation | null {
  const steps = (doc.tool_flags.ivr_steps ?? []) as IvrStep[];
  const failure = doc.tool_flags.ivr_failure_reason ?? null;
  if (steps.length === 0 && !failure) return null;
  const outcome: IvrOutcome = failure
    ? (failure as IvrOutcome)
    : eventType === "VOICEMAIL"
      ? "VOICEMAIL"
      : "REACHED_PERSON";
  return { detected: true, outcome, reason: failure, steps };
}

// Keys pressed with Vapi's built-in dtmf tool never reach our webhook; read them
// (and the menu text just before each one) from the end-of-call message log.
function deriveIvrStepsFromMessages(messages: Array<Record<string, any>> | undefined): IvrStep[] {
  const steps: IvrStep[] = [];
  let lastHeard = "";
  for (const m of messages ?? []) {
    if (m.role === "user" && typeof m.message === "string") lastHeard = m.message.trim();
    for (const t of m.toolCalls ?? []) {
      if (t?.function?.name !== "dtmf") continue;
      let keys = "";
      try {
        const a = typeof t.function.arguments === "string" ? JSON.parse(t.function.arguments) : t.function.arguments;
        keys = String(a?.keys ?? "");
      } catch {
        /* unreadable arguments: keep empty */
      }
      steps.push({
        level: steps.length + 1,
        menu_options: lastHeard ? [lastHeard.slice(0, 300)] : [],
        key_pressed: keys,
        option_selected: null,
        confidence: null,
      });
    }
  }
  return steps;
}

const IVR_REASON_TEXT: Record<string, string> = {
  IVR_NO_MATCH: "no option on the menu was suitable for a shipment update",
  IVR_DEAD_END: "the menu led to a dead end",
  IVR_LOOP: "the menu kept repeating",
  IVR_NO_ANSWER: "no person came on the line after the menu",
};

// call_summary for a NO_ACTION call: describes the phone-menu flow, not a conversation.
function ivrCallSummary(doc: CallRequestDoc): string {
  const steps = (doc.tool_flags.ivr_steps ?? []) as IvrStep[];
  const why = IVR_REASON_TEXT[doc.tool_flags.ivr_failure_reason ?? ""] ?? "no suitable option was found";
  const path =
    steps.length > 0
      ? `The agent navigated ${steps.length} menu level${steps.length === 1 ? "" : "s"} (keys pressed: ${steps.map((st) => st.key_pressed).join(", ")})`
      : "The agent pressed no key";
  return `The call reached an automated phone menu (IVR), not a person. ${path}, but ${why}, so the call was ended. No shipment update was collected on this call.`;
}

async function applyToolCall(doc: CallRequestDoc, call: VapiToolCall): Promise<string | undefined> {
  const args = call.function.arguments ?? {};

  switch (call.function.name) {
    case "reportWrongContact": {
      const referredName = (args.referred_name as string) ?? null;
      const referredPhone = (args.referred_phone as string) ?? null;
      doc.tool_flags.wrong_contact = true;
      doc.tool_flags.referred_contact = { name: referredName, phone: referredPhone };

      // No referral given = the wrong-number case (see prompt.ts's
      // Introduction section): the LLM says nothing itself, so OUR server
      // speaks MDR's exact closing line and ends the call deterministically
      // via Live Call Control, rather than relying on the model to say a
      // custom line and then somehow hang up — see callControl.ts for why.
      if (!referredName && !referredPhone && doc.control_url) {
        await sayAndEndCall(doc.control_url, WRONG_NUMBER_MESSAGE);
      }
      return;
    }
    case "reportCallbackRequested":
      doc.tool_flags.callback_requested = true;
      doc.tool_flags.callback_after_minutes = (args.callback_after_minutes as number) ?? null;
      return;
    case "reportEmailRequested":
      // No separate event_type (MDR confirmed 2026-10-23): the flag is sent as
      // email_requested in each shipment's result, see buildCommonResult.
      doc.tool_flags.email_requested = true;
      doc.tool_flags.requested_email = (args.requested_email as string) ?? null;
      // Carrier representative: MDR wants the call to simply wrap up after a
      // resend request. The model either skipped the resend line and hung up, or
      // (with a tool-level message) went silent for ~15 s (calls 01a18204,
      // 01a18214), so OUR server says the line + closing and ends the call.
      if (doc.contact?.type === "CARRIER_REPRESENTATIVE" && doc.control_url) {
        await sayAndEndCall(doc.control_url, `${EMAIL_RESENT_LINE} ${CARRIER_REP_CLOSING}`);
        return "Recorded. The system is confirming the resend to the caller and ending the call — say nothing and call no tool.";
      }
      return;
    case "flagHumanEscalation":
      // Call-level only — see mdr/types.ts's CommonCallResult.
      // human_escalation_required comment for why this isn't merged into
      // any individual shipment's result.
      doc.tool_flags.human_escalation_required = true;
      doc.tool_flags.escalation_reason = (args.escalation_reason as string) ?? null;
      return;
    case "reportIvrStep": {
      const steps = [...((doc.tool_flags.ivr_steps ?? []) as IvrStep[])];
      const options = Array.isArray(args.menu_options) ? (args.menu_options as unknown[]).map(String) : [];
      const key = String(args.key_pressed ?? "");
      const menuKey = options.map((o) => o.toLowerCase().replace(/\s+/g, " ").trim()).sort().join("|");
      const seen = steps.filter(
        (s) => s.menu_options.map((o) => o.toLowerCase().replace(/\s+/g, " ").trim()).sort().join("|") === menuKey,
      ).length;
      steps.push({
        level: Number(args.level) || steps.length + 1,
        menu_options: options,
        key_pressed: key,
        option_selected: typeof args.option_selected === "string" ? args.option_selected : null,
        confidence: typeof args.confidence === "number" ? args.confidence : null,
      });
      doc.tool_flags.ivr_steps = steps;
      if (seen >= 2) return "This same menu has now repeated three times — stop. Call reportIvrFailure with IVR_LOOP.";
      if (steps.length >= IVR_MAX_PRESSES || steps[steps.length - 1]!.level > IVR_MAX_DEPTH) {
        return "Navigation limit reached — stop. Call reportIvrFailure with IVR_DEAD_END.";
      }
      return "ok. If a person has spoken to you (a greeting such as the company name, \"dispatch\", \"how can I help?\"), give the introduction now, in full, with no filler first. Otherwise say nothing and keep listening for the next menu or a person.";
    }
    case "reportIvrFailure": {
      const reason = String(args.reason ?? "");
      // First menu, reported before any option could have been read: refuse and keep listening.
      const createdAt = (doc as unknown as { createdAt?: Date }).createdAt;
      const elapsed = createdAt ? (Date.now() - createdAt.getTime()) / 1000 : Infinity;
      if (
        (reason === "IVR_NO_MATCH" || reason === "IVR_DEAD_END") &&
        ((doc.tool_flags.ivr_steps ?? []) as IvrStep[]).length === 0 &&
        elapsed < IVR_MIN_SECONDS_BEFORE_FAILURE
      ) {
        console.warn(`[webhookHandlers] ${doc.vapi_call_id}: ${reason} reported after ${elapsed.toFixed(0)}s with no options heard — refused, keep listening`);
        return "Not yet — the menu has not finished and its options may still be coming (the greeting or an extension notice is not the menu). Say nothing, keep listening until the options (\"press 1 …\") have been read, and only then, if none fits, call reportIvrFailure again.";
      }
      doc.tool_flags.ivr_failure_reason = IVR_FAILURE_REASONS.includes(reason) ? reason : "IVR_DEAD_END";
      if (doc.control_url) await endCallSilently(doc.control_url);
      return "Recorded. The call is ending — say nothing.";
    }
    default:
      throw new Error(`unknown tool: ${call.function.name}`);
  }
}

// Vapi's own recordingUrl is a private storage path that can't be played
// without credentials. MDR gets our public proxy link instead (see
// recordings.ts): <base>/recordings/<vapi_call_id>?key=<key>, add
// &download=1 to download.
function buildPlayableRecordingUrl(vapiCallId: string): string {
  const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.RECORDINGS_PROXY_SECRET ?? "";
  return `${base}/recordings/${vapiCallId}?key=${key}`;
}

export async function handleEndOfCallReport(message: {
  call: { id: string };
  endedReason?: string;
  recordingUrl?: string;
  transcript?: string;
  startedAt?: string;
  endedAt?: string;
  analysis?: { structuredData?: Record<string, unknown> };
  artifact?: { messages?: Array<Record<string, any>> };
}) {
  const doc = await resolveByVapiCallId(message.call.id);
  if (!doc) {
    console.error(`[webhookHandlers] no CallRequest for vapi call ${message.call.id}`);
    return;
  }

  let structured = message.analysis?.structuredData ?? {};
  // RETRY FALLBACK, added 2026-09-29 — real test calls showed
  // analysis.structuredData sometimes entirely absent from this webhook
  // even when the conversation was clean and complete, while a follow-up
  // GET /call/{id} moments later HAD it. Root-caused as a race: Vapi's
  // own docs say structured-data analysis "typically completes within a
  // few seconds" after the call ends, but end-of-call-report fires
  // immediately at call end — sometimes before that analysis pass
  // finishes. Investigated migrating to Vapi's newer Structured Outputs
  // API instead (their docs recommend it over analysisPlan for
  // reliability) but its own docs are contradictory about persistence/
  // webhook delivery (one page says results are stored and retrievable,
  // another says "NOT stored... webhook access only") — too big a risk to
  // build on blind. This polls the same GET /call/{id} endpoint already
  // used reliably elsewhere in this codebase instead.
  if (!hasStructuredShipments(structured)) {
    const recovered = await pollForStructuredData(message.call.id);
    if (recovered) structured = recovered;
  }
  // Backstop: the agent sometimes says "I've had the email resent" without
  // having called reportEmailRequested (STG-CU-CR-004), so MDR would never see
  // the flag. If the transcript has the line and the tool flag is missing, set
  // it (address on record unless the tool captured another).
  if (!doc.tool_flags.email_requested && /AI:[^\n]*had the email resent/i.test(message.transcript ?? "")) {
    doc.tool_flags.email_requested = true;
    doc.tool_flags.requested_email = doc.contact?.email ?? null;
    console.warn(`[webhookHandlers] ${message.call.id}: resend line spoken but reportEmailRequested not called — flag set from transcript`);
  }
  // The keys actually pressed (Vapi's dtmf tool) come from Vapi's own message log —
  // authoritative, unlike reportIvrStep which the model skips or mislabels (calls
  // 01a1a03d, 01a1a0c0). The model's reported menu options / chosen option / confidence
  // are merged in by position when it did report.
  const derived = deriveIvrStepsFromMessages(message.artifact?.messages);
  if (derived.length > 0) {
    const reported = (doc.tool_flags.ivr_steps ?? []) as IvrStep[];
    if (reported.length !== derived.length) {
      console.warn(`[webhookHandlers] ${message.call.id}: ${derived.length} dtmf press(es) vs ${reported.length} reportIvrStep call(s) — using the message log`);
    }
    doc.tool_flags.ivr_steps = derived.map((d, i) => {
      const r = reported[i];
      return {
        level: i + 1,
        menu_options: r && r.key_pressed === d.key_pressed && r.menu_options.length ? r.menu_options : d.menu_options,
        key_pressed: d.key_pressed,
        option_selected: r && r.key_pressed === d.key_pressed ? r.option_selected : null,
        confidence: r && r.key_pressed === d.key_pressed ? r.confidence : null,
      };
    });
  }
  // A menu was navigated but no person ever came on (hold messages, then the line
  // dropped): NO_ACTION, not CALL_HANG. Voicemail endings stay VOICEMAIL.
  if (
    (doc.tool_flags.ivr_steps ?? []).length > 0 &&
    !doc.tool_flags.ivr_failure_reason &&
    message.endedReason !== "voicemail" &&
    !INTRO_SPOKEN.test(message.transcript ?? "")
  ) {
    doc.tool_flags.ivr_failure_reason = "IVR_NO_ANSWER";
    console.warn(`[webhookHandlers] ${message.call.id}: menu navigated but no person came on — IVR_NO_ANSWER`);
  }
  const eventType = classifyEventType(
    message.endedReason,
    doc.tool_flags,
    structured.call_ended_abruptly as boolean | undefined,
    message.transcript,
  );

  // Split 2026-09-29 per the user's direction — structured_result stores
  // just the shipments array directly (not wrapped in the raw
  // { shipments, call_ended_abruptly } object), and call_ended_abruptly
  // is its own top-level field. FURTHER CHANGED 2026-09-29: built via
  // buildShipmentResults (the same function used for the actual MDR
  // payload) rather than the raw Vapi extraction — MDR requires the
  // nested driver/dispatcher: {name, phone, email} shape (matching
  // production's original format), but resultSchema.ts's extraction
  // schema deliberately stays FLAT (driver_name/driver_phone/...) for
  // extraction reliability (see that file's header comment — nested
  // objects were a real cause of dropped/failed extractions earlier
  // today). This keeps that fix intact while still storing the nested
  // shape internally, by reshaping at storage time instead of reverting
  // the schema. Each entry's `result` fields are spread directly onto the
  // shipment object (no `result` wrapper) — that wrapper is specific to
  // the outbound MDR contract (VoiceWebhookEvent's ShipmentResult), not
  // wanted in this internal debug copy.
  doc.started_at = message.startedAt ? new Date(message.startedAt) : null;
  doc.ended_at = message.endedAt ? new Date(message.endedAt) : null;
  doc.structured_result = buildShipmentResults(doc, structured).map(({ shipment_id, status, result }) => ({
    shipment_id,
    status,
    ...result,
  }));
  if (eventType === "NO_ACTION") {
    const ivrSummary = ivrCallSummary(doc);
    doc.structured_result = (doc.structured_result as Array<Record<string, unknown>>).map((r) => ({ ...r, call_summary: ivrSummary }));
  }
  // The extraction misreads a phone menu as an abrupt end; not meaningful for NO_ACTION.
  doc.call_ended_abruptly = eventType === "NO_ACTION" ? null : ((structured.call_ended_abruptly as boolean) ?? null);
  doc.event_type = eventType;
  doc.recording_url = message.recordingUrl ? buildPlayableRecordingUrl(message.call.id) : null;
  doc.transcript = message.transcript ?? null;
  doc.lifecycle_status = "COMPLETED";

  const event = buildWebhookEvent(doc, structured, eventType);
  const ivrNavigation = buildIvrNavigation(doc, eventType);
  if (ivrNavigation) event.ivr_navigation = ivrNavigation;
  await doc.save();

  // Idempotency guard: if a retried end-of-call-report webhook arrives
  // (Vapi retries on non-2xx), don't push to MDR twice.
  if (doc.mdr_pushed_at) return;

  const pushed = await sendVoiceWebhookEvent(event);
  if (pushed) {
    doc.mdr_pushed_at = new Date();
    await doc.save();
  }
  // On failure, mdr_pushed_at stays null — left for manual reconciliation,
  // see docs/requirements-tracker.md. No retry queue in v1.
}

// True only if `shipments` is present AND non-empty — an empty/missing
// object (Vapi's failure signature, see handleEndOfCallReport) doesn't
// count, but neither does a technically-non-empty object missing the one
// field that actually matters downstream.
function hasStructuredShipments(structured: Record<string, unknown>): boolean {
  return Array.isArray(structured.shipments) && structured.shipments.length > 0;
}

const POLL_MAX_ATTEMPTS = 4;
const POLL_DELAY_MS = 3000;

async function pollForStructuredData(vapiCallId: string): Promise<Record<string, unknown> | null> {
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_DELAY_MS));
    try {
      const call = await getCall(vapiCallId);
      const structured = call.analysis?.structuredData;
      if (structured && hasStructuredShipments(structured)) {
        console.log(
          `[webhookHandlers] recovered structuredData via poll (attempt ${attempt}/${POLL_MAX_ATTEMPTS}) for call ${vapiCallId}`,
        );
        return structured;
      }
    } catch (err) {
      console.warn(`[webhookHandlers] poll attempt ${attempt}/${POLL_MAX_ATTEMPTS} for call ${vapiCallId} failed`, err);
    }
  }
  console.warn(
    `[webhookHandlers] structuredData still missing after ${POLL_MAX_ATTEMPTS} poll attempts for call ${vapiCallId} — giving up`,
  );
  return null;
}

interface ShipmentRecord {
  shipment_id?: unknown;
  status?: unknown;
  estimated_delivery_date?: unknown;
  delivery_appointment?: unknown;
  [key: string]: unknown;
}

const NOT_REACHED_SUMMARY = "Not discussed on this call.";

// One entry per shipment MDR sent on the inbound request (doc.shipments is
// the source of truth for WHICH shipments to report — not the extraction
// output, so a shipment the call never reached still gets an entry rather
// than silently vanishing from the response). Each entry's data comes from
// the matching item in the post-call structured extraction's `shipments[]`
// array (see resultSchema.ts), matched by shipment_id.
export function buildShipmentResults(
  doc: CallRequestDoc,
  structured: Record<string, unknown>,
): ShipmentResult[] {
  const inboundShipments = (doc.shipments ?? []) as ShipmentRecord[];
  const extractedRaw = structured.shipments;
  const extracted = Array.isArray(extractedRaw) ? (extractedRaw as Record<string, unknown>[]) : [];
  const byId = new Map(extracted.map((s) => [String(s.shipment_id ?? ""), s]));

  // Fallback for extraction entries whose shipment_id matches none of the
  // inbound shipments (e.g. "" because the agent never spoke that
  // shipment's ID — LOCAL-PREV-002 reported its first shipment as "Not
  // discussed" for that reason). Shipments are worked in order, so hand these
  // entries, in order, to the inbound shipments that found no match by ID.
  const inboundIds = new Set(inboundShipments.map((s) => (typeof s.shipment_id === "string" ? s.shipment_id : "")));
  const orphans = extracted.filter((e) => !inboundIds.has(String(e.shipment_id ?? "")));
  const unmatchedInbound = inboundShipments.filter(
    (s) => !(typeof s.shipment_id === "string" && byId.has(s.shipment_id)),
  );
  const orphanFor = new Map<ShipmentRecord, Record<string, unknown>>();
  if (inboundShipments.length > 1) {
    unmatchedInbound.forEach((s, i) => {
      if (orphans[i]) orphanFor.set(s, orphans[i]);
    });
  }

  // Reference "now" for ETA arithmetic: when the call actually started
  // (started_at is set from Vapi's report before this runs), else when we
  // created the request.
  const callTime =
    doc.started_at ?? (doc as unknown as { createdAt?: Date }).createdAt ?? new Date();

  return inboundShipments.map((shipment, index) => {
    const shipmentId =
      typeof shipment.shipment_id === "string" && shipment.shipment_id
        ? shipment.shipment_id
        : `unknown-${index + 1}`;
    // Single-shipment calls don't speak the shipment ID aloud (see
    // callVariables.ts's shipmentWordingRule), so the extraction pass has
    // no ID to attribute its entry to and returns shipment_id empty — with
    // exactly one inbound shipment and one extracted entry there's nothing
    // to disambiguate, so pair them directly instead of reporting the
    // shipment as "not reached" (confirmed 2026-10-06, LOCAL-DRIVER-001).
    const match =
      byId.get(shipmentId) ??
      orphanFor.get(shipment) ??
      (inboundShipments.length === 1 && extracted.length === 1 ? extracted[0] : undefined);
    if (!match) {
      console.warn(
        `[webhookHandlers] no extraction result for shipment ${shipmentId} on call ${doc.vapi_call_id} — likely not reached before the call ended`,
      );
    }
    return {
      shipment_id: shipmentId,
      status: typeof shipment.status === "string" ? shipment.status : null,
      result: buildCommonResult(match ?? {}, doc.tool_flags, !match, shipment, callTime),
    };
  });
}

// Builds one shipment's CommonCallResult from its slice of the post-call
// structured extraction. `notReached` is true when the call ended before
// this shipment came up at all (no matching extraction entry) — reported
// as an all-null result with an explanatory call_summary rather than a
// fabricated one.
function buildCommonResult(
  structured: Record<string, unknown>,
  toolFlags: CallRequestDoc["tool_flags"],
  notReached: boolean,
  inboundShipment: ShipmentRecord,
  callTime: Date,
): CommonCallResult {
  // A shipment the extraction returned nothing for, on a call where the contact
  // asked for the update email to be (re)sent and gave no update: say so
  // instead of "Not discussed on this call." (checked 2026-10-24, LOCAL-CR-008).
  const emailOnlyShipment = notReached && Boolean(toolFlags?.email_requested);
  const driver = contactInfoFromFlatFields(structured.driver_name, structured.driver_phone, structured.driver_email);
  const dispatcher = contactInfoFromFlatFields(
    structured.dispatcher_name,
    structured.dispatcher_phone,
    structured.dispatcher_email,
  );
  const etaValue = computeEta(structured, inboundShipment, callTime);
  // CONTACT_UPDATE_REQUEST only (MDR, 2026-11-04): derived in code from what was
  // actually captured, not guessed by the model. Confirming unchanged contacts is
  // not an update (contacts_confirmed, all contact fields null). driver_assigned /
  // driver_confirmed are contact answers, so they do not count as shipment info.
  const isContactUpdateShipment = resolveStatusKey(String(inboundShipment.status ?? "")) === "CONTACT_UPDATE_REQUEST";
  const shipmentInfoGiven = [
    structured.current_location,
    etaValue,
    structured.delay,
    structured.delay_minutes,
    structured.delay_reason,
    structured.delivery_completed,
    structured.delivery_completed_at,
    structured.pickup_completed,
    structured.pickup_completed_at,
    structured.equipment_assigned,
  ].some((v) => v !== undefined && v !== null && v !== "") ||
    (structured.appointment_status !== undefined && structured.appointment_status !== null && structured.appointment_status !== "UNKNOWN");
  return {
    driver_confirmed: (structured.driver_confirmed as boolean) ?? null,
    driver_assigned: (structured.driver_assigned as boolean) ?? null,
    equipment_assigned: (structured.equipment_assigned as boolean) ?? null,
    pickup_completed: (structured.pickup_completed as boolean) ?? null,
    pickup_completed_at: normalizeMdrTimestamp(structured.pickup_completed_at, "pickup_completed_at"),
    delivery_completed: (structured.delivery_completed as boolean) ?? null,
    delivery_completed_at: normalizeMdrTimestamp(structured.delivery_completed_at, "delivery_completed_at"),
    scheduled_pickup_date_correct: (structured.scheduled_pickup_date_correct as boolean) ?? null,

    current_location: (structured.current_location as string) ?? null,
    // Computed in code from what the caller said (eta_kind + numbers) and
    // the shipment's own schedule — see etaCalc.ts.
    eta: etaValue,

    delay: (structured.delay as boolean) ?? null,
    delay_minutes: (structured.delay_minutes as number) ?? null,
    delay_reason: (structured.delay_reason as string) ?? null,
    issue_type: (structured.issue_type as string) ?? null,

    appointment_status:
      (structured.appointment_status as CommonCallResult["appointment_status"]) ?? null,

    // Per-shipment escalation comes ONLY from the extraction pass now —
    // deliberately NOT OR'd with toolFlags.human_escalation_required the
    // way the old single-shipment code combined the two signals. The
    // flagHumanEscalation tool is call-level (tools.ts's hard "never
    // accept an LLM-supplied ID" rule means it can't say WHICH shipment),
    // so merging it into every shipment's result here would falsely mark
    // every shipment on the call as escalated when only one actually had
    // an issue. Confirmed empirically (2026-09-28 multi-shipment
    // extraction test) that the extraction pass alone reliably attributes
    // fields to the correct shipment — revisit this if that stops holding
    // up on real multi-shipment calls. toolFlags.human_escalation_required
    // is still recorded on CallRequest for internal visibility/audit.
    human_escalation_required: Boolean(structured.human_escalation_required),
    escalation_reason: (structured.escalation_reason as string) ?? null,

    // Defensive fallback only — resultSchema.ts's `required` list and
    // extraction prompt should already force these two to always be
    // present for a shipment that WAS reached. If still missing (and the
    // shipment was reached), that's the extraction pass misbehaving, not a
    // real "unconfirmed" case, so warn loudly rather than silently sending
    // MDR a fabricated-looking default.
    confidence_score: emailOnlyShipment
      ? 1
      : notReached
      ? 0
      : valueOrWarnDefault(structured.confidence_score as number | undefined, 0, "confidence_score"),
    call_summary: emailOnlyShipment
      ? EMAIL_ONLY_SUMMARY
      : notReached
      ? NOT_REACHED_SUMMARY
      : valueOrWarnDefault(structured.call_summary as string | undefined, "No summary available.", "call_summary"),
    next_action: (structured.next_action as string) ?? null,
    open_issue: (structured.open_issue as string) ?? null,

    // FLATTENED 2026-09-28 — resultSchema.ts now extracts flat
    // driver_name/driver_phone/driver_email fields (not a nested driver
    // object) to improve extraction reliability; reconstructed into the
    // nested ContactInfo shape here since that's the unchanged, confirmed
    // outbound contract to MDR. See resultSchema.ts's file header comment.
    driver,
    dispatcher,
    contacts_confirmed: (structured.contacts_confirmed as boolean) ?? null,
    // Call-level flag from the reportEmailRequested tool, repeated on each
    // shipment's result; null when nobody asked for the email.
    email_requested: toolFlags?.email_requested ? true : null,
    requested_email:
      toolFlags?.email_requested &&
      typeof toolFlags.requested_email === "string" &&
      EMAIL_PATTERN.test(toolFlags.requested_email.trim())
        ? toolFlags.requested_email.trim()
        : null,
    shipment_update: isContactUpdateShipment ? !notReached && shipmentInfoGiven : null,
    contact_update: isContactUpdateShipment ? !notReached && (driver !== null || dispatcher !== null) : null,
  };
}

// Deliberately simple/permissive (RFC 5322 has far more valid shapes than
// this) — the point isn't strict validation, it's a deterministic backstop
// against the LLM extraction confidently returning obvious garbage (e.g.
// "pests at error", confirmed empirically 2026-09-24, TEST-CONTACT-
// UPDATE-003 — that specific case was already correctly left null by the
// extraction, but this exists so a similarly garbled value NEVER reaches
// MDR even if the extraction's judgment is wrong some other time).
const EMAIL_ONLY_SUMMARY =
  "The contact asked for the update email to be resent; no shipment update was given for this shipment on this call.";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Reconstructs a nested ContactInfo from resultSchema.ts's flat
// driver_*/dispatcher_* extraction fields — null (not an all-null object)
// when nothing at all was captured, same semantics the old nested-object
// version had.
function contactInfoFromFlatFields(name: unknown, phone: unknown, email: unknown): ContactInfo | null {
  const n = typeof name === "string" && name ? name : null;
  // Country code always included (+1 default) — see phoneFormat.ts.
  const rawPhone = typeof phone === "string" && phone ? phone : null;
  let p = normalizePhoneE164(rawPhone);
  if (rawPhone && !p) {
    // The caller did give a number, it just isn't a valid E.164 one (e.g.
    // too short) — keep the digits as heard rather than losing it; MDR
    // can see it and the agent already read it back to the caller.
    const digitsOnly = rawPhone.replace(/\D/g, "");
    console.warn(`[webhookHandlers] extraction returned non-standard phone "${rawPhone}" — keeping digits "${digitsOnly}"`);
    p = digitsOnly || null;
  }
  let e = typeof email === "string" && email ? email : null;
  if (e && !EMAIL_PATTERN.test(e)) {
    console.warn(`[webhookHandlers] extraction returned malformed email "${e}" — dropping to null`);
    e = null;
  }
  if (!n && !p && !e) return null;
  return { name: n, phone: p, email: e };
}

function valueOrWarnDefault<T>(value: T | undefined | null, fallback: T, field: string): T {
  if (value === undefined || value === null) {
    console.warn(`[webhookHandlers] structured extraction omitted required field "${field}" — using fallback`);
    return fallback;
  }
  return value;
}

// Whole-call summary for CALL_DROPPED/CALL_HANG — joins whichever
// shipments actually got discussed. ASSUMPTION, not confirmed by MDR: the
// old single-shipment code had one natural call_summary; there's no worked
// multi-shipment example for a dropped/hung call yet. Flag in
// docs/requirements-tracker.md; revisit once MDR gives a real example.
function summarizePartialShipments(shipments: PartialShipmentResult[]): string | null {
  const summaries = shipments
    .map((s) => s.result.call_summary)
    .filter((summary): summary is string => Boolean(summary) && summary !== NOT_REACHED_SUMMARY);
  return summaries.length > 0 ? summaries.join(" ") : null;
}

function buildWebhookEvent(
  doc: CallRequestDoc,
  structured: Record<string, unknown>,
  eventType: VoiceWebhookEvent["event_type"],
): VoiceWebhookEvent {
  const voiceCallId = doc.vapi_call_id ?? null;

  switch (eventType) {
    case "NO_ANSWER":
    case "VOICEMAIL":
    case "BUSY":
    case "CALL_FAILED":
      return { event_type: eventType, mdr_call_id: doc.mdr_call_id, voice_call_id: voiceCallId };

    // Identical construction, only event_type differs — see CallRequest.ts's
    // EVENT_TYPES comment for what distinguishes the two (classifyEventType
    // in callOutcome.ts is where that distinction is actually decided).
    case "CALL_DROPPED":
    case "CALL_HANG": {
      const shipments = buildShipmentResults(doc, structured) as PartialShipmentResult[];
      return {
        event_type: eventType,
        mdr_call_id: doc.mdr_call_id,
        voice_call_id: voiceCallId,
        shipments,
        call_summary: summarizePartialShipments(shipments),
        recording_url: doc.recording_url ?? null,
        transcript: doc.transcript ?? null,
      };
    }

    case "NO_ACTION":
      return {
        event_type: "NO_ACTION",
        mdr_call_id: doc.mdr_call_id,
        voice_call_id: voiceCallId,
        call_summary: ivrCallSummary(doc),
        recording_url: doc.recording_url ?? null,
        transcript: doc.transcript ?? null,
      };

    case "CALLBACK_REQUESTED":
      return {
        event_type: "CALLBACK_REQUESTED",
        mdr_call_id: doc.mdr_call_id,
        voice_call_id: voiceCallId,
        callback_after_minutes: doc.tool_flags.callback_after_minutes ?? null,
        call_summary: (structured.call_summary as string) ?? null,
      };

    case "WRONG_CONTACT":
      return {
        event_type: "WRONG_CONTACT",
        mdr_call_id: doc.mdr_call_id,
        voice_call_id: voiceCallId,
        referred_contact: {
          name: doc.tool_flags.referred_contact?.name ?? null,
          phone: doc.tool_flags.referred_contact?.phone ?? null,
        },
      };

    case "CALL_COMPLETED":
      return {
        event_type: "CALL_COMPLETED",
        mdr_call_id: doc.mdr_call_id,
        voice_call_id: voiceCallId,
        call_type: doc.call_type,
        call_status: "COMPLETED",
        shipments: buildShipmentResults(doc, structured),
        recording_url: doc.recording_url ?? null,
        transcript: doc.transcript ?? null,
      };
  }
}
