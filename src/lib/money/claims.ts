import { isUniqueViolation, type Queryable } from "@/lib/db";

// The claim for a money-moving write (paypal-plan.md 1b.1, DUPLICATE CLAIMS). Inserted before the
// PayPal call; `money_actions_live_uq` rejects a second live claim for the same (milestone, action).

export type MoneyAction = "create_order" | "authorize" | "capture" | "void" | "payout" | `reauthorize_${number}`;

export type ClaimStatus = "pending" | "succeeded" | "failed" | "unknown";

export type Claim = {
  id: string;
  milestone_id: string;
  action: MoneyAction;
  attempt: number;
  request_id: string;
  status: ClaimStatus;
  paypal_id: string | null;
};

/** Money rule 2: the PayPal-Request-Id is derived from the milestone id, the action and the attempt. */
export function requestIdFor(milestoneId: string, action: MoneyAction, attempt: number): string {
  return `ms_${milestoneId}_${action}_${attempt}`;
}

export type ClaimResult = { won: true; claim: Claim } | { won: false; claim: Claim };

export async function claimAction(q: Queryable, milestoneId: string, action: MoneyAction): Promise<ClaimResult> {
  const { rows: prior } = await q.query<{ n: string }>(
    "select count(*) as n from money_actions where milestone_id = $1 and action = $2 and status = 'failed'",
    [milestoneId, action],
  );
  const attempt = Number(prior[0]!.n) + 1;
  try {
    const { rows } = await q.query<Claim>(
      `insert into money_actions (milestone_id, action, attempt, request_id, status)
       values ($1, $2, $3, $4, 'pending') returning *`,
      [milestoneId, action, attempt, requestIdFor(milestoneId, action, attempt)],
    );
    return { won: true, claim: rows[0]! };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const live = await liveClaim(q, milestoneId, action);
    if (!live) throw err; // lost to a claim that was released in between; caller can retry
    return { won: false, claim: live };
  }
}

export async function liveClaim(q: Queryable, milestoneId: string, action: MoneyAction): Promise<Claim | undefined> {
  const { rows } = await q.query<Claim>(
    "select * from money_actions where milestone_id = $1 and action = $2 and status in ('pending','succeeded','unknown')",
    [milestoneId, action],
  );
  return rows[0];
}

export async function unknownClaims(q: Queryable, milestoneId: string): Promise<Claim[]> {
  const { rows } = await q.query<Claim>(
    "select * from money_actions where milestone_id = $1 and status = 'unknown' order by id",
    [milestoneId],
  );
  return rows;
}

export async function settleClaim(
  q: Queryable,
  claimId: string,
  status: Exclude<ClaimStatus, "pending">,
  extra: { paypalId?: string | null; error?: unknown } = {},
): Promise<void> {
  await q.query("update money_actions set status = $2, paypal_id = coalesce($3, paypal_id), error = $4, updated_at = now() where id = $1", [
    claimId,
    status,
    extra.paypalId ?? null,
    extra.error === undefined ? null : JSON.stringify(extra.error),
  ]);
}
