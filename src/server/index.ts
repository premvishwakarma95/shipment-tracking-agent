import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { connectDB } from "../db/connection.js";
import { mdrCallRequestRouter } from "./mdrCallRequest.js";
import { recordingsRouter } from "./recordings.js";
import { handleEndOfCallReport, handleToolCalls } from "./webhookHandlers.js";

const app = express();
// Express's default 100kb limit silently rejected Vapi's end-of-call-report
// webhook for any call with a long enough transcript/structured-data
// payload — the request never reached our route handler at all, so nothing
// was saved and the CallRequest stayed stuck at lifecycle_status: "CALLING"
// forever. Confirmed empirically 2026-09-24 (TEST-CONTACT-UPDATE-002: a
// ~108KB payload, rejected with PayloadTooLargeError). Not specific to any
// one call type — raised generously since a full transcript + structured
// data + Vapi's other call metadata can legitimately exceed 100KB.
app.use(express.json({ limit: "10mb" }));

app.use("/mdr", mdrCallRequestRouter);
app.use("/recordings", recordingsRouter);

// Vapi posts every call event (tool-calls, end-of-call-report, and others
// we don't act on) to this single URL, wrapped as { message: {...} }.
app.post("/vapi/tool-calls", async (req, res) => {
  const message = req.body?.message;

  try {
    switch (message?.type) {
      case "tool-calls": {
        const result = await handleToolCalls(message);
        res.json(result);
        return;
      }
      case "end-of-call-report":
        await handleEndOfCallReport(message);
        res.status(200).json({ received: true });
        return;
      default:
        res.status(200).json({ received: true });
        return;
    }
  } catch (err) {
    console.error(`[vapi/tool-calls] failed handling message type ${message?.type}`, err);
    res.status(500).json({ error: "internal error" });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});

// Last-resort JSON error responder.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[express error handler]", err);
  res.status(500).json({ error: "internal error" });
});

async function main() {
  await connectDB();
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(`[server] listening on :${port}`);
  });
}

main().catch((err) => {
  console.error("[server] failed to start", err);
  process.exit(1);
});
