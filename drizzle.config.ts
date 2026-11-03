import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://assessor:assessor@127.0.0.1:54329/moope_assessor",
  },
  strict: true,
  verbose: true,
});
