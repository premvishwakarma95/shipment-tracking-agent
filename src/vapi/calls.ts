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
}

export async function createOutboundCall(params: CreateCallParams): Promise<VapiCall> {
  return vapiClient.post<VapiCall>("/call", {
    phoneNumberId: params.phoneNumberId,
    assistantId: params.assistantId,
    customer: { number: params.customerNumber },
    assistantOverrides: {
      variableValues: params.variableValues,
      ...(params.firstMessage ? { firstMessage: params.firstMessage } : {}),
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
