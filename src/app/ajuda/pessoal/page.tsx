import type { Metadata } from "next";
import { ContextNote } from "@/components/help/ContextNote";
import { HelpChrome } from "@/components/help/HelpChrome";
import { ManualView } from "@/components/help/ManualView";
import { PhoneChat } from "@/components/landing/PhoneChat";
import { PESSOAL_SCENES } from "@/components/landing/phone-scenes";
import { MANUAL_PESSOAL } from "@/content/help-manuals";

export const metadata: Metadata = {
  title: "Manual pessoal · MOOPE Assessor",
  description:
    "Manual do Assessor pessoal no WhatsApp: cobrar agora, agenda, teto, pastas e o que pedir no Zap.",
};

export default function AjudaPessoalPage() {
  return (
    <HelpChrome>
      <div className="help-phone">
        <PhoneChat scenes={PESSOAL_SCENES} label="O que pedir no pessoal" />
      </div>
      <ContextNote current="pessoal" />
      <ManualView
        doc={MANUAL_PESSOAL}
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
