import { CheckoutPaymentIntent, OrderApplicationContextShippingPreference } from "paypal";
import type { PoolClient } from "pg";
import { db } from "@/lib/db";
import { InvariantViolation } from "@/lib/errors";
import { audit, getMilestone, type Milestone } from "@/lib/milestones/repo";
import { centsToValue, estimatePaypalFee, splitCapture, valueToCents } from "@/lib/money/amounts";
import { mockHeader, NOT_DONE, paypalFeeOf, PREFER, readAuthorization, readCreatedOrder, runWrite, sandboxTestCard, type AuthInfo, type CreatedOrder, type Deps } from "@/lib/money/flow";
import { PaypalFailure } from "@/lib/paypal/errors";
import { createPayout } from "@/lib/paypal/payouts";

// Fee holds (V2_PLAN §3.G): each side that takes a decision to the arbitrator funds a small PayPal
// authorization. When the award is signed, the side it goes against is captured and that money is paid out
// to the arbitrator; the other side's hold is voided. Every call runs under its own claim and
// PayPal-Request-Id (money rules 2 and 4, flow.ts runWrite), and the AI never reaches any of them.

export type Side = "client" | "worker";

/** The audit log's name for a side. */
export const actorOf = (role: Side) => (role === "worker" ? "freelancer" : "client");

export type FeeHold = {
  role: Side;
  order_id: string | null;
  approve_url: string | null;
  authorization_id: string | null;
  authorized_cents: number | null;
  status: "open" | "authorized" | "captured" | "voided";
  capture_id: string | null;
  captured_cents: number | null;
  payout_batch_id: string | null;
  payout_cents: number | null;
};

export async function feeHolds(milestoneId: string): Promise<FeeHold[]> {
  const { rows } = await db().query<FeeHold>("select role, order_id, approve_url, authorization_id, authorized_cents, status, capture_id, captured_cents, payout_batch_id, payout_cents from fee_holds where milestone_id = $1 order by role", [milestoneId]);
  return rows;
}

export async function feeHold(milestoneId: string, role: Side): Promise<FeeHold | undefined> {
  return (await feeHolds(milestoneId)).find((f) => f.role === role);
}

async function reread(c: PoolClient, id: string): Promise<Milestone> {
  return getMilestone(id, c);
}

const unit = (m: Milestone, role: Side, cents: number) => ({
  amount: { currencyCode: "USD", value: centsToValue(cents) },
  customId: `fee:${role}:${m.id}`,
  description: `Arbitration fee for "${m.title.slice(0, 80)}" (${role})`,
});

/** An order the side approves at PayPal, like the milestone's own hold. Reused while it is open. */
export async function createFeeOrder(m: Milestone, role: Side, cents: number, deps: Deps, opts: { mock?: string } = {}): Promise<FeeHold> {
  const have = await feeHold(m.id, role);
  if (have) return have;
  const send = (requestId: string) =>
    deps.paypal.orders
      .createOrder({
        payPalRequestId: requestId,
        prefer: PREFER,
        ...mockHeader(opts.mock),
        body: {
          intent: CheckoutPaymentIntent.Authorize,
          purchaseUnits: [unit(m, role, cents)],
          applicationContext: {
            returnUrl: `${deps.appUrl}/api/paypal/return?milestone=${m.id}&fee=${role}`,
            cancelUrl: `${deps.appUrl}/milestones/${m.id}/court?cancelled=1`,
            shippingPreference: OrderApplicationContextShippingPreference.NoShipping,
          },
        },
      })
      .then(readCreatedOrder);
  await runWrite<CreatedOrder>(m, {
    action: `fee_order_${role}`,
    actor: actorOf(role),
    call: send,
    reread: (claim) => send(claim.request_id), // the same PayPal-Request-Id returns the same order
    paypalId: (r) => r.orderId,
    record: async (c, r) => {
      await c.query("insert into fee_holds (milestone_id, role, order_id, approve_url) values ($1, $2, $3, $4) on conflict (milestone_id, role) do nothing", [m.id, role, r.orderId, r.approveUrl]);
      await audit(c, { milestoneId: m.id, actor: "paypal", event: "fee:order_created", paypalId: r.orderId, detail: { role, cents } });
      return reread(c, m.id);
    },
  });
  return (await feeHold(m.id, role))!;
}

