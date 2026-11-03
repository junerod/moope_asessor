import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { resolveGoogleOAuthShortLink } from "@/integrations/google/oauth";

/**
 * Link curto enviado no WhatsApp:
 *   https://assessor.moope.com.br/g/{state}
 * Redireciona para o OAuth do Google (URL longa).
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ state: string }> }
) {
  const { state } = await ctx.params;
  if (!state || !/^[a-f0-9]{20,64}$/i.test(state)) {
    return NextResponse.redirect(
      new URL("/ajuda/pessoal?google=link_invalido", "https://assessor.moope.com.br")
    );
  }
  const db = getDb();
  const resolved = await resolveGoogleOAuthShortLink(db, state);
  if (!resolved.ok) {
    const q =
      resolved.error === "state_expired"
        ? "google=expirado"
        : "google=link_invalido";
    return NextResponse.redirect(
      new URL(`/ajuda/pessoal?${q}`, "https://assessor.moope.com.br")
    );
  }
  return NextResponse.redirect(resolved.authUrl);
}
