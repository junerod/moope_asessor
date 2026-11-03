import { describe, expect, it } from "vitest";
import { fanoutSummary } from "@/domain/fanout-notify";

describe("fanout de notificação", () => {
  it("só está ok quando todos receberam", () => {
    expect(
      fanoutSummary([
        { phone: "+5531984246434", ok: true },
        { phone: "+5561996715985", ok: true },
        { phone: "+5519991853636", ok: true },
      ]).allOk
    ).toBe(true);
  });

  it("um ok e outro falho é parcial — os que falharam continuam pendentes", () => {
    const s = fanoutSummary([
      { phone: "+5531984246434", ok: true },
      { phone: "+5561996715985", ok: false, error: "zernio_send_failed" },
      { phone: "+5519991853636", ok: false, error: "no_conversation" },
    ]);
    expect(s.allOk).toBe(false);
    expect(s.partial).toBe(true);
    expect(s.failed.map((f) => f.phone)).toEqual([
      "+5561996715985",
      "+5519991853636",
    ]);
  });

  it("lista vazia não é sucesso", () => {
    expect(fanoutSummary([]).allOk).toBe(false);
  });
});
