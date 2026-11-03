import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { readFacejusLive } from "@/domain/visual-board";
import {
  agendaFacejus,
  agendaPdfFacejus,
  andamentoFacejus,
  buscarProcessosFacejus,
} from "@/integrations/facejus-assessor";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const live = await readFacejusLive(getDb(), token);
  if (!live) {
    return NextResponse.json({ error: "link_expirado" }, { status: 404 });
  }
  if (req.nextUrl.searchParams.get("pdf") === "1") {
    if (live.modo !== "agenda") {
      return NextResponse.json({ error: "sem_pdf" }, { status: 400 });
    }
    const diaPdf = String(req.nextUrl.searchParams.get("dia") || live.dia || "");
    const pdf = await agendaPdfFacejus(live.phone, live.tenantId, diaPdf, {
      natureza: live.natureza,
      escritorioId: live.escritorioId,
    });
    if (!pdf) {
      return NextResponse.json({ error: "pdf_indisponivel" }, { status: 502 });
    }
    const arquivo = live.natureza === "administrativo" ? "atendimentos" : "prazos-processuais";
    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${arquivo}-${diaPdf || "dia"}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  }
  const q = String(req.nextUrl.searchParams.get("q") || "");
  const numero = String(req.nextUrl.searchParams.get("numero") || "");
  const dia = String(req.nextUrl.searchParams.get("dia") || live.dia || "");
  const andamento = req.nextUrl.searchParams.get("andamento") === "1";
  const agenda = req.nextUrl.searchParams.get("agenda") === "1" || live.modo === "agenda" && !q && !andamento;

  if (andamento) {
    if (numero.replace(/\D/g, "").length < 4) {
      return NextResponse.json({ error: "numero_invalido" }, { status: 400 });
    }
    const data = await andamentoFacejus(live.phone, live.tenantId, numero);
    return NextResponse.json({
      encontrado: data.encontrado === true,
      novos: data.novos || [],
      legado: data.legado || null,
    });
  }

  if (agenda && live.modo === "agenda") {
    const data = await agendaFacejus(live.phone, live.tenantId, dia, {
      natureza: live.natureza,
      escritorioId: live.escritorioId,
    });
    return NextResponse.json({ dia: data.dia || dia, itens: data.itens || [] });
  }

  const data = await buscarProcessosFacejus(live.phone, live.tenantId, q);
  return NextResponse.json({ aviso: data.aviso || "", itens: data.itens || [] });
}
