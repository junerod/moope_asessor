import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { getEnv } from "@/config/env";

export type Db = ReturnType<typeof createDb>;

let sqlClient: ReturnType<typeof postgres> | null = null;
let dbSingleton: Db | null = null;

export function createDb(connectionString?: string) {
  const url = connectionString ?? getEnv().DATABASE_URL;
  const client = postgres(url, {
    max: 10,
    prepare: false,
  });
  return drizzle(client, { schema });
}

export function getDb(): Db {
  if (!dbSingleton) {
    const url = getEnv().DATABASE_URL;
    sqlClient = postgres(url, { max: 10, prepare: false });
    dbSingleton = drizzle(sqlClient, { schema });
  }
  return dbSingleton;
}

export async function closeDb() {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = null;
    dbSingleton = null;
  }
}

export { schema };
