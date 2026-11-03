import { describe, expect, it } from "vitest";
import {
  executeRows,
  insertedRowCount,
  isClearReject,
  isConfirmedDelivery,
  isUncertainSendFailure,
  looksLikeScheduledSend,
  shouldReleaseSendClaim,
} from "@/domain/send-once";

describe("executeRows", () => {
  it("lê array do drizzle/postgres-js", () => {
    expect(executeRows([{ workspace_id: "a" }])).toHaveLength(1);
  });

  it("lê { rows } do pg", () => {
    expect(executeRows({ rows: [{ workspace_id: "a" }] })).toHaveLength(1);
  });

  it("vazio quando o SELECT não veio como lista", () => {
    expect(executeRows({ rowCount: 1 })).toEqual([]);
    expect(executeRows(null)).toEqual([]);
  });
});

describe("isUncertainSendFailure", () => {
  it("timeout e 5xx não são 'não enviou'", () => {
    expect(isUncertainSendFailure({ status: 0, error: "aborted" })).toBe(true);
    expect(isUncertainSendFailure({ status: 504, error: "timeout" })).toBe(true);
    expect(isUncertainSendFailure({ error: "zernio_unreachable" })).toBe(true);
  });

  it("4xx claro não é incerto", () => {
    expect(
      isUncertainSendFailure({ status: 400, error: "zernio_send_failed" })
    ).toBe(false);
  });

  it("status 0 sem texto é incerto", () => {
    expect(isUncertainSendFailure({ status: 0 })).toBe(true);
  });
});

describe("insertedRowCount", () => {
  it("lê count do postgres-js", () => {
    expect(insertedRowCount({ count: 1, rows: [] })).toBe(1);
    expect(insertedRowCount({ count: 0, rows: [] })).toBe(0);
  });

  it("conflito = zero = não envia de novo", () => {
    expect(insertedRowCount({ rowCount: 0 })).toBe(0);
  });
});

describe("isClearReject", () => {
  it("400 é rejeição: pode cair no texto livre", () => {
    expect(isClearReject({ status: 400 })).toBe(true);
  });

  it("200/500/0 não é rejeição clara", () => {
    expect(isClearReject({ status: 200 })).toBe(false);
    expect(isClearReject({ status: 500 })).toBe(false);
    expect(isClearReject({ status: 0 })).toBe(false);
  });
});

describe("looksLikeScheduledSend", () => {
  it("trava resumo e encerramento", () => {
    expect(looksLikeScheduledSend("evening_wrap:abc:ew1")).toBe(true);
    expect(looksLikeScheduledSend("daily_brief:x:db1")).toBe(true);
    expect(looksLikeScheduledSend("crm-new:abc:61996715985")).toBe(true);
    expect(looksLikeScheduledSend("weekly_digest:ws:2026W44")).toBe(true);
    expect(looksLikeScheduledSend("gcal-nudge:ws:evt")).toBe(true);
    expect(looksLikeScheduledSend("job:123:reply")).toBe(false);
  });
});

describe("isConfirmedDelivery", () => {
  it("ok sem código é entrega", () => {
    expect(isConfirmedDelivery({ ok: true })).toBe(true);
    expect(isConfirmedDelivery({ ok: true, errorCode: "ALREADY_SENT" })).toBe(
      true
    );
  });

  it("claim preso e incerteza não são entrega", () => {
    expect(
      isConfirmedDelivery({ ok: false, errorCode: "CLAIM_HELD" })
    ).toBe(false);
    expect(
      isConfirmedDelivery({ ok: true, errorCode: "CLAIM_HELD" })
    ).toBe(false);
    expect(
      isConfirmedDelivery({ ok: true, errorCode: "SEND_UNCERTAIN" })
    ).toBe(false);
    expect(isConfirmedDelivery({ ok: false })).toBe(false);
  });
});

describe("shouldReleaseSendClaim", () => {
  it("sucesso mantém o claim", () => {
    expect(shouldReleaseSendClaim({ ok: true })).toBe(false);
  });

  it("timeout mantém o claim — retry duplicaria", () => {
    expect(
      shouldReleaseSendClaim({
        ok: false,
        errorCode: "SEND_UNCERTAIN",
        error: "timeout",
      })
    ).toBe(false);
  });

  it("claim preso não libera a chave", () => {
    expect(
      shouldReleaseSendClaim({
        ok: false,
        errorCode: "CLAIM_HELD",
      })
    ).toBe(false);
  });

  it("credencial ausente libera pra tentar de novo", () => {
    expect(
      shouldReleaseSendClaim({
        ok: false,
        error: "zernio_credentials_missing",
      })
    ).toBe(true);
  });

  it("template que não saiu libera pra tentar de novo", () => {
    expect(
      shouldReleaseSendClaim({
        ok: false,
        errorCode: "TEMPLATE_NOT_CONFIGURED_FALLBACK",
      })
    ).toBe(true);
  });

  it("zernio recusou: libera pra o guarda reenviar", () => {
    expect(
      shouldReleaseSendClaim({
        ok: false,
        error: "zernio_send_failed",
      })
    ).toBe(true);
  });
});
