import { NextResponse } from "next/server";
import { AiBusy, AiUnreadable } from "@/lib/ai/client";
import { Forbidden, Unauthorized } from "@/lib/auth";
import { InProgress, InvariantViolation, OutcomeUnknown } from "@/lib/errors";
import { NotFound, StaleState } from "@/lib/milestones/repo";
import { InvalidTransition } from "@/lib/milestones/states";
import { PaypalFailure } from "@/lib/paypal/errors";
import { GitHubError } from "@/lib/review/github";

// The one place errors become HTTP responses (paypal-plan.md 1b.4).
export function toHttp(err: unknown): NextResponse {
  if (err instanceof NotFound) return json(404, { error: err.message });
  if (err instanceof Unauthorized) return json(401, { error: err.message });
  if (err instanceof Forbidden) return json(403, { error: err.message });
  if (err instanceof AiBusy) return json(503, { error: err.message, aiBusy: true });
  if (err instanceof AiUnreadable) return json(502, { error: "The AI didn't return usable terms. Try again, or write them by hand." });
  if (err instanceof InvalidTransition || err instanceof StaleState || err instanceof InProgress) return json(409, { error: err.message });
  if (err instanceof InvariantViolation) return json(409, { error: err.message });
  if (err instanceof OutcomeUnknown) return json(202, { error: "PayPal hasn't confirmed this yet. We're checking with PayPal; this page will update.", unknown: true });
  if (err instanceof GitHubError) {
    console.warn("github refused", err.status, err.message);
    if (err.status === 404) return json(422, { error: `That pull request doesn't exist in ${err.repo ?? "the repository"}. Check the number.` });
    return json(502, { error: "Couldn't reach GitHub, try again." });
  }
  if (err instanceof PaypalFailure) {
    const { status, reason, issue, debugId } = err.detail;
    if (err.kind === "unknown") return json(202, { error: "PayPal hasn't confirmed this yet. We're checking with PayPal; this page will update.", unknown: true });
    if (err.kind === "never_sent") {
      console.error("paypal request not sent", err.message, err.cause);
      return json(502, { error: "Couldn't reach PayPal. Try again in a moment." });
    }
    console.warn("paypal refused", status, issue, debugId);
    if (status === 401 || status === 403) return json(502, { error: "PayPal rejected our credentials" });
    if (status === 429) return json(503, { error: "PayPal is busy right now. Try again in a minute." });
    if (issue === "PAYER_CANNOT_PAY")
      return json(422, { error: "PayPal's sandbox declined this test card. Click fund again to try another test card, or fund with a PayPal login.", issue, debugId });
    if (status && status >= 400 && status < 500) return json(status, { error: reason ?? "PayPal rejected the request", issue, debugId });
    return json(502, { error: "PayPal had a problem. Try again.", debugId });
  }
  console.error(err);
  return json(500, { error: "Unexpected error" });
}

export function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status });
}

export function devActionsAllowed(): boolean {
  return process.env.ALLOW_DEV_ACTIONS === "1";
}
