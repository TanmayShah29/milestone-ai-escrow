import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLedgerRows, holdDaysLeft, ledgerTotals, moneyNow, nextAction, portfolioRow, requestIdOf, totalRows, type ActionRow, type AuditRow } from "@/lib/client/ledger";
import type { MilestoneView } from "@/lib/client/states";
import { requestIdFor } from "@/lib/money/claims";

// The ledger and portfolio grids are built from what GET /api/milestones/:id returns. Pure: no DB.

const T0 = Date.parse("2026-10-01T12:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

const paid: MilestoneView = {
  id: "m_paid",
  title: "Slugify helper",
  state: "PAID_OUT",
  amount_cents: 2500,
  authorized_cents: 2500,
  captured_cents: 2500,
  paypal_fee_cents: 117,
  payout_fee_cents: 25,
  fee_cents: 125,
  payout_cents: 2233,
};

const audit: AuditRow[] = [
  { id: 1, actor: "client", event: "order:created", paypal_id: "O-1", created_at: at(0) },
  { id: 2, actor: "paypal", event: "authorize:refused", paypal_id: null, created_at: at(1) },
  { id: 3, actor: "client", event: "hold:authorized", paypal_id: "AUTH-1", created_at: at(3) },
  { id: 4, actor: "system", event: "hold:captured", paypal_id: "CAP-1", created_at: at(60) },
  { id: 5, actor: "paypal", event: "payout:created", paypal_id: "BATCH-1", created_at: at(61) },
];
const actions: ActionRow[] = [
  { action: "create_order", attempt: 1, status: "succeeded", paypal_id: "O-1", created_at: at(0) },
  { action: "authorize", attempt: 1, status: "failed", paypal_id: null, created_at: at(1) },
  { action: "authorize", attempt: 2, status: "succeeded", paypal_id: "AUTH-1", created_at: at(3) },
  { action: "capture", attempt: 1, status: "succeeded", paypal_id: "CAP-1", created_at: at(60) },
  { action: "payout", attempt: 1, status: "unknown", paypal_id: null, created_at: at(61) },
];

describe("ledger rows", () => {
  const rows = buildLedgerRows({ role: "client", milestone: paid, audit, actions });

  it("one row per money action, joined with its audit event", () => {
    assert.equal(rows.length, 5);
    assert.deepEqual(
      rows.map((r) => [r.action, r.attempt, r.status, r.actor]),
      [
        ["Order", 1, "succeeded", "Client"],
        ["Hold", 1, "failed", "PayPal"],
        ["Hold", 2, "succeeded", "Client"],
        ["Capture", 1, "succeeded", "Fixed rules"],
        ["Payout", 1, "unknown", "PayPal"],
      ],
    );
    assert.equal(rows[2]!.paypalId, "AUTH-1");
    assert.equal(rows[2]!.at, at(3));
    assert.equal(rows[4]!.paypalId, "BATCH-1", "a claim without a PayPal id takes its audit event's");
  });

  it("amounts come from the milestone's cent columns", () => {
    assert.deepEqual(
      rows.map((r) => r.amountCents),
      [2500, 2500, 2500, 2500, 2233],
    );
  });

  it("each attempt carries the PayPal-Request-Id the server sent", () => {
    assert.equal(rows[1]!.requestId, requestIdFor("m_paid", "authorize", 1));
    assert.equal(rows[2]!.requestId, requestIdFor("m_paid", "authorize", 2));
    assert.equal(requestIdOf("m_paid", "reauthorize_1", 1), requestIdFor("m_paid", "reauthorize_1", 1));
  });

  it("seeded history with no claim rows still shows its money events, without attempts", () => {
    const seeded = buildLedgerRows({
      role: "worker",
      milestone: paid,
      actions: [],
      audit: [
        { id: 10, actor: "system", event: "terms:agreed", paypal_id: null, created_at: at(0) },
        { id: 11, actor: "system", event: "hold:authorized", paypal_id: "AUTH-9", created_at: at(1) },
        { id: 12, actor: "system", event: "hold:captured", paypal_id: "CAP-9", created_at: at(2) },
        { id: 13, actor: "system", event: "payout:succeeded", paypal_id: "ITEM-9", created_at: at(3) },
      ],
    });
    assert.deepEqual(
      seeded.map((r) => [r.action, r.attempt, r.requestId, r.source, r.amountCents]),
      [
        ["Hold", null, null, "trail", 2500],
        ["Capture", null, null, "trail", 2500],
        ["Payout", null, null, "trail", 2233],
      ],
    );
  });

  it("never carries a link token", () => {
    const tokens = ["mct_secret_client", "mwt_secret_worker"];
    const json = JSON.stringify([rows, portfolioRow(paid, "client", true)]);
    for (const t of tokens) assert.ok(!json.includes(t));
    assert.ok(!/mct_|mwt_/.test(json));
  });
});

describe("ledger totals", () => {
  const funded: MilestoneView = { id: "m_f", title: "Funded", state: "FUNDED", amount_cents: 4000, authorized_cents: 4000 };
  const draft: MilestoneView = { id: "m_d", title: "Draft", state: "DRAFT", amount_cents: 9900 };

  it("held now, captured, PayPal fees, platform fees, paid out", () => {
    assert.deepEqual(ledgerTotals([paid, funded, draft]), { heldNow: 4000, captured: 2500, paypalFees: 142, platformFees: 125, paidOut: 2233 });
  });

  it("captured = PayPal fees + platform fee + paid out", () => {
    const t = ledgerTotals([paid]);
    assert.equal(t.captured, t.paypalFees + t.platformFees + t.paidOut);
  });

  it("one labelled pinned row per total", () => {
    assert.deepEqual(
      totalRows(ledgerTotals([funded])).map((r) => [r.action, r.amountCents]),
      [
        ["Held now", 4000],
        ["Captured", 0],
        ["PayPal fees", 0],
        ["Platform fees", 0],
        ["Paid out", 0],
      ],
    );
  });
});

describe("portfolio", () => {
  const base: MilestoneView = { id: "m", title: "t", state: "DRAFT", amount_cents: 1000 };
  const signed = { criteria: { criteria: [] }, criteria_hash: "h" };

  it("next action per state and role", () => {
    const cases: [Partial<MilestoneView>, string, string, boolean][] = [
      [{ state: "DRAFT" }, "client", "Draft the terms", true],
      [{ state: "DRAFT" }, "worker", "Waiting for the terms", false],
      [{ state: "DRAFT", ...signed }, "worker", "Read the terms, then sign", true],
      [{ state: "DRAFT", ...signed, client_signed_hash: "h" }, "client", "Waiting for the worker to sign", false],
      [{ state: "AGREED" }, "client", "Fund $10.00", true],
      [{ state: "AGREED" }, "worker", "Waiting for the client to fund", false],
      [{ state: "FUNDED" }, "worker", "Deliver the work", true],
      [{ state: "FUNDED" }, "client", "Waiting for the delivery", false],
      [{ state: "CHANGES_REQUESTED" }, "worker", "Fix and resubmit", true],
      [{ state: "IN_REVIEW" }, "client", "Checking the work", false],
      [{ state: "HUMAN_CHECK" }, "client", "Your decision", true],
      [{ state: "HUMAN_CHECK" }, "worker", "Waiting for the client's decision", false],
      [{ state: "PAID_OUT", payout_cents: 950 }, "worker", "You were paid $9.50", false],
      [{ state: "PAID_OUT" }, "client", "Done. The worker was paid.", false],
      [{ state: "CANCELLED" }, "client", "Cancelled", false],
    ];
    for (const [m, role, text, yours] of cases) {
      assert.deepEqual(nextAction({ ...base, ...m } as MilestoneView, role as "client" | "worker"), { text, yours }, `${m.state} as ${role}`);
    }
  });

  it("hold days left only while the hold is live", () => {
    const now = T0;
    const live = { ...base, state: "FUNDED", authorization_expires_at: new Date(now + 2.5 * 86_400_000).toISOString() };
    assert.equal(holdDaysLeft(live, now), 3);
    assert.equal(holdDaysLeft({ ...live, authorization_expires_at: new Date(now - 1000).toISOString() }, now), 0);
    assert.equal(holdDaysLeft({ ...live, state: "PAID_OUT" }, now), null);
    assert.equal(holdDaysLeft({ ...base, state: "FUNDED" }, now), null);
  });

  it("money now", () => {
    assert.deepEqual(moneyNow({ ...base, state: "FUNDED", authorized_cents: 1000 }), { word: "Held", cents: 1000, tone: "held" });
    assert.equal(moneyNow(paid).word, "Paid");
    assert.equal(moneyNow({ ...base, state: "RELEASED", captured_cents: 1000 }).word, "Captured");
    assert.equal(moneyNow(base).word, "None");
  });
});

describe("card funding", () => {
  it("one create_order claim that wrote hold:authorized is a single Hold row, not Order + Hold", async () => {
    const { buildLedgerRows } = await import("@/lib/client/ledger");
    const at = "2026-10-21T10:00:00.000Z";
    const rows = buildLedgerRows({
      role: "client",
      milestone: { id: "m1", title: "T", amount_cents: 2500, authorized_cents: 2500, state: "FUNDED" } as never,
      audit: [{ id: 1, actor: "client", event: "hold:authorized", paypal_id: "AUTH1", created_at: at }],
      actions: [{ action: "create_order", attempt: 1, status: "succeeded", paypal_id: "AUTH1", created_at: at }] as never,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.action, "Hold");
    assert.equal(rows[0]!.attempt, 1);
    assert.equal(rows[0]!.actor, "Client");
  });
});
