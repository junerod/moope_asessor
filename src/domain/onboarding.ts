import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  consentAcceptances,
  conversations,
  users,
  type Conversation,
} from "@/db/schema";
import { getEnv } from "@/config/env";
import { pairIdentityToUser } from "@/domain/whatsapp-identities";
import {
  createPersonalWorkspace,
  getPersonalWorkspaceForUser,
} from "@/domain/workspaces";
import { hashPassword } from "@/lib/auth";
import { randomToken } from "@/lib/crypto";
import { isPhoneWhitelisted } from "@/domain/access-whitelist";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const BUSINESS_TYPES: Array<{ key: string; labels: RegExp; title: string }> = [
  { key: "advocacia", labels: /^(1|advogad|advocacia)\b/i, title: "Advocacia" },
  { key: "restaurante", labels: /^(2|restaurante|food|bar)\b/i, title: "Restaurante / Food" },
  {
    key: "clinica_odontologica",
    labels: /^(3|odonto|dentista|cl[ií]nica odont)/i,
    title: "Clínica odontológica / Dentista",
  },
  {
    key: "clinica_medica",
    labels: /^(4|cl[ií]nica|m[eé]dic)/i,
    title: "Clínica médica",
  },
  { key: "locadora", labels: /^(5|locadora|frota|ve[ií]culo)/i, title: "Locadora / Frota" },
  { key: "comercio", labels: /^(6|com[eé]rcio|loja|varejo)/i, title: "Comércio" },
  { key: "servicos", labels: /^(7|servi[cç]os?)\b/i, title: "Serviços" },
  { key: "outro", labels: /^(8|outro)/i, title: "Outro" },
];

export type OnboardingResult = {
  reply: string;
  completed: boolean;
  userId?: string;
  workspaceId?: string;
};

function meta(conversation: Conversation): Record<string, unknown> {
  return (conversation.metadata as Record<string, unknown>) || {};
}

function onlyDigits(s: string) {
  return String(s || "").replace(/\D/g, "");
}

