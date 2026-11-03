import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { findClashes, hourHoles, looksLikeClashAsk, looksLikeFreeSlotAsk } from "@/domain/agenda-gaps";

describe("agenda livre e choque", () => {
  it("sexta de manhã devolve os horários e marca o ocupado", () => {
    expect(looksLikeFreeSlotAsk("Sexta de manhã livre?")).toBe(true);
    expect(looksLikeFreeSlotAsk("estou livre")).toBe(false);
    const friday = DateTime.fromObject(
      { year: 2026, month: 10, day: 9, hour: 9, minute: 0 },
      { zone: "America/Sao_Paulo" }
    );
    const holes = hourHoles(friday, 8, 12, [{ at: friday.toJSDate(), title: "Dentista" }]);
    expect(holes.map((hole) => `${hole.hour} ${hole.state}`)).toEqual([
      "8h livre",
      "9h ocupado",
      "10h livre",
      "11h livre",
    ]);
    expect(holes[1]?.title).toBe("Dentista");
  });

  it("dois no mesmo horário aparecem como choque", () => {
    expect(looksLikeClashAsk("Tem choque na agenda?")).toBe(true);
    const zone = "America/Sao_Paulo";
    const at = DateTime.fromObject(
      { year: 2026, month: 10, day: 9, hour: 15 },
      { zone }
    ).toJSDate();
    const clashes = findClashes([
      { at, title: "Reunião", zone },
      { at, title: "Dentista", zone },
    ]);
    expect(clashes).toHaveLength(1);
    expect(clashes[0]?.hour).toBe("15h");
    expect(clashes[0]?.titles).toEqual(["Reunião", "Dentista"]);
  });
});
