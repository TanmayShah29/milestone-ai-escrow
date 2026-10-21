import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { APICallError, generateText } from "ai";
import type { z } from "zod";
import { db } from "@/lib/db";

// One structured-output call per task, on free OpenRouter models. Falls through AI_MODEL →
// AI_MODEL_FALLBACK → AI_MODEL_FALLBACK_2 on 404 / 429 / 5xx or unusable output, and stops at a daily
// budget so the free tier (50 requests/day) is never exhausted by a single visitor.
// The model only ever returns data: nothing it says can move money (money rule 1).

export class AiBusy extends Error {}
export class AiUnreadable extends Error {}

export type ModelCall = (model: string, system: string, prompt: string, maxOutputTokens: number) => Promise<string>;

export function configuredModels(): string[] {
  return [process.env.AI_MODEL, process.env.AI_MODEL_FALLBACK, process.env.AI_MODEL_FALLBACK_2].filter((m): m is string => !!m);
}

export function dailyCap(): number {
  const n = Number(process.env.AI_DAILY_CAP ?? "40");
  return Number.isInteger(n) && n > 0 ? n : 40;
}

const openRouterCall: ModelCall = async (model, system, prompt, maxOutputTokens) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const openrouter = createOpenRouter({ apiKey });
  const { text } = await generateText({
    // Reasoning models spend the output budget "thinking" and cut the JSON off: keep reasoning short
    // and out of the reply. Non-reasoning models ignore this.
    model: openrouter.chat(model, { reasoning: { effort: "low", exclude: true } }),
    system,
    prompt,
    temperature: 0.2,
    maxOutputTokens, // reasoning models return empty content below ~1500; drafts ask for more
    maxRetries: 0, // we fall through to the next model instead
    abortSignal: AbortSignal.timeout(90_000),
  });
  return text;
};

export async function callsToday(): Promise<number> {
  const { rows } = await db().query<{ n: string }>("select count(*) as n from ai_calls where created_at >= date_trunc('day', now())");
  return Number(rows[0]!.n);
}

/** Pull the JSON object out of a reply that may be wrapped in a code fence or prose. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in reply");
  return JSON.parse(body.slice(start, end + 1));
}

function retryable(err: unknown): number | undefined {
  if (APICallError.isInstance(err)) {
    const s = err.statusCode ?? 0;
    if (s === 404 || s === 408 || s === 429 || s >= 500 || err.isRetryable) return s || 503;
  }
  return undefined;
}

export async function generateJson<T>(opts: {
  purpose: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxOutputTokens?: number;
  call?: ModelCall;
  models?: string[];
}): Promise<{ value: T; model: string }> {
  const models = opts.models ?? configuredModels();
  if (models.length === 0) throw new Error("no AI_MODEL configured");
  const call = opts.call ?? openRouterCall;
  let sawBusy = false;
  let sawOther = false;
  for (const model of models) {
    if ((await callsToday()) >= dailyCap()) throw new AiBusy("today's free AI budget is used up; try again tomorrow");
    const started = Date.now();
    try {
      const text = await call(model, opts.system, opts.prompt, Math.max(1500, opts.maxOutputTokens ?? 1500));
      let json: unknown;
      try {
        json = extractJson(text);
      } catch (e) {
        // Keep enough of the reply to diagnose truncation or prose-only answers (no secrets in it).
        throw new AiUnreadable(`${String(e)} (reply ${text.length} chars, ends: ${JSON.stringify(text.slice(-120))})`);
      }
      const parsed = opts.schema.safeParse(json);
      if (!parsed.success) throw new AiUnreadable(`reply did not match the schema: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message ?? "invalid"}`);
      await logCall(opts.purpose, model, true, 200, null, Date.now() - started);
      return { value: parsed.data, model };
    } catch (err) {
      const status = retryable(err);
      await logCall(opts.purpose, model, false, status ?? null, String(err).slice(0, 500), Date.now() - started);
      if (status === 429) sawBusy = true;
      else sawOther = true;
      if (status === undefined && !(err instanceof AiUnreadable)) throw err;
      // otherwise: busy, missing, broken or off-schema → next model
    }
  }
  throw sawBusy && !sawOther ? new AiBusy("the free AI models are busy right now; try again in a minute") : new AiUnreadable("no model returned a usable answer");
}

async function logCall(purpose: string, model: string, ok: boolean, status: number | null, error: string | null, latency: number) {
  await db().query("insert into ai_calls (purpose, model, ok, status, error, latency_ms) values ($1, $2, $3, $4, $5, $6)", [purpose, model, ok, status, error, latency]);
}
