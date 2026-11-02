// Applies db/migrations/*.sql in order, once each. Used by `npm run db:migrate` and at server startup
// (src/instrumentation.ts). An advisory lock keeps two starting processes from applying the same file.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const LOCK = "milestone:migrations";

export async function migrate(url: string, dir = join(process.cwd(), "db", "migrations"), log = console.log): Promise<void> {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    // One transaction, so the lock works through a connection pooler too (see withMilestoneLock): all the
    // pending files apply together or not at all, and the commit releases the lock.
    await db.query("begin");
    try {
      await db.query("select pg_advisory_xact_lock(hashtext($1))", [LOCK]);
      await db.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
      const done = new Set((await db.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
      const applied: string[] = [];
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
        if (done.has(file)) continue;
        await db.query(readFileSync(join(dir, file), "utf8"));
        await db.query("insert into schema_migrations (name) values ($1)", [file]);
        applied.push(file);
      }
      await db.query("commit");
      for (const file of applied) log(`applied ${file}`);
    } catch (err) {
      await db.query("rollback");
      throw err;
    }
  } finally {
    await db.end();
  }
}
