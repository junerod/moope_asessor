import {
  beginGoogleOAuth,
  disconnectGoogle,
  getGoogleConnection,
  loadGoogleTokens,
  resolveGoogleOAuthConfig,
} from "@/integrations/google/oauth";
import { syncWorkspaceToGoogleCalendar } from "@/integrations/google/calendar";
import { syncWorkspaceToGoogleSheets } from "@/integrations/google/sheets";
import { registerTool } from "./registry";

/** Conexão “de verdade” = status connected + token real (não mock). */
async function isRealGoogleConnected(
  db: Parameters<typeof getGoogleConnection>[0],
  workspaceId: string
): Promise<{ connected: boolean; mock: boolean }> {
  const row = await getGoogleConnection(db, workspaceId);
  if (!row || row.status !== "connected") {
    return { connected: false, mock: false };
  }
  const tokens = await loadGoogleTokens(db, workspaceId);
  const meta = (row.metadata || {}) as Record<string, unknown>;
  const mock = Boolean(tokens?.mock || meta.mock || meta.connected_via === "dev_mock");
  if (mock || !tokens?.access_token) {
    return { connected: false, mock: true };
  }
  return { connected: true, mock: false };
}

registerTool({
  name: "connect_google",
  description:
    "Inicia conexão com Google (Agenda + Sheets). Use quando pedirem conectar Google, Google Calendar, Google Sheets, sincronizar Google.",
  inputSchema: { type: "object", properties: {} },
  async handler(ctx) {
    const cfg = await resolveGoogleOAuthConfig(ctx.db);
    const state = await isRealGoogleConnected(ctx.db, ctx.workspaceId);

    // Mock antigo / sem token real → limpa e pede OAuth de verdade
    if (state.mock || (state.connected === false && cfg.configured)) {
      const row = await getGoogleConnection(ctx.db, ctx.workspaceId);
      if (row?.status === "connected" && state.mock) {
        await disconnectGoogle(ctx.db, ctx.workspaceId);
      }
    }

    if (state.connected && !state.mock) {
      return {
        ok: true,
        summary:
          "Google já está conectado ✅\nDiga “sincronizar agenda” ou “sincronizar planilha” pra atualizar.\n\nSe quiser trocar de conta: diga *desconectar google* e depois *conectar google*.",
        data: { already: true },
      };
    }

    if (!cfg.configured) {
      return {
        ok: false,
        summary:
          "Google ainda não está configurado no servidor (Client ID/Secret). Peça ao admin.",
        errorCode: "oauth_config",
      };
    }

    const started = await beginGoogleOAuth(ctx.db, {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
    });
    if (!started.ok) {
      return { ok: false, summary: started.error, errorCode: "oauth_config" };
    }
    const linkLine = `Conectar Google → ${started.shortUrl}`;
    return {
      ok: true,
      summary:
        started.mode === "mock"
          ? `🔗 Conectar Google (homolog)\n\n${linkLine}\n\nDepois diga *sincronizar agenda*.`
          : [
              "🔗 *Conectar Google*",
              "",
              "1. Toque no link",
              "2. Escolha a conta e autorize",
              "3. Volte e diga *sincronizar agenda*",
              "",
              linkLine,
            ].join("\n"),
      data: {
        // Só o link curto — nunca expor a URL OAuth longa ao modelo
        url: started.shortUrl,
        mode: started.mode,
      },
    };
  },
});

registerTool({
  name: "google_status",
  description: "Mostra se o Google está conectado e último sync.",
  inputSchema: { type: "object", properties: {} },
  async handler(ctx) {
    const row = await getGoogleConnection(ctx.db, ctx.workspaceId);
    const state = await isRealGoogleConnected(ctx.db, ctx.workspaceId);
    if (!state.connected) {
      return {
        ok: true,
        summary: state.mock
          ? "Google estava em modo homolog (falso). Diga *conectar google* pra autorizar de verdade."
          : "Google ainda não conectado. Diga “conectar google”.",
        data: { connected: false, mock: state.mock },
      };
    }
    return {
      ok: true,
      summary: [
        "Google: *conectado* ✅",
        row?.lastSyncedAt
          ? `Último sync: ${row.lastSyncedAt.toISOString()}`
          : "Ainda sem sync — diga “sincronizar agenda”.",
      ].join("\n"),
      data: {
        connected: true,
        mock: false,
        last_synced_at: row?.lastSyncedAt,
      },
    };
  },
});

