import assert from "node:assert/strict";
import { parseZernioWebhook } from "../src/channels/zernio/parse";

/** Payload real Zernio (Oi homologação 2026-09-20) — sender.phoneNumber. */
const realOiPayload = {
  id: "4cf17ebf-6642-4204-82e3-7fd3a36411a8",
  event: "message.received",
  account: {
    id: "6aafdf658d284ffb2120c825",
    platform: "whatsapp",
    username: "+1 323-250-8113",
    accountId: "6aafdf658d284ffb2120c825",
    profileId: "6aafdcdc83c4b0591357d4f8",
    displayName: "MOOPE Assessor",
  },
  message: {
    id: "6ab03fc0a1a5943bcbafc0ca",
    text: "Oi",
    sender: {
      id: "556196715985",
      name: "June Rodrigues ",
      contactId: "6ab03fc0a1a5943bcbafc0cc",
      phoneNumber: "+556196715985",
      businessScopedUserId: "BR.1433951011914614",
    },
    conversationId: "6ab03fc04c22a8d9cf507c94",
    direction: "incoming",
  },
  conversation: {
    id: "6ab03fc04c22a8d9cf507c94",
    participantId: "556196715985",
    participantName: "June Rodrigues ",
    participantUsername: "+556196715985",
  },
  timestamp: "2026-09-20T20:19:12.514Z",
};

const n = parseZernioWebhook(realOiPayload);
assert.ok(n, "parse failed");
assert.equal(n!.phoneE164, "+556196715985");
assert.equal(n!.bsuid, "BR.1433951011914614");
assert.equal(n!.text, "Oi");
assert.equal(n!.accountId, "6aafdf658d284ffb2120c825");
assert.equal(n!.contactName?.trim(), "June Rodrigues");
console.log("ok parse real zernio sender.phoneNumber");
