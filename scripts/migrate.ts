// Applies db/migrations/*.sql in order, once each. Usage: npm run db:migrate
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const dir = join(import.meta.dirname, "..", "db", "migrations");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const done = new Set((await db.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(file)) continue;
      await db.query("begin");
      try {
        await db.query(readFileSync(join(dir, file), "utf8"));
        await db.query("insert into schema_migrations (name) values ($1)", [file]);
        await db.query("commit");
        console.log(`applied ${file}`);
      } catch (err) {
        await db.query("rollback");
        throw err;
      }
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
