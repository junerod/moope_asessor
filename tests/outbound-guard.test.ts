import { describe, expect, it } from "vitest";
import {
  digestStillMissing,
  formatOutboundGuardAlert,
  tipoDoZap,
} from "@/domain/outbound-guard";
import { isConfirmedDelivery, shouldReleaseSendClaim } from "@/domain/send-once";

describe("guarda de envio", () => {
  it("falha sem envio posterior continua faltando", () => {
    expect(digestStillMissing({ failed: true, laterSent: false })).toBe(true);
    expect(digestStillMissing({ failed: true, laterSent: true })).toBe(false);
    expect(digestStillMissing({ failed: false, laterSent: false })).toBe(false);
  });

  it("recusa clara do Zernio libera o slot", () => {
    expect(
      shouldReleaseSendClaim({ ok: false, error: "zernio_send_failed" })
    ).toBe(true);
  });

  it("o aviso diz o local e o tipo, e não é texto de cliente", () => {
    expect(tipoDoZap("gcal-new:abc")).toBe("Agenda Google");
    const text = formatOutboundGuardAlert({
      retried: 20,
      recovered: 0,
      still: [
        {
          phone: "+5561998052151",
          local: "Paulo — Negócio",
          tipo: "Agenda Google",
          assunto: "Na sua Agenda Google",
        },
      ],
    });
    expect(text).toContain("Paulo — Negócio");
    expect(text).toContain("Agenda Google");
    expect(text).toContain("Só o número do dev");
  });

  it("ALREADY_SENT e incerteza não contam como entrega", () => {
    expect(
      isConfirmedDelivery({ ok: false, errorCode: "CLAIM_HELD" })
    ).toBe(false);
    expect(
      isConfirmedDelivery({ ok: true, errorCode: "SEND_UNCERTAIN" })
    ).toBe(false);
  });
});
