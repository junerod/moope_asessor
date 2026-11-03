import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { completeGoogleOAuth } from "@/integrations/google/oauth";
import { enqueueAgentJob } from "@/domain/jobs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const err = url.searchParams.get("error");

  if (err) {
    return htmlPage(
      "Autorização cancelada",
      "Você cancelou o login Google. Pode voltar ao WhatsApp e tentar de novo."
    );
  }
  if (!code || !state) {
    // Preview do WhatsApp às vezes abre sem query — página amigável
    return htmlPage(
      "Abra pelo botão do Google",
      "Se você veio do WhatsApp, volte e toque de novo no link completo, ou diga “conectar google” para gerar um novo."
    );
  }

  const db = getDb();
  try {
    const done = await completeGoogleOAuth(db, { code, state });
    if (!done.ok) {
      return htmlPage("Falha na conexão", done.error);
    }

    // Avisa no WhatsApp se tivermos conversation
    if (done.conversationId) {
      await enqueueAgentJob(db, {
        jobType: "inbound_message",
        workspaceId: done.workspaceId,
        conversationId: done.conversationId,
        idempotencyKey: `google-connected:${done.workspaceId}:${Date.now()}`,
        payload: {
          paired: true,
          content_type: "text",
          text:
            done.mock
              ? "Google conectado em modo homolog. Agora diga: sincronizar agenda"
              : "Google conectado com sucesso. Agora diga: sincronizar agenda ou sincronizar planilha",
          system_event: "google_connected",
        },
      });
    }

    return htmlPage(
      done.mock ? "Google conectado (homolog)" : "Google conectado ✅",
      done.mock
        ? "Modo homolog ativo. Volte ao WhatsApp e diga “sincronizar agenda” ou “sincronizar planilha”."
        : "Pode voltar ao WhatsApp e dizer “sincronizar agenda” ou “sincronizar planilha”."
    );
  } catch (e) {
    return htmlPage(
      "Erro",
      e instanceof Error ? e.message : "Falha inesperada no OAuth Google"
    );
  }
}

function htmlPage(title: string, body: string) {
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title>
  <style>body{font-family:system-ui,sans-serif;background:#0b1220;color:#e8eefc;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
  .card{max-width:420px;background:#121a2b;border:1px solid #243049;border-radius:16px;padding:28px;line-height:1.5}
  h1{font-size:1.25rem;margin:0 0 12px}p{margin:0;color:#b7c3db}</style></head>
  <body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></div></body></html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
