import type { Metadata } from "next";
import { HelpChrome } from "@/components/help/HelpChrome";
import { ConceptStage } from "@/components/landing/ConceptStage";
import { getAssessorWhatsAppPublic } from "@/lib/assessor-whatsapp";
import "../ajuda/ajuda.css";
import "./conceito.css";

export const metadata: Metadata = {
  title: "MOOPE Assessor — rascunho visual",
  description: "Prévia da tela inicial. A página publicada continua a mesma.",
};

export const dynamic = "force-dynamic";

export default async function ConceitoPage() {
  const wa = await getAssessorWhatsAppPublic();
  return (
    <HelpChrome>
      <ConceptStage waUrl={wa.waUrl} />
    </HelpChrome>
  );
}
