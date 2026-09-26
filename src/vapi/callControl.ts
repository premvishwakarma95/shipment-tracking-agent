// Live Call Control (docs.vapi.ai/calls/call-features) — a per-call
// control URL, separate from api.vapi.ai, that lets us inject a spoken
// message and/or end an active call server-side, outside the normal
// LLM turn-generation loop. Used for the wrong-number case in
// webhookHandlers.ts: we need an exact, non-paraphrased closing line
// (MDR gave us the precise wording) followed by a guaranteed hangup, and
// having the LLM say a custom line itself with no endCall tool afterward
// left the call open indefinitely (confirmed empirically 2026-09-23,
// TEST-WrongNumb-004) — the caller had to hang up manually. This
// sidesteps that entirely: our server speaks the fixed line and ends the
// call in one deterministic step, independent of the model.

const TIMEOUT_MS = 15_000;

async function postSay(controlUrl: string, content: string, endCallAfterSpoken: boolean): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(controlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.VAPI_API_KEY ?? ""}`,
      },
      body: JSON.stringify({ type: "say", content, endCallAfterSpoken }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[callControl] say failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
  } catch (err) {
    console.error("[callControl] say request failed", err);
  } finally {
    clearTimeout(timeout);
  }
}

export async function sayAndEndCall(controlUrl: string, content: string): Promise<void> {
  await postSay(controlUrl, content, true);
}
