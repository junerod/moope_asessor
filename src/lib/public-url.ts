/**
 * URL pública canônica do Assessor (links em WhatsApp / manuais).
 * NUNCA deve vazar localhost para o usuário final.
 */
export const CANONICAL_PUBLIC_BASE = "https://assessor.moope.com.br";

function looksLikeLocalhost(url: string): boolean {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(url);
}

/**
 * Base HTTPS para links ao usuário (ajuda, manuais, etc.).
 * Em produção, rejeita localhost mesmo se APP_BASE_URL estiver errado.
 */
export function publicAppBaseUrl(): string {
  const raw = (process.env.APP_BASE_URL || "").trim().replace(/\/+$/, "");
  const isProd =
    process.env.APP_ENV === "production" ||
    process.env.NODE_ENV === "production" ||
    process.env.ASSESSOR_DOCKER_PROD === "1";

  if (raw && /^https?:\/\//i.test(raw) && !looksLikeLocalhost(raw)) {
    return raw;
  }

  if (isProd || !raw || looksLikeLocalhost(raw)) {
    if (raw && looksLikeLocalhost(raw) && isProd) {
      // Fail-soft: log implícito via escolha canônica (logger no caller se precisar)
    }
    return CANONICAL_PUBLIC_BASE;
  }

  return raw || CANONICAL_PUBLIC_BASE;
}
