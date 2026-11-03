import type { Db } from "@/db/client";
import { notifyAssessorPhone } from "@/domain/dev-ops-metrics";

export type FanoutResult = {
  phone: string;
  ok: boolean;
  error?: string;
};

/** Todos os destinos, em paralelo. Um falhar não cancela os outros. */
export async function notifyAssessorPhones(
  db: Db,
  input: {
    phones: string[];
    text: string;
    keyForPhone: (phone: string) => string;
  }
): Promise<FanoutResult[]> {
  const phones = [...new Set(input.phones.map((p) => p.trim()).filter(Boolean))];
  const settled = await Promise.allSettled(
    phones.map(async (phone) => {
      const sent = await notifyAssessorPhone(
        db,
        phone,
        input.text,
        input.keyForPhone(phone)
      );
      return {
        phone,
        ok: sent.ok,
        error: sent.reason,
      } satisfies FanoutResult;
    })
  );
  return settled.map((row, i) => {
    const phone = phones[i]!;
    if (row.status === "fulfilled") return row.value;
    const err = row.reason instanceof Error ? row.reason.message : "send_failed";
    return { phone, ok: false, error: err };
  });
}

export function fanoutSummary(results: FanoutResult[]): {
  allOk: boolean;
  partial: boolean;
  failed: FanoutResult[];
} {
  const failed = results.filter((r) => !r.ok);
  return {
    allOk: results.length > 0 && failed.length === 0,
    partial: results.some((r) => r.ok) && failed.length > 0,
    failed,
  };
}
