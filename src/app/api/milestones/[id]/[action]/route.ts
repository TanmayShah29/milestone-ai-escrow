import { publicMilestone, requireRole, roleOn, type Role } from "@/lib/auth";
import { db, withMilestoneLock } from "@/lib/db";
import { devActionsAllowed, json, toHttp } from "@/lib/http";
import { cancelHold, createHold, fundWithTestCard, refreshHold, releaseFunds, syncMilestone } from "@/lib/money/flow";
import { draftTerms, editTerms, signTerms } from "@/lib/contract/terms";
import { humanDecision, objectToRelease, submitDeliverable, tick } from "@/lib/review/run";
import { getMilestone, transition, type Milestone } from "@/lib/milestones/repo";

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
  "dev-pass": ["client"],
  sync: ["client", "worker"],
};

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
    // Non-money transitions take the same per-milestone lock as the money flow.
    const locked = (fn: (m: Milestone) => Promise<Milestone>) => withMilestoneLock(id, async () => fn(await getMilestone(id)));

    switch (action) {
      case "draft-terms":
        return done(await draftTerms(id, { repo: str(body.repo), stack: str(body.stack) }));
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
        return done(await humanDecision(id, false));
      case "object":
        return done(await objectToRelease(id));
      case "dev-pass":
        // Stand-in for the verifier + decision policy (build step 2).
        if (!devActionsAllowed()) return json(404, { error: "not found" });
        return done(await locked((m) => transition(db(), m, "PASSED", "dev", {}, { event: "review:dev-pass" })));
      case "fund-card":
        return done(await fundWithTestCard(id, undefined, opts));
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
