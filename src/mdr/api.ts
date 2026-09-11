import { mdrClient, MdrApiError } from "./client.js";
import type { VoiceWebhookEvent } from "./types.js";

// Confirmed by MDR (integration guide §5, §13) — no longer a placeholder.
// Update src/mdr/client.ts's MDR_API_BASE_URL to
// "https://api.mydrayrate.com" once that's set in .env for this to work.
const VOICE_WEBHOOK_ENDPOINT = "/api/v1/agent3/voice/webhook";

// Deliberately no retry loop here: on failure we log and return false, and
// the caller (src/server/webhookHandlers.ts) leaves CallRequest.mdr_pushed_at
// null so the record is visibly "unpushed" for manual reconciliation. A
// retry policy is an open question for MDR, not something to speculate on
// in code — see docs/requirements-tracker.md.
export async function sendVoiceWebhookEvent(event: VoiceWebhookEvent): Promise<boolean> {
  // Always visible, success or failure — useful for seeing exactly what
  // this service is telling MDR happened on a given call.
  console.log(
    `[mdr] ${event.event_type} -> ${VOICE_WEBHOOK_ENDPOINT} for ${event.mdr_call_id}`,
    JSON.stringify(event, null, 2),
  );

  try {
    const response = await mdrClient.post(VOICE_WEBHOOK_ENDPOINT, event);
    console.log(`[mdr] ${event.event_type} delivered for ${event.mdr_call_id}`, response);
    return true;
  } catch (err) {
    if (err instanceof MdrApiError) {
      console.error(
        `[mdr] ${event.event_type} failed for ${event.mdr_call_id}: HTTP ${err.status}`,
        JSON.stringify(err.body, null, 2),
      );
    } else {
      // Network-level failure (DNS/connection/timeout).
      console.error(`[mdr] ${event.event_type} failed for ${event.mdr_call_id}:`, err);
    }
    return false;
  }
}
