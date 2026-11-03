import type { Metadata } from "next";
import { ContextNote } from "@/components/help/ContextNote";
import { HelpChrome } from "@/components/help/HelpChrome";
import { ManualView } from "@/components/help/ManualView";
import { PhoneChat } from "@/components/landing/PhoneChat";
import { LOCADORA_SCENES } from "@/components/landing/phone-scenes";
import { MANUAL_LOCADORA } from "@/content/help-manuals";

export const metadata: Metadata = {
  title: "Manual locadora · MOOPE Assessor",
  description:
    "Manual do Assessor da locadora: frota, contratos, rastreamento Moope e financeiro.",
};

export default function AjudaLocadoraPage() {
  return (
    <HelpChrome>
      <ContextNote current="locadora" />
      <ManualView
        doc={MANUAL_LOCADORA}
        demo={
          <PhoneChat scenes={LOCADORA_SCENES} label="O que pedir na locadora" />
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
