import { ACTION_ROLES } from "@/lib/platform/actions";
import { withIdempotency } from "@/lib/platform/idempotency";
import { platformFrom, publicMilestone, requireRole, roleOn } from "@/lib/auth";
import { devActionsAllowed, json, toHttp } from "@/lib/http";
import { cancelHold, createHold, defaultDeps, fundWithTestCard, refreshHold, releaseFunds, syncMilestone } from "@/lib/money/flow";
import { attackTerms } from "@/lib/contract/attack";
import { passkeyOptions, passkeyRegister, siteFor } from "@/lib/contract/signatures";
import { draftTerms, editTerms, signTerms, type SignOptions } from "@/lib/contract/terms";
import { eraseMilestone, rotateLink } from "@/lib/privacy";
import { setDueDate } from "@/lib/schedule";
import { humanDecision, objectToRelease, submitDeliverable, tick } from "@/lib/review/run";
import { matchLock, openLock } from "@/lib/resolution/desk";
import { getMilestone, type Milestone } from "@/lib/milestones/repo";
import { DAY, HOUR, hit, ipKey, tooMany, waitText, type Rule } from "@/lib/ratelimit";

export const runtime = "nodejs";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);


// AI drafting spends the shared free-model budget: 5 per hour per IP (platform keys are exempt) and
// 3 per day per milestone (for everyone).
const DRAFTS_PER_IP_HOUR = 5;
const DRAFTS_PER_MILESTONE_DAY = 3;

async function draftLimit(req: Request, id: string) {
  const rules: Rule[] = [{ key: `draft-terms:milestone:${id}`, limit: DRAFTS_PER_MILESTONE_DAY, windowMs: DAY }];
  if (!(await platformFrom(req))) rules.push({ key: ipKey(req, "draft-terms"), limit: DRAFTS_PER_IP_HOUR, windowMs: HOUR });
  const v = await hit(rules);
  if (v.ok) return undefined;
  const wait = waitText(v.retryAfterMs);
  return v.rule.windowMs === DAY
    ? tooMany(`These terms have been drafted ${DRAFTS_PER_MILESTONE_DAY} times today. Edit them by hand, or try again in ${wait}.`, v.retryAfterMs)
    : tooMany(`You've drafted terms ${DRAFTS_PER_IP_HOUR} times this hour. Try again in ${wait}.`, v.retryAfterMs);
}

// POST /api/milestones/:id/:action  (auth: the milestone's client/worker link token, or the owning platform's API key)
// An Idempotency-Key header makes a retry return the first response instead of acting again.
export async function POST(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await ctx.params;
  return withIdempotency(req, `${id}:${action}`, () => act(req, id, action));
}

async function act(req: Request, id: string, action: string) {
  try {
    const allowed = ACTION_ROLES[action];
    if (!allowed) return json(404, { error: `unknown action ${action}` });
    const role = await roleOn(req, await getMilestone(id));
    requireRole(role, ...allowed);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    // Forced PayPal errors (PayPal-Mock-Response) are a demo/dev tool only.
    const mock = devActionsAllowed() && typeof body.mock === "string" ? body.mock : undefined;
    const opts = mock ? { mock } : {};
    const done = (m: Milestone, extra: Record<string, unknown> = {}) => json(200, { milestone: publicMilestone(m), ...extra });

    switch (action) {
      case "draft-terms": {
        const limited = await draftLimit(req, id);
        if (limited) return limited;
        return done(await draftTerms(id, { repo: str(body.repo), stack: str(body.stack) }));
      }
      case "attack-terms": {
        const v = await hit([
          { key: `attack-terms:milestone:${id}`, limit: DRAFTS_PER_MILESTONE_DAY, windowMs: DAY },
          ...((await platformFrom(req)) ? [] : [{ key: ipKey(req, "attack-terms"), limit: DRAFTS_PER_IP_HOUR, windowMs: HOUR }]),
        ]);
        if (!v.ok) return tooMany(`These terms have been attacked enough for now. Try again in ${waitText(v.retryAfterMs)}.`, v.retryAfterMs);
        return done(await attackTerms(id));
      }
      case "edit-terms":
        return done(await editTerms(id, body.terms, { ...(str(body.repo) !== undefined ? { repo: str(body.repo) } : {}) }));
      case "sign-terms": {
        // Optionally with a passkey assertion (body.passkey) or an agent's own key (body.agent: { jwk, signature }).
        const opts: SignOptions = {
          ...(body.passkey ? { passkey: { site: siteFor(req), response: body.passkey as NonNullable<SignOptions["passkey"]>["response"] } } : {}),
          ...(body.agent && typeof body.agent === "object" ? { agent: body.agent as SignOptions["agent"] } : {}),
          ...(str(body.githubLogin) ? { githubLogin: str(body.githubLogin) } : {}),
        };
        return done(await signTerms(id, role, str(body.hash) ?? "", opts));
      }
      case "passkey-options": {
        const out = await passkeyOptions(await getMilestone(id), role, siteFor(req), str(body.githubLogin));
        return json(200, out);
      }
      case "passkey-register":
        await passkeyRegister(await getMilestone(id), role, siteFor(req), body.response as Parameters<typeof passkeyRegister>[3]);
        return json(200, { registered: true });
      case "fund": {
        const m = await createHold(id, undefined, opts);
        return done(m, { approveUrl: m.approve_url });
      }
      case "submit":
        return done(await submitDeliverable(id, { prUrl: str(body.prUrl), text: str(body.text) }));
      case "check":
        // Moves the milestone forward: review once CI is done, release after the objection window.
        return done(await tick(id));
      case "approve":
        return done(await humanDecision(id, true));
      case "request-changes":
        return done(await humanDecision(id, false, { reason: str(body.reason) }));
      case "object":
        return done(await objectToRelease(id, { reason: str(body.reason) }));
      case "fund-card":
        return done(await fundWithTestCard(id, undefined, opts));
      case "schedule": {
        const { milestone, warnings } = await setDueDate(id, str(body.dueAt) ?? "");
        return done(milestone, { warnings });
      }
      case "release":
        return done(await releaseFunds(id, undefined, opts));
      case "cancel":
        return done(await cancelHold(id));
      case "refresh-hold":
        return done(await refreshHold(id));
      case "rotate-link": {
        // The new link's token is returned once, like at creation; the old one stops working now.
        const which = body.link === "client" || body.link === "worker" ? body.link : role;
        const { milestone, token } = await rotateLink(id, role, which);
        return done(milestone, { link: which, token });
      }
      case "erase":
        return done(await eraseMilestone(id, "client"));
      case "lock":
      case "match-lock": {
        // The sandbox test card funds the fee with no PayPal login (the judge path); otherwise approve at PayPal.
        const input = { statement: str(body.statement), card: body.card === true, ...(mock ? { mock } : {}) };
        const { milestone, fee } = await (action === "lock" ? openLock : matchLock)(id, role, input, { money: defaultDeps() });
        return done(milestone, { approveUrl: fee.status === "open" ? fee.approve_url : null });
      }
      default:
        return done(await syncMilestone(id));
    }
  } catch (err) {
    return toHttp(err);
  }
}
