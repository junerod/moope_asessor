export type ResolvedZernioIdentity = {
  phoneE164: string | null;
  bsuid: string | null;
  displayName: string | null;
};

/**
 * Pure identity extraction — no CRM lead/contact side effects.
 */
export function resolveZernioIdentity(input: {
  phoneE164?: string | null;
  bsuid?: string | null;
  contactName?: string | null;
}): ResolvedZernioIdentity {
  const phone = input.phoneE164?.trim() || null;
  const bsuid = input.bsuid?.trim() || null;
  if (!phone && !bsuid) {
    throw new Error("identity_missing_phone_and_bsuid");
  }
  return {
    phoneE164: phone,
    bsuid,
    displayName: input.contactName?.trim() || null,
  };
}
