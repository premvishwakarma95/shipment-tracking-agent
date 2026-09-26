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
  // Redundant backstop for the opening Hello script below: if the customer
  // never speaks at all (not even in response to the customer.speech.timeout
  // hook's check-in), Vapi itself ends the call (endedReason:
  // "silence-timed-out", mapped to CALL_HANG in callOutcome.ts) after 60s
  // of total silence, well before maxDurationSeconds would otherwise be
  // reached.
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
  serverMessages: ["end-of-call-report"],
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
  // Per MDR's requested opening script: say just "Hello.", then wait for
  // the customer to respond; if they stay silent, check in once at 14s,
  // then give up and end the call at 30s (absolute, from the same reset
  // point — not 16s after the first hook).
  //
  // Two customer.speech.timeout hooks, timeoutSeconds: 14 and 30. Extensive
  // real-phone-call testing 2026-09-26 stepped the first hook down from 15
  // to 10 one second at a time: 14/13/12/11 each fired reliably when a
  // real call was tested, 10 fired in one call but not another. The
  // deciding factor isn't the raw threshold alone — a hook this short only
  // reliably arms if there's been at least one prior "customer speech"
  // event (even the false-positive automated "now being recorded"
  // announcement counts, see prompt.ts's Introduction section) to reset
  // from; measured from pure call-start with zero speech at all, very
  // short thresholds can silently fail to arm (confirmed via two back-to-
  // back calls with identical config, one with the announcement and one
  // without — only the one with it fired hook 1). 14 was chosen as a safe
  // margin above the observed failure point (10s). The 30s second hook has
  // never shown this issue, firing reliably from pure call-start with zero
  // prior speech every time it's been tested. This also matches a known
  // Vapi platform bug independently reported by other users (community
  // reports describe short customer.speech.timeout hooks not triggering as
  // configured) — not something fixable via our config beyond picking a
  // safe margin. Don't lower the first hook below 14 without re-testing
  // with a genuinely silent call (no announcement) specifically.
  //
  // triggerResetMode: "onUserSpeech" on both — a deliberate, explicit
  // tradeoff (confirmed with the user 2026-09-26) over "never": "never"
  // would avoid ever re-arming mid-call, but the false-positive automated
  // "now being recorded" announcement (see prompt.ts's Introduction
  // section) happens in nearly every real test call, and "never" means
  // once that happens both hooks are permanently disarmed for the rest of
  // the call — in practice the give-up/hangup would almost never fire at
  // all. "onUserSpeech" recovers from that false positive reliably, at the
  // accepted cost that a genuine mid-call pause longer than 15s (e.g. the
  // caller thinking before answering a question) can also re-trigger these
  // same hooks and end a real, engaged call early — confirmed via real
  // transcripts (TEST-LOCAL-HELLOFLOW-034/035) before this tradeoff was
  // explicitly chosen. If that turns out to happen often in practice,
  // revisit this — there is no native-hooks config that avoids both
  // failure modes at once.
  //
  // Explicit array, NOT omitted — Vapi's PATCH only updates fields actually
  // present in the request body; omitting `hooks` leaves whatever was
  // previously live untouched instead of clearing it (confirmed empirically
  // 2026-09-25).
  hooks: [
    {
      on: "customer.speech.timeout",
      options: { timeoutSeconds: 14, triggerMaxCount: 1, triggerResetMode: "onUserSpeech" },
      do: [{ type: "say", exact: "Hello? Are you there?" }],
    },
    {
      on: "customer.speech.timeout",
      options: { timeoutSeconds: 30, triggerMaxCount: 1, triggerResetMode: "onUserSpeech" },
      do: [
        { type: "say", exact: "Okay, I'll try again later. Thank you." },
        { type: "tool", tool: { type: "endCall" } },
      ],
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
