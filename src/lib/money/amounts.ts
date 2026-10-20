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

export function feeBps(): number {
  const raw = process.env.PLATFORM_FEE_BPS ?? "500";
  const bps = Number(raw);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error(`invalid PLATFORM_FEE_BPS: ${raw}`);
  return bps;
}

/** Payout = captured amount minus the platform fee (money rule 3). */
export function splitCapture(capturedCents: number, bps = feeBps()): { feeCents: number; payoutCents: number } {
  const feeCents = Math.round((capturedCents * bps) / 10_000);
  return { feeCents, payoutCents: capturedCents - feeCents };
}
