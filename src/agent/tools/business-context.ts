import { eq } from "drizzle-orm";
import { conversations, whatsappIdentities } from "@/db/schema";
import {
  CONTEXT_SWITCH_HINT,
  dedupeBusinessOptions,
  formatActiveStatus,
  formatChooser,
  listBusinessOptions,
  matchBusinessChoice,
  resolveBusinessForPhone,
  setActiveBusinessContext,
  type BusinessOption,
} from "@/domain/business-context";
import { registerTool } from "./registry";

async function phoneFromCtx(ctx: {
  db: import("@/db/client").Db;
  conversationId: string;
}): Promise<string | null> {
  const conv = await ctx.db.query.conversations.findFirst({
    where: eq(conversations.id, ctx.conversationId),
  });
  if (!conv?.whatsappIdentityId) return null;
  const id = await ctx.db.query.whatsappIdentities.findFirst({
    where: eq(whatsappIdentities.id, conv.whatsappIdentityId),
  });
  return id?.phoneE164 || null;
}

registerTool({
  name: "check_business_context",
  description:
    "Mostra o modo empresarial ATUAL (locadora ou Facejus) deste WhatsApp. Use em 'onde estou?', 'qual o contexto?', 'modo atual'. Pessoal sempre existe em paralelo.",
  inputSchema: { type: "object", properties: {} },
  async handler(ctx) {
    const phone = await phoneFromCtx(ctx);
    if (!phone) {
      return { ok: false, summary: "Não identifiquei seu WhatsApp.", errorCode: "no_phone" };
    }
    const { isPersonalFocusPhone, PERSONAL_FOCUS_REPLY } = await import(
      "@/domain/personal-focus"
    );
    if (isPersonalFocusPhone(phone)) {
      return { ok: true, summary: PERSONAL_FOCUS_REPLY, data: { personalFocus: true } };
    }
    const resolved = await resolveBusinessForPhone(ctx.db, phone);
    return {
      ok: true,
      summary: formatActiveStatus(resolved.active, resolved.options),
      data: {
        options: resolved.options,
        active: resolved.active,
        needsChoice: resolved.needsChoice,
      },
    };
  },
});

registerTool({
  name: "switch_business_context",
  description:
    "Troca o contexto empresarial ativo (locadora / Facejus). Use quando o usuário disser 'trocar empresa', 'mudar contexto', 'agora a locadora X', 'agora o escritório', 'Facejus', ou responder 1/2 na lista. Pessoal NÃO muda.",
  inputSchema: {
    type: "object",
    properties: {
      choice: {
        type: "string",
        description:
          "Número da lista (1, 2…) ou trecho do nome da empresa/escritório. Vazio = só lista opções.",
      },
    },
  },
  async handler(ctx, args) {
    const phone = await phoneFromCtx(ctx);
    if (!phone) {
      return { ok: false, summary: "Não identifiquei seu WhatsApp.", errorCode: "no_phone" };
    }
    const { isPersonalFocusPhone, PERSONAL_FOCUS_REPLY } = await import(
      "@/domain/personal-focus"
    );
    if (isPersonalFocusPhone(phone)) {
      return { ok: true, summary: PERSONAL_FOCUS_REPLY, data: { personalFocus: true } };
    }
    const options = await listBusinessOptions(phone);
    if (!options.length) {
      return {
        ok: true,
        summary: [
          "Você não tem locadora nem escritório liberados neste número.",
          "O Assessor *pessoal* segue normal.",
        ].join("\n"),
      };
    }
    const choice = String(args.choice || "").trim();
    if (!choice || options.length === 1) {
      if (options.length === 1) {
        await setActiveBusinessContext(ctx.db, phone, options[0]);
        const world = options[0].kind === "locadora" ? "Locadora" : "Facejus";
        return {
          ok: true,
          summary: [
            `Modo empresarial: *${world} · ${options[0].label}* (${options[0].papel}).`,
            "Pessoal: sempre disponível em paralelo.",
            "",
            CONTEXT_SWITCH_HINT,
          ].join("\n"),
        };
      }
      return { ok: true, summary: formatChooser(options), data: { options } };
    }

    const matched = matchBusinessChoice(choice, options);
    if (!matched) {
      return {
        ok: true,
        summary: [
          "Não identifiquei qual empresa. Escolha pelo número ou diga o nome:",
          "",
          formatChooser(options),
        ].join("\n"),
        data: { options },
      };
    }
    await setActiveBusinessContext(ctx.db, phone, matched);
    const world = matched.kind === "locadora" ? "Locadora" : "Facejus";
    return {
      ok: true,
      summary: [
        `Pronto ✅ Assumi *${world} · ${matched.label}* (${matched.papel}).`,
        "Pessoal continua igual — gastos, lembretes e agenda sua não mudam.",
        "",
        CONTEXT_SWITCH_HINT,
      ].join("\n"),
      data: { active: matched },
    };
  },
});

export async function requireActiveBusinessOrChooser(
  db: import("@/db/client").Db,
  phone: string,
  kind?: "locadora" | "facejus"
): Promise<
  | { ok: true; option: BusinessOption }
  | { ok: false; summary: string }
> {
  const resolved = await resolveBusinessForPhone(db, phone);
  const options = dedupeBusinessOptions(resolved.options);

  // Sem vínculos: NÃO inventar chooser "mais de um contexto"
  if (!options.length) {
    return {
      ok: false,
      summary:
        kind === "facejus"
          ? "Neste número não há escritório Facejus liberado."
          : "Neste número não há locadora/IoT liberado. Libere em frotas.moope.com.br → Configurações → Assessor MOOPE.",
    };
  }

  // Um só: assume e segue (mesmo se effective ainda null por race)
  if (options.length === 1) {
    const only = options[0];
    if (
      !resolved.effective ||
      resolved.effective.kind !== only.kind ||
      resolved.effective.tenantId !== only.tenantId
    ) {
      await setActiveBusinessContext(db, phone, only);
    }
    if (kind && only.kind !== kind) {
      return {
        ok: false,
        summary:
          kind === "locadora"
            ? "Neste número não há locadora/IoT liberada para essa consulta."
            : "Neste número não há escritório Facejus liberado.",
      };
    }
    return { ok: true, option: only };
  }

  if (kind) {
    const sameKind = dedupeBusinessOptions(
      options.filter((option) => option.kind === kind)
    );
    if (
      resolved.effective?.kind === kind &&
      sameKind.some((option) => option.tenantId === resolved.effective?.tenantId)
    ) {
      return {
        ok: true,
        option:
          sameKind.find((option) => option.tenantId === resolved.effective?.tenantId) ||
          sameKind[0],
      };
    }
    if (sameKind.length === 1) {
      await setActiveBusinessContext(db, phone, sameKind[0]);
      return { ok: true, option: sameKind[0] };
    }
    if (sameKind.length > 1) {
      return { ok: false, summary: formatChooser(sameKind) };
    }
    return {
      ok: false,
      summary:
        kind === "locadora"
          ? "Neste número não há locadora/IoT liberada. Use *trocar empresa* se tiver outro vínculo, ou libere em frotas.moope.com.br → Assessor MOOPE."
          : "Neste número não há escritório Facejus liberado. Use *trocar empresa* se tiver outro vínculo.",
    };
  }

  if (resolved.needsChoice || !resolved.effective) {
    return {
      ok: false,
      summary: formatChooser(options),
    };
  }
  return { ok: true, option: resolved.effective };
}
