import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { registerTool } from "./registry";

function onlyDigits(s: string) {
  return String(s || "").replace(/\D/g, "");
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

registerTool({
  name: "update_user_profile",
  description:
    "Atualiza o cadastro do usuário (nome, e-mail, CPF/CNPJ, CEP/endereço, uso pessoal/negócio, tipo de negócio). Use quando a pessoa pedir para mudar dados do perfil.",
  inputSchema: {
    type: "object",
    properties: {
      full_name: { type: "string" },
      email: { type: "string" },
      cpf_cnpj: { type: "string" },
      cep: { type: "string" },
      usage_type: { type: "string", description: "pessoal | negocio" },
      business_type: {
        type: "string",
        description:
          "advocacia|restaurante|clinica_odontologica|clinica_medica|locadora|comercio|servicos|outro",
      },
      note: { type: "string", description: "Observação livre para memória de perfil" },
    },
  },
  async handler(ctx, args) {
    const user = await ctx.db.query.users.findFirst({
      where: eq(users.id, ctx.userId),
    });
    if (!user) {
      return { ok: false, summary: "Usuário não encontrado", errorCode: "not_found" };
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    const changed: string[] = [];

    if (args.full_name) {
      const full = String(args.full_name).trim().slice(0, 200);
      patch.fullName = full;
      if (!user.name || user.name.length < 3) patch.name = full.split(" ")[0];
      changed.push(`nome=${full}`);
    }
    if (args.email) {
      const email = String(args.email).toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { ok: false, summary: "E-mail inválido", errorCode: "invalid_email" };
      }
      patch.email = email;
      changed.push(`e-mail=${email}`);
    }
    if (args.cpf_cnpj) {
      const doc = onlyDigits(String(args.cpf_cnpj));
      if (doc.length !== 11 && doc.length !== 14) {
        return { ok: false, summary: "CPF/CNPJ inválido", errorCode: "invalid_doc" };
      }
      patch.cpfCnpj = doc;
      changed.push("documento atualizado");
    }
    if (args.usage_type) {
      const u = String(args.usage_type).toLowerCase();
      if (u.startsWith("neg")) patch.usageType = "negocio";
      else if (u.startsWith("pes")) patch.usageType = "pessoal";
      if (patch.usageType) changed.push(`uso=${patch.usageType}`);
    }
    if (args.business_type) {
      patch.businessType = String(args.business_type).slice(0, 64);
      changed.push(`negócio=${patch.businessType}`);
    }

    let addressJson = (user.addressJson || {}) as Record<string, unknown>;
    if (args.cep) {
      const address = await lookupCep(String(args.cep));
      if (!address) {
        return { ok: false, summary: "CEP não encontrado", errorCode: "invalid_cep" };
      }
      patch.cep = onlyDigits(String(args.cep));
      patch.addressJson = address;
      addressJson = address;
      changed.push(
        `endereço=${String(address.logradouro || "")} ${String(address.localidade || "")}/${String(address.uf || "")}`.trim()
      );
    }

    if (args.note) {
      patch.profileJson = {
        ...(user.profileJson || {}),
        last_note: String(args.note).slice(0, 500),
        updated_via: "whatsapp_tool",
      };
      changed.push("nota de perfil");
    }

    if (changed.length === 0) {
      return {
        ok: false,
        summary: "Nada para atualizar — diga o que mudar (e-mail, CEP, nome…)",
        errorCode: "empty_patch",
      };
    }

    await ctx.db.update(users).set(patch).where(eq(users.id, ctx.userId));

    return {
      ok: true,
      summary: `Cadastro atualizado: ${changed.join("; ")}`,
      data: {
        city: addressJson.localidade || null,
        uf: addressJson.uf || null,
      },
    };
  },
});

registerTool({
  name: "get_user_profile",
  description: "Mostra o cadastro atual do usuário (nome, e-mail, uso, negócio, endereço).",
  inputSchema: { type: "object", properties: {} },
  async handler(ctx) {
    const user = await ctx.db.query.users.findFirst({
      where: eq(users.id, ctx.userId),
    });
    if (!user) {
      return { ok: false, summary: "Usuário não encontrado", errorCode: "not_found" };
    }
    const address = (user.addressJson || {}) as Record<string, unknown>;
    const email = user.email?.includes("@whatsapp.assessor.moope.local")
      ? "(não informado)"
      : user.email;
    const lines = [
      `Nome: ${user.fullName || user.name}`,
      `E-mail: ${email}`,
      `Uso: ${user.usageType || "—"}`,
      user.businessType ? `Negócio: ${user.businessType}` : null,
      user.cep
        ? `CEP: ${user.cep} — ${String(address.logradouro || "")} ${String(address.localidade || "")}/${String(address.uf || "")}`.trim()
        : "Endereço: —",
    ].filter(Boolean);
    return {
      ok: true,
      summary: lines.join("\n"),
      data: { user_id: user.id },
    };
  },
});
