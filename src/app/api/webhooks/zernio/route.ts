import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { handleZernioWebhook } from "@/services/inbound-webhook";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature =
    req.headers.get("x-zernio-signature") ||
    req.headers.get("x-late-signature");
  const eventIdHeader =
    req.headers.get("x-zernio-event-id") ||
    req.headers.get("x-late-event-id");

  const db = getDb();
  const result = await handleZernioWebhook(db, {
    rawBody,
    signature,
    eventIdHeader,
  });

  return NextResponse.json(result.body, { status: result.status });
}
