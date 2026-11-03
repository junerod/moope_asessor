import { and, eq, isNull } from "drizzle-orm";
import { google } from "googleapis";
import { DateTime } from "luxon";
import type { Db } from "@/db/client";
import { integrationConnections, memories } from "@/db/schema";
import { getAuthedGoogleClient, getGoogleConnection } from "./oauth";

async function loadMonthExpenses(
  db: Db,
  workspaceId: string,
  timezone: string,
  month?: string
) {
  const tz = timezone || "America/Sao_Paulo";
  const now = DateTime.now().setZone(tz);
  let start = now.startOf("month");
  let end = now.endOf("month");
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    start = DateTime.fromISO(`${month}-01`, { zone: tz }).startOf("month");
    end = start.endOf("month");
  }
  const rows = await db.query.memories.findMany({
    where: and(
      eq(memories.workspaceId, workspaceId),
      eq(memories.status, "active"),
      eq(memories.sourceType, "expense"),
      isNull(memories.deletedAt)
    ),
    orderBy: (m, { desc }) => [desc(m.createdAt)],
    limit: 500,
  });
  const items: Array<[string, string, number, string, string]> = [];
  for (const r of rows) {
    const meta = (r.metadata || {}) as Record<string, unknown>;
    let when = DateTime.fromJSDate(r.createdAt).setZone(tz);
    if (typeof meta.date === "string" && meta.date) {
      const iso = DateTime.fromISO(meta.date, { zone: tz });
      const br = DateTime.fromFormat(meta.date, "dd/MM/yyyy", { zone: tz });
      if (iso.isValid) when = iso;
      else if (br.isValid) when = br;
    }
    if (when < start || when > end) continue;
    const amount = Number(meta.amount);
    if (!Number.isFinite(amount)) continue;
    items.push([
      when.toFormat("dd/LL/yyyy"),
      String(meta.category || "outro"),
      amount,
      meta.merchant ? String(meta.merchant) : "",
      String(meta.note || "").slice(0, 120),
    ]);
  }
  return {
    start,
    monthKey: start.toFormat("yyyy-MM"),
    label: start.toFormat("LLLL yyyy", { locale: "pt-BR" }),
    items,
  };
}

export async function syncWorkspaceToGoogleSheets(
  db: Db,
  input: { workspaceId: string; timezone: string; month?: string }
): Promise<{
  ok: boolean;
  summary: string;
  rows: number;
  spreadsheetUrl?: string;
  mock: boolean;
  errorCode?: string;
}> {
  const auth = await getAuthedGoogleClient(db, input.workspaceId);
  if (!auth) {
    return {
      ok: false,
      summary: "Google não está conectado. Diga “conectar google”.",
      rows: 0,
      mock: false,
      errorCode: "not_connected",
    };
  }

  const pack = await loadMonthExpenses(
    db,
    input.workspaceId,
    input.timezone,
    input.month
  );
  if (!pack.items.length) {
    return {
      ok: true,
      summary: `Sem gastos em ${pack.label} para mandar ao Sheets 📊`,
      rows: 0,
      mock: auth.mock,
    };
  }

  const values: (string | number)[][] = [
    ["data", "categoria", "valor", "estabelecimento", "nota"],
    ...pack.items.map(([d, c, v, m, n]) => [d, c, v, m, n]),
  ];
  const total = pack.items.reduce((s, i) => s + i[2], 0);
  values.push(["", "", total, "TOTAL", ""]);

  if (auth.mock) {
    const conn = await getGoogleConnection(db, input.workspaceId);
    if (conn) {
      await db
        .update(integrationConnections)
        .set({
          lastSyncedAt: new Date(),
          metadata: {
            ...((conn.metadata || {}) as object),
            last_sheets_sync: {
              at: new Date().toISOString(),
              rows: pack.items.length,
              total,
              month: pack.monthKey,
              mock: true,
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(integrationConnections.id, conn.id));
    }
    return {
      ok: true,
      summary: `📊 (homolog) Montei planilha mock com *${pack.items.length}* linhas · total R$ ${total.toFixed(2)}.\nClient ID real no /admin grava no Google Sheets de verdade.`,
      rows: pack.items.length,
      mock: true,
    };
  }

  const sheets = google.sheets({ version: "v4", auth: auth.oauth2! });
  const conn = await getGoogleConnection(db, input.workspaceId);
  const meta = (conn?.metadata || {}) as Record<string, unknown>;
  let spreadsheetId = String(meta.spreadsheet_id || "");
  let spreadsheetUrl = String(meta.spreadsheet_url || "");

  try {
    if (!spreadsheetId) {
      const created = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title: `Assessor MOOPE — Gastos` },
          sheets: [{ properties: { title: pack.monthKey } }],
        },
      });
      spreadsheetId = String(created.data.spreadsheetId || "");
      spreadsheetUrl = String(created.data.spreadsheetUrl || "");
    } else {
      // ensure tab exists
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                addSheet: { properties: { title: pack.monthKey } },
              },
            ],
          },
        });
      } catch {
        /* tab may already exist */
      }
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${pack.monthKey}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });

    if (conn) {
      await db
        .update(integrationConnections)
        .set({
          lastSyncedAt: new Date(),
          metadata: {
            ...meta,
            spreadsheet_id: spreadsheetId,
            spreadsheet_url: spreadsheetUrl,
            last_sheets_sync: {
              at: new Date().toISOString(),
              rows: pack.items.length,
              total,
              month: pack.monthKey,
              mock: false,
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(integrationConnections.id, conn.id));
    }

    return {
      ok: true,
      summary: `📊 Atualizei o *Google Sheets* (${pack.items.length} gastos · R$ ${total.toFixed(2)})${
        spreadsheetUrl ? `\n${spreadsheetUrl}` : ""
      }`,
      rows: pack.items.length,
      spreadsheetUrl: spreadsheetUrl || undefined,
      mock: false,
    };
  } catch (err) {
    return {
      ok: false,
      summary: `Falha ao gravar no Sheets: ${
        err instanceof Error ? err.message : "erro"
      }`,
      rows: 0,
      mock: false,
      errorCode: "sheets_push_failed",
    };
  }
}
