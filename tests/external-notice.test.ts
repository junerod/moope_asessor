import { describe, expect, it } from "vitest";
import {
  localStatusFromZernio,
  organizerChatUrl,
  withOrganizerChat,
} from "@/domain/external-notice";

describe("aviso para quem não usa o Assessor", () => {
  it("monta o link do organizador, não do Assessor", () => {
    expect(organizerChatUrl("+5561996715985", "Oi, June")).toBe(
      "https://wa.me/5561996715985?text=Oi%2C%20June"
    );
    expect(organizerChatUrl("+1 323 250 8113")).not.toContain("5561996715985");
    const body = withOrganizerChat(
      "Oi, Zé. June pediu para te lembrar do pagamento de R$ 50,00 até sexta 10/10.",
      "June",
      "+5561996715985"
    );
    expect(body).toContain("Fale com June:");
    expect(body).toContain("https://wa.me/5561996715985?text=Oi%2C%20June");
    expect(body).not.toContain("13232508113");
    expect(withOrganizerChat("Oi, Zé.", "June", null)).toBe("Oi, Zé.");
  });

  it("trata APPROVED do Zernio como modelo ativo", () => {
    expect(localStatusFromZernio("APPROVED")).toBe("active");
    expect(localStatusFromZernio("PENDING")).toBe("pending");
    expect(localStatusFromZernio("REJECTED")).toBe("rejected");
  });
});
