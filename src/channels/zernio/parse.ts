export type ZernioNormalizedInbound = {
  eventId: string;
  eventType: string;
  timestamp: string | null;
  accountId: string | null;
  conversationId: string | null;
  messageId: string | null;
  text: string | null;
  contentType: string;
  phoneE164: string | null;
  bsuid: string | null;
  contactName: string | null;
  mediaUrl: string | null;
  mediaMimeType: string | null;
  /** Pin de localização WhatsApp, se houver. */
  location: {
    lat: number;
    lon: number;
    name?: string | null;
    address?: string | null;
  } | null;
  /** Contato compartilhado do WhatsApp (vCard / contacts). */
  sharedContacts: Array<{
    name: string;
    phoneE164: string;
  }> | null;
  raw: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function pickString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Normalizes Zernio webhook envelopes into a stable inbound shape.
 * Tolerant to nested variants documented across inbox / WhatsApp payloads.
 */
export function parseZernioWebhook(
  payload: unknown
): ZernioNormalizedInbound | null {
  const root = asRecord(payload);
  if (!root) return null;

  const eventId = pickString(root.id, root.eventId, root.event_id);
  const eventType = pickString(root.event, root.type, root.eventType);
  if (!eventId || !eventType) return null;

  const data = asRecord(root.data) || asRecord(root.payload) || root;
  const message =
    asRecord(data.message) ||
    asRecord(root.message) ||
    asRecord(data.inboxMessage) ||
    null;
  const conversation =
    asRecord(data.conversation) ||
    asRecord(root.conversation) ||
    asRecord(message?.conversation) ||
    null;
  const contact =
    asRecord(data.contact) ||
    asRecord(root.contact) ||
    asRecord(conversation?.contact) ||
    asRecord(message?.contact) ||
    asRecord(message?.sender) ||
    asRecord(data.sender) ||
    null;
  const sender =
    asRecord(message?.sender) ||
    asRecord(data.sender) ||
    asRecord(root.sender) ||
    null;
  const account =
    asRecord(data.account) ||
    asRecord(root.account) ||
    asRecord(message?.account) ||
    null;
  const metadata =
    asRecord(message?.metadata) ||
    asRecord(contact?.metadata) ||
    asRecord(sender?.metadata) ||
    asRecord(data.metadata) ||
    {};

  const phoneE164 = pickString(
    contact?.phone,
    contact?.phoneNumber,
    contact?.phone_number,
    contact?.waId,
    contact?.wa_id,
    sender?.phone,
    sender?.phoneNumber,
    sender?.phone_number,
    sender?.waId,
    sender?.wa_id,
    conversation?.participantUsername,
    conversation?.participantPhone,
    conversation?.participant_phone,
    metadata.phone,
    metadata.phoneNumber,
    data.from,
    message?.from,
    // WhatsApp WA id sometimes arrives as digits-only participant id
    conversation?.participantId &&
      String(conversation.participantId).length >= 10
      ? `+${String(conversation.participantId).replace(/\D/g, "")}`
      : null,
    sender?.id && String(sender.id).length >= 10
      ? `+${String(sender.id).replace(/\D/g, "")}`
      : null
  );

  const bsuid = pickString(
    contact?.bsuid,
    contact?.BSUID,
    contact?.businessScopedUserId,
    contact?.business_scoped_user_id,
    sender?.bsuid,
    sender?.BSUID,
    sender?.businessScopedUserId,
    sender?.business_scoped_user_id,
    metadata.bsuid,
    metadata.BSUID,
    metadata.businessScopedUserId
  );

  const text = pickString(
    message?.text,
    message?.body,
    message?.message,
    data.text,
    data.body,
    typeof message?.content === "string" ? message.content : null
  );

  const contentType =
    pickString(
      message?.type,
      message?.contentType,
      message?.content_type,
      data.type
    ) || (text ? "text" : "unknown");

  const attachments = Array.isArray(message?.attachments)
    ? (message!.attachments as unknown[])
    : Array.isArray(data.attachments)
      ? (data.attachments as unknown[])
      : [];
  const firstAttachment = asRecord(attachments[0]);
  const attachmentPayload = asRecord(firstAttachment?.payload);

  const media =
    asRecord(message?.media) ||
    asRecord(message?.attachment) ||
    asRecord(data.media) ||
    firstAttachment ||
    null;

  const mediaUrl = pickString(
    media?.url,
    media?.downloadUrl,
    media?.download_url,
    media?.href,
    message?.mediaUrl,
    message?.media_url,
    firstAttachment?.url,
    attachmentPayload?.url
  );

  const mediaMimeType = pickString(
    media?.mimeType,
    media?.mime_type,
    attachmentPayload?.mimeType,
    attachmentPayload?.mime_type,
    typeof media?.type === "string" && String(media.type).includes("/")
      ? media.type
      : null,
    firstAttachment?.type === "image"
      ? "image/jpeg"
      : firstAttachment?.type === "audio" || firstAttachment?.type === "ptt"
        ? "audio/ogg"
        : firstAttachment?.type === "document"
          ? "application/pdf"
          : null
  );

  const resolvedContentType =
    contentType !== "unknown" && contentType !== "text"
      ? contentType
      : firstAttachment?.type
        ? String(firstAttachment.type)
        : mediaUrl
          ? "image"
          : contentType;

  // Localização WhatsApp (Meta / Zernio / anexos)
  let location: ZernioNormalizedInbound["location"] = null;
  const locCandidates = [
    asRecord(message?.location),
    asRecord(data.location),
    asRecord(attachmentPayload),
    asRecord(firstAttachment),
    asRecord(media),
  ];
  for (const loc of locCandidates) {
    if (!loc) continue;
    const lat = Number(loc.latitude ?? loc.lat);
    const lon = Number(loc.longitude ?? loc.lon ?? loc.lng);
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180 &&
      !(lat === 0 && lon === 0)
    ) {
      location = {
        lat,
        lon,
        name: pickString(loc.name),
        address: pickString(loc.address),
      };
      break;
    }
  }
  if (!location) {
    // busca profunda no envelope (Zernio às vezes aninha)
    const deep = findLocationDeep(root);
    if (deep) location = deep;
  }

  const sharedContacts = extractSharedContacts(root, message, data);

  const finalContentType = sharedContacts?.length
    ? "contacts"
    : location &&
        (resolvedContentType === "unknown" || resolvedContentType === "text")
      ? "location"
      : resolvedContentType;

  return {
    eventId,
    eventType,
    timestamp: pickString(root.timestamp, data.timestamp, message?.timestamp, message?.sentAt),
    accountId: pickString(
      account?._id,
      account?.id,
      account?.accountId,
      data.accountId,
      data.account_id,
      root.accountId
    ),
    conversationId: pickString(
      conversation?._id,
      conversation?.id,
      data.conversationId,
      data.conversation_id,
      message?.conversationId
    ),
    messageId: pickString(
      message?._id,
      message?.id,
      message?.messageId,
      data.messageId
    ),
    text,
    contentType: finalContentType,
    phoneE164,
    bsuid,
    contactName: pickString(
      contact?.name,
      contact?.displayName,
      contact?.profileName,
      sender?.name,
      sender?.displayName,
      conversation?.participantName,
      metadata.profileName
    ),
    mediaUrl,
    mediaMimeType,
    location,
    sharedContacts,
    raw: root,
  };
}

