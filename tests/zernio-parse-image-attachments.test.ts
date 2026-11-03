import assert from "node:assert/strict";
import { parseZernioWebhook } from "../src/channels/zernio/parse";

/** Payload real com imagem (receita) — media em message.attachments[]. */
const realImagePayload = {
  id: "781aaf32-b690-4172-8040-bd4e72619e61",
  event: "message.received",
  account: {
    id: "6aafdf658d284ffb2120c825",
    profileId: "6aafdcdc83c4b0591357d4f8",
  },
  message: {
    id: "img-msg-1",
    text: "Registra essa receita de novo",
    attachments: [
      {
        url: "https://zernio.com/api/v1/whatsapp/media/1442633451096333?accountId=6aafdf658d284ffb2120c825",
        type: "image",
        payload: {
          id: "1442633451096333",
          mimeType: "image/jpeg",
        },
      },
    ],
    sender: {
      phoneNumber: "+556196715985",
      name: "June",
    },
    conversationId: "conv-1",
  },
  conversation: {
    id: "conv-1",
    participantUsername: "+556196715985",
  },
  timestamp: "2026-09-20T21:11:32.000Z",
};

const n = parseZernioWebhook(realImagePayload);
assert.ok(n, "parse failed");
assert.ok(n!.mediaUrl?.includes("/whatsapp/media/"), "mediaUrl missing");
assert.equal(n!.mediaMimeType, "image/jpeg");
assert.equal(n!.contentType, "image");
assert.ok(n!.text?.includes("Registra"), "caption text");
console.log("ok parse zernio attachments image");
