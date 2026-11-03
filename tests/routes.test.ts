import { describe, expect, it } from "vitest";
import {
  looksLikeRouteIntent,
  parseRouteDestination,
  parseRouteOriginOverride,
  formatRouteCard,
  extractInboundLocation,
} from "@/domain/routes";
import { parseZernioWebhook } from "@/channels/zernio/parse";

describe("routes helpers", () => {
  it("detecta intenções de rota e ignora recolha IoT", () => {
    expect(looksLikeRouteIntent("quanto tempo até o aeroporto")).toBe(true);
    expect(looksLikeRouteIntent("até Taguatinga")).toBe(true);
    expect(looksLikeRouteIntent("rota até Taguatinga")).toBe(true);
    expect(looksLikeRouteIntent("salvar base")).toBe(true);
    expect(looksLikeRouteIntent("rota de recolha dos carrinhos")).toBe(false);
    expect(
      looksLikeRouteIntent(
        "Anotar compromisso para as 18h00 Verificar aplicativo do Bistek para gerar rotas"
      )
    ).toBe(false);
  });

  it("extrai destino e origem", () => {
    expect(parseRouteDestination("quanto tempo até o aeroporto")).toBe(
      "aeroporto"
    );
    expect(parseRouteDestination("até Taguatinga")).toBe("Taguatinga");
    expect(parseRouteOriginOverride("de Asa Norte até o aeroporto")).toBe(
      "Asa Norte"
    );
    expect(parseRouteDestination("de Asa Norte até o aeroporto")).toBe(
      "aeroporto"
    );
  });

  it("formata card", () => {
    const card = formatRouteCard({
      origin: { lat: -15.78, lon: -47.93, label: "Brasília-DF" },
      dest: {
        lat: -15.87,
        lon: -47.91,
        label: "Aeroporto de Brasília (BSB)",
      },
      durationSec: 1058,
      distanceM: 14199,
      mapsUrl: "https://www.google.com/maps/dir/?api=1",
      originSource: "pin",
    });
    expect(card).toContain("Bora");
    expect(card).toContain("18 min");
    expect(card).toContain("do seu pin");
  });

  it("extrai location de payload Meta-like", () => {
    const loc = extractInboundLocation({
      data: {
        message: {
          type: "location",
          location: {
            latitude: -15.78,
            longitude: -47.93,
            name: "Asa Norte",
          },
        },
      },
    });
    expect(loc?.lat).toBeCloseTo(-15.78);
    expect(loc?.name).toBe("Asa Norte");
  });
});

describe("zernio parse location", () => {
  it("normaliza mensagem de localização", () => {
    const n = parseZernioWebhook({
      id: "evt_loc_1",
      event: "message.received",
      data: {
        conversation: { id: "conv1", participantPhone: "+5561996715985" },
        message: {
          id: "m1",
          type: "location",
          location: {
            latitude: -15.8,
            longitude: -47.9,
            name: "Casa",
            address: "Asa Norte",
          },
        },
      },
    });
    expect(n?.contentType).toBe("location");
    expect(n?.location?.lat).toBeCloseTo(-15.8);
    expect(n?.location?.name).toBe("Casa");
  });
});
