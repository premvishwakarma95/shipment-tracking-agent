import type { CallRequestDoc } from "../db/models/CallRequest.js";
import { describeUtcNow } from "./timeFormat.js";
import { STATUS_QUESTIONS, DISPATCHER_STATUS_QUESTIONS, DEFAULT_STATUS_QUESTIONS } from "../assistant/prompt.js";

// Maps a CallRequest into the flat object of every {{variable}} referenced
// in src/assistant/prompt.ts, passed as assistantOverrides.variableValues
// on call creation (Vapi does the {{var}} substitution at call time).
// Must be kept in sync with prompt.ts.
//
// CHANGED 2026-09-28: MDR moved from one shipment per call to an array of
// shipments per call. The old flat per-call variables (shipment_id,
// call_type, call_type_questions, mdr_questions_text,
// previous_summary_text, open_issue_text) are retired in favor of
// {{shipments_block}} — one rendered block per shipment, each with its own
// context/questions — plus {{shipment_ids_text}} for the voicemail
// message, which can't reasonably itemize per-shipment detail.
export function buildCallVariables(doc: CallRequestDoc): Record<string, string> {
  const shipments = (doc.shipments ?? []) as ShipmentLike[];
  const contact = describeContact(doc.contact);
  const now = new Date();

  return {
    // Company name from the payload's calling_from; generic wording if MDR
    // didn't send one (no company name is hardcoded anywhere).
    calling_from: doc.calling_from?.trim() || "our company",
    // Spoken at the very end of the call, drivers only.
    closing_wish: contact.isDriver ? " Drive safe." : " Have a good day.",
    call_start_utc: describeUtcNow(now),
    contact_context: contact.promptContext,
    contact_summary_note: contact.summaryNote,
    shipment_ids_text: shipments.map((s, i) => shipmentId(s, i)).join(", "),
    shipments_block: shipments.map((s, i) => renderShipmentBlock(s, i, contact.isDispatcher)).join("\n\n"),
    shipment_wording_rule: shipmentWordingRule(shipments.length),
  };
}

// Added 2026-10-06 after MDR feedback: with a single shipment the agent
// said "First, can you tell me where you are now?" — ordinal/transition
// wording only makes sense when there's more than one shipment. Rendered
// as a variable (not static prompt text) so the single-shipment case can
// explicitly override the multi-shipment "say its shipment ID once"
// instruction above it.
function shipmentWordingRule(count: number): string {
  if (count === 1) {
    return `This call covers exactly ONE shipment. Ask its questions directly, one at a time. Do NOT use ordinal or sequencing words such as "first", "second", "next", "then" or "finally" to introduce a question, do NOT say "for a different shipment", and do NOT say the shipment ID — it overrides the instruction above to say the ID. Just ask, e.g. "Where are you now?" or "What is your current ETA?".`;
  }
  return `This call covers ${count} shipments. Use sequencing words such as "first", "second" or "next" only to move between shipments, never between questions within the same shipment.`;
}

interface ShipmentLike {
  shipment_id?: unknown;
  status?: unknown;
  questions?: unknown;
  previous_summary?: unknown;
  open_issue?: unknown;
  [key: string]: unknown;
}

function shipmentId(shipment: ShipmentLike, index: number): string {
  return typeof shipment.shipment_id === "string" && shipment.shipment_id
    ? shipment.shipment_id
    : `unknown-${index + 1}`;
}

function renderShipmentBlock(shipment: ShipmentLike, index: number, isDispatcher: boolean): string {
  const id = shipmentId(shipment, index);
  const status = typeof shipment.status === "string" ? shipment.status.trim() : "";

  const previousSummary =
    typeof shipment.previous_summary === "string" && shipment.previous_summary
      ? shipment.previous_summary
      : "None on file — this is the first contact for this shipment.";

  const openIssue =
    typeof shipment.open_issue === "string" && shipment.open_issue
      ? shipment.open_issue
      : "None.";

  const mdrQuestions = renderMdrQuestions(shipment.questions);
  const details = renderShipmentDetails(shipment, status);
  const statusKey = resolveStatusKey(status);

  return `
## Shipment ${index + 1}: ${id}${status ? ` — status: ${status}` : ""}

Shipment details (share ONLY if the caller asks about them):
${details}

Previous summary: ${previousSummary}
Open issue to reconfirm: ${openIssue}

Questions MDR specifically wants answered for this shipment:
${mdrQuestions}

Default questions for this shipment's status:
${questionsForStatusKey(statusKey, isDispatcher)}
`.trim();
}

// Plain facts from the call request that a caller may ask about mid-call
// ("what's the pickup date?"). Only fields MDR actually sent are listed.
const DETAIL_FIELDS: Array<[string, string]> = [
  ["pickup_date", "Scheduled pickup date"],
  ["estimated_delivery_date", "Estimated delivery date"],
  ["delivery_appointment", "Delivery appointment time"],
  ["carrier_name", "Carrier"],
];

function renderShipmentDetails(shipment: ShipmentLike, status: string): string {
  const lines: string[] = [];
  if (status) lines.push(`- Status: ${status.replace(/_/g, " ").toLowerCase()}`);
  for (const [key, label] of DETAIL_FIELDS) {
    const v = shipment[key];
    if (typeof v === "string" && v.trim()) lines.push(`- ${label}: ${v.trim()}`);
  }
  return lines.length ? lines.join("\n") : "- (no extra details were provided)";
}

