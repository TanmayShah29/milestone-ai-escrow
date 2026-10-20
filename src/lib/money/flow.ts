import { CheckoutPaymentIntent, OrderApplicationContextShippingPreference, type Order, type PaypalClient } from "paypal";
import type { PoolClient } from "pg";
import { db, tx } from "@/lib/db";
import { audit, getMilestone, transition, updateFields, type Actor, type Milestone } from "@/lib/milestones/repo";
import { assertTransition, type MilestoneState } from "@/lib/milestones/states";
import { PaypalFailure, classify } from "@/lib/paypal/errors";
import { paypal } from "@/lib/paypal/client";
import { createPayout, getPayout } from "@/lib/paypal/payouts";
import { centsToValue, splitCapture, valueToCents } from "./amounts";
import { claimAction, settleClaim, unknownClaims, type Claim, type MoneyAction } from "./claims";

// The only code that moves money (money rule 1). Every write follows paypal-plan.md 1b.1:
// claim → PayPal call (with the claim's PayPal-Request-Id) → record the result, and on an unknown
// outcome a re-read settles it instead of a guess.

export type Deps = { paypal: PaypalClient; fetch: typeof fetch; appUrl: string };

export function defaultDeps(): Deps {
  return { paypal: paypal(), fetch, appUrl: process.env.APP_URL ?? "http://localhost:3000" };
}

const PREFER = "return=representation"; // the SDK default "return=minimal" omits the ids we store

export class InProgress extends Error {}
export class OutcomeUnknown extends Error {}
export class InvariantViolation extends Error {}

type WriteSpec<T> = {
  action: MoneyAction;
  actor: Actor;
  /** The PayPal call. Throw PaypalFailure("unknown") if a 2xx lacks the members we depend on. */
  call: (requestId: string) => Promise<T>;
  /** Re-read PayPal after an unknown outcome. undefined = not found (still unknown). */
  reread: (claim: Claim) => Promise<T | undefined>;
  /** Store the result. Runs in a transaction with the claim being marked succeeded. */
  record: (c: PoolClient, result: T, claim: Claim) => Promise<Milestone>;
  paypalId: (result: T) => string;
};

async function runWrite<T>(m: Milestone, spec: WriteSpec<T>): Promise<Milestone> {
  const claimed = await claimAction(db(), m.id, spec.action);
  if (!claimed.won) {
    if (claimed.claim.status === "succeeded") return getMilestone(m.id);
    if (claimed.claim.status === "unknown") return settle(m, spec, claimed.claim);
    throw new InProgress(`${spec.action} is already in progress for this milestone`);
  }
  const claim = claimed.claim;
  let result: T;
  try {
    result = await spec.call(claim.request_id);
  } catch (err) {
    let f: PaypalFailure;
    try {
      f = classify(err);
    } catch {
      // Not a PayPal failure (a bug after the response, say). PayPal may have acted, so never leave
      // the claim pending: mark it unknown so a sync re-reads PayPal.
      await settleClaim(db(), claim.id, "unknown", { error: { message: String(err) } });
      throw err;
    }
    if (f.kind !== "unknown") {
      await settleClaim(db(), claim.id, "failed", { error: { message: f.message, ...f.detail } });
      await audit(db(), { milestoneId: m.id, actor: "paypal", event: `${spec.action}:refused`, paypalDebugId: f.detail.debugId ?? null, detail: f.detail });
      throw f;
    }
    await settleClaim(db(), claim.id, "unknown", { error: { message: f.message, ...f.detail } });
    await audit(db(), { milestoneId: m.id, actor: "system", event: `${spec.action}:unknown`, detail: { message: f.message } });
    return settle(m, spec, claim);
  }
  return commit(spec, result, claim);
}

async function commit<T>(spec: WriteSpec<T>, result: T, claim: Claim): Promise<Milestone> {
  return tx(async (c) => {
    await settleClaim(c, claim.id, "succeeded", { paypalId: spec.paypalId(result) });
    return spec.record(c, result, claim);
  });
}

