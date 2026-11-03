import { describe, expect, it } from "vitest";
import { parseZernioWebhook } from "@/channels/zernio/parse";

describe("zernio parse attachments", () => {
  it("reads media from message.attachments[]", () => {
    const n = parseZernioWebhook({
      id: "781aaf32-b690-4172-8040-bd4e72619e61",
      event: "message.received",
      account: { id: "6aafdf658d284ffb2120c825" },
      message: {
        id: "img-msg-1",
        text: "Registra essa receita de novo",
        attachments: [
          {
            url: "https://zernio.com/api/v1/whatsapp/media/1442633451096333?accountId=6aafdf658d284ffb2120c825",
            type: "image",
            payload: { id: "1442633451096333", mimeType: "image/jpeg" },
          },
        ],
        sender: { phoneNumber: "+556196715985", name: "June" },
        conversationId: "conv-1",
      },
      conversation: {
        id: "conv-1",
        participantUsername: "+556196715985",
      },
      timestamp: "2026-09-20T21:11:32.000Z",
    });
    expect(n?.mediaUrl).toContain("/whatsapp/media/");
    expect(n?.mediaMimeType).toBe("image/jpeg");
    expect(n?.contentType).toBe("image");
  });
});
