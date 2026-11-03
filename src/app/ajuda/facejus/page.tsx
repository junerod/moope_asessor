import type { Metadata } from "next";
import { ContextNote } from "@/components/help/ContextNote";
import { HelpChrome } from "@/components/help/HelpChrome";
import { ManualView } from "@/components/help/ManualView";
import { PhoneChat } from "@/components/landing/PhoneChat";
import { FACEJUS_SCENES } from "@/components/landing/phone-scenes";
import { MANUAL_FACEJUS } from "@/content/help-manuals";

export const metadata: Metadata = {
  title: "Manual Facejus · MOOPE Assessor",
  description:
    "Manual do Assessor Facejus: processos, agenda de atendimento e agenda de prazos processuais no WhatsApp.",
};

export default function AjudaFacejusPage() {
  return (
    <HelpChrome>
      <ContextNote current="facejus" />
      <ManualView
        doc={MANUAL_FACEJUS}
        demo={
          <PhoneChat scenes={FACEJUS_SCENES} label="O que pedir no Facejus" />
        }
        notice={
          <p className="painel-hint">
            Os números não ficam numa página aberta. Peça no WhatsApp uma frase da{" "}
            <a href="/painel">lista</a>. A resposta traz um link só daquela consulta.
          </p>
        }
      />
    </HelpChrome>
  );
}