async function settle<T>(m: Milestone, spec: WriteSpec<T>, claim: Claim): Promise<Milestone> {
  let found: T | undefined;
  try {
    found = await spec.reread(claim);
  } catch (err) {
    const f = classify(err); // rethrows anything outside the PayPal error family
    throw new OutcomeUnknown(`PayPal outcome of ${spec.action} is unknown and the re-read failed (${f.message})`, { cause: f });
  }
  if (found === undefined) throw new OutcomeUnknown(`PayPal outcome of ${spec.action} is still unknown`);
  await audit(db(), { milestoneId: m.id, actor: "system", event: `${spec.action}:settled`, paypalId: spec.paypalId(found) });
  return commit(spec, found, claim);
}

function mockHeader(mock?: string) {
  return mock ? { payPalMockResponse: JSON.stringify({ mock_application_codes: mock }) } : {};
}

function requireState(m: Milestone, ...states: MilestoneState[]) {
  if (!states.includes(m.state)) throw new InvariantViolation(`milestone is ${m.state}, expected ${states.join(" or ")}`);
}

// ---------------------------------------------------------------------------------------------
// 6. Create the hold order (intent AUTHORIZE). The client approves it at PayPal next.

type CreatedOrder = { orderId: string; approveUrl: string };

function readCreatedOrder(o: Order): CreatedOrder {
  const approveUrl = o.links?.find((l) => l.rel === "approve" || l.rel === "payer-action")?.href;
  if (!o.id || !approveUrl) throw new PaypalFailure("unknown", "createOrder returned no id or approve link");
  return { orderId: o.id, approveUrl };
}

export async function createHold(milestoneId: string, deps: Deps = defaultDeps(), opts: { mock?: string } = {}): Promise<Milestone> {
  const m = await getMilestone(milestoneId);
  requireState(m, "AGREED");
  const send = (requestId: string) =>
    deps.paypal.orders
      .createOrder({
        payPalRequestId: requestId,
        prefer: PREFER,
        ...mockHeader(opts.mock),
        body: {
          intent: CheckoutPaymentIntent.Authorize,
          purchaseUnits: [
            {
              amount: { currencyCode: "USD", value: centsToValue(m.amount_cents) },
              customId: m.id,
              description: m.title.slice(0, 127),
            },
          ],
          applicationContext: {
            returnUrl: `${deps.appUrl}/api/paypal/return?milestone=${m.id}`,
            cancelUrl: `${deps.appUrl}/milestones/${m.id}?cancelled=1`,
            shippingPreference: OrderApplicationContextShippingPreference.NoShipping,
          },
        },
      })
      .then(readCreatedOrder);
  return runWrite<CreatedOrder>(m, {
    action: "create_order",
    actor: "client",
    call: send,
    // PayPal returns the original order for a replay with the same PayPal-Request-Id.
    reread: (claim) => send(claim.request_id),
    paypalId: (r) => r.orderId,
    record: async (c, r) => {
      const out = await updateFields(c, m.id, { paypal_order_id: r.orderId, approve_url: r.approveUrl });
      await audit(c, { milestoneId: m.id, actor: "paypal", event: "order:created", paypalId: r.orderId });
      return out;
    },
  });
}

// ---------------------------------------------------------------------------------------------
// 8. Authorize after the client approved. The return URL carries ?token=<order id>.

type AuthInfo = { authorizationId: string; status: string; cents: number; expiresAt: string | null };

function readAuthorization(units: Order["purchaseUnits"]): AuthInfo | undefined {
  const a = units?.[0]?.payments?.authorizations?.[0];
  if (!a?.id || !a.amount) return undefined;
  return { authorizationId: a.id, status: a.status ?? "UNKNOWN", cents: valueToCents(a.amount.value), expiresAt: a.expirationTime ?? null };
}

