import { roleOn } from "@/lib/auth";
import { json, toHttp } from "@/lib/http";
import { getMilestone } from "@/lib/milestones/repo";
import { defaultDeps } from "@/lib/money/flow";
import { importVerifyKey, verifySig } from "@/lib/proof/verify";
import { arbitrator } from "@/lib/resolution/config";
import { courtReadStatement, courtView, signAward } from "@/lib/resolution/desk";

export const runtime = "nodejs";

async function arbitratorReading(req: Request, id: string): Promise<boolean> {
  const header = req.headers.get("x-arbitrator-signature") ?? "";
  const [minute, sig] = header.split(".", 2);
  const desk = arbitrator();
  if (!desk || !minute || !sig || Math.abs(Date.now() / 60_000 - Number(minute)) > 5) return false;
  return verifySig(await importVerifyKey(desk.publicJwk), courtReadStatement(id, Number(minute)), sig);
}

// GET /api/milestones/:id/court: the case (lock, fee holds, evidence pack, draft, award). Either side's
// link, or the arbitrator's signed read (scripts/sign-award.mts).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const m = await getMilestone(id);
    const role = (await arbitratorReading(req, id)) ? "arbitrator" : await roleOn(req, m);
    return json(200, { role, state: m.state, ...(await courtView(id)) });
  } catch (err) {
    return toHttp(err);
  }
}

// POST /api/milestones/:id/court { shareBps, reasons, signature }: the arbitrator's award. The signature is
// the authorization: it must be by the key the signed terms name, over desk.ts awardStatement.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const m = await signAward(id, body, { money: defaultDeps() });
    return json(200, { state: m.state, ...(await courtView(id)) });
  } catch (err) {
    return toHttp(err);
  }
}
