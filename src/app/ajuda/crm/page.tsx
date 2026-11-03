import type { Metadata } from "next";
import { ContextNote } from "@/components/help/ContextNote";
import { HelpChrome } from "@/components/help/HelpChrome";
import { ManualView } from "@/components/help/ManualView";
import { PhoneChat } from "@/components/landing/PhoneChat";
import { CRM_SCENES } from "@/components/landing/phone-scenes";
import { MANUAL_CRM } from "@/content/help-manuals";

export const metadata: Metadata = {
  title: "Manual CRM · MOOPE Assessor",
  description: "Avisos de lead e de resposta, e como pedir os leads do dia no WhatsApp.",
};

export default function AjudaCrmPage() {
  return (
    <HelpChrome>
      <ContextNote current="crm" />
      <ManualView
        doc={MANUAL_CRM}
        demo={<PhoneChat scenes={CRM_SCENES} label="O que pedir no CRM" />}
        notice={
          <p className="painel-hint">
            Os leads não ficam numa página aberta. Peça no WhatsApp. A resposta traz um link só
            daquela consulta.
          </p>
        }
      />
    </HelpChrome>
  );
}
