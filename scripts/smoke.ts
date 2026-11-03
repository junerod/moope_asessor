/**
 * Smoke tests hit REAL external APIs when credentials are present.
 * Never called from `npm test`.
 */
import { getDb, closeDb } from "@/db/client";
import { testOpenAIConnection, testZernioConnection } from "@/domain/providers";
import { testEmailSend } from "@/lib/email/provider";
import { resolveVisionProvider, resolveTranscriptionProvider } from "@/lib/ai/providers";

async function smokeOpenAI() {
  const db = getDb();
  const r = await testOpenAIConnection(db, "openai_llm");
  console.log("smoke:openai", r);
  return r.status === "connected";
}

async function smokeZernio() {
  const db = getDb();
  const r = await testZernioConnection(db);
  console.log("smoke:zernio", r);
  return r.status === "connected";
}

async function smokeEmail() {
  const db = getDb();
  const to = process.env.SMOKE_EMAIL_TO || "";
  if (!to) {
    console.log("smoke:email SKIP (set SMOKE_EMAIL_TO)");
    return false;
  }
  const r = await testEmailSend(db, to);
  console.log("smoke:email", r);
  return r.status === "connected";
}

async function smokeVision() {
  const db = getDb();
  const p = await resolveVisionProvider(db);
  if (p.name === "stub") {
    console.log("smoke:vision SKIP (not configured)");
    return false;
  }
  // 1x1 png
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  const r = await p.describe({ buffer: png, mimeType: "image/png" });
  console.log("smoke:vision", { mocked: r.mocked, chars: r.text.length });
  return !r.mocked;
}

async function smokeTranscription() {
  const db = getDb();
  const p = await resolveTranscriptionProvider(db);
  if (p.name === "stub") {
    console.log("smoke:transcription SKIP (not configured)");
    return false;
  }
  console.log("smoke:transcription provider ready:", p.name);
  console.log("AGUARDANDO CREDENCIAL PARA HOMOLOGAÇÃO EXTERNA — envie áudio real via WhatsApp");
  return true;
}

async function main() {
  const which = process.argv[2] || "all";
  const results: Record<string, boolean> = {};
  try {
    if (which === "openai" || which === "all") results.openai = await smokeOpenAI();
    if (which === "zernio" || which === "all") results.zernio = await smokeZernio();
    if (which === "email" || which === "all") results.email = await smokeEmail();
    if (which === "vision" || which === "all") results.vision = await smokeVision();
    if (which === "transcription" || which === "all")
      results.transcription = await smokeTranscription();
    console.log("SMOKE_RESULTS", results);
  } finally {
    await closeDb();
  }
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(1);
});
