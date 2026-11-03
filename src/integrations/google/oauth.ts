import { createHash, randomBytes } from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { google } from "googleapis";
import type { Db } from "@/db/client";
import { getEnv } from "@/config/env";
import { integrationConnections } from "@/db/schema";
import { secretStore } from "@/lib/secrets/store";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];

export type GoogleTokens = {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
  mock?: boolean;
};

function tokenSecretKey(workspaceId: string) {
  return `google:oauth:${workspaceId}:tokens`;
}

function stateSecretKey(state: string) {
  return `google:oauth:state:${state}`;
}

export async function resolveGoogleOAuthConfig(db: Db): Promise<{
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  mockAllowed: boolean;
  configured: boolean;
}> {
  const env = getEnv();
  const clientId =
    (await secretStore.getSecret(db, "provider:google_oauth:client_id")) ||
    env.GOOGLE_CLIENT_ID ||
    "";
  const clientSecret =
    (await secretStore.getSecret(db, "provider:google_oauth:client_secret")) ||
    env.GOOGLE_CLIENT_SECRET ||
    "";
  const redirectUri =
    env.GOOGLE_REDIRECT_URI ||
    `${env.APP_BASE_URL.replace(/\/+$/, "")}/api/integrations/google/callback`;
  return {
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    redirectUri,
    mockAllowed: env.GOOGLE_OAUTH_DEV_MOCK,
    configured: Boolean(clientId.trim() && clientSecret.trim()),
  };
}

export function createOAuth2Client(cfg: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}) {
  return new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
}

export async function beginGoogleOAuth(
  db: Db,
  input: { workspaceId: string; userId: string; conversationId?: string }
): Promise<
  | { ok: true; url: string; shortUrl: string; mode: "oauth" | "mock" }
  | { ok: false; error: string }
> {
  const cfg = await resolveGoogleOAuthConfig(db);
  const env = getEnv();
  const base = env.APP_BASE_URL.replace(/\/+$/, "");
  const state = randomBytes(24).toString("hex");
  const shortUrl = `${base}/g/${state}`;

  // Upsert connecting row
  await upsertConnection(db, {
    workspaceId: input.workspaceId,
    status: "connecting",
    metadata: { pending_state: state.slice(0, 8) },
  });

  if (!cfg.configured) {
    if (!cfg.mockAllowed) {
      return {
        ok: false,
        error:
          "Google OAuth ainda não está configurado (Client ID/Secret). Peça ao admin em /admin.",
      };
    }
    const mockUrl = `${base}/api/integrations/google/dev/${state}`;
    await secretStore.setSecret(
      db,
      stateSecretKey(state),
      JSON.stringify({
        workspaceId: input.workspaceId,
        userId: input.userId,
        conversationId: input.conversationId || null,
        at: Date.now(),
        authUrl: mockUrl,
      })
    );
    return {
      ok: true,
      mode: "mock",
      url: mockUrl,
      shortUrl,
    };
  }

  const client = createOAuth2Client(cfg);
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
  });
  await secretStore.setSecret(
    db,
    stateSecretKey(state),
    JSON.stringify({
      workspaceId: input.workspaceId,
      userId: input.userId,
      conversationId: input.conversationId || null,
      at: Date.now(),
      authUrl: url,
    })
  );
  return { ok: true, mode: "oauth", url, shortUrl };
}

/** Resolve link curto /g/{state} → URL Google (ou mock). */
export async function resolveGoogleOAuthShortLink(
  db: Db,
  state: string
): Promise<{ ok: true; authUrl: string } | { ok: false; error: string }> {
  const raw = await secretStore.getSecret(db, stateSecretKey(state));
  if (!raw) return { ok: false, error: "state_expired" };
  try {
    const parsed = JSON.parse(raw) as {
      authUrl?: string;
      at?: number;
    };
    // Link expira em 30 min
    if (parsed.at && Date.now() - parsed.at > 30 * 60_000) {
      return { ok: false, error: "state_expired" };
    }
    if (!parsed.authUrl) return { ok: false, error: "state_invalid" };
    return { ok: true, authUrl: parsed.authUrl };
  } catch {
    return { ok: false, error: "state_invalid" };
  }
}

export async function completeGoogleOAuth(
  db: Db,
  input: { code: string; state: string }
): Promise<
  | {
      ok: true;
      workspaceId: string;
      userId: string;
      conversationId: string | null;
      mock: boolean;
    }
  | { ok: false; error: string }
