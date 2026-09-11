import type { CallRequestDoc } from "../db/models/CallRequest.js";
import { CALL_TYPE_QUESTIONS, FIRST_MESSAGE } from "../assistant/prompt.js";

// Maps a CallRequest into the flat object of every {{variable}} referenced
// in src/assistant/prompt.ts, passed as assistantOverrides.variableValues
// on call creation (Vapi does the {{var}} substitution at call time).
// Must be kept in sync with prompt.ts.
export function buildCallVariables(doc: CallRequestDoc): Record<string, string> {
  const shipmentId = String(
    (doc.shipment as Record<string, unknown>)?.shipment_id ?? "unknown",
  );

  return {
    shipment_id: shipmentId,
    first_message: FIRST_MESSAGE.replaceAll("{{shipment_id}}", shipmentId),
    call_type: doc.call_type,
    call_type_questions: CALL_TYPE_QUESTIONS[doc.call_type] ?? "",
    previous_interactions_summary: renderPreviousInteractions(doc),
    open_items_text: renderOpenItems(doc),
  };
}

function renderPreviousInteractions(doc: CallRequestDoc): string {
  const interactions = doc.previous_interactions as Array<{
    date?: string;
    contact_type?: string;
    summary?: string;
  }> | undefined;

  if (!interactions || interactions.length === 0) {
    return "None on file — this is the first contact for this shipment.";
  }

  return interactions
    .map((i) => `- (${i.date ?? "unknown date"}, ${i.contact_type ?? "unknown"}) ${i.summary ?? ""}`)
    .join("\n");
}

function renderOpenItems(doc: CallRequestDoc): string {
  const items = doc.open_items as string[] | undefined;
  if (!items || items.length === 0) {
    return "None.";
  }
  return items.map((item) => `- ${item}`).join("\n");
}
