import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { beginGoogleOAuth } from "@/integrations/google/oauth";

/**
 * GET /api/integrations/google/start?workspace_id=&user_id=&conversation_id=
 * Preferivel: gerar link via tool connect_google (já inclui state).
 * Este endpoint é fallback admin/dev.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspace_id") || "";
  const userId = url.searchParams.get("user_id") || "";
  const conversationId = url.searchParams.get("conversation_id") || undefined;
  if (!workspaceId || !userId) {
    return NextResponse.json(
      { error: "workspace_id and user_id required" },
      { status: 400 }
    );
  }
  const db = getDb();
  const started = await beginGoogleOAuth(db, {
    workspaceId,
    userId,
    conversationId,
  });
  if (!started.ok) {
    return NextResponse.json({ error: started.error }, { status: 400 });
  }
  return NextResponse.redirect(started.url);
}
