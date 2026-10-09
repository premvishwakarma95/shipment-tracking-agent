import { Router } from "express";
import { Readable } from "node:stream";

export const recordingsRouter = Router();

// Vapi's own recording URL is a private storage path that can't be played
// without credentials. Playback needs Vapi's GET /call/{id}/stereo-recording
// (private API key, 302 to a short-lived signed URL). This route makes that
// call server-side and streams the audio back, so MDR gets a plain link:
//   <base>/recordings/<vapi_call_id>?key=<key>                -> plays inline
//   <base>/recordings/<vapi_call_id>?key=<key>&download=1     -> downloads
// Auth is a query param (not a header) so it works as a bare link / <audio src>.
recordingsRouter.get("/:vapiCallId", async (req, res) => {
  const expectedKey = process.env.RECORDINGS_PROXY_SECRET;
  if (!expectedKey || req.query.key !== expectedKey) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const { vapiCallId } = req.params;
  try {
    const upstream = await fetch(`https://api.vapi.ai/call/${vapiCallId}/stereo-recording`, {
      headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY ?? ""}` },
    });
    if (!upstream.ok || !upstream.body) {
      console.error(`[recordings] Vapi returned ${upstream.status} for ${vapiCallId}`);
      res.status(upstream.status === 404 ? 404 : 502).json({ error: "recording not available" });
      return;
    }

    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "audio/wav");
    if (req.query.download) {
      res.setHeader("Content-Disposition", `attachment; filename="${vapiCallId}.wav"`);
    }
    Readable.fromWeb(upstream.body as any).pipe(res);
  } catch (err) {
    console.error(`[recordings] failed to proxy ${vapiCallId}`, err);
    res.status(502).json({ error: "failed to fetch recording" });
  }
});
