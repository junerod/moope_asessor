import { registerTool } from "./registry";
import { formatDeepLinksBlock } from "@/domain/deep-links";

/**
 * Pesquisa web leve (DuckDuckGo Instant Answer + HTML lite).
 * Sempre devolve o texto encontrado + atalhos clicáveis (Google Flights etc.).
 */
registerTool({
  name: "web_research",
  description:
    "Pesquisa na internet (passagens, preços de carro, horários, indicações, notícias). Use sempre que o usuário pedir dados do mundo real. Devolva o conteúdo completo ao usuário.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      locale_hint: {
        type: "string",
        description: "Ex.: Brasil, São José SC, BRL",
      },
    },
    required: ["query"],
  },
  async handler(_ctx, args) {
    const q = String(args.query || "").trim();
    if (q.length < 3) {
      return { ok: false, summary: "Consulta vazia", errorCode: "invalid_args" };
    }
    const locale = String(args.locale_hint || "Brasil").trim();
    const query = `${q} ${locale}`.trim();
    const wantQuote =
      /(pre[cç]o|cota[cç][aã]o|passagem|voo|a[eé]reo|hotel|di[aá]ria|quanto custa)/i.test(
        q
      );

    const snippets: string[] = [];
    const links: string[] = [];

    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          AbstractText?: string;
          AbstractURL?: string;
          Heading?: string;
          RelatedTopics?: Array<{
            Text?: string;
            FirstURL?: string;
            Topics?: Array<{ Text?: string; FirstURL?: string }>;
          }>;
          Results?: Array<{ Text?: string; FirstURL?: string }>;
        };
        if (data.AbstractText) {
          snippets.push(
            `${data.Heading ? data.Heading + ": " : ""}${data.AbstractText}`
          );
        }
        if (data.AbstractURL) links.push(data.AbstractURL);
        for (const t of data.RelatedTopics || []) {
          if (t.Text) snippets.push(t.Text);
          if (t.FirstURL) links.push(t.FirstURL);
          for (const st of t.Topics || []) {
            if (st.Text) snippets.push(st.Text);
            if (st.FirstURL) links.push(st.FirstURL);
          }
          if (snippets.length >= 8) break;
        }
        for (const r of data.Results || []) {
          if (r.Text) snippets.push(r.Text);
          if (r.FirstURL) links.push(r.FirstURL);
        }
      }
    } catch {
      /* fall through */
    }

    if (snippets.length < 2) {
      try {
        const lite = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const res = await fetch(lite, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; MOOPE-Assessor/1.0; +https://assessor.moope.com.br)",
            Accept: "text/html",
          },
          signal: AbortSignal.timeout(15000),
        });
        const html = await res.text();
        const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
        const linkRe =
          /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let m: RegExpExecArray | null;
        while ((m = snippetRe.exec(html)) && snippets.length < 6) {
          const text = m[1]
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          if (text.length > 30) snippets.push(text);
        }
        while ((m = linkRe.exec(html)) && links.length < 5) {
          let href = m[1];
          try {
            const u = new URL(href.startsWith("//") ? `https:${href}` : href);
            const real = u.searchParams.get("uddg");
            if (real) href = decodeURIComponent(real);
          } catch {
            /* keep */
          }
          if (/^https?:\/\//i.test(href) && !/duckduckgo\.com/i.test(href)) {
            links.push(href);
          }
        }
      } catch {
        /* ignore */
      }
    }

    const deep = formatDeepLinksBlock(q);
    const uniqueLinks = [...new Set(links)].slice(0, 4);
    const uniqueSnips = [...new Set(snippets)].slice(0, 6);

    if (!uniqueSnips.length && !uniqueLinks.length) {
      return {
        ok: true,
        summary: [
          wantQuote
            ? `🔎 *Cotação / preço*`
            : `🔎 *Pesquisa*`,
          "────────────",
          wantQuote
            ? `Não achei valor fechado pra “${q}” agora.`
            : `Não trouxe resultados confiáveis agora pra “${q}”.`,
          "",
          wantQuote
            ? "Me diga *origem, destino e datas* (ex.: Brasília → Salvador, 27–30/09) que eu monto melhor."
            : "Refina (cidade, data, modelo) que eu tento de novo.",
          deep ? `\n${deep}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        data: { query, snippets: [], links: [] },
      };
    }

    const title = wantQuote ? "🔎 *Cotação / preço*" : "🔎 *Pesquisa*";
    const lines = [
      title,
      "────────────",
      `*Pedido:* ${q}`,
      "",
      "*O que achei*",
      ...uniqueSnips.map((s, i) => `• ${s}`),
      uniqueLinks.length
        ? `\n*Fonte*\n${uniqueLinks.map((l) => `• ${l}`).join("\n")}`
        : null,
      deep ? `\n${deep}` : null,
      "",
      "────────────",
      wantQuote
        ? "_Pesquisa aberta (não cotação oficial). Valores mudam — confirme no site._"
        : "_Fontes da web — confira se precisar._",
    ].filter(Boolean);

    return {
      ok: true,
      summary: lines.join("\n"),
      data: { query, snippets: uniqueSnips, links: uniqueLinks },
    };
  },
});
