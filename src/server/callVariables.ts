import type { CallRequestDoc } from "../db/models/CallRequest.js";
import { STATUS_QUESTIONS, DEFAULT_STATUS_QUESTIONS } from "../assistant/prompt.js";

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

  return {
    shipment_ids_text: shipments.map((s, i) => shipmentId(s, i)).join(", "),
    shipments_block: shipments.map((s, i) => renderShipmentBlock(s, i)).join("\n\n"),
  };
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

function renderShipmentBlock(shipment: ShipmentLike, index: number): string {
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
  const statusKey = resolveStatusKey(status);

  return `
## Shipment ${index + 1}: ${id}${status ? ` — status: ${status}` : ""}

Previous summary: ${previousSummary}
Open issue to reconfirm: ${openIssue}

Questions MDR specifically wants answered for this shipment:
${mdrQuestions}

Default questions for this shipment's status:
${questionsForStatusKey(statusKey)}
`.trim();
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

function questionsForStatusKey(key: keyof typeof STATUS_QUESTIONS | null): string {
  if (!key) {
    console.warn("[callVariables] shipment status didn't match any known question set — using default");
    return DEFAULT_STATUS_QUESTIONS;
  }
  return STATUS_QUESTIONS[key];
}