function renderMdrQuestions(questions: unknown): string {
  if (!Array.isArray(questions) || questions.length === 0) {
    return "None beyond the default questions below.";
  }
  return questions.map((q) => `- ${String(q)}`).join("\n");
}

// CHANGED 2026-09-28: MDR is moving to sending `status` as an exact
// uppercase-with-underscore value matching STATUS_QUESTIONS's keys
// directly (e.g. "OUT_FOR_DELIVERY") rather than free text — confirmed by
// the user, who is informing MDR of this expected format. Primary match is
// now an exact normalized-key lookup (uppercase, non-alphanumerics ->
// underscore), which also happens to still match the old free-text style
// ("Out for Delivery" normalizes to "OUT_FOR_DELIVERY") for backward
// compatibility during any transition. Substring keyword matching is kept
// only as a secondary fallback for wording that doesn't normalize to an
// exact key (e.g. "Out for Delivery Today"). Falls back to a generic
// question set (with a warning) rather than asking nothing for a shipment
// whose status doesn't match anything known.
const STATUS_KEYWORD_MAP: Array<{ keywords: string[]; key: keyof typeof STATUS_QUESTIONS }> = [
  { keywords: ["out for delivery"], key: "OUT_FOR_DELIVERY" },
  { keywords: ["pickup", "pick up", "pick-up"], key: "PICKUP_TODAY" },
  { keywords: ["dispatch"], key: "DISPATCHED" },
  { keywords: ["transit"], key: "IN_TRANSIT" },
  { keywords: ["contact update", "contact_update", "update contact"], key: "CONTACT_UPDATE_REQUEST" },
];

function normalizeStatusKey(status: string): string {
  return status
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function resolveStatusKey(status: string): keyof typeof STATUS_QUESTIONS | null {
  if (!status) return null;

  const normalized = normalizeStatusKey(status);
  if (normalized in STATUS_QUESTIONS) {
    return normalized as keyof typeof STATUS_QUESTIONS;
  }

  const lower = status.toLowerCase();
  for (const { keywords, key } of STATUS_KEYWORD_MAP) {
    if (keywords.some((k) => lower.includes(k))) {
      return key;
    }
  }

  return null;
}

function questionsForStatusKey(key: keyof typeof STATUS_QUESTIONS | null, isDispatcher: boolean): string {
  if (!key) {
    console.warn("[callVariables] shipment status didn't match any known question set — using default");
    return DEFAULT_STATUS_QUESTIONS;
  }
  if (isDispatcher && key in DISPATCHER_STATUS_QUESTIONS) {
    return DISPATCHER_STATUS_QUESTIONS[key];
  }
  return STATUS_QUESTIONS[key];
}

// The summaryNote deliberately omits the contact's NAME: when it included
// it, the extraction pass copied it into dispatcher_name even though no
// contact details were ever collected (confirmed 2026-10-06,
// LOCAL-DISPATCHED-TEST-015: dispatcher {name: "Test Dispatcher"} appeared
// in the result on a call that never asked for it).
//
// Added 2026-10-06 per MDR feedback: the model was never told who it was
// talking to, so a dispatcher's call could be summarized as "the driver
// confirmed ...". DISPATCHER and SECONDARY_DISPATCHER get the dispatcher
// question wording (DISPATCHER_STATUS_QUESTIONS); every other contact type
// (DRIVER, CARRIER_MAIN, AFTER_HOURS, CARRIER_REPRESENTATIVE) gets the
// default driver-facing wording — confirmed with the user 2026-10-06.
function describeContact(contact: CallRequestDoc["contact"] | undefined): {
  isDispatcher: boolean;
  isDriver: boolean;
  promptContext: string;
  summaryNote: string;
} {
  const type = contact?.type ?? "";
  const name = contact?.name?.trim() || "the contact";
  const isDispatcher = type === "DISPATCHER" || type === "SECONDARY_DISPATCHER";

  const role = (
    {
      DRIVER: "driver",
      DISPATCHER: "dispatcher",
      SECONDARY_DISPATCHER: "dispatcher",
      CARRIER_MAIN: "carrier representative",
      CARRIER_REPRESENTATIVE: "carrier representative",
      AFTER_HOURS: "after-hours contact",
    } as Record<string, string>
  )[type] ?? "contact";

  const promptContext = isDispatcher
    ? `You are speaking with ${name}, the ${role} — NOT the driver. Whenever you ask about the driver (location, ETA, delay, delivery), refer to "the driver" in the third person; "you" always means the ${role}.`
    : `You are speaking with ${name}, the ${role}. "You" in the questions below refers to them.`;

  const summaryNote = isDispatcher
    ? `The person on this call is the ${role} — NOT the driver. In every call_summary, attribute what they said to "the ${role}" (e.g. "The ${role} said the driver is ..."), and never call them "the driver".`
    : `The person on this call is the ${role}. In every call_summary, attribute what they said to "the ${role}", not to a different role.`;

  return { isDispatcher, isDriver: type === "DRIVER", promptContext, summaryNote };
}
