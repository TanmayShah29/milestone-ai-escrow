import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import "./helpers";
import { db, withMilestoneLock } from "@/lib/db";

after(() => db().end());

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("withMilestoneLock", () => {
  it("doesn't starve the pool: many concurrent locks can still run queries inside", async () => {
    // Regression: locks and their work shared one 8-connection pool, so 8 concurrent locks took every
    // connection and each waited forever for a ninth (found by the Nov 7 payments audit).
    const ids = Array.from({ length: 12 }, (_, i) => `lock-starve-${i}`);
    const run = Promise.all(
      ids.map((id) =>
        withMilestoneLock(id, async () => {
          await sleep(20);
          return (await db().query("select 1 as one")).rows[0].one as number;
        }),
      ),
    );
    const out = await Promise.race([run, sleep(8_000).then(() => "hung" as const)]);
    assert.notEqual(out, "hung");
    assert.deepEqual(out, ids.map(() => 1));
  });

  it("takes a nested lock on another key without a second lock connection", async () => {
    // Regression: postBounty holds mandate:<id>, then locks the milestone it funds. 8 at once used to need
    // 16 lock connections and all failed after the connect timeout (Nov 7 re-audit).
    const run = Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        withMilestoneLock(`lock-outer-${i}`, () => withMilestoneLock(`lock-inner-${i}`, async () => (await db().query("select 1 as one")).rows[0].one as number)),
      ),
    );
    const out = await Promise.race([run, sleep(8_000).then(() => "hung" as const)]);
    assert.deepEqual(out, Array.from({ length: 10 }, () => 1));
  });

  it("doesn't let waiters on one busy milestone block the others", async () => {
    let release!: () => void;
    const busy = withMilestoneLock("lock-busy", () => new Promise<void>((done) => (release = done)));
    await sleep(50);
    const waiters = Array.from({ length: 10 }, () => withMilestoneLock("lock-busy", async () => "late"));
    await sleep(100);
    const other = await Promise.race([withMilestoneLock("lock-free", async () => "ran"), sleep(3_000).then(() => "blocked")]);
    assert.equal(other, "ran");
    release();
    await busy;
    assert.deepEqual(await Promise.all(waiters), Array.from({ length: 10 }, () => "late"));
  });

  it("runs actions on one milestone one at a time, and is reentrant", async () => {
    const order: string[] = [];
    const action = (name: string) =>
      withMilestoneLock("lock-test-a", async () => {
        order.push(`${name} in`);
        await sleep(30);
        await withMilestoneLock("lock-test-a", async () => order.push(`${name} nested`));
        order.push(`${name} out`);
      });
    await Promise.all([action("x"), action("y")]);
    const first = order[0]![0]!; // either may get the lock first; the other must wait until it's done
    const second = first === "x" ? "y" : "x";
    assert.deepEqual(order, [`${first} in`, `${first} nested`, `${first} out`, `${second} in`, `${second} nested`, `${second} out`]);
  });

  it("doesn't let one milestone wait on another, and holds no lock afterwards", async () => {
    let bDone = false;
    await withMilestoneLock("lock-test-b", async () => {
      await withMilestoneLock("lock-test-c", async () => {
        bDone = true;
      });
    });
    assert.equal(bDone, true);
    const { rows } = await db().query("select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = any (select pid from pg_stat_activity where datname = current_database())");
    assert.equal(rows[0].n, 0);
  });

  it("survives the database dropping connections, idle or held, and frees the lock (Neon does this)", async () => {
    await db().query("select 1");
    await db().query("select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()");
    await sleep(100);
    const out = await withMilestoneLock("lock-test-e", async () => {
      await db().query("select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()");
      await sleep(100);
      return "finished";
    });
    assert.equal(out, "finished");
    assert.equal(await withMilestoneLock("lock-test-e", async () => "free"), "free");
    assert.equal((await db().query("select 1 as n")).rows[0].n, 1);
  });

  it("releases the lock when the action throws, and passes the error on", async () => {
    await assert.rejects(withMilestoneLock("lock-test-d", async () => { throw new Error("boom"); }), /boom/);
    assert.equal(await withMilestoneLock("lock-test-d", async () => "free"), "free");
  });
});
