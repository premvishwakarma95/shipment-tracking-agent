import "dotenv/config";
import { vapiClient } from "../vapi/client.js";
import { END_CALL_MESSAGE, FIRST_MESSAGE, SYSTEM_PROMPT, VOICEMAIL_MESSAGE } from "./prompt.js";
import { RESULT_EXTRACTION_PROMPT, RESULT_SCHEMA } from "./resultSchema.js";
import { buildTools } from "./tools.js";

// Voice/model/transcriber/call-quality settings below are mirrored from
// the reference project's live "Everly" assistant (id 765184dd-196b-420f-
// 85de-959034487070) to match its call-handling behavior — see git history
// for the settings this replaced. Deliberately NOT mirrored from that
// assistant: model.messages/tools (our own prompt.ts/tools.ts stay
// authoritative), analysisPlan (ours, for our own result contract),
// firstMessage/voicemailMessage/endCallMessage (that assistant's copy is
// specific to its own quoting domain), name, and server.url (points at
// our own PUBLIC_BASE_URL, not theirs).
if (!process.env.VAPI_ASSISTANT_NAME) {
  throw new Error("VAPI_ASSISTANT_NAME is not set in .env");
}

const assistantConfig = {
  name: process.env.VAPI_ASSISTANT_NAME,
  firstMessage: FIRST_MESSAGE,
  model: {
    provider: "openai",
    model: "gpt-4.1",
    temperature: 0.4,
    messages: [{ role: "system", content: SYSTEM_PROMPT }],
    tools: buildTools(),
  },
  voice: {
    provider: "11labs",
    voiceId: "gE0owC0H9C8SzfDyIUtB",
    model: "eleven_v3",
    stability: 0.3,
    similarityBoost: 0.8,
    style: 0.65,
    speed: 1,
  },
  transcriber: {
    provider: "deepgram",
    model: "nova-3",
    language: "en",
  },
  silenceTimeoutSeconds: 60,
  maxDurationSeconds: 900,
  // "assistant-waits-for-user" made the model treat the intro as a
  // question it had to pause on indefinitely — if the callee didn't
  // respond, it just went silent instead of continuing into "May I ask
  // you a few questions..." (confirmed by MDR + reproduced in our own
  // testing, 2026-09-23). "assistant-speaks-first" lets it keep going on
  // its own per the Introduction section in prompt.ts. Re-verify
  // voicemail detection still behaves correctly after this change — it
  // wasn't mirrored from the reference project's settings, so its
  // interaction with voicemailDetection below hasn't been tested here.
  firstMessageMode: "assistant-speaks-first",
  serverMessages: ["end-of-call-report", "status-update"],
  artifactPlan: {
    transcriptPlan: { enabled: true },
    recordingEnabled: true,
  },
  startSpeakingPlan: {
    waitSeconds: 0.8,
    smartEndpointingPlan: { provider: "vapi" },
  },
  stopSpeakingPlan: {
    numWords: 2,
    voiceSeconds: 0.2,
    backoffSeconds: 1,
  },
  hooks: [
    {
      on: "customer.speech.timeout",
      do: [{ type: "say", exact: "Hello? Are you there?" }],
      options: {
        timeoutSeconds: 30,
        triggerMaxCount: 1,
        triggerResetMode: "onUserSpeech",
      },
    },
  ],
  voicemailDetection: {
    provider: "vapi",
    backoffPlan: {
      maxRetries: 5,
      startAtSeconds: 2,
      frequencySeconds: 2.5,
    },
    beepMaxAwaitSeconds: 20,
  },
  voicemailMessage: VOICEMAIL_MESSAGE,
  endCallMessage: END_CALL_MESSAGE,
  analysisPlan: {
    structuredDataPlan: {
      enabled: true,
      schema: RESULT_SCHEMA,
      // Vapi's structuredDataPlan takes a `messages` array (like
      // model.messages), not a plain `prompt` string — one of the
      // messages must reference {{transcript}}.
      messages: [
        { role: "system", content: RESULT_EXTRACTION_PROMPT },
        { role: "user", content: "Call transcript:\n\n{{transcript}}" },
      ],
    },
  },
  server: {
    url: `${process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"}/vapi/tool-calls`,
  },
};

async function main() {
  const existingId = process.env.VAPI_ASSISTANT_ID;

  if (existingId) {
    await vapiClient.patch(`/assistant/${existingId}`, assistantConfig);
    console.log(`[assistant:create] updated existing assistant ${existingId}`);
    return;
  }

  const created = await vapiClient.post<{ id: string }>("/assistant", assistantConfig);
  console.log(`[assistant:create] created assistant ${created.id}`);
  console.log("Add this to your .env as VAPI_ASSISTANT_ID for future runs.");
}

main().catch((err) => {
  console.error("[assistant:create] failed", err);
  process.exit(1);
});
