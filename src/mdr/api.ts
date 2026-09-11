import { mdrClient, MdrApiError } from "./client.js";
import type { CallResultPayload } from "./types.js";

// PLACEHOLDER path — the real endpoint MDR wants results pushed to hasn't
// been confirmed yet (see docs/requirements-tracker.md). Update this one
// constant once it is; nothing else here should need to change.
const CALL_RESULT_ENDPOINT = "/api/v1/voice-calls/results";

// Deliberately no retry loop here: on failure we log and return false, and
// the caller (src/server/webhookHandlers.ts) leaves CallRequest.mdr_pushed_at
// null so the record is visibly "unpushed" for manual reconciliation. A
// retry policy is an open question for MDR, not something to speculate on
// in code — see docs/requirements-tracker.md.
export async function pushCallResult(payload: CallResultPayload): Promise<boolean> {
  try {
    await mdrClient.post(CALL_RESULT_ENDPOINT, payload);
    return true;
  } catch (err) {
    if (err instanceof MdrApiError) {
      console.error(
        `[mdr] pushCallResult failed for ${payload.mdr_call_id}: ${err.status}`,
        err.body,
      );
    } else {
      console.error(`[mdr] pushCallResult failed for ${payload.mdr_call_id}`, err);
    }
    return false;
  }
}
