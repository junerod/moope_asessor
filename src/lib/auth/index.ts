import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { getEnv } from "@/config/env";
import type { Db } from "@/db/client";
import { users } from "@/db/schema";
import { createPersonalWorkspace } from "@/domain/workspaces";

const BCRYPT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  passwordHash: string
): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

function jwtSecretKey() {
  return new TextEncoder().encode(getEnv().AUTH_JWT_SECRET);
}

export type AuthTokenPayload = {
  sub: string;
  email: string;
};

export async function signAccessToken(payload: AuthTokenPayload): Promise<string> {
  const env = getEnv();
  return new SignJWT({ email: payload.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${env.AUTH_JWT_TTL_SECONDS}s`)
    .sign(jwtSecretKey());
}

export async function verifyAccessToken(
  token: string
): Promise<AuthTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, jwtSecretKey());
    if (!payload.sub || typeof payload.email !== "string") return null;
    return { sub: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

export type RegisterInput = {
  email: string;
  name: string;
  password: string;
  timezone?: string;
};

export async function registerUser(db: Db, input: RegisterInput) {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!email || !name || input.password.length < 8) {
    throw new Error("invalid_register_input");
  }

  const existing = await db.query.users.findFirst({
    where: eq(users.email, email),
  });
  if (existing) {
    throw new Error("email_already_registered");
  }

  const passwordHash = await hashPassword(input.password);
  const timezone = input.timezone || getEnv().DEFAULT_TIMEZONE;

  const [user] = await db
    .insert(users)
    .values({
      email,
      name,
      passwordHash,
      status: "active",
      emailVerifiedAt: new Date(),
      timezone,
      globalUserId: null,
    })
    .returning();

  const workspace = await createPersonalWorkspace(db, {
    userId: user.id,
    name: `${name.split(" ")[0]} — Pessoal`,
    timezone,
  });

  const token = await signAccessToken({ sub: user.id, email: user.email });

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      global_user_id: user.globalUserId,
      timezone: user.timezone,
    },
    workspace,
    access_token: token,
  };
}

export async function loginUser(
  db: Db,
  input: { email: string; password: string }
) {
  const email = input.email.trim().toLowerCase();
  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });
  if (!user || !user.passwordHash || user.deletedAt) {
    throw new Error("invalid_credentials");
  }
  if (user.status !== "active") {
    throw new Error("user_not_active");
  }
  const ok = await verifyPassword(input.password, user.passwordHash);
  if (!ok) throw new Error("invalid_credentials");

  const token = await signAccessToken({ sub: user.id, email: user.email });
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      global_user_id: user.globalUserId,
      timezone: user.timezone,
    },
    access_token: token,
  };
}
