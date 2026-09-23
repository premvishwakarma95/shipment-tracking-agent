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
          "Two cases. (1) Wrong number — the person has no connection to this shipment/driver at all: call this IMMEDIATELY with no arguments (leave referred_name/referred_phone empty) and say NOTHING yourself afterward — the system automatically speaks the closing line and ends the call for you. (2) Wrong person but they can refer you to someone else: call this ONLY AFTER the person has actually finished telling you the referred person's name (and phone number, if given) — do not call it the moment they say something like 'talk to...' or 'you should call...'. If they trail off, pause, or you're not sure you caught the name, ask them to repeat it first, then call this tool with what they actually said. Do not call the new number yourself.",
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
          "Call this when the person asks to be called back later. Convert whatever they said into a number of minutes from now (e.g. 'in an hour' -> 60, 'in 30 minutes' -> 30, 'this afternoon' -> a reasonable estimate like 180). Omit if no time was given. If you misheard the time and the person corrects you (e.g. you confirmed '1 day' but they say 'no, 1 hour'), call this tool AGAIN with the corrected number — the latest call is what's used, so always re-call after a correction rather than leaving the wrong value as final.",
        parameters: {
          type: "object",
          properties: {
            callback_after_minutes: { type: "number" },
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
          "Call this ONLY for one of the defined escalation conditions (see the Escalation section of your instructions): truck breakdown/mechanical failure, accident, driver cannot complete the move, carrier cannot perform the load, an appointment will definitely be missed, a serious safety issue, the contact specifically asks for a human, you cannot confidently understand an important answer, or another serious operational issue outside the normal flow. Always include why.",
        parameters: {
          type: "object",
          properties: {
            escalation_reason: { type: "string" },
          },
          required: ["escalation_reason"],
        },
      },
      server,
    },
    // Vapi built-in, no `server` — it hangs up directly and never reaches
    // our webhook. Without it the assistant has no way to end the call and
    // just waits for the caller until silenceTimeoutSeconds expires.
    {
      type: "endCall",
    },
  ];
}
