import "dotenv/config";
import { vapiClient } from "../vapi/client.js";
import { FIRST_MESSAGE, SYSTEM_PROMPT, VOICEMAIL_MESSAGE } from "./prompt.js";
import { RESULT_EXTRACTION_PROMPT, RESULT_SCHEMA } from "./resultSchema.js";
import { buildTools } from "./tools.js";

const assistantConfig = {
  name: "MDR Agent 3 - Everly",
  firstMessage: FIRST_MESSAGE,
  model: {
    provider: "openai",
    model: "gpt-4o",
    messages: [{ role: "system", content: SYSTEM_PROMPT }],
    tools: buildTools(),
  },
  voice: {
    // Vapi's default 11labs voice, usable without your own ElevenLabs
    // credentials. Swap for the client's approved voice once chosen.
    provider: "11labs",
    voiceId: "sarah",
  },
  transcriber: {
    provider: "deepgram",
    model: "nova-2",
  },
  voicemailDetection: {
    provider: "twilio",
  },
  voicemailMessage: VOICEMAIL_MESSAGE,
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
