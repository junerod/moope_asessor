import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { encryptedSecrets } from "@/db/schema";
import { getEnv } from "@/config/env";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;

function deriveKey(master: string, version: number): Buffer {
  return scryptSync(`${master}:v${version}`, "moope-assessor-secret-store", KEY_LEN);
}

function masterKey(): string {
  const key = getEnv().ENCRYPTION_MASTER_KEY;
  if (!key || key.length < 32) {
    throw new Error("encryption_master_key_missing");
  }
  return key;
}

export type SecretStore = {
  setSecret(db: Db, key: string, plaintext: string): Promise<{ key: string; keyVersion: number }>;
  getSecret(db: Db, key: string): Promise<string | null>;
  deleteSecret(db: Db, key: string): Promise<void>;
  hasSecret(db: Db, key: string): Promise<boolean>;
};

export function encryptSecret(plaintext: string, keyVersion = 1): {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
} {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, deriveKey(masterKey(), keyVersion), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    keyVersion,
  };
}

export function decryptSecret(input: {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}): string {
  const decipher = createDecipheriv(
    ALGO,
    deriveKey(masterKey(), input.keyVersion),
    Buffer.from(input.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(input.authTag, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(input.ciphertext, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

export function createSecretStore(): SecretStore {
  return {
    async setSecret(db, key, plaintext) {
      const sealed = encryptSecret(plaintext, 1);
      const existing = await db.query.encryptedSecrets.findFirst({
        where: eq(encryptedSecrets.key, key),
      });
      if (existing) {
        await db
          .update(encryptedSecrets)
          .set({
            ciphertext: sealed.ciphertext,
            iv: sealed.iv,
            authTag: sealed.authTag,
            keyVersion: sealed.keyVersion,
            updatedAt: new Date(),
            rotatedAt: new Date(),
          })
          .where(eq(encryptedSecrets.key, key));
      } else {
        await db.insert(encryptedSecrets).values({
          key,
          ciphertext: sealed.ciphertext,
          iv: sealed.iv,
          authTag: sealed.authTag,
          keyVersion: sealed.keyVersion,
        });
      }
      return { key, keyVersion: sealed.keyVersion };
    },

    async getSecret(db, key) {
      const row = await db.query.encryptedSecrets.findFirst({
        where: eq(encryptedSecrets.key, key),
      });
      if (!row) return null;
      return decryptSecret({
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
        keyVersion: row.keyVersion,
      });
    },

    async deleteSecret(db, key) {
      await db.delete(encryptedSecrets).where(eq(encryptedSecrets.key, key));
    },

    async hasSecret(db, key) {
      const row = await db.query.encryptedSecrets.findFirst({
        where: eq(encryptedSecrets.key, key),
      });
      return Boolean(row);
    },
  };
}

export const secretStore = createSecretStore();
