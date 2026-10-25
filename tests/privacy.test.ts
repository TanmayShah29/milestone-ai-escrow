import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { resetDb } from "./helpers";
import { db } from "@/lib/db";
import { createMilestone, getMilestone, transition } from "@/lib/milestones/repo";
import { DISPUTE_WINDOW_MS, LINK_TTL_AFTER_CLOSE_MS, privacySweep, WEBHOOK_RETENTION_MS } from "@/lib/privacy";
import { POST as action } from "@/app/api/milestones/[id]/[action]/route";
import { GET as read } from "@/app/api/milestones/[id]/route";

beforeEach(resetDb);
after(() => db().end());

const post = (id: string, act: string, token: string, body: unknown = {}) =>
  action(new Request(`http://localhost/api/milestones/${id}/${act}`, { method: "POST", headers: { "content-type": "application/json", "x-milestone-token": token }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id, action: act }),
  });
const get = (id: string, token: string) => read(new Request(`http://localhost/api/milestones/${id}`, { headers: { "x-milestone-token": token } }), { params: Promise.resolve({ id }) });
const ago = (ms: number) => new Date(Date.now() - ms);
const fresh = () => createMilestone({ title: "Dark mode", brief: "secret brief", amountCents: 1_000, freelancerEmail: "w@example.com" });

describe("link reissue", () => {
  it("a reissued link works and the old one stops at once", async () => {
    const { milestone, clientToken } = await fresh();
    const res = await post(milestone.id, "rotate-link", clientToken, { link: "client" });
    assert.equal(res.status, 200);
    const { token } = await res.json();
    assert.match(token, /^mct_/);
    assert.equal((await get(milestone.id, clientToken)).status, 403);
    assert.equal((await get(milestone.id, token)).status, 200);
  });

  it("the client can reissue the worker link only until the worker signs; the worker can reissue its own", async () => {
    const { milestone, clientToken, workerToken } = await fresh();
    const r1 = await post(milestone.id, "rotate-link", clientToken, { link: "worker" });
    assert.equal(r1.status, 200);
    const worker2 = (await r1.json()).token as string;
    assert.equal((await get(milestone.id, workerToken)).status, 403);
    await db().query("update milestones set worker_signed_at = now() where id = $1", [milestone.id]);
    assert.notEqual((await post(milestone.id, "rotate-link", clientToken, { link: "worker" })).status, 200);
    assert.notEqual((await post(milestone.id, "rotate-link", worker2, { link: "client" })).status, 200);
    assert.equal((await post(milestone.id, "rotate-link", worker2, { link: "worker" })).status, 200);
  });
});

describe("link expiry", () => {
  it("closing sets closed_at, and links stop working 30 days later", async () => {
    const { milestone, clientToken } = await fresh();
    const closed = await transition(db(), milestone, "CANCELLED", "client");
    assert.ok(closed.closed_at);
    assert.equal((await get(milestone.id, clientToken)).status, 200);
    await db().query("update milestones set closed_at = $2 where id = $1", [milestone.id, ago(LINK_TTL_AFTER_CLOSE_MS + 1_000)]);
    const res = await get(milestone.id, clientToken);
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /expired/);
  });

  it("a dispute on a paid milestone reopens it, so its links work again", async () => {
    const { milestone, clientToken } = await fresh();
    await db().query("update milestones set state = 'PAID_OUT', closed_at = $2 where id = $1", [milestone.id, ago(LINK_TTL_AFTER_CLOSE_MS + 1_000)]);
    const disputed = await transition(db(), await getMilestone(milestone.id), "DISPUTE", "paypal");
    assert.equal(disputed.closed_at, null);
    assert.equal((await get(milestone.id, clientToken)).status, 200);
  });
});

describe("erasure", () => {
  it("only a closed milestone can be erased, and a paid one only after the dispute window", async () => {
    const { milestone, clientToken } = await fresh();
    assert.notEqual((await post(milestone.id, "erase", clientToken)).status, 200); // still a draft
    await db().query("update milestones set state = 'PAID_OUT', closed_at = now() where id = $1", [milestone.id]);
    const early = await post(milestone.id, "erase", clientToken);
    assert.notEqual(early.status, 200);
    assert.match((await early.json()).error, /180 days/);
  });

  it("erasing removes personal data and revokes links, but keeps the money record and audit trail", async () => {
    const { milestone, clientToken, workerToken } = await fresh();
    await db().query("update milestones set paypal_order_id = 'ORDER9', pr_url = 'https://github.com/a/b/pull/1' where id = $1", [milestone.id]);
    await transition(db(), milestone, "CANCELLED", "client");
    await db().query(`insert into webhook_events (id, event_type, milestone_id, payload) values ('WH-1', 'X', $1, '{"payer":{"email":"c@example.com"}}')`, [milestone.id]);
    assert.equal((await post(milestone.id, "erase", workerToken)).status, 403); // only the client erases
    assert.equal((await post(milestone.id, "erase", clientToken)).status, 200);
    const m = await getMilestone(milestone.id);
    assert.equal(m.title, "Erased milestone");
    assert.equal(m.brief, "");
    assert.equal(m.freelancer_email, "");
    assert.equal(m.pr_url, null);
    assert.equal(m.client_token_hash, null);
    assert.ok(m.erased_at);
    assert.equal(m.paypal_order_id, "ORDER9");
    assert.equal(m.amount_cents, 1_000);
    const { rows: wh } = await db().query("select payload, pruned_at from webhook_events where id = 'WH-1'");
    assert.deepEqual(wh[0].payload, {});
    assert.ok(wh[0].pruned_at);
    const { rows: log } = await db().query("select event from audit_log where milestone_id = $1 order by id", [milestone.id]);
    assert.ok(log.some((r) => r.event === "privacy:erased"));
    assert.equal((await get(milestone.id, clientToken)).status, 403);
  });
});

describe("retention sweep", () => {
  it("prunes old webhook payloads and erases milestones past the dispute window", async () => {
    const { milestone } = await fresh();
    const { milestone: recent } = await fresh();
    await db().query("update milestones set state = 'PAID_OUT', closed_at = $2 where id = $1", [milestone.id, ago(DISPUTE_WINDOW_MS + 1_000)]);
    await db().query("update milestones set state = 'PAID_OUT', closed_at = now() where id = $1", [recent.id]);
    await db().query(
      `insert into webhook_events (id, event_type, payload, received_at) values ('OLD', 'X', '{"a":1}', $1), ('NEW', 'X', '{"a":1}', now())`,
      [ago(WEBHOOK_RETENTION_MS + 1_000)],
    );
    const out = await privacySweep();
    assert.deepEqual(out.erased, [milestone.id]);
    assert.ok(out.prunedWebhooks >= 1);
    assert.ok((await getMilestone(milestone.id)).erased_at);
    assert.equal((await getMilestone(recent.id)).erased_at, null);
    const { rows } = await db().query("select id, payload from webhook_events order by id");
    assert.deepEqual(rows, [
      { id: "NEW", payload: { a: 1 } },
      { id: "OLD", payload: {} },
    ]);
  });
});
