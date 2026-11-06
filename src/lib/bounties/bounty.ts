import { createHash } from "node:crypto";
import { hashToken, newToken } from "@/lib/auth";
import { contractDocument, editTerms, signBlocker, termsSchema } from "@/lib/contract/terms";
import { validLogin } from "@/lib/contract/signatures";
import { db, withMilestoneLock } from "@/lib/db";
import { InvariantViolation } from "@/lib/errors";
import { checkLimits, type Mandate } from "@/lib/mandates/mandate";
import { fundFromMandate } from "@/lib/mandates/vault";
import { audit, createMilestone, getMilestone, transition, type Milestone } from "@/lib/milestones/repo";
import { valueToCents } from "@/lib/money/amounts";
import { cancelHold, defaultDeps, type Deps } from "@/lib/money/flow";
import { canonical, importVerifyKey, termsStatement, verifySig } from "@/lib/proof/verify";
import { latestDueAt } from "@/lib/timeline";

// Open bounties (V2_PLAN §3.I). An agent holding a mandate posts one: the terms are saved and checked like any
// client's, the mandate stands in for the client's signature (it is what the person signed), and the hold is
// funded from the mandate's card. Anyone, human or agent, can then claim it with a GitHub login, a PayPal
// email and a signature on the terms: the first valid claim takes it into the normal flow (FUNDED). A claim
// with no pull request submitted in time lapses back to OFFERED; a bounty nobody delivers is voided.

/** Where an unclaimed bounty's payout would go: nowhere. A claim replaces it before any work can pass. */
export const UNCLAIMED_EMAIL = "unclaimed@bounty.invalid";
export const CLAIM_DAYS = 3;
const DAY = 86_400_000;

export type BountyInput = { title?: unknown; brief?: unknown; amount?: unknown; repo?: unknown; criteria?: unknown; testCommand?: unknown; dueDate?: unknown };

/** Post and fund a bounty within the mandate. Every limit is checked before anything is created or sent. */
export async function postBounty(mandate: Mandate, input: BountyInput, deps: Deps = defaultDeps()): Promise<Milestone> {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title || title.length > 200) throw new InvariantViolation("Give the bounty a title (200 characters at most).");
  const repo = typeof input.repo === "string" ? input.repo.trim() : "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new InvariantViolation("Name the repository as owner/name.");
  let amountCents: number;
  try {
    amountCents = valueToCents(String(input.amount ?? ""));
  } catch {
    throw new InvariantViolation("Enter the amount in dollars, like 50.00.");
  }
  const dueAt = typeof input.dueDate === "string" && input.dueDate ? new Date(input.dueDate) : new Date(Date.now() + 14 * DAY);
  if (Number.isNaN(dueAt.getTime()) || dueAt.getTime() < Date.now() + DAY) throw new InvariantViolation("Pick a due date at least a day away.");
  if (dueAt.getTime() > latestDueAt({ created_at: new Date(), authorization_expires_at: null }).getTime()) throw new InvariantViolation("The due date must fall inside the PayPal hold's 29 days.");

  // One mandate's posts run one at a time, so two can't both fit under the same remaining budget.
  return withMilestoneLock(`mandate:${mandate.id}`, async () => {
    await checkLimits(mandate, { amountCents, repo, verifier: "code_pr" });
    const { milestone } = await createMilestone({ title, brief: typeof input.brief === "string" ? input.brief.slice(0, 5000) : "", amountCents, freelancerEmail: UNCLAIMED_EMAIL, verifier: "code_pr", dueAt });
    await db().query("update milestones set mandate_id = $2, open_bounty = true where id = $1", [milestone.id, mandate.id]);
    try {
      // The terms go through the same checks a client's do (client-written tests get the static check).
      const m = await editTerms(milestone.id, { criteria: input.criteria, ...(typeof input.testCommand === "string" ? { testCommand: input.testCommand } : {}) }, { repo });
      const blocked = signBlocker(termsSchema.parse(m.criteria));
      if (blocked) throw new InvariantViolation(blocked.charAt(0).toUpperCase() + blocked.slice(1));
      // The mandate stands in for the client's signature: what the person signed with a passkey is the
      // mandate, and checkLimits just found these terms inside it.
      const signed = await db().query<Milestone>("update milestones set client_signed_hash = criteria_hash, client_signed_at = now() where id = $1 returning *", [m.id]);
      await audit(db(), { milestoneId: m.id, actor: "client", event: "terms:signed", detail: { hash: m.criteria_hash, role: "client", method: "mandate", mandateId: mandate.id, mandateHash: mandate.document_hash } });
      return await fundFromMandate(signed.rows[0]!, mandate, deps);
    } catch (err) {
      // Nothing half-made counts against the budget: a bounty that couldn't be saved or funded is cancelled.
      const m = await getMilestone(milestone.id);
      if (m.state === "DRAFT") await transition(db(), m, "CANCELLED", "system", {}, { event: "bounty:abandoned", detail: { reason: String((err as Error).message).slice(0, 200) } });
      throw err;
    }
  });
}