/** Sandbox only: fund the fee hold with PayPal's test card, with no PayPal login (the judge path). */
export async function fundFeeWithTestCard(m: Milestone, role: Side, cents: number, deps: Deps, opts: { mock?: string } = {}): Promise<FeeHold> {
  const have = await feeHold(m.id, role);
  if (have?.status === "authorized") return have;
  if (have) throw new InvariantViolation("A PayPal checkout for this fee is already open. Finish it at PayPal.");
  const send = async (requestId: string): Promise<{ orderId: string; auth: AuthInfo }> => {
    const o = await deps.paypal.orders.createOrder({
      payPalRequestId: requestId,
      prefer: PREFER,
      ...mockHeader(opts.mock),
      body: { intent: CheckoutPaymentIntent.Authorize, purchaseUnits: [unit(m, role, cents)], paymentSource: { card: sandboxTestCard(requestId) } },
    });
    const auth = readAuthorization(o.purchaseUnits);
    if (!o.id || !auth) throw new PaypalFailure("unknown", "card order returned no authorization");
    if (auth.status === "DENIED") throw new PaypalFailure("refused", "the card was declined", { status: 422, reason: "Card declined", issue: "DENIED" });
    return { orderId: o.id, auth };
  };
  await runWrite(m, {
    action: `fee_order_${role}`,
    actor: actorOf(role),
    call: send,
    reread: (claim) => send(claim.request_id),
    paypalId: (r) => r.auth.authorizationId,
    record: async (c, r) => {
      await c.query(
        `insert into fee_holds (milestone_id, role, order_id, authorization_id, authorized_cents, status) values ($1, $2, $3, $4, $5, 'authorized')
         on conflict (milestone_id, role) do nothing`,
        [m.id, role, r.orderId, r.auth.authorizationId, r.auth.cents],
      );
      await audit(c, { milestoneId: m.id, actor: "paypal", event: "fee:authorized", paypalId: r.auth.authorizationId, detail: { role, cents: r.auth.cents, method: "sandbox_test_card" } });
      return reread(c, m.id);
    },
  });
  return (await feeHold(m.id, role))!;
}

/** After the side approved the fee order at PayPal (the return URL carries the order id). */
export async function authorizeFee(m: Milestone, role: Side, orderId: string, deps: Deps): Promise<FeeHold> {
  const f = await feeHold(m.id, role);
  if (!f?.order_id || f.order_id !== orderId) throw new InvariantViolation("That PayPal order isn't this side's arbitration fee.");
  if (f.status !== "open") return f;
  await runWrite<AuthInfo>(m, {
    action: `fee_authorize_${role}`,
    actor: actorOf(role),
    call: async (requestId) => {
      const res = await deps.paypal.orders.authorizeOrder({ id: orderId, payPalRequestId: requestId, prefer: PREFER, body: {} });
      const a = readAuthorization(res.purchaseUnits);
      if (!a) throw new PaypalFailure("unknown", "authorizeOrder returned no authorization");
      if (a.status === "DENIED") throw new PaypalFailure("refused", "PayPal denied the authorization", { status: 422, reason: "Authorization denied", issue: "DENIED" });
      return a;
    },
    reread: async () => {
      const o = await deps.paypal.orders.getOrder({ id: orderId });
      const a = readAuthorization(o.purchaseUnits);
      if (a) return a;
      return o.status === "APPROVED" ? NOT_DONE : undefined;
    },
    paypalId: (a) => a.authorizationId,
    record: async (c, a) => {
      await c.query("update fee_holds set authorization_id = $3, authorized_cents = $4, status = 'authorized', updated_at = now() where milestone_id = $1 and role = $2", [m.id, role, a.authorizationId, a.cents]);
      await audit(c, { milestoneId: m.id, actor: "paypal", event: "fee:authorized", paypalId: a.authorizationId, detail: { role, cents: a.cents } });
      return reread(c, m.id);
    },
  });
  return (await feeHold(m.id, role))!;
}

