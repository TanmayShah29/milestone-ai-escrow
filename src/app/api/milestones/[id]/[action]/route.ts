import { db } from "@/lib/db";
import { devActionsAllowed, json, toHttp } from "@/lib/http";
import { cancelHold, createHold, refreshHold, releaseFunds, syncMilestone } from "@/lib/money/flow";
import { getMilestone, transition } from "@/lib/milestones/repo";

export const runtime = "nodejs";

// POST /api/milestones/:id/:action
export async function POST(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  try {
    const { id, action } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    // Forced PayPal errors (PayPal-Mock-Response) are a demo/dev tool only.
    const mock = devActionsAllowed() && typeof body.mock === "string" ? body.mock : undefined;
    const opts = mock ? { mock } : {};

    switch (action) {
      case "agree":
        return json(200, { milestone: await transition(db(), await getMilestone(id), "AGREED", "freelancer") });
      case "fund": {
        const m = await createHold(id, undefined, opts);
        return json(200, { milestone: m, approveUrl: m.approve_url });
      }
      case "submit": {
        const prUrl = typeof body.prUrl === "string" ? body.prUrl.trim() : "";
        if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(prUrl)) return json(400, { error: "prUrl must be a GitHub pull request URL" });
        return json(200, { milestone: await transition(db(), await getMilestone(id), "SUBMITTED", "freelancer", { pr_url: prUrl }) });
      }
      case "dev-pass":
        // Stand-in for the AI reviewer + decision policy (build step 4).
        if (!devActionsAllowed()) return json(404, { error: "not found" });
        return json(200, { milestone: await transition(db(), await getMilestone(id), "PASSED", "dev", {}, { event: "review:dev-pass" }) });
      case "release":
        return json(200, { milestone: await releaseFunds(id, undefined, opts) });
      case "cancel":
        return json(200, { milestone: await cancelHold(id) });
      case "refresh-hold":
        return json(200, { milestone: await refreshHold(id) });
      case "sync":
        return json(200, { milestone: await syncMilestone(id) });
      default:
        return json(404, { error: `unknown action ${action}` });
    }
  } catch (err) {
    return toHttp(err);
  }
}
