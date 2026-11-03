import { afterEach, describe, expect, it, vi } from "vitest";

const { insertMock, patchMock, listMock, calendarMock } = vi.hoisted(() => {
  const insertMock = vi.fn();
  const patchMock = vi.fn();
  const listMock = vi.fn();
  const calendarMock = vi.fn(() => ({
    events: {
      insert: insertMock,
      patch: patchMock,
      list: listMock,
    },
  }));
  return { insertMock, patchMock, listMock, calendarMock };
});

vi.mock("googleapis", () => ({
  google: { calendar: calendarMock },
}));

vi.mock("@/integrations/google/oauth", () => ({
  getAuthedGoogleClient: vi.fn(async () => ({ oauth2: {}, mock: false })),
  getGoogleConnection: vi.fn(async () => ({ id: "connection-1", status: "connected", metadata: {} })),
  loadGoogleTokens: vi.fn(async () => ({ access_token: "connected" })),
}));

import { autoPushAppointmentToGoogle } from "@/integrations/google/auto-push";

describe("Google Meet appointment push", () => {
  const db = {
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
  } as never;

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requests one Meet conference and RRULE on the organizer event", async () => {
    listMock.mockResolvedValueOnce({ data: { items: [] } });
    insertMock.mockResolvedValueOnce({
      data: {
        id: "organizer-event-1",
        hangoutLink: "https://meet.google.com/abc-defg-hij",
      },
    });
    const result = await autoPushAppointmentToGoogle(db, {
      workspaceId: "owner-workspace",
      title: "Reunião CRM",
      startsAt: new Date("2026-10-05T20:00:00.000Z"),
      endsAt: new Date("2026-10-05T21:00:00.000Z"),
      timezone: "America/Sao_Paulo",
      createMeet: true,
      recurrenceRule: "weekly:1@17:00",
      assessorId: "assessor-appt-series-1",
    });

    expect(result).toMatchObject({
      note: expect.stringContaining("Google Meet"),
      eventId: "organizer-event-1",
      meetUrl: "https://meet.google.com/abc-defg-hij",
    });
    expect(insertMock).toHaveBeenCalledOnce();
    const request = insertMock.mock.calls[0][0];
    expect(request.conferenceDataVersion).toBe(1);
    expect(request.requestBody.conferenceData.createRequest.conferenceSolutionKey)
      .toEqual({ type: "hangoutsMeet" });
    expect(request.requestBody.recurrence).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
    ]);
  });

  it("patches the stable event instead of inserting a duplicate", async () => {
    patchMock.mockResolvedValueOnce({ data: { id: "organizer-event-1" } });
    const result = await autoPushAppointmentToGoogle(db, {
      workspaceId: "owner-workspace",
      title: "Reunião CRM atualizada",
      startsAt: new Date("2026-10-05T20:00:00.000Z"),
      endsAt: new Date("2026-10-05T21:00:00.000Z"),
      timezone: "America/Sao_Paulo",
      recurrenceRule: "weekly:1@17:00",
      assessorId: "assessor-appt-series-1",
      existingEventId: "organizer-event-1",
    });

    expect(result.eventId).toBe("organizer-event-1");
    expect(patchMock).toHaveBeenCalledOnce();
    expect(insertMock).not.toHaveBeenCalled();
    expect(patchMock.mock.calls[0][0].requestBody.recurrence).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
    ]);
  });
});
