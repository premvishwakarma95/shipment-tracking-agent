import { Router } from "express";
import { getCall, getRecordingUrl } from "../vapi/calls.js";

export const recordingsRouter = Router();

// Vapi's recording URLs require the Vapi API key to fetch and must never
// be handed to a third party directly. This proxies the fetch server-side
// so MDR can be given a plain playable link instead. Auth via query param
// (not a header) deliberately — this needs to work as a bare clickable
// link / <audio src>, which can't attach custom headers.
recordingsRouter.get("/:vapiCallId", async (req, res) => {
  if (req.query.key !== process.env.RECORDINGS_PROXY_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    const call = await getCall(req.params.vapiCallId);
    const recordingUrl = getRecordingUrl(call);
    if (!recordingUrl) {
      res.status(404).json({ error: "no recording available for this call" });
      return;
    }

    const upstream = await fetch(recordingUrl);
    if (!upstream.ok || !upstream.body) {
      res.status(502).json({ error: "failed to fetch recording" });
      return;
    }

    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "audio/wav");
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    console.error(`[recordings] failed to proxy ${req.params.vapiCallId}`, err);
    res.status(502).json({ error: "failed to fetch recording" });
  }
});
