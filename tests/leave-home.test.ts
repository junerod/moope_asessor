import { describe, expect, it } from "vitest";
import { looksLikeLeaveHomeIntent } from "@/domain/leave-home";

describe("leave-home", () => {
  it("detecta intenções", () => {
    expect(looksLikeLeaveHomeIntent("quando sair")).toBe(true);
    expect(looksLikeLeaveHomeIntent("quando sair pro aeroporto")).toBe(true);
    expect(looksLikeLeaveHomeIntent("que horas sair")).toBe(true);
    expect(looksLikeLeaveHomeIntent("cotação do dólar")).toBe(false);
  });
});
