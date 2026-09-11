import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { connectDB } from "../db/connection.js";
import { mdrCallRequestRouter } from "./mdrCallRequest.js";
import { recordingsRouter } from "./recordings.js";
import { handleEndOfCallReport, handleToolCalls } from "./webhookHandlers.js";

const app = express();
app.use(express.json());

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
