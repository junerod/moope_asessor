import { isIP } from "net";
import { lookup } from "dns/promises";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google",
]);

function isPrivateIp(ip: string): boolean {
  if (ip === "::1" || ip === "0.0.0.0") return true;
  if (ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) {
    return true;
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Blocks SSRF via private IPs / link-local / metadata endpoints
 * before downloading remote media.
 */
export async function assertSafeRemoteUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid_media_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("unsupported_media_protocol");
  }
  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".local")) {
    throw new Error("blocked_media_host");
  }
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("blocked_private_ip");
    return url;
  }
  const records = await lookup(hostname, { all: true });
  for (const rec of records) {
    if (isPrivateIp(rec.address)) {
      throw new Error("blocked_resolved_private_ip");
    }
  }
  return url;
}
