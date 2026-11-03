import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { loadVisualBoard } from "@/domain/visual-board";
import { fetchRendimentosFile } from "@/integrations/moope-finance-assessor";

const KINDS = new Set(["pdf", "contabil", "xlsx", "executivo"]);

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ token: string }> }
) {
  const { token } = await context.params;
  const kind = String(req.nextUrl.searchParams.get("kind") || "");
  if (!KINDS.has(kind)) {
    return NextResponse.json({ error: "tipo_invalido" }, { status: 400 });
  }
  const board = await loadVisualBoard(getDb(), token);
  const ref = board?.exportRef;
  if (!board || !ref) {
    return NextResponse.json({ error: "link_expirado" }, { status: 404 });
  }
  const file = await fetchRendimentosFile({
    userid: ref.userid,
    start: ref.start,
    end: ref.end,
    kind,
  });
  if (!file.ok) {
    return NextResponse.json({ error: "arquivo_indisponivel" }, { status: 502 });
  }
  return new NextResponse(Buffer.from(file.bytes), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