registerTool({
  name: "sync_google_calendar",
  description:
    "Envia lembretes/compromissos do Assessor para o Google Agenda. Use após conectar.",
  inputSchema: {
    type: "object",
    properties: { days_ahead: { type: "number" } },
  },
  async handler(ctx, args) {
    const state = await isRealGoogleConnected(ctx.db, ctx.workspaceId);
    if (!state.connected) {
      return {
        ok: false,
        summary: state.mock
          ? "A conexão Google era só de teste. Diga *conectar google* e autorize de verdade."
          : "Google ainda não conectado. Diga *conectar google* primeiro.",
        errorCode: "not_connected",
      };
    }
    const said = String(ctx.userText || "");
    const wantsPull =
      /(trazer|puxar|importar|baixar|sincroniz).{0,40}(agenda|google agenda|calend[aá]rio)|agenda google para (o |meu )?assessor|do google para (o |meu )?(assessor|mim)/i.test(
        said
      ) && !/planilha|sheets/i.test(said);
    if (wantsPull) {
      const { listGoogleUpcomingEvents } = await import("@/integrations/google/pull");
      const events = await listGoogleUpcomingEvents(ctx.db, {
        workspaceId: ctx.workspaceId,
        timezone: ctx.timezone,
        withinMinutes: 7 * 24 * 60,
      });
      const external = events.filter((e) => !e.fromAssessor);
      if (!external.length) {
        return {
          ok: true,
          summary:
            "📆 Google conectado, mas não achei eventos de fora nos próximos 7 dias.\n\nEles entram sozinhos quando você perguntar *o que tenho amanhã*.",
          data: { pulled: 0 },
        };
      }
      const { DateTime } = await import("luxon");
      const lines = external.slice(0, 12).map((e) => {
        const when = DateTime.fromJSDate(e.start)
          .setZone(ctx.timezone)
          .toFormat("dd/LL · HH:mm");
        return `• 📆 *${e.summary}*\n  🗓️ ${when}`;
      });
      return {
        ok: true,
        summary: [
          `📆 *Trouxe ${external.length} da Agenda Google*`,
          "",
          ...lines,
          "",
          "Eles aparecem junto com seus compromissos em *o que tenho amanhã*.",
        ].join("\n"),
        data: { pulled: external.length },
      };
    }
    const result = await syncWorkspaceToGoogleCalendar(ctx.db, {
      workspaceId: ctx.workspaceId,
      timezone: ctx.timezone,
      daysAhead: args.days_ahead ? Number(args.days_ahead) : 60,
    });
    return {
      ok: result.ok,
      summary: result.summary,
      errorCode: result.errorCode,
      data: { pushed: result.pushed, mock: result.mock },
    };
  },
});

registerTool({
  name: "sync_google_sheets",
  description:
    "Envia gastos do mês para Google Sheets (cria/atualiza planilha). Use após conectar.",
  inputSchema: {
    type: "object",
    properties: { month: { type: "string" } },
  },
  async handler(ctx, args) {
    const state = await isRealGoogleConnected(ctx.db, ctx.workspaceId);
    if (!state.connected) {
      return {
        ok: false,
        summary: state.mock
          ? "A conexão Google era só de teste. Diga *conectar google* e autorize de verdade."
          : "Google ainda não conectado. Diga *conectar google* primeiro.",
        errorCode: "not_connected",
      };
    }
    const result = await syncWorkspaceToGoogleSheets(ctx.db, {
      workspaceId: ctx.workspaceId,
      timezone: ctx.timezone,
      month: args.month ? String(args.month) : undefined,
    });
    return {
      ok: result.ok,
      summary: result.summary,
      errorCode: result.errorCode,
      data: {
        rows: result.rows,
        mock: result.mock,
        spreadsheet_url: result.spreadsheetUrl,
      },
    };
  },
});

registerTool({
  name: "disconnect_google",
  description: "Desconecta a conta Google do workspace.",
  inputSchema: { type: "object", properties: {} },
  async handler(ctx) {
    await disconnectGoogle(ctx.db, ctx.workspaceId);
    return { ok: true, summary: "Desconectei o Google deste Assessor." };
  },
});
