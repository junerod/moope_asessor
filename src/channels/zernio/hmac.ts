import { hmacSha256Hex, timingSafeEqualString } from "@/lib/crypto";

export function computeZernioSignature(
  secret: string,
  rawBody: string | Buffer
): string {
  return hmacSha256Hex(secret, rawBody);
}

export function verifyZernioSignature(input: {
  secret: string;
  rawBody: string | Buffer;
  presented: string | null | undefined;
}): boolean {
  if (!input.presented) return false;
  const expected = computeZernioSignature(input.secret, input.rawBody);
  // Accept both raw hex and optional "sha256=" prefix
  const presented = input.presented.replace(/^sha256=/i, "").trim().toLowerCase();
  return timingSafeEqualString(expected, presented);
}
