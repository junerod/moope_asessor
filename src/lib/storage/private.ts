import { mkdir, writeFile, readFile, rm } from "fs/promises";
import { dirname, join } from "path";
import { createHash } from "crypto";
import { getEnv } from "@/config/env";

export async function putPrivateObject(input: {
  key: string;
  buffer: Buffer;
  mimeType?: string;
}): Promise<{
  storageKey: string;
  sha256: string;
  size: number;
  provider: "local" | "r2";
}> {
  const env = getEnv();
  const storageKey = input.key.replace(/^\/+/, "");
  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const size = input.buffer.length;

  if (
    env.STORAGE_DRIVER === "r2" &&
    env.R2_ENDPOINT &&
    env.R2_BUCKET &&
    env.R2_ACCESS_KEY_ID &&
    env.R2_SECRET_ACCESS_KEY
  ) {
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      endpoint: env.R2_ENDPOINT,
      region: env.R2_REGION || "auto",
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
    await client.send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET,
        Key: storageKey,
        Body: input.buffer,
        ContentType: input.mimeType || "application/octet-stream",
      })
    );
    return { storageKey, sha256, size, provider: "r2" };
  }

  const root = env.STORAGE_ROOT;
  const full = join(process.cwd(), root, storageKey);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, input.buffer);
  return { storageKey, sha256, size, provider: "local" };
}

export async function getPrivateObject(storageKey: string): Promise<Buffer> {
  const env = getEnv();
  const key = storageKey.replace(/^\/+/, "");

  if (
    env.STORAGE_DRIVER === "r2" &&
    env.R2_ENDPOINT &&
    env.R2_BUCKET &&
    env.R2_ACCESS_KEY_ID &&
    env.R2_SECRET_ACCESS_KEY
  ) {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      endpoint: env.R2_ENDPOINT,
      region: env.R2_REGION || "auto",
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
    const out = await client.send(
      new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key })
    );
    const bytes = await out.Body?.transformToByteArray();
    if (!bytes) throw new Error("r2_empty_object");
    return Buffer.from(bytes);
  }

  const full = join(process.cwd(), env.STORAGE_ROOT, key);
  return readFile(full);
}

export async function createPrivateObjectDownloadUrl(
  storageKey: string,
  filename: string,
  expiresInSeconds = 900
): Promise<string | null> {
  const env = getEnv();
  if (
    env.STORAGE_DRIVER !== "r2" ||
    !env.R2_ENDPOINT ||
    !env.R2_BUCKET ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY
  ) {
    return null;
  }
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const client = new S3Client({
    endpoint: env.R2_ENDPOINT,
    region: env.R2_REGION || "auto",
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  const safeFilename = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: storageKey.replace(/^\/+/, ""),
      ResponseContentDisposition: `attachment; filename="${safeFilename}"`,
    }),
    { expiresIn: Math.max(60, Math.min(900, Math.floor(expiresInSeconds))) }
  );
}

export async function deletePrivateObject(storageKey: string): Promise<void> {
  const env = getEnv();
  const key = storageKey.replace(/^\/+/, "");
  if (
    env.STORAGE_DRIVER === "r2" &&
    env.R2_ENDPOINT &&
    env.R2_BUCKET &&
    env.R2_ACCESS_KEY_ID &&
    env.R2_SECRET_ACCESS_KEY
  ) {
    const { S3Client, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      endpoint: env.R2_ENDPOINT,
      region: env.R2_REGION || "auto",
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
    await client.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
    return;
  }
  await rm(join(process.cwd(), env.STORAGE_ROOT, key), { force: true });
}
