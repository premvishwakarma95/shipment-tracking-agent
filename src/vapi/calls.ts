import { vapiClient } from "./client.js";

export interface CreateCallParams {
  phoneNumberId: string;
  assistantId: string;
  customerNumber: string;
  // Injected into the assistant's system prompt as {{variable}} values —
  // see src/server/callVariables.ts.
  variableValues: Record<string, unknown>;
  // First message override, so the greeting can vary per contact type /
  // call type without needing a second assistant. See prompt.ts.
  firstMessage?: string;
  // Per-call structured-data extraction override — lets one call_type
  // (currently only CONTACT_UPDATE_REQUEST) use a different result shape
  // than the shared assistant's default analysisPlan, without needing a
  // second Vapi assistant. Confirmed supported by Vapi's assistantOverrides
  // 2026-09-24. See src/assistant/contactUpdateResultSchema.ts and
  // mdrCallRequest.ts.
  analysisPlan?: Record<string, unknown>;
}

export interface VapiCall {
  id: string;
  status: string;
  endedReason?: string;
  recordingUrl?: string;
  transcript?: string;
  summary?: string;
  startedAt?: string;
  endedAt?: string;
  analysis?: {
    structuredData?: Record<string, unknown>;
  };
  // Live Call Control (docs.vapi.ai/calls/call-features) — a per-call URL
  // returned at creation time, used to inject a spoken message and/or end
  // the call server-side mid-conversation. See src/vapi/callControl.ts.
  monitor?: {
    listenUrl?: string;
    controlUrl?: string;
  };
}

export async function createOutboundCall(params: CreateCallParams): Promise<VapiCall> {
  return vapiClient.post<VapiCall>("/call", {
    phoneNumberId: params.phoneNumberId,
    assistantId: params.assistantId,
    customer: { number: params.customerNumber },
    assistantOverrides: {
      variableValues: params.variableValues,
      ...(params.firstMessage ? { firstMessage: params.firstMessage } : {}),
      ...(params.analysisPlan ? { analysisPlan: params.analysisPlan } : {}),
    },
  });
}

export async function getCall(vapiCallId: string): Promise<VapiCall> {
  return vapiClient.get<VapiCall>(`/call/${vapiCallId}`);
}

// Vapi recording URLs require the API key to fetch and must never be
// exposed to a third party directly — src/server/recordings.ts proxies
// this server-side instead of handing the raw URL to MDR.
export function getRecordingUrl(call: VapiCall): string | null {
  return call.recordingUrl ?? null;
}
