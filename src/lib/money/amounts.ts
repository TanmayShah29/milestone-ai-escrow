// Integer cents in our DB, decimal strings at PayPal (money rule 7). USD only.

export function centsToValue(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`invalid cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function valueToCents(value: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) throw new Error(`invalid amount: ${value}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

function envInt(name: string, fallback: string, max: number): number {
  const raw = process.env[name] ?? fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`invalid ${name}: ${raw}`);
  return n;
}

/** Platform fee in basis points of the captured amount (500 = 5%). */
export function feeBps(): number {
  return envInt("PLATFORM_FEE_BPS", "500", 10_000);
}

/** Payout fee estimate in basis points (PayPal US Payouts: 2%, PayPal_Sandbox_Guide.md [DOCS]). */
export function payoutFeeBps(): number {
  return envInt("PAYOUT_FEE_BPS", "200", 10_000);
}

/** Cap on the payout fee estimate, in cents (PayPal US Payouts: $1.00 [DOCS]). Empty = no cap. */
export function payoutFeeCapCents(): number | null {
  if (process.env.PAYOUT_FEE_CAP_CENTS === "") return null;
  return envInt("PAYOUT_FEE_CAP_CENTS", "100", 100_000_000);
}

// PayPal's US checkout rate (3.49% + $0.49), used when a capture doesn't report its fee [DOCS].
export const CHECKOUT_FEE_BPS = 349;
export const CHECKOUT_FEE_FIXED_CENTS = 49;

export function estimatePaypalFee(amountCents: number): number {
  return Math.round((amountCents * CHECKOUT_FEE_BPS) / 10_000) + CHECKOUT_FEE_FIXED_CENTS;
}

export type FeeSchedule = { platformBps: number; payoutBps: number; payoutCapCents: number | null };

export function feeSchedule(): FeeSchedule {
  return { platformBps: feeBps(), payoutBps: payoutFeeBps(), payoutCapCents: payoutFeeCapCents() };
}

/**
 * The platform fee both sides signed: terms saved since the contract policy existed carry
 * policy.platformFeeBps in the hashed document (contract/terms.ts policySchema). A pure read of the
 * stored criteria document, so it works in the browser too. undefined for older contracts.
 */
export function signedPlatformBps(criteria: unknown): number | undefined {
  const bps = (criteria as { policy?: { platformFeeBps?: unknown } } | null | undefined)?.policy?.platformFeeBps;
  return typeof bps === "number" && Number.isInteger(bps) && bps >= 0 && bps <= 10_000 ? bps : undefined;
}

/** The schedule for one milestone: the signed platform fee when there is one, the env otherwise. */
export function scheduleFor(criteria: unknown, base: FeeSchedule = feeSchedule()): FeeSchedule {
  const signed = signedPlatformBps(criteria);
  return signed == null ? base : { ...base, platformBps: signed };
}

/** The env defaults, for browser code where server env isn't available. */
export const DEFAULT_FEE_SCHEDULE: FeeSchedule = { platformBps: 500, payoutBps: 200, payoutCapCents: 100 };

export type Split = { paypalFeeCents: number; payoutFeeCents: number; feeCents: number; payoutCents: number };

/**
 * Worker receives captured − PayPal fee − payout fee − platform fee (money rule 3: never more than
 * captured, never negative). The platform fee is on the captured amount; the payout fee is on what is
 * left after the PayPal and platform fees, capped. Integer cents throughout; fees that would exceed
 * what is left are cut so the parts always add up to the captured amount.
 */
export function splitCapture(capturedCents: number, paypalFeeCents: number, s: FeeSchedule = feeSchedule()): Split {
  if (!Number.isSafeInteger(capturedCents) || capturedCents < 0) throw new Error(`invalid cents: ${capturedCents}`);
  if (!Number.isSafeInteger(paypalFeeCents) || paypalFeeCents < 0) throw new Error(`invalid PayPal fee: ${paypalFeeCents}`);
  let left = capturedCents;
  const take = (want: number) => {
    const got = Math.min(Math.max(want, 0), left);
    left -= got;
    return got;
  };
  const paypal = take(paypalFeeCents);
  const fee = take(Math.round((capturedCents * s.platformBps) / 10_000));
  const payoutWant = Math.round((left * s.payoutBps) / 10_000);
  const payoutFee = take(s.payoutCapCents == null ? payoutWant : Math.min(payoutWant, s.payoutCapCents));
  return { paypalFeeCents: paypal, payoutFeeCents: payoutFee, feeCents: fee, payoutCents: left };
}

/** Before funding: what the worker receives about, with the PayPal fee estimated. Pure. */
export function estimateSplit(amountCents: number, s: FeeSchedule = DEFAULT_FEE_SCHEDULE): Split {
  return splitCapture(amountCents, estimatePaypalFee(amountCents), s);
}

/** Smallest milestone: below this the fees eat most of the payment. */
export const MIN_AMOUNT_CENTS = 1_000;
