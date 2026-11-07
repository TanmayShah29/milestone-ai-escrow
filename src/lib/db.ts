import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";

// One pool per process. Next dev reloads modules, so keep it on globalThis.
const g = globalThis as unknown as { __milestonePool?: Pool; __milestoneLockPool?: Pool };

// A wait for a free connection gives up instead of hanging forever, so a burst fails loudly and recovers.
const CONNECT_TIMEOUT_MS = 20_000;

function makePool(max: number): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const p = new Pool({ connectionString: url, max, connectionTimeoutMillis: CONNECT_TIMEOUT_MS, allowExitOnIdle: true });
  // Neon drops idle connections. Without a listener, node-postgres's error event would crash the whole process.
  p.on("error", dropped);
  return p;
}

export function db(): Pool {
  return (g.__milestonePool ??= makePool(8));
}

// Milestone locks live in their own pool. A lock holds its connection while the work inside uses db(), so
// sharing one pool let eight concurrent locks take every connection and wait forever for a ninth.
function lockPool(): Pool {
  return (g.__milestoneLockPool ??= makePool(8));
}

const dropped = (err: Error) => console.warn(`database connection dropped: ${String(err).slice(0, 200)}`);

/** A connection this code holds: the same crash applies to it while it's checked out. */
async function checkOut(pool: Pool = db()): Promise<PoolClient & { done: (err?: Error) => void }> {
  const c = await pool.connect();
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
type Held = { keys: Set<string>; conn: PoolClient };
const held = new AsyncLocalStorage<Held>();

const LOCK_WAIT_MS = 180_000; // longer than an AI draft, which holds a milestone's lock
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Try for a nested lock on the connection already holding the outer one, backing off until LOCK_WAIT_MS. */
async function acquire(c: PoolClient, key: string, started: number): Promise<void> {
  for (let wait = 25; ; wait = Math.min(wait * 2, 400)) {
    const { rows } = await c.query<{ ok: boolean }>("select pg_try_advisory_xact_lock(hashtext($1)) as ok", [key]);
    if (rows[0]?.ok) return;
    if (Date.now() - started > LOCK_WAIT_MS) throw Object.assign(new Error(`milestone ${key} stayed locked for ${LOCK_WAIT_MS / 1000}s`), { code: "55P03" });
    await sleep(wait + Math.random() * wait);
  }
}

export async function withMilestoneLock<T>(milestoneId: string, fn: () => Promise<T>): Promise<T> {
  const mine = held.getStore();
  if (mine?.keys.has(milestoneId)) return fn();
  const started = Date.now();

  // Nested lock on another key (e.g. a mandate, then the milestone it funds): take it on the connection that
  // already holds the outer lock, so one flow never needs two lock connections. It ends with the outer one.
  if (mine) {
    await acquire(mine.conn, milestoneId, started);
    return held.run({ keys: new Set([...mine.keys, milestoneId]), conn: mine.conn }, fn);
  }

  // Outer lock: never hold a pooled connection while waiting. Each try is a short transaction; a busy
  // milestone sends the connection back to the pool between tries, so it can't starve other milestones.
  for (let wait = 25; ; wait = Math.min(wait * 2, 400)) {
    const c = await checkOut(lockPool());
    let broken: Error | undefined;
    let got = false;
    try {
      await c.query("begin");
      const { rows } = await c.query<{ ok: boolean }>("select pg_try_advisory_xact_lock(hashtext($1)) as ok", [milestoneId]);
      got = !!rows[0]?.ok;
      if (got) return await held.run({ keys: new Set([milestoneId]), conn: c }, fn);
    } finally {
      // This transaction holds only the lock (fn's writes use other connections), so a failed commit must not
      // replace fn's result. The lost connection took the lock with it; the pool drops it.
      await c.query(got ? "commit" : "rollback").catch((err: Error) => {
        broken = err;
        console.warn(`milestone lock ${got ? "commit" : "rollback"} failed: ${String(err).slice(0, 200)}`);
      });
      c.done(broken);
    }
    if (Date.now() - started > LOCK_WAIT_MS) throw Object.assign(new Error(`milestone ${milestoneId} stayed locked for ${LOCK_WAIT_MS / 1000}s`), { code: "55P03" });
    await sleep(wait + Math.random() * wait);
  }
}