export async function authorizeHold(milestoneId: string, returnedOrderId: string, deps: Deps = defaultDeps(), opts: { mock?: string } = {}): Promise<Milestone> {
  const m = await getMilestone(milestoneId);
  // Only this milestone's own order may be authorized, whatever the return URL says.
  if (!m.paypal_order_id || returnedOrderId !== m.paypal_order_id) throw new InvariantViolation("that PayPal order does not belong to this milestone");
  if (m.state === "FUNDED" && m.paypal_authorization_id) return m;
  requireState(m, "AGREED");
  assertTransition(m.state, "FUNDED");
  const orderId = m.paypal_order_id;
  return runWrite<AuthInfo>(m, {
    action: "authorize",
    actor: "client",
    call: async (requestId) => {
      // body {} makes the SDK send Content-Type: application/json; without it PayPal answers 415.
      const res = await deps.paypal.orders.authorizeOrder({ id: orderId, payPalRequestId: requestId, prefer: PREFER, ...mockHeader(opts.mock), body: {} });
      const a = readAuthorization(res.purchaseUnits);
      if (!a) throw new PaypalFailure("unknown", "authorizeOrder returned no authorization");
      if (a.status === "DENIED") throw new PaypalFailure("refused", "PayPal denied the authorization", { status: 422, reason: "Authorization denied", issue: "DENIED" });
      return a;
    },
    reread: async () => readAuthorization((await deps.paypal.orders.getOrder({ id: orderId })).purchaseUnits),
    paypalId: (a) => a.authorizationId,
    record: (c, a) =>
      transition(c, m, "FUNDED", "client", {
        paypal_authorization_id: a.authorizationId,
        authorized_cents: a.cents,
        authorization_expires_at: a.expiresAt,
      }, { paypalId: a.authorizationId, event: "hold:authorized", detail: { status: a.status, cents: a.cents } }),
  });
}

// ---------------------------------------------------------------------------------------------
// 13–14. Release: capture the hold, then pay the freelancer.

type CaptureInfo = { captureId: string; status: string; cents: number };

export async function releaseFunds(milestoneId: string, deps: Deps = defaultDeps(), opts: { mock?: string } = {}): Promise<Milestone> {
  let m = await getMilestone(milestoneId);
  if (m.state === "PASSED") {
    if (!m.paypal_authorization_id || !m.paypal_order_id || m.authorized_cents == null) throw new InvariantViolation("milestone has no hold to capture");
    const captureCents = m.amount_cents;
    // Money rule 3: never capture more than was authorized.
    if (captureCents > m.authorized_cents) throw new InvariantViolation("capture would exceed the authorized amount");
    const authorizationId = m.paypal_authorization_id;
    const orderId = m.paypal_order_id;
    const cur = m;
    m = await runWrite<CaptureInfo>(cur, {
      action: "capture",
      actor: "system",
      call: async (requestId) => {
        const c = await deps.paypal.payments.captureAuthorizedPayment({
          authorizationId,
          payPalRequestId: requestId,
          prefer: PREFER,
          ...mockHeader(opts.mock),
          body: { amount: { currencyCode: "USD", value: centsToValue(captureCents) }, finalCapture: true },
        });
        if (!c.id || !c.amount) throw new PaypalFailure("unknown", "capture returned no id or amount");
        return { captureId: c.id, status: c.status ?? "UNKNOWN", cents: valueToCents(c.amount.value) };
      },
      reread: async () => {
        const cap = (await deps.paypal.orders.getOrder({ id: orderId })).purchaseUnits?.[0]?.payments?.captures?.[0];
        return cap?.id && cap.amount ? { captureId: cap.id, status: cap.status ?? "UNKNOWN", cents: valueToCents(cap.amount.value) } : undefined;
      },
      paypalId: (c) => c.captureId,
      record: (c, cap) => {
        const { feeCents, payoutCents } = splitCapture(cap.cents);
        return transition(c, cur, "RELEASED", "system", {
          paypal_capture_id: cap.captureId,
          capture_status: cap.status,
          captured_cents: cap.cents,
          fee_cents: feeCents,
          payout_cents: payoutCents,
        }, { paypalId: cap.captureId, event: "hold:captured", detail: { status: cap.status, cents: cap.cents, feeCents, payoutCents } });
      },
    });
  }
  if (m.state === "RELEASED" && m.capture_status === "COMPLETED" && !m.paypal_payout_batch_id) {
    m = await payoutFreelancer(m, deps);
  }
  return m;
}

