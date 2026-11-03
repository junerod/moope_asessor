import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { completeGoogleOAuth } from "@/integrations/google/oauth";
import { enqueueAgentJob } from "@/domain/jobs";

type Ctx = { params: Promise<{ state: string }> };

/**
 * Homolog mock connect — state na URL path (WhatsApp não engole querystring).
 * GET mostra botão; ?confirm=1 conclui (evita preview do WhatsApp consumir o state).
 */
export async function GET(req: Request, ctx: Ctx) {
  const { state } = await ctx.params;
  const url = new URL(req.url);
  const confirm = url.searchParams.get("confirm") === "1";

  if (!state || state.length < 16) {
    return html("Link inválido", "State ausente. Peça um novo link no WhatsApp.");
  }

  if (!confirm) {
    const confirmUrl = `${url.pathname}?confirm=1`;
    const page = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Conectar Google</title>
<style>body{font-family:system-ui,sans-serif;background:#0b1220;color:#e8eefc;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
.card{max-width:420px;background:#121a2b;border:1px solid #243049;border-radius:16px;padding:28px;line-height:1.5;text-align:center}
a.btn{display:inline-block;margin-top:16px;background:#3b82f6;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:600}
p{color:#b7c3db;margin:0}</style></head>
<body><div class="card"><h1 style="margin:0 0 12px;font-size:1.2rem">Conectar Google</h1>
<p>Toque no botão abaixo para autorizar o Assessor (modo homolog).</p>
<a class="btn" href="${confirmUrl}">Conectar agora</a></div></body></html>`;
    return new NextResponse(page, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const db = getDb();
  try {
    const done = await completeGoogleOAuth(db, { code: "dev_mock", state });
    if (!done.ok) {
      return html("Falha na conexão", done.error);
    }
    if (done.conversationId) {
      await enqueueAgentJob(db, {
        jobType: "inbound_message",
        workspaceId: done.workspaceId,
        conversationId: done.conversationId,
        idempotencyKey: `google-connected:${done.workspaceId}:${Date.now()}`,
        payload: {
          paired: true,
          content_type: "text",
          text: "Google conectado (homolog). Agora diga: sincronizar agenda",
          system_event: "google_connected",
        },
      });
    }
    return html(
      "Google conectado ✅",
      "Pode voltar ao WhatsApp e dizer “sincronizar agenda” ou “sincronizar planilha”."
    );
  } catch (e) {
    return html("Erro", e instanceof Error ? e.message : "falha");
  }
}

function html(title: string, body: string) {
  const page = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#0b1220;color:#e8eefc;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
.card{max-width:420px;background:#121a2b;border:1px solid #243049;border-radius:16px;padding:28px;line-height:1.5}
h1{font-size:1.2rem;margin:0 0 12px}p{margin:0;color:#b7c3db}</style></head>
<body><div class="card"><h1>${esc(title)}</h1><p>${esc(body)}</p></div></body></html>`;
  return new NextResponse(page, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function esc(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
