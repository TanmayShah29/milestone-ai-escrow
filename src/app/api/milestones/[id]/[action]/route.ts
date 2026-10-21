import { publicMilestone, requireRole, roleOn, type Role } from "@/lib/auth";
import { db, withMilestoneLock } from "@/lib/db";
import { devActionsAllowed, json, toHttp } from "@/lib/http";
import { cancelHold, createHold, refreshHold, releaseFunds, syncMilestone } from "@/lib/money/flow";
import { getMilestone, transition, type Milestone } from "@/lib/milestones/repo";

export const runtime = "nodejs";

// Which side may trigger each action.
const ALLOWED: Record<string, Role[]> = {
  agree: ["worker"],
  submit: ["worker"],
  fund: ["client"],
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
    requireRole(await roleOn(req, await getMilestone(id)), ...allowed);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    // Forced PayPal errors (PayPal-Mock-Response) are a demo/dev tool only.
    const mock = devActionsAllowed() && typeof body.mock === "string" ? body.mock : undefined;
    const opts = mock ? { mock } : {};
    const done = (m: Milestone, extra: Record<string, unknown> = {}) => json(200, { milestone: publicMilestone(m), ...extra });
    // Non-money transitions take the same per-milestone lock as the money flow.
    const locked = (fn: (m: Milestone) => Promise<Milestone>) => withMilestoneLock(id, async () => fn(await getMilestone(id)));

    switch (action) {
      case "agree":
        return done(await locked((m) => transition(db(), m, "AGREED", "freelancer")));
      case "fund": {
        const m = await createHold(id, undefined, opts);
        return done(m, { approveUrl: m.approve_url });
      }
      case "submit": {
        const prUrl = typeof body.prUrl === "string" ? body.prUrl.trim() : "";
        if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(prUrl)) return json(400, { error: "prUrl must be a GitHub pull request URL" });
        return done(await locked((m) => transition(db(), m, "SUBMITTED", "freelancer", { pr_url: prUrl })));
      }
      case "dev-pass":
        // Stand-in for the verifier + decision policy (build step 2).
        if (!devActionsAllowed()) return json(404, { error: "not found" });
        return done(await locked((m) => transition(db(), m, "PASSED", "dev", {}, { event: "review:dev-pass" })));
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
