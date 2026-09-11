import { connectDB, disconnectDB } from "./connection.js";
import { CallRequest } from "./models/index.js";

// Dev-only. Clears CallRequest (transient correlation state) only.
// RawCapture is never touched here — it's the permanent audit log.
async function main() {
  await connectDB();
  const { deletedCount } = await CallRequest.deleteMany({});
  console.log(`[db:reset] cleared ${deletedCount} CallRequest document(s)`);
  await disconnectDB();
}

main().catch((err) => {
  console.error("[db:reset] failed", err);
  process.exit(1);
});
