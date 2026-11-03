import { searchMoopeKnowledge, MOOPE_SITE } from "@/domain/moope-knowledge";
import { registerTool } from "./registry";

registerTool({
  name: "search_moope_knowledge",
  description:
    "Busca informações oficiais sobre a MOOPE (produtos, finance, rastreamento, planos, locadoras). SEMPRE use quando perguntarem sobre MOOPE, preços MOOPE, produtos MOOPE, moope-finance. Sempre cite https://moope.com.br",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
  },
  async handler(ctx, args) {
    const q = String(args.query || "").trim();
    const { looksLikeLegalAsk, formatLegalReply } = await import(
      "@/domain/legal-docs"
    );
    if (looksLikeLegalAsk(q)) {
      const body = formatLegalReply(q) || "";
      return { ok: true, summary: body, data: { kind: "legal" } };
    }
    if (q.length < 2) {
      return {
        ok: true,
        summary: `Sobre a MOOPE, veja o site oficial: ${MOOPE_SITE}`,
        data: { site: MOOPE_SITE },
      };
    }
    const hits = await searchMoopeKnowledge(ctx.db, q, 4);
    if (!hits.length) {
      return {
        ok: true,
        summary: `Não encontrei um trecho interno específico. Para produtos e preços da MOOPE, acesse ${MOOPE_SITE}`,
        data: { site: MOOPE_SITE, hits: [] },
      };
    }
    const body = hits
      .map((h, i) => `${i + 1}. *${h.title}*\n${h.content}`)
      .join("\n\n");
    return {
      ok: true,
      summary: `${body}\n\n🔗 Saiba mais / preços atualizados: ${MOOPE_SITE}`,
      data: { site: MOOPE_SITE, hits },
    };
  },
});
