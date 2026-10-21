import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";

// One pool per process. Next dev reloads modules, so keep it on globalThis.
const g = globalThis as unknown as { __milestonePool?: Pool };

export function db(): Pool {
  if (!g.__milestonePool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    g.__milestonePool = new Pool({ connectionString: url, max: 8 }) // each locked action holds one connection for the lock;
  }
  return g.__milestonePool;
}

export type Queryable = Pick<Pool, "query"> | PoolClient;

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db().connect();
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (err) {
    await c.query("rollback");
    throw err;
  } finally {
    c.release();
  }
}

/** Postgres unique_violation, recognised by code, never by message. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

// Per-milestone serialization: every action on a milestone (money or not) runs under a Postgres
// advisory lock, so a cancel can't race an authorize or a submit. Reentrant within one async flow
// (syncMilestone → createHold etc.), since a second session-level lock from another pooled
// connection would deadlock.
const held = new AsyncLocalStorage<Set<string>>();

export async function withMilestoneLock<T>(milestoneId: string, fn: () => Promise<T>): Promise<T> {
  const mine = held.getStore();
  if (mine?.has(milestoneId)) return fn();
  const c = await db().connect();
  try {
    await c.query("select pg_advisory_lock(hashtext($1))", [milestoneId]);
    try {
      return await held.run(new Set([...(mine ?? []), milestoneId]), fn);
    } finally {
      await c.query("select pg_advisory_unlock(hashtext($1))", [milestoneId]);
    }
  } finally {
    c.release();
  }
}
