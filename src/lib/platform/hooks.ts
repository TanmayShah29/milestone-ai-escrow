import { z } from "zod";
import { db } from "@/lib/db";
import { InvariantViolation } from "@/lib/errors";
import type { Milestone } from "@/lib/milestones/repo";

// Policy hooks (V2_PLAN §3.J, after ERC-8183): limits a platform sets on its own milestones. They are
// static rules checked by our code, never callbacks, and they can only block: a hook never funds,
// captures or pays anything. beforeFund runs before a hold is created; beforeSettle before the capture
// and the payout (a payout to a worker outside the allowlist is stopped, and the hold stays where it is).

export const hooksSchema = z.object({
  maxAmountCents: z.number().int().min(1_000).max(1_000_000).optional(),
  allowedRepos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).max(50).optional(),
  workerEmailDomains: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i)).max(50).optional(),
});
export type Hooks = z.infer<typeof hooksSchema>;

async function hooksOf(m: Pick<Milestone, "platform_id">): Promise<{ name: string; hooks: Hooks } | undefined> {
  if (!m.platform_id) return undefined;
  const { rows } = await db().query<{ name: string; hooks: unknown }>("select name, hooks from platforms where id = $1", [m.platform_id]);
  const parsed = hooksSchema.safeParse(rows[0]?.hooks ?? {});
  return rows[0] && parsed.success ? { name: rows[0].name, hooks: parsed.data } : undefined;
}

const domainOf = (email: string) => email.split("@").pop()!.toLowerCase();

/** Why the platform's own rules block this step, or undefined. */
export function hookProblem(m: Pick<Milestone, "amount_cents" | "repo" | "freelancer_email">, hooks: Hooks, stage: "beforeFund" | "beforeSettle"): string | undefined {
  if (stage === "beforeFund") {
    if (hooks.maxAmountCents !== undefined && m.amount_cents > hooks.maxAmountCents) return `the amount is over its limit of $${(hooks.maxAmountCents / 100).toFixed(2)}`;
    if (hooks.allowedRepos && !hooks.allowedRepos.some((r) => r.toLowerCase() === (m.repo ?? "").toLowerCase())) return `${m.repo ?? "this repository"} isn't on its list of repositories`;
  }
  if (hooks.workerEmailDomains && !hooks.workerEmailDomains.map((d) => d.toLowerCase()).includes(domainOf(m.freelancer_email))) return "the worker's PayPal email isn't on its allowlist";
  return undefined;
}

export async function checkHooks(m: Milestone, stage: "beforeFund" | "beforeSettle"): Promise<void> {
  const p = await hooksOf(m);
  if (!p) return;
  const problem = hookProblem(m, p.hooks, stage);
  if (problem) throw new InvariantViolation(`${p.name}'s policy blocks this: ${problem}.`);
}
