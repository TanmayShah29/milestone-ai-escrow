import { platformFrom, publicMilestone, requireRole, roleOn, type Role } from "@/lib/auth";
import { devActionsAllowed, json, toHttp } from "@/lib/http";
import { cancelHold, createHold, fundWithTestCard, refreshHold, releaseFunds, syncMilestone } from "@/lib/money/flow";
import { draftTerms, editTerms, signTerms } from "@/lib/contract/terms";
import { setDueDate } from "@/lib/schedule";
import { humanDecision, objectToRelease, submitDeliverable, tick } from "@/lib/review/run";
import { getMilestone, type Milestone } from "@/lib/milestones/repo";
import { DAY, HOUR, hit, ipKey, tooMany, waitText, type Rule } from "@/lib/ratelimit";

export const runtime = "nodejs";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// Which side may trigger each action.
const ALLOWED: Record<string, Role[]> = {
  "draft-terms": ["client"],
  "edit-terms": ["client"],
  "sign-terms": ["client", "worker"],
  submit: ["worker"],
  check: ["client", "worker"],
  approve: ["client"],
  "request-changes": ["client"],
  object: ["client"],
  fund: ["client"],
  "fund-card": ["client"],
  cancel: ["client"],
  release: ["client"],
  "refresh-hold": ["client"],
  schedule: ["client"],
  sync: ["client", "worker"],
};

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
export async function POST(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  try {
    const { id, action } = await ctx.params;
    const allowed = ALLOWED[action];
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
      case "edit-terms":
        return done(await editTerms(id, body.terms, { ...(str(body.repo) !== undefined ? { repo: str(body.repo) } : {}) }));
      case "sign-terms":
        return done(await signTerms(id, role, str(body.hash) ?? ""));
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
      default:
        return done(await syncMilestone(id));
    }
  } catch (err) {
    return toHttp(err);
  }
}
