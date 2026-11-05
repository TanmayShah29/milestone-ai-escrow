import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { resetDb, seedMilestone } from "./helpers";
import { db, tx } from "@/lib/db";
import { audit, createMilestone, getMilestone, transition } from "@/lib/milestones/repo";
import { chainOf, repairChain } from "@/lib/proof/chain";
import { publishedKeys } from "@/lib/proof/keys";
import { canonical, detailMatches, verifyChain, type ProofBody, type ProofEvent } from "@/lib/proof/verify";

beforeEach(resetDb);
after(() => db().end());

async function verified(id: string) {
  const events = await chainOf(id);
  return { events, check: await verifyChain(id, events, await publishedKeys()) };
}

const bodyOf = (e: ProofEvent) => JSON.parse(e.body) as ProofBody;

describe("proof chain", () => {
  it("every audit row becomes a signed, linked event that verifies", async () => {
    const { milestone: m } = await createMilestone({ title: "Slugify", brief: "b", amountCents: 2500, freelancerEmail: "w@example.com" });
    await audit(db(), { milestoneId: m.id, actor: "client", event: "terms:signed:client", detail: { hash: "a".repeat(64), note: "private words" } });
    await transition(db(), await getMilestone(m.id), "AGREED", "freelancer", {}, { event: "terms:agreed", detail: { hash: "a".repeat(64) } });

    const { events, check } = await verified(m.id);
    assert.equal(events.length, 3);
    assert.ok(check.ok, check.problems.join("; "));
    assert.equal(check.head, events[2]!.hash);
    assert.deepEqual(events.map((e) => bodyOf(e).event), ["created", "terms:signed:client", "terms:agreed"]);
    assert.equal(bodyOf(events[2]!).prev, events[1]!.hash);
    assert.deepEqual(bodyOf(events[2]!).to, "AGREED");
    // Facts are public; anything else in the detail is only a salted digest.
    assert.deepEqual(bodyOf(events[1]!).facts, { hash: "a".repeat(64) });
    assert.ok(!events[1]!.body.includes("private words"));
    const { rows } = await db().query<{ detail_salt: string; detail: unknown }>(
      "select p.detail_salt, a.detail from proof_events p join audit_log a on a.id = p.audit_id where p.milestone_id = $1 and p.seq = 2",
      [m.id],
    );
    assert.ok(await detailMatches(rows[0]!.detail, rows[0]!.detail_salt, bodyOf(events[1]!).detailDigest));
    assert.ok(!(await detailMatches({ hash: "b" }, rows[0]!.detail_salt, bodyOf(events[1]!).detailDigest)));
  });

  it("one edited byte, a reorder, a dropped event or a forged signature fails verification", async () => {
    const id = (await createMilestone({ title: "T", brief: "b", amountCents: 2500, freelancerEmail: "w@example.com" })).milestone.id;
    for (const ev of ["a", "b", "c"]) await audit(db(), { milestoneId: id, actor: "system", event: `test:${ev}` });
    const { events } = await verified(id);
    const keys = await publishedKeys();

    const edited = events.map((e, i) => (i === 1 ? { ...e, body: e.body.replace("test:a", "test:x") } : e));
    assert.match((await verifyChain(id, edited, keys)).problems.join(";"), /event 2: hash does not match/);

    const dropped = events.filter((_, i) => i !== 1);
    assert.equal((await verifyChain(id, dropped, keys)).ok, false);

    const swapped = [events[0]!, { ...events[2]!, seq: 2 }, { ...events[1]!, seq: 3 }];
    assert.equal((await verifyChain(id, swapped, keys)).ok, false);

    const forged = events.map((e, i) => (i === 2 ? { ...e, sig: events[1]!.sig } : e));
    assert.match((await verifyChain(id, forged, keys)).problems.join(";"), /event 3: signature is not valid/);

    // A body rewritten and re-hashed by someone without the key still fails on the signature.
    const body = { ...bodyOf(events[3]!), event: "test:paid" };
    const text = canonical(body);
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const rewritten = events.map((e, i) => (i === 3 ? { ...e, body: text, hash } : e));
    assert.match((await verifyChain(id, rewritten, keys)).problems.join(";"), /event 4: signature is not valid/);

    assert.equal((await verifyChain("00000000-0000-0000-0000-000000000000", events, keys)).ok, false);
  });

  it("rows written before the chain existed are signed in order and marked backfilled", async () => {
    const id = await seedMilestone({ state: "DRAFT" });
    await db().query("insert into audit_log (milestone_id, actor, event) values ($1, 'client', 'created'), ($1, 'client', 'terms:drafted')", [id]);
    assert.equal((await chainOf(id)).length, 0);
    await audit(db(), { milestoneId: id, actor: "client", event: "terms:edited" });
    const { events, check } = await verified(id);
    assert.ok(check.ok, check.problems.join("; "));
    assert.deepEqual(events.map((e) => [bodyOf(e).event, bodyOf(e).backfilled ?? false]), [
      ["created", true],
      ["terms:drafted", true],
      ["terms:edited", false],
    ]);
    await repairChain(id); // nothing missing: no-op
    assert.equal((await chainOf(id)).length, 3);
  });

  it("a signing failure inside a transaction neither aborts it nor loses the row", async () => {
    const id = await seedMilestone({ state: "DRAFT" });
    await tx(async (c) => {
      await c.query("alter table proof_events add constraint proof_test_block check (seq < 0) not valid");
      await audit(c, { milestoneId: id, actor: "system", event: "test:during-outage" });
      await c.query("alter table proof_events drop constraint proof_test_block");
      await c.query("update milestones set title = 'still committed' where id = $1", [id]);
    });
    assert.equal((await getMilestone(id)).title, "still committed");
    assert.equal((await chainOf(id)).length, 0);
    await audit(db(), { milestoneId: id, actor: "system", event: "test:after" });
    const { events, check } = await verified(id);
    assert.ok(check.ok);
    assert.deepEqual(events.map((e) => [bodyOf(e).event, bodyOf(e).backfilled ?? false]), [
      ["test:during-outage", true],
      ["test:after", false],
    ]);
  });

  it("concurrent appends to one milestone keep a single unbroken chain", async () => {
    const id = await seedMilestone({ state: "DRAFT" });
    await Promise.all(Array.from({ length: 8 }, (_, i) => audit(db(), { milestoneId: id, actor: "system", event: `test:${i}` })));
    const { events, check } = await verified(id);
    assert.equal(events.length, 8);
    assert.ok(check.ok, check.problems.join("; "));
  });
});
