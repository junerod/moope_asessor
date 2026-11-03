import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import postgres from "postgres";

async function main() {
  const url =
    process.env.DATABASE_URL ||
    "postgres://assessor:assessor@127.0.0.1:54329/moope_assessor";
  const sql = postgres(url, { max: 1 });

  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const dir = join(process.cwd(), "src/db/migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const applied = await sql`
      SELECT id FROM schema_migrations WHERE id = ${file}
    `;
    if (applied.length) {
      console.log(`skip ${file}`);
      continue;
    }
    const body = readFileSync(join(dir, file), "utf8");
    console.log(`apply ${file}`);
    await sql.unsafe(body);
    await sql`INSERT INTO schema_migrations (id) VALUES (${file})`;
  }

  await sql.end({ timeout: 5 });
  console.log("migrations complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
