#!/usr/bin/env tsx
/**
 * Aviso de novidades para usuários (WhatsApp).
 *
 * Formato alinhado à lista “Novidades” de /ajuda/pessoal.
 *
 *   npx tsx scripts/broadcast-whats-new.ts              # dry-run
 *   npx tsx scripts/broadcast-whats-new.ts --test-dev   # só Zap DEV
 *   npx tsx scripts/broadcast-whats-new.ts --send       # envia de verdade
 *   npx tsx scripts/broadcast-whats-new.ts --send --audience=geral
 */
import { eq } from "drizzle-orm";
import { getDb, closeDb } from "@/db/client";
import { users } from "@/db/schema";
import {
  sendBroadcast,
  type BroadcastAudience,
} from "@/domain/admin-broadcast";
import { CANONICAL_PUBLIC_BASE } from "@/lib/public-url";

/** Sempre domínio canônico — nunca localhost. */
const HELP = `${CANONICAL_PUBLIC_BASE}/ajuda/pessoal`;

/** Mesma identidade visual da lista Novidades da ajuda. */
const NEWS = [
  "✨ *Novidades no Meu Assessor*",
  "",
  "Mais coisas que você já pode pedir no Zap — sem decorar comando.",
  "",
  "🎙️ Áudio → ação: manda um zap de voz e eu executo",
  "🛣️ Rotas + *Saí de casa*",
  "📅 *Seu dia* — *o que tenho hoje?* (com Agenda, se conectou)",
  "✅ Baixa fácil: *baixa 1* · *baixa 1 e 3*",
  "👨‍👩‍👧 Modo família: contato 📎 · aviso como *Recado de você*",
  "🔗 Google sync automático + aviso ~30 min antes",
  "🌙 Encerramento do dia · 🧾 comprovante na hora",
  "✈️ Modo viagem · 🤝 follow-up social · ☀️ resumo da manhã",
  "",
  "📖 Manual:",
  HELP,
  "",
  "_Equipe MOOPE · Meu Assessor_",
].join("\n");

const FIX_LINK = [
  "🔧 *Correção rápida*",
  "",
  "No aviso anterior o link saiu errado (localhost).",
  "O manual certo é este:",
  "",
  `👉 ${HELP}`,
  "",
  "Desculpa o tropeço — agora está no domínio oficial 💚",
  "",
  "_Equipe MOOPE_",
].join("\n");

async function main() {
  const doSend = process.argv.includes("--send");
  const testDev = process.argv.includes("--test-dev");
  const fixLink = process.argv.includes("--fix-link");
  const audArg = process.argv.find((a) => a.startsWith("--audience="));
  const audience = (audArg?.split("=")[1] || "all") as BroadcastAudience;
  const message = fixLink ? FIX_LINK : NEWS;

  if (!HELP.startsWith("https://assessor.moope.com.br")) {
    throw new Error(`REFUSAL: help URL must be canonical, got ${HELP}`);
  }

  const db = getDb();
  try {
    const admin =
      (await db.query.users.findFirst({
        where: eq(users.email, "admin@moope.com.br"),
      })) ||
      (await db.query.users.findFirst({}));

    if (!admin) throw new Error("admin_user_not_found");

    const result = await sendBroadcast(db, {
      audience,
      message,
      actorUserId: admin.id,
      dryRun: !doSend && !testDev,
      testDevOnly: testDev,
      pauseMs: 450,
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          dry_run: !doSend && !testDev,
          test_dev: testDev,
          fix_link: fixLink,
          help_url: HELP,
          audience,
          total: result.total,
          sent: result.sent,
          failed: result.failed,
          errors: result.errors.slice(0, 10),
        },
        null,
        2
      )
    );
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(1);
});
