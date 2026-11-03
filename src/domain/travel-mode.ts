/**
 * Modo viagem — fuso + silencia alertas locais / Google nudges.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { users } from "@/db/schema";

function norm(text: string): string {
  return String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function looksLikeTravelIntent(text: string): boolean {
  const t = norm(text);
  if (!t || t.length > 160) return false;
  if (/^(modo viagem|viagem|estou viajando|voltar da viagem|fim da viagem)\b/.test(t))
    return true;
  if (/^(liga|desliga|ativar|desativar)\s+modo viagem\b/.test(t)) return true;
  if (/^fuso\s+\S+/.test(t)) return true;
  return false;
}

export async function handleTravelTurn(
  db: Db,
  input: { userId: string; text: string }
): Promise<string> {
  const t = norm(input.text);
  const user = await db.query.users.findFirst({ where: eq(users.id, input.userId) });
  if (!user) return "Não achei seu perfil.";

  const profile = {
    ...((user.profileJson || {}) as Record<string, unknown>),
  };

  if (/(desliga|desativar|fim da viagem|voltar da viagem|sair do modo viagem)/.test(t)) {
    delete profile.travel_mode;
    delete profile.travel_city;
    await db
      .update(users)
      .set({
        profileJson: profile,
        timezone: "America/Sao_Paulo",
        updatedAt: new Date(),
      })
      .where(eq(users.id, input.userId));
    return [
      "✈️ *Modo viagem desligado*",
      "Fuso de volta pra *America/Sao_Paulo*.",
      "Alertas locais e avisos do Google Agenda voltam ao normal.",
    ].join("\n");
  }

  // modo viagem [cidade] [fuso opcional]
  const m = input.text.match(
    /(?:modo viagem|viagem|estou viajando|liga modo viagem)\s*(?:em|para|pra)?\s*(.+)?$/i
  );
  const rest = (m?.[1] || "").trim();
  let city = rest.split(/\s+fuso\s+/i)[0]?.trim() || rest;
  let tz = "America/Sao_Paulo";
  const fz = input.text.match(/fuso\s+(\S+)/i);
  if (fz?.[1]) {
    tz = fz[1].trim();
  } else if (/new york|nova york|nyc/i.test(city)) {
    tz = "America/New_York";
  } else if (/lisboa|portugal/i.test(city)) {
    tz = "Europe/Lisbon";
  } else if (/london|londres/i.test(city)) {
    tz = "Europe/London";
  } else if (/miami|orlando|florida/i.test(city)) {
    tz = "America/New_York";
  } else if (/buenos aires|argentina/i.test(city)) {
    tz = "America/Argentina/Buenos_Aires";
  } else if (/tokyo|toquio|tóquio/i.test(city)) {
    tz = "Asia/Tokyo";
  }

  if (!city || city.length < 2) {
    return [
      "✈️ *Modo viagem*",
      "Diga a cidade, ex.:",
      "• *modo viagem em Lisboa*",
      "• *modo viagem Miami*",
      "• *modo viagem Nova York fuso America/New_York*",
      "",
      "Isso muda o fuso dos lembretes e *silencia* avisos locais/Google da rotina.",
      "Pra sair: *desliga modo viagem*",
    ].join("\n");
  }

  profile.travel_mode = true;
  profile.travel_city = city.slice(0, 80);
  profile.travel_timezone = tz;

  await db
    .update(users)
    .set({
      profileJson: profile,
      timezone: tz,
      updatedAt: new Date(),
    })
    .where(eq(users.id, input.userId));

  return [
    `✈️ *Modo viagem ligado* · *${city}*`,
    `Fuso: \`${tz}\``,
    "",
    "• Lembretes usam esse fuso",
    "• Avisos do Google Agenda / alertas locais ficam quietos",
    "",
    "Quando voltar: *desliga modo viagem*",
  ].join("\n");
}
