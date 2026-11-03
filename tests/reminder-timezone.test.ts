import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import {
  hasExplicitClockTime,
  parseNaturalDateTime,
  resolveReminderFireAt,
} from "@/lib/datetime";

describe("reminder timezone", () => {
  it("detects 16:00 without h", () => {
    expect(
      hasExplicitClockTime(
        "preciso que me lembre as 16:00 de cobrar os alugueis"
      )
    ).toBe(true);
  });

  it("parses 16:00 as wall clock in America/Sao_Paulo", () => {
    const tz = "America/Sao_Paulo";
    const now = DateTime.fromISO("2026-09-22T15:30:00", { zone: tz });
    const dt = parseNaturalDateTime(
      "preciso que me lembre as 16:00 de cobrar",
      tz,
      now
    );
    expect(dt?.hour).toBe(16);
    expect(dt?.minute).toBe(0);
  });

  it("user text 16:00 wins over LLM double-offset ISO (19 local)", () => {
    const fire = resolveReminderFireAt({
      fireAtIso: "2026-09-22T19:00:00-03:00",
      timezone: "America/Sao_Paulo",
      userText: "lembre as 16:00 de cobrar aluguel",
    });
    const local = DateTime.fromJSDate(fire).setZone("America/Sao_Paulo");
    expect(local.hour).toBe(16);
  });
});
