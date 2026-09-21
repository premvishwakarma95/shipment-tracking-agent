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
const assistantConfig = {
  name: "MDR Agent 3 - Everly",
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
  firstMessageMode: "assistant-waits-for-user",
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
