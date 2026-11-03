/**
 * Atalhos determinísticos do Assessor pessoal (texto ou áudio transcrito).
 * Retorna reply pronta ou null pra seguir pro LLM.
 */
import type { Db } from "@/db/client";
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { whatsappIdentities } from "@/db/schema";

export async function tryPersonalShortcuts(
  db: Db,
  input: {
    userId: string;
    workspaceId: string;
    text: string;
    phoneE164?: string | null;
    timezone?: string;
  }
): Promise<{ reply: string; model: string } | null> {
  const text = String(input.text || "").trim();
  if (!text || text.length > 2000) return null;

  const { looksLikeLegalAsk, formatLegalReply } = await import(
    "@/domain/legal-docs"
  );
  if (looksLikeLegalAsk(text)) {
    const reply = formatLegalReply(text);
    if (reply) return { reply, model: "legal-docs" };
  }

  const { looksLikePreferencesCommand, handlePreferencesTurn } = await import(
    "@/domain/user-preferences"
  );
  if (looksLikePreferencesCommand(text)) {
    return {
      reply: await handlePreferencesTurn(db, input.userId, text),
      model: "user-preferences",
    };
  }

  const { shouldHandleWeatherTurn, handleWeatherTurn } = await import(
    "@/domain/weather-prefs"
  );
  if (await shouldHandleWeatherTurn(db, input.userId, text)) {
    return {
      reply: await handleWeatherTurn(db, {
        userId: input.userId,
        text,
        phoneE164: input.phoneE164,
      }),
      model: "weather",
    };
  }

  const { looksLikeFxIntent, handleFxTurn } = await import(
    "@/domain/exchange-rate"
  );
  if (looksLikeFxIntent(text)) {
    return { reply: await handleFxTurn(text), model: "exchange-rate" };
  }

  const { looksLikeLeaveHomeIntent, handleLeaveHomeTurn } = await import(
    "@/domain/leave-home"
  );
  if (looksLikeLeaveHomeIntent(text)) {
    return {
      reply: await handleLeaveHomeTurn(db, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        text,
        phoneE164: input.phoneE164,
        timezone: input.timezone,
      }),
      model: "leave-home",
    };
  }

  const { looksLikeRouteIntent, handleRouteTurn } = await import(
    "@/domain/routes"
  );
  if (looksLikeRouteIntent(text)) {
    return {
      reply: await handleRouteTurn(db, {
        userId: input.userId,
        text,
        phoneE164: input.phoneE164,
      }),
      model: "routes",
    };
  }

  const { parseSpokenDone, applySpokenDone, looksLikeYesterdayAsk, replyYesterdayOpen } =
    await import("@/domain/reminder-baixa");
  if (looksLikeYesterdayAsk(text)) {
    return {
      reply: await replyYesterdayOpen(db, {
        workspaceId: input.workspaceId,
        timezone: input.timezone || "America/Sao_Paulo",
      }),
      model: "yesterday-open",
    };
  }
  if (parseSpokenDone(text)) {
    const reply = await applySpokenDone(db, {
      workspaceId: input.workspaceId,
      text,
    });
    if (reply) return { reply, model: "spoken-done" };
  }

  const {
    getReceiptPending,
    looksLikeReceiptPaidText,
    handleReceiptTextTurn,
  } = await import("@/domain/receipt-prompt");
  if (
    looksLikeReceiptPaidText(text) &&
    (await getReceiptPending(db, input.userId))
  ) {
    const reply = await handleReceiptTextTurn(db, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      text,
    });
    if (reply) return { reply, model: "receipt-prompt" };
  }

  const {
    looksLikeContactGroupIntent,
    handleContactGroupTurn,
    looksLikeFamilyIntent,
    handleFamilyTurn,
  } = await import("@/domain/family-contacts");
  if (looksLikeContactGroupIntent(text)) {
    return {
      reply: await handleContactGroupTurn(db, { userId: input.userId, text }),
      model: "contact-groups",
    };
  }
  if (looksLikeFamilyIntent(text)) {
    return {
      reply: await handleFamilyTurn(db, {
        userId: input.userId,
        text,
      }),
      model: "family-contacts",
    };
  }

  const { looksLikeTravelIntent, handleTravelTurn } = await import(
    "@/domain/travel-mode"
  );
  if (looksLikeTravelIntent(text)) {
    return {
      reply: await handleTravelTurn(db, {
        userId: input.userId,
        text,
      }),
      model: "travel-mode",
    };
  }

  const { looksLikeSocialFollowUp, handleSocialFollowUp } = await import(
    "@/domain/social-followup"
  );
  if (looksLikeSocialFollowUp(text)) {
    return {
      reply: await handleSocialFollowUp(db, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        text,
        timezone: input.timezone,
      }),
      model: "social-followup",
    };
  }

  const { looksLikeUsefulMemoryIntent, handleUsefulMemoryTurn } = await import(
    "@/domain/useful-memory"
  );
  if (looksLikeUsefulMemoryIntent(text)) {
    return {
      reply: await handleUsefulMemoryTurn(db, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        text,
      }),
      model: "useful-memory",
    };
  }

  const { looksLikeDayList } = await import("@/domain/desk-router");
  if (looksLikeDayList(text)) {
    const { parseNaturalDateTime } = await import("@/lib/datetime");
    const { loadDayAgenda, formatDayAgenda } = await import(
      "@/domain/day-agenda"
    );
    const tz = input.timezone || "America/Sao_Paulo";
    const when =
      parseNaturalDateTime(text, tz) || parseNaturalDateTime("hoje", tz);
    const iso = when?.toISODate() || undefined;
    const items = await loadDayAgenda(db, input.workspaceId, tz, iso);
    const dayIso = iso || DateTime.now().setZone(tz).toISODate() || "";
    return {
      reply: formatDayAgenda(items, tz, dayIso),
      model: "day-list",
    };
  }

  const { parseBaixaIntent, applyBaixaIntent } = await import(
    "@/domain/reminder-baixa"
  );
  const intent = parseBaixaIntent(text);
  if (intent) {
    const reply = await applyBaixaIntent(db, {
      workspaceId: input.workspaceId,
      timezone: input.timezone || "America/Sao_Paulo",
      intent,
    });
    if (reply) return { reply, model: "reminder-baixa" };
  }

  return null;
}

export async function phoneFromConversation(
  db: Db,
  whatsappIdentityId: string | null | undefined
): Promise<string | null> {
  if (!whatsappIdentityId) return null;
  const id = await db.query.whatsappIdentities.findFirst({
    where: eq(whatsappIdentities.id, whatsappIdentityId),
  });
  return id?.phoneE164 || null;
}
