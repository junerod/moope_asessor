import { describe, expect, it } from "vitest";
import {
  isDevOpsPhone,
  parseDevOpsCommand,
} from "@/domain/dev-ops-commands";

describe("dev-ops-commands", () => {
  it("só libera o número DEV", () => {
    expect(isDevOpsPhone("+5561996715985")).toBe(true);
    expect(isDevOpsPhone("61996715985")).toBe(true);
    expect(isDevOpsPhone("+5511999999999")).toBe(false);
  });

  it("parseia comandos", () => {
    expect(parseDevOpsCommand("/saude")).toBe("saude");
    expect(parseDevOpsCommand("#status")).toBe("status");
    expect(parseDevOpsCommand("/uso")).toBe("uso");
    expect(parseDevOpsCommand("/consumo")).toBe("consumo");
    expect(parseDevOpsCommand("/consumoIA")).toBe("consumo");
    expect(parseDevOpsCommand("/comandos")).toBe("ops");
    expect(parseDevOpsCommand("tokens")).toBe("consumo");
    expect(parseDevOpsCommand("servidor")).toBe("servidor");
    expect(parseDevOpsCommand("cura")).toBe("cura");
    expect(parseDevOpsCommand("/ops")).toBe("ops");
    expect(parseDevOpsCommand("me lembre às 10h")).toBe(null);
  });
});
