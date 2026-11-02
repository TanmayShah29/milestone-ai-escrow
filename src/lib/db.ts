import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";

// One pool per process. Next dev reloads modules, so keep it on globalThis.
const g = globalThis as unknown as { __milestonePool?: Pool };

export function db(): Pool {
  if (!g.__milestonePool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    g.__milestonePool = new Pool({ connectionString: url, max: 8 }); // each locked action holds one connection for the lock
    // Neon drops idle connections. Without a listener, node-postgres's error event would crash the whole process.
    g.__milestonePool.on("error", dropped);
  }
  return g.__milestonePool;
}

const dropped = (err: Error) => console.warn(`database connection dropped: ${String(err).slice(0, 200)}`);

/** A connection this code holds: the same crash applies to it while it's checked out. */
async function checkOut(): Promise<PoolClient & { done: (err?: Error) => void }> {
  const c = await db().connect();
  c.on("error", dropped);
  return Object.assign(c, {
    done: (err?: Error) => {
      c.removeListener("error", dropped);
      c.release(err);
    },
  });
}

export type Queryable = Pick<Pool, "query"> | PoolClient;

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await checkOut();
  let broken: Error | undefined;
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (err) {
    await c.query("rollback").catch((e: Error) => {
      broken = e;
    });
    throw err;
  } finally {
    c.done(broken);
  }
}

/** Postgres unique_violation, recognised by code, never by message. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

// Per-milestone serialization: every action on a milestone (money or not) runs under a Postgres
// advisory lock, so a cancel can't race an authorize or a submit. Reentrant within one async flow
// (syncMilestone → createHold etc.), since a second lock from another pooled connection would
// deadlock. A transaction-level lock, because a connection pooler (Neon's, PgBouncer) can run each
// statement outside a transaction on a different backend: a session-level lock could leak there, and two
// leaked locks can deadlock. The open transaction pins one backend until the commit releases the lock.
const held = new AsyncLocalStorage<Set<string>>();

export async function withMilestoneLock<T>(milestoneId: string, fn: () => Promise<T>): Promise<T> {
  const mine = held.getStore();
  if (mine?.has(milestoneId)) return fn();
  const c = await checkOut();
  let broken: Error | undefined;
  try {
    await c.query("begin");
    await c.query("set local lock_timeout = '180s'"); // longer than an AI draft, which holds this lock
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [milestoneId]);
    return await held.run(new Set([...(mine ?? []), milestoneId]), fn);
  } finally {
    // This transaction holds only the lock (fn's writes use other connections), so a failed commit must not
    // replace fn's result. The lost connection took the lock with it; the pool drops it.
    await c.query("commit").catch((err: Error) => {
      broken = err;
      console.warn(`milestone lock commit failed: ${String(err).slice(0, 200)}`);
    });
    c.done(broken);
  }
}
