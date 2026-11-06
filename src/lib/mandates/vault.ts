import { CheckoutPaymentIntent, PaymentInitiator, StoredPaymentSourcePaymentType, StoredPaymentSourceUsageType, VaultTokenRequestType } from "paypal";
import { db } from "@/lib/db";
import { InvariantViolation, OutcomeUnknown } from "@/lib/errors";
import { getMilestone, transition, type Milestone } from "@/lib/milestones/repo";
import { centsToValue } from "@/lib/money/amounts";
import { mockHeader, PREFER, readAuthorization, runWrite, sandboxTestCard, type AuthInfo, type Deps } from "@/lib/money/flow";
import { PaypalFailure, classify } from "@/lib/paypal/errors";
import type { Mandate } from "./mandate";

// The PayPal side of a mandate (paypal-plan.md, "v2 Phase 8"): vault the sandbox test card once
// (setup token → payment token), and fund a bounty's hold from it as a merchant-initiated charge with no
// buyer present [VERIFIED H3, Nov 5]. Only fixed code calls these, and only after mandate.ts checkLimits.

type Vaulted = { vaultId: string; last4: string | null };

/** Vault the card for a mandate: claimed on the mandate row, replayed with the same request ids if unknown. */
export async function vaultCard(mandateId: string, deps: Deps): Promise<{ vaultId: string; last4: string | null }> {
  // Claim (DUPLICATE CLAIMS): only one caller moves none → pending.
  const won = await db().query("update mandates set vault_status = 'pending', updated_at = now() where id = $1 and vault_status = 'none' and status = 'draft'", [mandateId]);
  const { rows } = await db().query<Pick<Mandate, "vault_status" | "vault_attempt" | "vault_id" | "card_last4" | "status">>("select vault_status, vault_attempt, vault_id, card_last4, status from mandates where id = $1", [mandateId]);
  const row = rows[0];
  if (!row) throw new InvariantViolation("No such mandate.");
  if (row.vault_status === "done") return { vaultId: row.vault_id!, last4: row.card_last4 };
  if (row.status !== "draft") throw new InvariantViolation("The card can only be added before the mandate is signed.");
  // A pending claim we didn't win (a call in flight, or one left unknown) is replayed with the same request
  // ids, which PayPal answers with the same tokens rather than vaulting twice.
  void won;

  const ids = { setup: `md_${mandateId}_setup_${row.vault_attempt}`, ptoken: `md_${mandateId}_ptoken_${row.vault_attempt}` };
  let out: Vaulted;
  try {
    const card = sandboxTestCard(`_${row.vault_attempt}`);
    const st = await deps.paypal.vault.createSetupToken({ payPalRequestId: ids.setup, body: { paymentSource: { card } } });
    if (!st.id) throw new PaypalFailure("unknown", "createSetupToken returned no id");
    const pt = await deps.paypal.vault.createPaymentToken({ payPalRequestId: ids.ptoken, body: { paymentSource: { token: { id: st.id, type: VaultTokenRequestType.SetupToken } } } });
    if (!pt.id) throw new PaypalFailure("unknown", "createPaymentToken returned no id");
    out = { vaultId: pt.id, last4: pt.paymentSource?.card?.lastDigits ?? null };
  } catch (err) {
    const f = classify(err);
    if (f.kind === "unknown") {
      // PayPal may have vaulted it: keep the claim; the next call replays the same request ids.
      throw new OutcomeUnknown(`PayPal didn't confirm the card was saved (${f.message}). Try again: the same request is replayed, not repeated.`, { cause: f });
    }
    // Refused or never sent: release the claim, and the next attempt gets fresh request ids.
    await db().query("update mandates set vault_status = 'none', vault_attempt = vault_attempt + 1, updated_at = now() where id = $1", [mandateId]);
    throw f;
  }
  await db().query("update mandates set vault_status = 'done', vault_id = $2, card_last4 = $3, updated_at = now() where id = $1", [mandateId, out.vaultId, out.last4]);
  return out;
}

/**
 * Fund an open bounty's hold from the mandate's vaulted card: an AUTHORIZE order with
 * payment_source.card.vault_id and a merchant-initiated stored credential, under the milestone's own
 * create_order claim (flow.ts runWrite). The milestone stays OFFERED: it is funded, and waits for a worker.
 */
export async function fundFromMandate(m: Milestone, mandate: Pick<Mandate, "id" | "vault_id">, deps: Deps, opts: { mock?: string } = {}): Promise<Milestone> {
  if (m.state !== "DRAFT" || !m.open_bounty || m.mandate_id !== mandate.id) throw new InvariantViolation("Only a bounty this mandate posted can be funded from it.");
  if (!mandate.vault_id) throw new InvariantViolation("This mandate has no saved card.");
  const vaultId = mandate.vault_id;
  const send = async (requestId: string): Promise<{ orderId: string; auth: AuthInfo }> => {
    const o = await deps.paypal.orders.createOrder({
      payPalRequestId: requestId,
      prefer: PREFER,
      ...mockHeader(opts.mock),
      body: {
        intent: CheckoutPaymentIntent.Authorize,
        purchaseUnits: [{ amount: { currencyCode: "USD", value: centsToValue(m.amount_cents) }, customId: m.id, description: `${m.title.slice(0, 100)} · terms ${m.criteria_hash!.slice(0, 12)}` }],
        paymentSource: {
          card: {
            vaultId,
            storedCredential: { paymentInitiator: PaymentInitiator.Merchant, paymentType: StoredPaymentSourcePaymentType.Unscheduled, usage: StoredPaymentSourceUsageType.Subsequent },
          },
        },
      },
    });
    const auth = readAuthorization(o.purchaseUnits);
    if (!o.id || !auth) throw new PaypalFailure("unknown", "vault order returned no authorization");
    if (auth.status === "DENIED") throw new PaypalFailure("refused", "the saved card was declined", { status: 422, reason: "Card declined", issue: "DENIED" });
    return { orderId: o.id, auth };
  };
  await runWrite(m, {
    action: "create_order",
    actor: "system",
    call: send,
    reread: (claim) => send(claim.request_id), // the same PayPal-Request-Id returns the same order, not a second hold
    paypalId: (r) => r.auth.authorizationId,
    record: (c, r) =>
      transition(c, m, "OFFERED", "system", {
        paypal_order_id: r.orderId,
        paypal_authorization_id: r.auth.authorizationId,
        authorized_cents: r.auth.cents,
        authorization_expires_at: r.auth.expiresAt,
      }, { paypalId: r.auth.authorizationId, event: "hold:authorized", detail: { method: "mandate", mandateId: mandate.id, status: r.auth.status, cents: r.auth.cents } }),
  });
  return getMilestone(m.id);
}
