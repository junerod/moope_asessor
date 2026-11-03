import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { openVisualBoard } from "@/domain/visual-board";
import { BoardView } from "@/components/visual/BoardView";

export const metadata: Metadata = {
  title: "Consulta · MOOPE Assessor",
  description: "Link único de uma consulta do MOOPE Assessor.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function VisualBoardPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const opened = await openVisualBoard(getDb(), token);
  return <BoardView board={opened.board} token={token} facejus={opened.facejus} />;
}
