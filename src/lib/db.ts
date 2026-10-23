import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";
import { InProgress } from "@/lib/errors";

// One pool per process. Next dev reloads modules, so keep it on globalThis.
const g = globalThis as unknown as { __milestonePool?: Pool; __milestoneLockSlots?: Slots };

const POOL_MAX = 16;

export function db(): Pool {
  if (!g.__milestonePool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    // Timeouts so a lost connection or a stuck query fails loudly instead of queueing callers forever.
    const pool = new Pool({ connectionString: url, max: POOL_MAX, connectionTimeoutMillis: 15_000, statement_timeout: 30_000 });
    // A dropped idle connection (Neon or Render restarting) emits 'error'; without a listener it crashes the process.
    pool.on("error", (err) => console.error("postgres pool error", err.message));
    g.__milestonePool = pool;
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
//
// A lock holder keeps one connection for the lock and needs another for its queries. So callers waiting
// for a lock never hold a connection (they retry pg_try_advisory_lock), and at most LOCK_SLOTS holders
// run at once per process: together they can't take every connection in the pool and wedge it.
const held = new AsyncLocalStorage<Set<string>>();

const LOCK_SLOTS = 6;
const LOCK_WAIT_MS = 30_000;
const LOCK_RETRY_MS = 150;

type Slots = { free: number; waiting: (() => void)[] };
const slots = (g.__milestoneLockSlots ??= { free: LOCK_SLOTS, waiting: [] });

async function takeSlot(deadline: number): Promise<void> {
  if (slots.free > 0) {
    slots.free--;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const wake = () => {
      clearTimeout(timer);
      resolve(); // the slot is handed over by giveSlot, so free stays as it is
    };
    const timer = setTimeout(() => {
      slots.waiting = slots.waiting.filter((w) => w !== wake);
      reject(new InProgress("The server is busy with other milestones. Try again in a moment."));
    }, Math.max(0, deadline - Date.now()));
    slots.waiting.push(wake);
  });
}

function giveSlot(): void {
  const next = slots.waiting.shift();
  if (next) next();
  else slots.free++;
}

export async function withMilestoneLock<T>(milestoneId: string, fn: () => Promise<T>): Promise<T> {
  const mine = held.getStore();
  if (mine?.has(milestoneId)) return fn();
  const deadline = Date.now() + LOCK_WAIT_MS;
  // A holder that takes a second milestone's lock already has a slot; waiting for another could deadlock.
  const nested = !!mine?.size;
  if (!nested) await takeSlot(deadline);
  try {
    for (;;) {
      const c = await db().connect();
      // A connection whose unlock failed may still hold the lock: destroy it rather than pool it.
      let broken: Error | undefined;
      try {
        const { rows } = await c.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext($1)) as ok", [milestoneId]);
        if (rows[0]?.ok === true) {
          try {
            return await held.run(new Set([...(mine ?? []), milestoneId]), fn);
          } finally {
            await c.query("select pg_advisory_unlock(hashtext($1))", [milestoneId]).catch((err: Error) => {
              broken = err;
            });
          }
        }
      } finally {
        c.release(broken);
      }
      if (Date.now() >= deadline) throw new InProgress("Another action on this milestone is still running. Try again in a moment.");
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  } finally {
    if (!nested) giveSlot();
  }
}