function findLocationDeep(
  raw: Record<string, unknown>
): ZernioNormalizedInbound["location"] {
  const seen = new Set<unknown>();
  const stack: unknown[] = [raw];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const o = cur as Record<string, unknown>;
    const lat = Number(o.latitude ?? o.lat);
    const lon = Number(o.longitude ?? o.lon ?? o.lng);
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180 &&
      !(lat === 0 && lon === 0) &&
      // evita IDs numéricos aleatórios: só se houver sinal de geo
      (o.latitude != null ||
        o.longitude != null ||
        o.lat != null ||
        o.lon != null ||
        o.lng != null)
    ) {
      return {
        lat,
        lon,
        name: pickString(o.name),
        address: pickString(o.address),
      };
    }
    for (const v of Object.values(o)) {
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return null;
}

/** Contatos compartilhados (Meta contacts[] / vCard / anexos). */
function extractSharedContacts(
  root: Record<string, unknown>,
  message: Record<string, unknown> | null,
  data: Record<string, unknown>
): ZernioNormalizedInbound["sharedContacts"] {
  const out: Array<{ name: string; phoneE164: string }> = [];
  const seen = new Set<string>();

  const push = (nameRaw: string | null | undefined, phoneRaw: string | null | undefined) => {
    const phone = String(phoneRaw || "").replace(/\D/g, "");
    if (phone.length < 10) return;
    const e164 = phone.startsWith("55") ? `+${phone}` : `+55${phone}`;
    const name =
      String(nameRaw || "").trim() ||
      e164.slice(-4);
    const key = `${e164}:${name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: name.slice(0, 40), phoneE164: e164 });
  };

  const arrays: unknown[] = [];
  // Zernio: contato compartilhado chega em metadata.contacts (não em message.contacts)
  const metaRoot = asRecord(root.metadata);
  const metaMsg = asRecord(message?.metadata);
  const metaData = asRecord(data.metadata);
  for (const bag of [metaRoot, metaMsg, metaData, message, data, root]) {
    if (!bag) continue;
    if (Array.isArray(bag.contacts)) arrays.push(...(bag.contacts as unknown[]));
  }
  if (Array.isArray(message?.sharedContacts))
    arrays.push(...(message!.sharedContacts as unknown[]));
  const single =
    asRecord(message?.contactMessage) ||
    asRecord(message?.contact_message) ||
    asRecord(data.contactMessage);
  if (single) arrays.push(single);

  for (const item of arrays) {
    const c = asRecord(item);
    if (!c) continue;
    const nameObj = asRecord(c.name);
    const name = pickString(
      nameObj?.formatted_name,
      nameObj?.formattedName,
      nameObj?.first_name,
      c.formatted_name,
      c.displayName,
      c.display_name,
      c.name
    );
    const phones = Array.isArray(c.phones) ? c.phones : [];
    if (phones.length) {
      for (const p of phones) {
        const pr = asRecord(p);
        push(
          name,
          pickString(pr?.wa_id, pr?.waId, pr?.phone, pr?.phoneNumber)
        );
      }
    } else {
      push(name, pickString(c.wa_id, c.waId, c.phone, c.phoneNumber, c.vcard));
    }
    // vCard string OU base64 (Zernio manda vcard em base64)
    let vcard = pickString(c.vcard, c.vcf);
    if (vcard && !/BEGIN:VCARD/i.test(vcard) && /^[A-Za-z0-9+/=\s]+$/.test(vcard)) {
      try {
        const decoded = Buffer.from(vcard.replace(/\s/g, ""), "base64").toString(
          "utf8"
        );
        if (/BEGIN:VCARD/i.test(decoded)) vcard = decoded;
      } catch {
        /* ignore */
      }
    }
    if (vcard && /BEGIN:VCARD/i.test(vcard)) {
      const fn = vcard.match(/^FN:(.+)$/im)?.[1]?.trim();
      const tel =
        vcard.match(/waid=(\d+)/i)?.[1] ||
        vcard.match(/TEL[^:]*:([+\d\s-]+)/i)?.[1];
      push(fn || name, tel);
    }
  }

  // Deep scan for contacts array with phones
  if (!out.length) {
    const deep = findContactsDeep(root);
    for (const d of deep) out.push(d);
  }

  return out.length ? out.slice(0, 5) : null;
}

function findContactsDeep(
  raw: Record<string, unknown>
): Array<{ name: string; phoneE164: string }> {
  const found: Array<{ name: string; phoneE164: string }> = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [raw];
  while (stack.length && found.length < 5) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const o = cur as Record<string, unknown>;
    if (Array.isArray(o.contacts) || Array.isArray(o.phones)) {
      const nameObj = asRecord(o.name);
      const name = pickString(
        nameObj?.formatted_name,
        nameObj?.formattedName,
        o.formatted_name,
        o.displayName,
        typeof o.name === "string" ? o.name : null
      );
      const phones = Array.isArray(o.phones) ? o.phones : [];
      for (const p of phones) {
        const pr = asRecord(p);
        const phone = pickString(pr?.wa_id, pr?.waId, pr?.phone);
        if (!phone) continue;
        const digits = phone.replace(/\D/g, "");
        if (digits.length < 10) continue;
        const e164 = digits.startsWith("55") ? `+${digits}` : `+55${digits}`;
        found.push({
          name: (name || e164.slice(-4)).slice(0, 40),
          phoneE164: e164,
        });
      }
    }
    for (const v of Object.values(o)) {
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return found;
}

export function isInboundMessageEvent(eventType: string): boolean {
  return (
    eventType === "message.received" ||
    eventType === "inbox.message.received" ||
    eventType === "whatsapp.message.received"
  );
}