> {
  const raw = await secretStore.getSecret(db, stateSecretKey(input.state));
  if (!raw) return { ok: false, error: "state_expired" };
  let parsed: {
    workspaceId: string;
    userId: string;
    conversationId: string | null;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "state_invalid" };
  }
  await secretStore.deleteSecret(db, stateSecretKey(input.state));

  const cfg = await resolveGoogleOAuthConfig(db);
  let tokens: GoogleTokens;

  if (input.code === "dev_mock" && cfg.mockAllowed) {
    tokens = {
      access_token: `mock_${randomBytes(8).toString("hex")}`,
      refresh_token: `mock_refresh_${randomBytes(8).toString("hex")}`,
      expiry_date: Date.now() + 3600_000,
      mock: true,
      scope: SCOPES.join(" "),
    };
  } else {
    if (!cfg.configured) return { ok: false, error: "oauth_not_configured" };
    const client = createOAuth2Client(cfg);
    const { tokens: t } = await client.getToken(input.code);
    tokens = {
      access_token: String(t.access_token || ""),
      refresh_token: t.refresh_token || undefined,
      expiry_date: t.expiry_date || undefined,
      token_type: t.token_type || undefined,
      scope: t.scope || undefined,
      mock: false,
    };
    if (!tokens.access_token) return { ok: false, error: "no_access_token" };
  }

  await secretStore.setSecret(
    db,
    tokenSecretKey(parsed.workspaceId),
    JSON.stringify(tokens)
  );
  await upsertConnection(db, {
    workspaceId: parsed.workspaceId,
    status: "connected",
    displayName: tokens.mock ? "Google (homolog mock)" : "Google",
    credentialsRef: tokenSecretKey(parsed.workspaceId),
    scopes: SCOPES,
    metadata: {
      mock: Boolean(tokens.mock),
      connected_via: tokens.mock ? "dev_mock" : "oauth",
    },
    connectedAt: new Date(),
  });

  return {
    ok: true,
    workspaceId: parsed.workspaceId,
    userId: parsed.userId,
    conversationId: parsed.conversationId,
    mock: Boolean(tokens.mock),
  };
}

async function upsertConnection(
  db: Db,
  input: {
    workspaceId: string;
    status: "connecting" | "connected" | "disconnected" | "error" | "revoked";
    displayName?: string;
    credentialsRef?: string;
    scopes?: string[];
    metadata?: Record<string, unknown>;
    connectedAt?: Date;
  }
) {
  const existing = await db.query.integrationConnections.findFirst({
    where: and(
      eq(integrationConnections.workspaceId, input.workspaceId),
      eq(integrationConnections.provider, "google_calendar"),
      isNull(integrationConnections.deletedAt)
    ),
  });
  const meta = {
    ...((existing?.metadata || {}) as Record<string, unknown>),
    ...(input.metadata || {}),
  };
  if (existing) {
    await db
      .update(integrationConnections)
      .set({
        status: input.status,
        displayName: input.displayName || existing.displayName,
        credentialsRef: input.credentialsRef || existing.credentialsRef,
        scopes: input.scopes || existing.scopes,
        metadata: meta,
        connectedAt: input.connectedAt || existing.connectedAt,
        updatedAt: new Date(),
      })
      .where(eq(integrationConnections.id, existing.id));
    return;
  }
  await db.insert(integrationConnections).values({
    workspaceId: input.workspaceId,
    provider: "google_calendar",
    status: input.status,
    displayName: input.displayName || "Google",
    credentialsRef: input.credentialsRef || null,
    scopes: input.scopes || [],
    metadata: meta,
    connectedAt: input.connectedAt || null,
  });
}

export async function getGoogleConnection(db: Db, workspaceId: string) {
  return db.query.integrationConnections.findFirst({
    where: and(
      eq(integrationConnections.workspaceId, workspaceId),
      eq(integrationConnections.provider, "google_calendar"),
      isNull(integrationConnections.deletedAt)
    ),
  });
}

export async function loadGoogleTokens(
  db: Db,
  workspaceId: string
): Promise<GoogleTokens | null> {
  const raw = await secretStore.getSecret(db, tokenSecretKey(workspaceId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GoogleTokens;
  } catch {
    return null;
  }
}

export async function getAuthedGoogleClient(db: Db, workspaceId: string) {
  const tokens = await loadGoogleTokens(db, workspaceId);
  if (!tokens) return null;
  if (tokens.mock) {
    return { mock: true as const, tokens, oauth2: null };
  }
  const cfg = await resolveGoogleOAuthConfig(db);
  if (!cfg.configured) return null;
  const oauth2 = createOAuth2Client(cfg);
  oauth2.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
    token_type: tokens.token_type,
    scope: tokens.scope,
  });
  oauth2.on("tokens", async (t) => {
    const merged: GoogleTokens = {
      ...tokens,
      access_token: t.access_token || tokens.access_token,
      refresh_token: t.refresh_token || tokens.refresh_token,
      expiry_date: t.expiry_date || tokens.expiry_date,
      mock: false,
    };
    await secretStore.setSecret(db, tokenSecretKey(workspaceId), JSON.stringify(merged));
  });
  return { mock: false as const, tokens, oauth2 };
}

export async function disconnectGoogle(db: Db, workspaceId: string) {
  await secretStore.deleteSecret(db, tokenSecretKey(workspaceId));
  const row = await getGoogleConnection(db, workspaceId);
  if (row) {
    await db
      .update(integrationConnections)
      .set({
        status: "disconnected",
        credentialsRef: null,
        updatedAt: new Date(),
        metadata: {
          ...((row.metadata || {}) as object),
          disconnected_at: new Date().toISOString(),
        },
      })
      .where(eq(integrationConnections.id, row.id));
  }
}

export function fingerprintWorkspace(workspaceId: string) {
  return createHash("sha256").update(workspaceId).digest("hex").slice(0, 12);
}
