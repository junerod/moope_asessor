/**
 * Explicit smoke against real Zernio credentials.
 * Never called by `npm test`.
 *
 * Required env:
 *   ZERNIO_MOCK=false
 *   ZERNIO_API_KEY
 *   ZERNIO_ACCOUNT_ID
 *   ZERNIO_SMOKE_CONVERSATION_ID
 */
import { createZernioClient } from "../src/channels/zernio";

async function main() {
  if (process.env.ZERNIO_MOCK !== "false") {
    console.error("Set ZERNIO_MOCK=false to run real smoke.");
    process.exit(2);
  }
  const conversationId = process.env.ZERNIO_SMOKE_CONVERSATION_ID;
  if (!conversationId) {
    console.error("Missing ZERNIO_SMOKE_CONVERSATION_ID");
    process.exit(2);
  }
  const client = createZernioClient({ mock: false });
  const result = await client.sendText({
    conversationId,
    message: "Smoke test MOOPE Meu Assessor",
    idempotencyKey: `smoke:${Date.now()}`,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main();