/** The open bounties anyone can claim, with the terms they would sign (no personal data in them). */
export async function listBounties() {
  const { rows } = await db().query<Milestone & { mandate_name: string }>(
    `select m.*, d.name as mandate_name from milestones m join mandates d on d.id = m.mandate_id
     where m.state = 'OFFERED' order by m.created_at desc limit 50`,
  );
  return rows.map((m) => ({
    id: m.id,
    title: m.title,
    brief: m.brief,
    amountCents: m.amount_cents,
    repo: m.repo,
    dueAt: m.due_at,
    postedBy: m.mandate_name,
    termsHash: m.criteria_hash,
    document: canonical(contractDocument(m, termsSchema.parse(m.criteria))),
  }));
}

export type ClaimInput = { githubLogin?: unknown; paypalEmail?: unknown; hash?: unknown; agent?: unknown };

/**
 * Claim an open bounty: sign its terms (optionally with an agent's own ES256 key) as the GitHub account the
 * pull request will come from, and name the PayPal email the payout goes to. The first valid claim takes it.
 * Returns the worker's link token, once.
 */
export async function claimBounty(milestoneId: string, input: ClaimInput): Promise<{ milestone: Milestone; workerToken: string }> {
  return withMilestoneLock(milestoneId, async () => {
    const m = await getMilestone(milestoneId);
    if (m.state !== "OFFERED" || !m.open_bounty) throw new InvariantViolation("This bounty isn't open to claim right now.");
    const login = validLogin(typeof input.githubLogin === "string" ? input.githubLogin : undefined);
    if (!login) throw new InvariantViolation("Claim with the GitHub account your pull request will come from.");
    const email = typeof input.paypalEmail === "string" ? input.paypalEmail.trim() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new InvariantViolation("Enter the PayPal email the payment should go to.");
    if (input.hash !== m.criteria_hash) throw new InvariantViolation("The terms changed since you read them. Read them again, then claim.");
    let method = "link";
    if (input.agent && typeof input.agent === "object") {
      const a = input.agent as { jwk?: JsonWebKey; signature?: unknown };
      if (!a.jwk || a.jwk.kty !== "EC" || a.jwk.crv !== "P-256" || typeof a.signature !== "string") throw new InvariantViolation("An agent claim needs an ES256 public key (JWK) and a signature.");
      const statement = termsStatement(m.id, "worker", m.criteria_hash!, login, "-");
      const key = await importVerifyKey({ kty: "EC", crv: "P-256", x: a.jwk.x, y: a.jwk.y });
      if (!(await verifySig(key, statement, a.signature))) throw new InvariantViolation(`The agent signature doesn't match. Sign exactly: ${statement}`);
      method = "agent";
    }
    const workerToken = newToken("mwt");
    const claimBy = new Date(Math.min(Date.now() + CLAIM_DAYS * DAY, (m.authorization_expires_at?.getTime() ?? Infinity) - 4 * DAY));
    if (claimBy.getTime() <= Date.now()) throw new InvariantViolation("This bounty's hold ends too soon to take on.");
    const salt = termsSchema.parse(m.criteria).emailSalt ?? "";
    const out = await transition(
      db(),
      m,
      "FUNDED",
      "freelancer",
      { freelancer_email: email, worker_github_login: login, worker_token_hash: hashToken(workerToken), worker_signed_hash: m.criteria_hash, worker_signed_at: new Date(), claim_expires_at: claimBy },
      // The proof chain gets the login and a salted digest of the email, never the email itself.
      { event: "bounty:claimed", detail: { hash: m.criteria_hash, githubLogin: login, method, emailDigest: createHash("sha256").update(`${salt}:${email}`).digest("hex"), claimBy: claimBy.toISOString() } },
    );
    return { milestone: out, workerToken };
  });
}

/**
 * The bounty clock, run from the review tick: a claim with no pull request by its deadline lapses back to
 * OFFERED (the worker's link stops working), and a bounty still unclaimed past its due date, or close to the
 * hold's end, is voided so the mandate's budget comes back.
 */
export async function tickBounty(milestoneId: string, deps: Deps = defaultDeps()): Promise<Milestone> {
  const m = await getMilestone(milestoneId);
  if (!m.open_bounty) return m;
  if (m.state === "FUNDED" && !m.pr_url && m.claim_expires_at && m.claim_expires_at.getTime() <= Date.now()) {
    return withMilestoneLock(m.id, async () => {
      const cur = await getMilestone(m.id);
      if (cur.state !== "FUNDED" || cur.pr_url) return cur;
      return transition(db(), cur, "OFFERED", "system", { freelancer_email: UNCLAIMED_EMAIL, worker_github_login: null, worker_token_hash: null, worker_signed_hash: null, worker_signed_at: null, claim_expires_at: null }, {
        event: "bounty:claim_lapsed",
        detail: { githubLogin: cur.worker_github_login, reason: `no pull request within ${CLAIM_DAYS} days of the claim` },
      });
    });
  }
  const endsAt = Math.min(m.due_at.getTime(), (m.authorization_expires_at?.getTime() ?? Infinity) - 3 * DAY);
  if (m.state === "OFFERED" && endsAt <= Date.now()) return cancelHold(m.id, deps, { actor: "system" });
  return m;
}

