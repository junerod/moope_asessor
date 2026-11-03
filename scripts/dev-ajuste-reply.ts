#!/usr/bin/env tsx
/**
 * Fecha um /ajuste e avisa o DEV no WhatsApp (via Assessor).
 *
 * Uso:
 *   npx tsx scripts/dev-ajuste-reply.ts 3 "Pronto: card do dólar menor no próximo deploy."
 */
import { getDb, closeDb } from "@/db/client";
import { completeAjuste, touchAgentHeartbeat } from "@/domain/dev-ajustes";
import { spawnSync } from "child_process";
import { join } from "path";

async function main() {
  const id = Number(process.argv[2]);
  const reply = process.argv.slice(3).join(" ").trim();
  if (!Number.isFinite(id) || id < 1 || !reply) {
    console.error(
      'Usage: npx tsx scripts/dev-ajuste-reply.ts <id> "mensagem pro DEV"'
    );
    process.exit(1);
  }

  const db = getDb();
  await touchAgentHeartbeat(db, "cursor");
  const it = await completeAjuste(db, id, reply);
  if (!it) {
    console.error(JSON.stringify({ ok: false, error: "not_found", id }));
    await closeDb();
    process.exit(2);
  }

  const zap = [
    `🛠️ *Ajuste #${id} — feito*`,
    "",
    `*Pedido:* ${it.text.slice(0, 280)}`,
    "",
    `*Resposta:* ${reply}`,
    "",
    "_Mande outro com `/ajuste …`_",
  ].join("\n");

  await closeDb();

  const r = spawnSync(
    "npx",
    ["tsx", join("scripts", "notify-dev-whatsapp.ts"), zap],
    { stdio: "inherit", cwd: process.cwd(), env: process.env }
  );
  if (r.status !== 0) {
    console.error(JSON.stringify({ ok: false, notified: false, item: it }));
    process.exit(r.status || 1);
  }
  console.log(JSON.stringify({ ok: true, id, notified: true }));
}

main().catch(async (e) => {
  console.error(e);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
