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
    mdr_questions_text: renderMdrQuestions(doc),
    previous_summary_text: doc.previous_summary || "None on file — this is the first contact for this shipment.",
    open_issue_text: doc.open_issue || "None.",
  };
}

function renderMdrQuestions(doc: CallRequestDoc): string {
  const questions = doc.questions as string[] | undefined;
  if (!questions || questions.length === 0) {
    return "None beyond the call type's default questions below.";
  }
  return questions.map((q) => `- ${q}`).join("\n");
}