type PayoutInfo = { batchId: string; batchStatus: string };

async function payoutFreelancer(m: Milestone, deps: Deps): Promise<Milestone> {
  requireState(m, "RELEASED");
  if (!m.payout_cents || m.payout_cents <= 0 || m.captured_cents == null || m.payout_cents > m.captured_cents) {
    throw new InvariantViolation("payout amount is not valid for the captured amount");
  }
  const payoutCents = m.payout_cents;
  const send = (requestId: string) =>
    createPayout({ requestId, milestoneId: m.id, receiver: m.freelancer_email, value: centsToValue(payoutCents), note: `Milestone: ${m.title}`.slice(0, 4000) }, deps.fetch);
  return runWrite<PayoutInfo>(m, {
    action: "payout",
    actor: "system",
    call: send,
    reread: (claim) => send(claim.request_id), // same PayPal-Request-Id + sender_batch_id → the original batch
    paypalId: (p) => p.batchId,
    record: async (c, p) => {
      const out = await updateFields(c, m.id, { paypal_payout_batch_id: p.batchId, payout_status: p.batchStatus });
      await audit(c, { milestoneId: m.id, actor: "paypal", event: "payout:created", paypalId: p.batchId, detail: { batchStatus: p.batchStatus, cents: payoutCents } });
      return out;
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Cancel before submission: void the hold.

type VoidInfo = { authorizationId: string; status: string };

export async function cancelHold(milestoneId: string, deps: Deps = defaultDeps()): Promise<Milestone> {
  const m = await getMilestone(milestoneId);
  if (m.state === "DRAFT" || (m.state === "AGREED" && !m.paypal_authorization_id)) {
    // No hold exists yet; an unapproved order simply expires.
    return transition(db(), m, "CANCELLED", "client");
  }
  requireState(m, "FUNDED");
  if (!m.paypal_authorization_id) throw new InvariantViolation("milestone has no hold to void");
  const authorizationId = m.paypal_authorization_id;
  return runWrite<VoidInfo>(m, {
    action: "void",
    actor: "client",
    call: async (requestId) => {
      const a = await deps.paypal.payments.voidPayment({ authorizationId, payPalRequestId: requestId, prefer: PREFER });
      return { authorizationId, status: a.status ?? "VOIDED" };
    },
    reread: async () => {
      const a = await deps.paypal.payments.getAuthorizedPayment({ authorizationId });
      return a.status === "VOIDED" ? { authorizationId, status: a.status } : undefined;
    },
    paypalId: (v) => v.authorizationId,
    record: (c, v) => transition(c, m, "CANCELLED", "client", {}, { paypalId: v.authorizationId, event: "hold:voided", detail: { status: v.status } }),
  });
}

// ---------------------------------------------------------------------------------------------
// Keep a hold alive past the 3-day honor period (the daily refreshHolds job calls this).

const HOLD_STATES: MilestoneState[] = ["FUNDED", "SUBMITTED", "IN_REVIEW", "CHANGES_REQUESTED", "HUMAN_CHECK", "PASSED", "CONTESTED"];

type ReauthInfo = { authorizationId: string; expiresAt: string | null };

export async function refreshHold(milestoneId: string, deps: Deps = defaultDeps()): Promise<Milestone> {
  const m = await getMilestone(milestoneId);
  requireState(m, ...HOLD_STATES);
  if (!m.paypal_authorization_id || !m.paypal_order_id) throw new InvariantViolation("milestone has no hold to refresh");
  const authorizationId = m.paypal_authorization_id;
  const orderId = m.paypal_order_id;
  return runWrite<ReauthInfo>(m, {
    action: `reauthorize_${m.reauth_count + 1}`,
    actor: "system",
    call: async (requestId) => {
      const a = await deps.paypal.payments.reauthorizePayment({ authorizationId, payPalRequestId: requestId, prefer: PREFER, body: {} }); // {} → Content-Type (see authorize)
      if (!a.id) throw new PaypalFailure("unknown", "reauthorize returned no authorization id");
      return { authorizationId: a.id, expiresAt: a.expirationTime ?? null };
    },
    reread: async () => {
      const auths = (await deps.paypal.orders.getOrder({ id: orderId })).purchaseUnits?.[0]?.payments?.authorizations ?? [];
      const fresh = auths.filter((a) => a.id && a.id !== authorizationId).at(-1);
      return fresh?.id ? { authorizationId: fresh.id, expiresAt: fresh.expirationTime ?? null } : undefined;
    },
    paypalId: (r) => r.authorizationId,
    record: async (c, r) => {
      const out = await updateFields(c, m.id, { paypal_authorization_id: r.authorizationId, authorization_expires_at: r.expiresAt, reauth_count: m.reauth_count + 1 });
      await audit(c, { milestoneId: m.id, actor: "system", event: "hold:reauthorized", paypalId: r.authorizationId, detail: { previous: authorizationId } });
      return out;
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Sync: settle unknown outcomes, pay out once a pending capture completes, and mark PAID_OUT.
// Webhooks (build step 3) will call the same paths.

export async function syncMilestone(milestoneId: string, deps: Deps = defaultDeps()): Promise<Milestone> {
  let m = await getMilestone(milestoneId);
  for (const claim of await unknownClaims(db(), m.id)) {
    m = await resumeAction(m, claim, deps);
  }
  if (m.state === "RELEASED" && m.paypal_capture_id && m.capture_status !== "COMPLETED") {
    const cap = await deps.paypal.payments.getCapturedPayment({ captureId: m.paypal_capture_id }).catch((e) => {
      throw classify(e);
    });
    if (cap.status && cap.status !== m.capture_status) {
      m = await updateFields(db(), m.id, { capture_status: cap.status });
      await audit(db(), { milestoneId: m.id, actor: "paypal", event: "capture:status", paypalId: m.paypal_capture_id, detail: { status: cap.status } });
    }
  }
  if (m.state === "RELEASED" && m.capture_status === "COMPLETED" && !m.paypal_payout_batch_id) {
    m = await payoutFreelancer(m, deps);
  }
  if (m.state === "RELEASED" && m.paypal_payout_batch_id) {
    const p = await getPayout(m.paypal_payout_batch_id, deps.fetch);
    if (p.itemStatus === "SUCCESS") {
      m = await transition(db(), m, "PAID_OUT", "paypal", { payout_status: "SUCCESS", paypal_payout_item_id: p.itemId ?? null }, {
        paypalId: p.itemId ?? m.paypal_payout_batch_id,
        event: "payout:succeeded",
      });
    } else if ((p.itemStatus ?? p.batchStatus) !== m.payout_status) {
      m = await updateFields(db(), m.id, { payout_status: p.itemStatus ?? p.batchStatus, ...(p.itemId ? { paypal_payout_item_id: p.itemId } : {}) });
    }
  }
  return m;
}

/** Re-running the action finds its own unknown claim and settles it by re-read (see runWrite). */
function resumeAction(m: Milestone, claim: Claim, deps: Deps): Promise<Milestone> {
  if (claim.action === "create_order") return createHold(m.id, deps);
  if (claim.action === "authorize") return authorizeHold(m.id, m.paypal_order_id ?? "", deps);
  if (claim.action === "capture" || claim.action === "payout") return releaseFunds(m.id, deps);
  if (claim.action === "void") return cancelHold(m.id, deps);
  return refreshHold(m.id, deps); // reauthorize_<n>: n is unchanged until the result is recorded
}