function validCpf(cpf: string): boolean {
  const d = onlyDigits(cpf);
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * (10 - i);
  let rev = (sum * 10) % 11;
  if (rev === 10) rev = 0;
  if (rev !== Number(d[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(d[i]) * (11 - i);
  rev = (sum * 10) % 11;
  if (rev === 10) rev = 0;
  return rev === Number(d[10]);
}

function validCnpj(cnpj: string): boolean {
  const d = onlyDigits(cnpj);
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const calc = (base: string, factors: number[]) => {
    let sum = 0;
    for (let i = 0; i < factors.length; i++) sum += Number(base[i]) * factors[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const n1 = calc(d, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const n2 = calc(d, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return n1 === Number(d[12]) && n2 === Number(d[13]);
}

async function lookupCep(cep: string): Promise<Record<string, unknown> | null> {
  const d = onlyDigits(cep);
  if (d.length !== 8) return null;
  try {
    const res = await fetch(`https://viacep.com.br/ws/${d}/json/`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    if (data.erro) return null;
    return data;
  } catch {
    return null;
  }
}

async function setStep(
  db: Db,
  conversationId: string,
  step: Conversation["onboardingStep"],
  metadata?: Record<string, unknown>
) {
  await db
    .update(conversations)
    .set({
      onboardingStep: step,
      metadata: metadata,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));
}

function usageTypePrompt() {
  return (
    "Para eu te atender melhor, esse uso é:\n\n" +
    "1) Pessoal\n" +
    "2) Negócio / empresa\n\n" +
    "Responda *1* ou *2*."
  );
}

function businessTypePrompt() {
  return (
    "Qual o tipo do negócio?\n\n" +
    "1) Advocacia\n" +
    "2) Restaurante / Food\n" +
    "3) Clínica odontológica / Dentista\n" +
    "4) Clínica médica\n" +
    "5) Locadora / Frota\n" +
    "6) Comércio\n" +
    "7) Serviços\n" +
    "8) Outro\n\n" +
    "Responda com o número ou o nome."
  );
}

export async function handleOnboardingTurn(
  db: Db,
  input: {
    conversation: Conversation;
    identityId: string;
    text: string;
  }
): Promise<OnboardingResult> {
  const env = getEnv();
  const text = input.text.trim();
  const conversation = input.conversation;
  const step = conversation.onboardingStep;
  const m = meta(conversation);

  if (step === "completed") {
    return { reply: "Sua conta já está ativa. Como posso ajudar?", completed: true };
  }

  if (step === "awaiting_name") {
    if (!text || text.length < 2) {
      return {
        reply:
          "Olá! Eu sou o Assessor da MOOPE. Posso ajudar você a organizar compromissos, documentos, tarefas e informações importantes.\n\nComo posso te chamar?",
        completed: false,
      };
    }
    if (/^(oi|olá|ola|hey|hello|bom dia|boa tarde|boa noite)\b/i.test(text) && text.length < 20) {
      return {
        reply:
          "Olá! Eu sou o Assessor da MOOPE. Posso ajudar você a organizar compromissos, documentos, tarefas e informações importantes.\n\nComo posso te chamar?",
        completed: false,
      };
    }
    const name = text.slice(0, 200);
    await setStep(db, conversation.id, "awaiting_email", {
      ...m,
      pending_name: name,
    });
    return {
      reply: `Prazer, ${name.split(" ")[0]}. Qual é o seu e-mail?`,
      completed: false,
    };
  }

  if (step === "awaiting_email") {
    // E-mail é só cadastral — identidade já é o WhatsApp. Sem código / confirmação.
    const raw = text.replace(/[\u200b-\u200d\ufeff]/g, "").trim();
    if (/^(pular|skip|depois|nao|não)\b/i.test(raw)) {
      await setStep(db, conversation.id, "awaiting_usage_type", {
        ...m,
        pending_email: null,
        email_verified: false,
        email_informational: true,
        email_skipped: true,
      });
      return {
        reply: `Sem problema — seguimos só com o WhatsApp.\n\n${usageTypePrompt()}`,
        completed: false,
      };
    }
    const email = raw.toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return {
        reply:
          "Esse e-mail não parece válido. Envie no formato nome@dominio.com (ex.: june@hotmail.com).\n\nOu diga *pular* se quiser informar depois.",
        completed: false,
      };
    }
    await setStep(db, conversation.id, "awaiting_usage_type", {
      ...m,
      pending_email: email,
      email_verified: false,
      email_informational: true,
    });
    return {
      reply: `Anotei o e-mail ${email}.\n\n${usageTypePrompt()}`,
      completed: false,
    };
  }

  // Compat: se ainda estiver no passo antigo de verificação, pula direto
  if (step === "awaiting_verification") {
    const maybeEmail = text.toLowerCase().replace(/[\u200b-\u200d\ufeff]/g, "").trim();
    const pendingEmail = EMAIL_RE.test(maybeEmail)
      ? maybeEmail
      : String(m.pending_email || "").toLowerCase();
    await setStep(db, conversation.id, "awaiting_usage_type", {
      ...m,
      pending_email: pendingEmail || m.pending_email,
      email_verified: false,
      email_informational: true,
    });
    return {
      reply: `Seguimos pelo WhatsApp — sem precisar confirmar e-mail.\n\n${usageTypePrompt()}`,
      completed: false,
    };
  }

  if (step === "awaiting_usage_type") {
    const t = text.toLowerCase();
    let usage: "pessoal" | "negocio" | null = null;
    if (/^(1|pessoal|pessoal\/|uso pessoal)\b/i.test(t)) usage = "pessoal";
    if (/^(2|neg[oó]cio|empresa|business)\b/i.test(t)) usage = "negocio";
    if (!usage) {
      return { reply: `Não entendi.\n\n${usageTypePrompt()}`, completed: false };
    }
    if (usage === "negocio") {
      await setStep(db, conversation.id, "awaiting_business_type", {
        ...m,
        pending_usage_type: usage,
      });
      return { reply: businessTypePrompt(), completed: false };
    }
    // Pessoal: caminho curto — nome já basta; KYC (CPF/CEP) depois se precisar
    await setStep(db, conversation.id, "awaiting_terms", {
      ...m,
      pending_usage_type: usage,
      pending_business_type: null,
      pending_full_name: String(m.pending_name || "").slice(0, 200),
      personal_short_path: true,
    });
    return {
      reply:
        "Perfeito — uso *pessoal*.\n\n" +
        `Para começar, preciso do seu aceite dos Termos (${env.TERMS_VERSION}) e da Política de Privacidade (${env.PRIVACY_VERSION}).\n\n` +
        `Responda *"aceito"* para ativar sua conta.`,
      completed: false,
    };
  }

  if (step === "awaiting_business_type") {
    const matched = BUSINESS_TYPES.find((b) => b.labels.test(text.trim()));
    if (!matched) {
      return { reply: `Não entendi.\n\n${businessTypePrompt()}`, completed: false };
    }
    await setStep(db, conversation.id, "awaiting_full_name", {
      ...m,
      pending_business_type: matched.key,
      pending_business_title: matched.title,
    });
    return {
      reply: `Combinado — *${matched.title}*.\n\nAgora me diga o *nome completo* do responsável (como no documento).`,
      completed: false,
    };
  }

  if (step === "awaiting_full_name") {
    const full = text.replace(/\s+/g, " ").trim();
    if (full.length < 5 || full.split(" ").length < 2) {
      return {
        reply: "Preciso do nome completo (nome e sobrenome), por favor.",
        completed: false,
      };
    }
    await setStep(db, conversation.id, "awaiting_cpf", {
      ...m,
      pending_full_name: full.slice(0, 200),
    });
    return {
      reply:
        "Obrigado. Agora envie seu *CPF* (ou CNPJ, se for o caso da empresa).",
      completed: false,
    };
  }

  if (step === "awaiting_cpf") {
    const doc = onlyDigits(text);
    const ok = doc.length === 11 ? validCpf(doc) : doc.length === 14 ? validCnpj(doc) : false;
    if (!ok) {
      return {
        reply: "CPF/CNPJ inválido. Envie só os números, com 11 (CPF) ou 14 (CNPJ) dígitos.",
        completed: false,
      };
    }
    await setStep(db, conversation.id, "awaiting_cep", {
      ...m,
      pending_cpf_cnpj: doc,
    });
    return {
      reply: "Quase lá. Qual o *CEP* do endereço principal?",
      completed: false,
    };
  }

  if (step === "awaiting_cep") {
    const cep = onlyDigits(text);
    if (cep.length !== 8) {
      return { reply: "CEP inválido. Envie 8 dígitos, ex.: 70000000.", completed: false };
    }
    const address = await lookupCep(cep);
    if (!address) {
      return {
        reply: "Não encontrei esse CEP. Confira e envie novamente.",
        completed: false,
      };
    }
    const city = String(address.localidade || "");
    const uf = String(address.uf || "");
    const street = String(address.logradouro || "");
    await setStep(db, conversation.id, "awaiting_terms", {
      ...m,
      pending_cep: cep,
      pending_address: address,
    });
    return {
      reply:
        `Endereço encontrado: ${street ? street + " — " : ""}${city}/${uf}.\n\n` +
        `Para concluir, preciso do seu aceite dos Termos (${env.TERMS_VERSION}) e da Política de Privacidade (${env.PRIVACY_VERSION}). Responda *"aceito"* para continuar.`,
      completed: false,
    };
  }

  if (step === "awaiting_terms") {
    const { looksLikeLegalAsk, formatLegalReply } = await import(
      "@/domain/legal-docs"
    );
    if (looksLikeLegalAsk(text)) {
      const body = formatLegalReply(text) || "";
      return {
        reply: `${body}\n\nQuando terminar a leitura, responda *"aceito"* para ativar a conta.`,
        completed: false,
      };
    }
    if (!/^aceito\b/i.test(text)) {
      return {
        reply: `Para usar o Assessor MOOPE, responda "aceito" aos Termos ${env.TERMS_VERSION} e Privacidade ${env.PRIVACY_VERSION}.\n\nQuer ler? Diga *termos de privacidade* ou *termos de uso*.`,
        completed: false,
      };
    }

    const pendingName = String(m.pending_name || "Usuário");
    const pendingFullName = String(m.pending_full_name || pendingName);

    const { whatsappIdentities } = await import("@/db/schema");
    const identity = await db.query.whatsappIdentities.findFirst({
      where: eq(whatsappIdentities.id, input.identityId),
    });
    const phoneDigits = onlyDigits(identity?.phoneE164 || "") || input.identityId.slice(0, 12);
    const pendingEmail =
      String(m.pending_email || "").toLowerCase() ||
      `wa${phoneDigits}@whatsapp.assessor.moope.local`;

    const usageType = String(m.pending_usage_type || "pessoal");
    const businessType =
      usageType === "negocio" ? String(m.pending_business_type || "outro") : null;
    const cpfCnpj = String(m.pending_cpf_cnpj || "") || null;
    const cep = String(m.pending_cep || "") || null;
    const addressJson = (m.pending_address as Record<string, unknown>) || {};

    const whitelisted = await isPhoneWhitelisted(db, identity?.phoneE164);

    let user = await db.query.users.findFirst({
      where: and(eq(users.email, pendingEmail), isNull(users.deletedAt)),
    });

    const profileJson = {
      usage_type: usageType,
      business_type: businessType,
      business_title: m.pending_business_title || null,
      whitelisted,
      billing_status: whitelisted ? "comped" : "pending_payment",
      onboarded_via: "whatsapp",
      email_informational: true,
      email_skipped: Boolean(m.email_skipped),
      phone_e164: identity?.phoneE164 || null,
    };

    if (!user) {
      const [created] = await db
        .insert(users)
        .values({
          email: pendingEmail,
          name: pendingName,
          fullName: pendingFullName,
          passwordHash: await hashPassword(randomToken(16)),
          status: "active",
          emailVerifiedAt: null,
          timezone: env.DEFAULT_TIMEZONE,
          termsVersion: env.TERMS_VERSION,
          privacyVersion: env.PRIVACY_VERSION,
          termsAcceptedAt: new Date(),
          globalUserId: null,
          cpfCnpj,
          cep,
          usageType,
          businessType,
          profileJson,
          addressJson,
          accountStatus: whitelisted ? "active" : "trial",
        })
        .returning();
      user = created;
    } else {
      await db
        .update(users)
        .set({
          name: user.name || pendingName,
          fullName: pendingFullName,
          // e-mail informativo — não exige verificação
          emailVerifiedAt: user.emailVerifiedAt || null,
          termsVersion: env.TERMS_VERSION,
          privacyVersion: env.PRIVACY_VERSION,
          termsAcceptedAt: new Date(),
          status: "active",
          cpfCnpj: cpfCnpj || user.cpfCnpj,
          cep: cep || user.cep,
          usageType,
          businessType,
          profileJson: { ...(user.profileJson || {}), ...profileJson },
          addressJson,
          accountStatus: whitelisted ? "active" : user.accountStatus || "trial",
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));
    }

    let workspace = await getPersonalWorkspaceForUser(db, user.id);
    if (!workspace) {
      const wsName =
        usageType === "negocio"
          ? `${pendingName.split(" ")[0]} — Negócio`
          : `${pendingName.split(" ")[0]} — Pessoal`;
      const created = await createPersonalWorkspace(db, {
        userId: user.id,
        name: wsName,
        timezone: user.timezone || env.DEFAULT_TIMEZONE,
      });
      workspace =
        (await db.query.workspaces.findFirst({
          where: (w, { eq: e }) => e(w.id, created.id),
        })) ?? null;
    }
    if (!workspace) throw new Error("workspace_create_failed");

    await pairIdentityToUser(db, {
      identityId: input.identityId,
      userId: user.id,
    });

    await db.insert(consentAcceptances).values({
      userId: user.id,
      workspaceId: workspace.id,
      termsVersion: env.TERMS_VERSION,
      privacyVersion: env.PRIVACY_VERSION,
      channel: "whatsapp",
      acceptedAt: new Date(),
    });

    const { ensureDefaultSubscription } = await import("@/domain/whatsapp-channels");
    await ensureDefaultSubscription(db, workspace.id);

    // Whitelist → acesso liberado; demais ficam em trial até Asaas (paywall futuro)
    if (whitelisted) {
      const { subscriptions } = await import("@/db/schema");
      await db
        .update(subscriptions)
        .set({ status: "comped", updatedAt: new Date() })
        .where(eq(subscriptions.workspaceId, workspace.id));
    }

    await db
      .update(conversations)
      .set({
        userId: user.id,
        workspaceId: workspace.id,
        status: "active",
        onboardingStep: "completed",
        metadata: {
          ...m,
          onboarded_at: new Date().toISOString(),
          whitelisted,
        },
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversation.id));

    const bizNote =
      usageType === "negocio" && m.pending_business_title
        ? ` Vi que você atua com *${String(m.pending_business_title)}* — vou adaptar as respostas a esse contexto.`
        : usageType === "pessoal"
          ? " Vou te ajudar no dia a dia pessoal."
          : "";

    const accessNote = whitelisted
      ? " Seu acesso está liberado (lista especial)."
      : " Em breve a liberação definitiva virá após confirmação de pagamento (PIX/boleto). Por enquanto você já pode começar a usar em modo de avaliação.";

    const privacyBlurb = [
      "────────────",
      "🔒 *Seus dados*",
      "Não vendemos suas informações. Suas conversas não viram anúncio pra terceiros.",
      "Detalhes (LGPD): https://assessor.moope.com.br/legal/privacidade",
    ].join("\n");

    const tourPessoal = [
      `✨ *Pronto, ${pendingName.split(" ")[0]}!*`,
      `Sua conta do Assessor MOOPE está ativa.${bizNote}${accessNote}`,
      "────────────",
      "*O que eu faço por você*",
      "⏰ Lembretes que *disparam de verdade*",
      "📅 Agenda e tarefas",
      "💸 Gastos, metas e contas",
      "📎 Foto de boleto, nota ou receita",
      "☀️ Resumo do dia de manhã (pode desligar)",
      "────────────",
      "*Experimente agora*",
      "1. `me lembre amanhã às 9h de …`",
      "2. `gastei R$ 50 de mercado`",
      "3. manda uma *foto* de boleto ou receita",
      "",
      "⚙️ Diga *preferências* pra ligar/desligar avisos.",
      "📖 Ou: “como controlo meus gastos?”",
      privacyBlurb,
    ].join("\n");

    const tourNegocio = [
      `Perfeito, ${pendingName.split(" ")[0]}! Sua conta do Assessor MOOPE está pronta.${bizNote}${accessNote}`,
      "",
      "Pode falar comigo no WhatsApp como com um assessor de verdade.",
      "",
      "📎 Manda foto de *receita* ou *nota* que eu guardo.",
      "💸 Ou diga “gastei R$ 50 de mercado”.",
      "📅 Lembretes, agenda e tarefas também.",
      "",
      "Dica: pergunte “como controlo meus gastos?” ou “quanto gastei esse mês?” quando quiser.",
      "",
      "⚙️ Diga *preferências* para avisos.",
      privacyBlurb,
    ].join("\n");

    return {
      reply: usageType === "pessoal" ? tourPessoal : tourNegocio,
      completed: true,
      userId: user.id,
      workspaceId: workspace.id,
    };
  }

  await setStep(db, conversation.id, "awaiting_name", m);
  return {
    reply:
      "Olá! Eu sou o Assessor da MOOPE 🙂\nPosso guardar receitas e notas (foto), anotar gastos, lembretes e agenda.\n\nComo posso te chamar?",
    completed: false,
  };
}
