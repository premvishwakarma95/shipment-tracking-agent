import { mdrClient, MdrApiError } from "./client.js";
import type { VoiceWebhookEvent } from "./types.js";

// Real endpoint confirmed directly by the MDR team (2026-09-16) — supersedes
// the integration guide's originally-described path/host. Requires
// MDR_API_BASE_URL="https://staging.mydrayrate.com" and MDR_API_AUTH_TOKEN
// set in .env (Bearer token, confirmed — see docs/requirements-tracker.md).
const VOICE_WEBHOOK_ENDPOINT = "/api/voice/check-call-completed";

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
