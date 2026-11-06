import { platformFrom, Unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import { json, toHttp } from "@/lib/http";
import { hooksSchema } from "@/lib/platform/hooks";
import { newWebhookSecret, webhookUrlProblem } from "@/lib/platform/outbound";

export const runtime = "nodejs";

async function platformOr401(req: Request) {
  const p = await platformFrom(req);
  if (!p) throw new Unauthorized("Call this with your platform's API key (Authorization: Bearer msk_...).");
  return p;
}

// GET /api/platform: your platform's webhook URL and policy hooks (never the secret).
export async function GET(req: Request) {
  try {
    const p = await platformOr401(req);
    const { rows } = await db().query<{ webhook_url: string | null; hooks: unknown }>("select webhook_url, hooks from platforms where id = $1", [p.id]);
    return json(200, { id: p.id, name: p.name, webhookUrl: rows[0]?.webhook_url ?? null, hooks: rows[0]?.hooks ?? {} });
  } catch (err) {
    return toHttp(err);
  }
}

// POST /api/platform { webhookUrl?: string | null, rotateSecret?: true, hooks?: {...} }. Setting a URL (or
// rotating) returns the signing secret once. Hooks can only restrict your own milestones (platform/hooks.ts).
export async function POST(req: Request) {
  try {
    const p = await platformOr401(req);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    let secret: string | undefined;
    if (b.webhookUrl === null) {
      await db().query("update platforms set webhook_url = null, webhook_secret = null where id = $1", [p.id]);
    } else if (typeof b.webhookUrl === "string") {
      const problem = webhookUrlProblem(b.webhookUrl);
      if (problem) return json(400, { error: `The webhook URL ${problem}.` });
      secret = newWebhookSecret();
      await db().query("update platforms set webhook_url = $2, webhook_secret = $3 where id = $1", [p.id, b.webhookUrl, secret]);
    } else if (b.rotateSecret === true) {
      secret = newWebhookSecret();
      await db().query("update platforms set webhook_secret = $2 where id = $1 and webhook_url is not null", [p.id, secret]);
    }
    if (b.hooks !== undefined) {
      const h = hooksSchema.strict().safeParse(b.hooks);
      if (!h.success) return json(400, { error: `hooks are not valid: ${h.error.issues[0]?.path.join(".")} ${h.error.issues[0]?.message}` });
      await db().query("update platforms set hooks = $2 where id = $1", [p.id, JSON.stringify(h.data)]);
    }
    const { rows } = await db().query<{ webhook_url: string | null; hooks: unknown }>("select webhook_url, hooks from platforms where id = $1", [p.id]);
    return json(200, { id: p.id, name: p.name, webhookUrl: rows[0]?.webhook_url ?? null, hooks: rows[0]?.hooks ?? {}, ...(secret ? { webhookSecret: secret } : {}) });
  } catch (err) {
    return toHttp(err);
  }
}
