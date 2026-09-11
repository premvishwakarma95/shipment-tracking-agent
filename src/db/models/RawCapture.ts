import { Schema, model } from "mongoose";

// Unconditional, unparsed capture of every inbound payload — from MDR's
// call requests AND Vapi's webhooks — before any validation happens.
// Adapted from the reference project's WebhookResponse model, generalized
// to one collection for both directions since neither payload shape is
// fully locked down yet. This is the audit safety net: if a real payload
// doesn't match what we assumed, the raw bytes are still here to inspect.
// Never cleared by db:reset.
const RawCaptureSchema = new Schema(
  {
    source: {
      type: String,
      enum: ["mdr_call_request", "vapi_webhook"],
      required: true,
    },
    payload: { type: Schema.Types.Mixed, required: true },
    received_at: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

export const RawCapture = model("RawCapture", RawCaptureSchema);
