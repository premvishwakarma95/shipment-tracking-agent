// Vapi function-tool definitions. Only for the four discrete,
// flow-altering outcomes the LLM must act on mid-conversation — see the
// "Tool usage rules" section of prompt.ts for why data fields (location,
// eta, delay, ...) are deliberately NOT tool parameters.
//
// Hard rule, carried over from the reference project: never accept an
// internal ID (mdr_call_id, shipment_id, etc.) as an LLM-supplied tool
// parameter. The LLM has no reliable way to know these are correct —
// context is always resolved server-side from Vapi's own call ID
// (see src/server/webhookHandlers.ts).

function webhookUrl(): string {
  const base = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
  return `${base}/vapi/tool-calls`;
}

export function buildTools() {
  const server = { url: webhookUrl() };

  return [
    {
      type: "function",
      function: {
        name: "reportWrongContact",
        description:
          "Call this when the person on the line is not the right contact for this shipment and has given you a different person's name and/or phone number to reach instead. Do not call the new number yourself.",
        parameters: {
          type: "object",
          properties: {
            referred_name: { type: "string" },
            referred_phone: { type: "string" },
          },
        },
      },
      server,
    },
    {
      type: "function",
      function: {
        name: "reportCallbackRequested",
        description:
          "Call this when the person asks to be called back later, with whatever time they mentioned.",
        parameters: {
          type: "object",
          properties: {
            callback_time: { type: "string" },
          },
        },
      },
      server,
    },
    {
      type: "function",
      function: {
        name: "reportEmailRequested",
        description:
          "Call this when the person asks for the shipment information by email, with the email address if they gave one.",
        parameters: {
          type: "object",
          properties: {
            requested_email: { type: "string" },
          },
        },
      },
      server,
    },
    {
      type: "function",
      function: {
        name: "flagHumanEscalation",
        description:
          "Call this when a serious issue comes up (breakdown, accident, safety concern, or anything else that needs human operations follow-up rather than just a data update).",
        parameters: {
          type: "object",
          properties: {
            reason: { type: "string" },
          },
          required: ["reason"],
        },
      },
      server,
    },
  ];
}