/** The side the award went against: capture its whole fee hold. */
export async function captureFee(m: Milestone, role: Side, deps: Deps): Promise<FeeHold> {
  const f = await feeHold(m.id, role);
  if (!f || f.status === "captured") return f!;
  if (f.status !== "authorized" || !f.authorization_id || f.authorized_cents == null) throw new InvariantViolation(`The ${role}'s arbitration fee isn't held, so it can't be captured.`);
  const authorizationId = f.authorization_id;
  const orderId = f.order_id;
  const cents = f.authorized_cents; // money rule 3: never more than authorized
  await runWrite<{ captureId: string; cents: number; paypalFeeCents: number | null }>(m, {
    action: `fee_capture_${role}`,
    actor: "system",
    call: async (requestId) => {
      const c = await deps.paypal.payments.captureAuthorizedPayment({ authorizationId, payPalRequestId: requestId, prefer: PREFER, body: { amount: { currencyCode: "USD", value: centsToValue(cents) }, finalCapture: true } });
      if (!c.id || !c.amount) throw new PaypalFailure("unknown", "capture returned no id or amount");
      return { captureId: c.id, cents: valueToCents(c.amount.value), paypalFeeCents: paypalFeeOf(c.sellerReceivableBreakdown) };
    },
    reread: async () => {
      if (orderId) {
        const cap = (await deps.paypal.orders.getOrder({ id: orderId })).purchaseUnits?.[0]?.payments?.captures?.[0];
        if (cap?.id && cap.amount) return { captureId: cap.id, cents: valueToCents(cap.amount.value), paypalFeeCents: paypalFeeOf(cap.sellerReceivableBreakdown) };
      }
      const a = await deps.paypal.payments.getAuthorizedPayment({ authorizationId });
      return a.status === "CREATED" ? NOT_DONE : undefined;
    },
    paypalId: (r) => r.captureId,
    record: async (c, r) => {
      const payout = splitCapture(r.cents, r.paypalFeeCents ?? estimatePaypalFee(r.cents), { platformBps: 0, payoutBps: 200, payoutCapCents: 100 }).payoutCents;
      await c.query("update fee_holds set capture_id = $3, captured_cents = $4, payout_cents = $5, status = 'captured', updated_at = now() where milestone_id = $1 and role = $2", [m.id, role, r.captureId, r.cents, payout]);
      await audit(c, { milestoneId: m.id, actor: "paypal", event: "fee:captured", paypalId: r.captureId, detail: { role, cents: r.cents, payoutCents: payout } });
      return reread(c, m.id);
    },
  });
  return (await feeHold(m.id, role))!;
}

/** The side the award went for, or every side when the earlier decision stands: give the hold back. */
export async function voidFee(m: Milestone, role: Side, deps: Deps): Promise<FeeHold | undefined> {
  const f = await feeHold(m.id, role);
  if (!f || f.status === "voided" || f.status === "captured") return f;
  if (f.status === "open" || !f.authorization_id) {
    // Never approved: nothing is held, and the unapproved order lapses on its own.
    await db().query("update fee_holds set status = 'voided', updated_at = now() where milestone_id = $1 and role = $2", [m.id, role]);
    await audit(db(), { milestoneId: m.id, actor: "system", event: "fee:abandoned", paypalId: f.order_id, detail: { role } });
    return feeHold(m.id, role);
  }
  const authorizationId = f.authorization_id;
  await runWrite<{ authorizationId: string }>(m, {
    action: `fee_void_${role}`,
    actor: "system",
    call: async (requestId) => {
      await deps.paypal.payments.voidPayment({ authorizationId, payPalRequestId: requestId, prefer: PREFER });
      return { authorizationId };
    },
    reread: async () => {
      const a = await deps.paypal.payments.getAuthorizedPayment({ authorizationId });
      if (a.status === "VOIDED") return { authorizationId };
      return a.status === "CREATED" ? NOT_DONE : undefined;
    },
    paypalId: (v) => v.authorizationId,
    record: async (c) => {
      await c.query("update fee_holds set status = 'voided', updated_at = now() where milestone_id = $1 and role = $2", [m.id, role]);
      await audit(c, { milestoneId: m.id, actor: "paypal", event: "fee:voided", paypalId: authorizationId, detail: { role } });
      return reread(c, m.id);
    },
  });
  return feeHold(m.id, role);
}

/** Pay the captured fee to the arbitrator, less PayPal's fees (never more than was captured). */
export async function payArbitrator(m: Milestone, role: Side, receiver: string, deps: Deps): Promise<FeeHold> {
  const f = await feeHold(m.id, role);
  if (!f || f.payout_batch_id) return f!;
  if (f.status !== "captured" || f.payout_cents == null || f.captured_cents == null || f.payout_cents <= 0 || f.payout_cents > f.captured_cents) {
    throw new InvariantViolation("The arbitration fee payout doesn't match what was captured, so it was stopped.");
  }
  const cents = f.payout_cents;
  const send = (requestId: string) => createPayout({ requestId, milestoneId: m.id, receiver, value: centsToValue(cents), note: `Arbitration fee: ${m.title}`.slice(0, 4000) }, deps.fetch);
  await runWrite(m, {
    action: "fee_payout",
    actor: "system",
    call: send,
    reread: (claim) => send(claim.request_id),
    paypalId: (p) => p.batchId,
    record: async (c, p) => {
      await c.query("update fee_holds set payout_batch_id = $3, updated_at = now() where milestone_id = $1 and role = $2", [m.id, role, p.batchId]);
      await audit(c, { milestoneId: m.id, actor: "paypal", event: "fee:paid_to_arbitrator", paypalId: p.batchId, detail: { role, cents } });
      return reread(c, m.id);
    },
  });
  return (await feeHold(m.id, role))!;
}
