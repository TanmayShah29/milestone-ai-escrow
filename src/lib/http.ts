import { NextResponse } from "next/server";
import { Forbidden, Unauthorized } from "@/lib/auth";
import { InProgress, InvariantViolation, OutcomeUnknown } from "@/lib/money/flow";
import { NotFound, StaleState } from "@/lib/milestones/repo";
import { InvalidTransition } from "@/lib/milestones/states";
import { PaypalFailure } from "@/lib/paypal/errors";

// The one place errors become HTTP responses (paypal-plan.md 1b.4).
export function toHttp(err: unknown): NextResponse {
  if (err instanceof NotFound) return json(404, { error: err.message });
  if (err instanceof Unauthorized) return json(401, { error: err.message });
  if (err instanceof Forbidden) return json(403, { error: err.message });
  if (err instanceof InvalidTransition || err instanceof StaleState || err instanceof InProgress) return json(409, { error: err.message });
  if (err instanceof InvariantViolation) return json(409, { error: err.message });
  if (err instanceof OutcomeUnknown) return json(202, { error: "Outcome unknown, checking with PayPal. Use sync to settle it.", unknown: true });
  if (err instanceof PaypalFailure) {
    const { status, reason, issue, debugId } = err.detail;
    if (err.kind === "unknown") return json(202, { error: "Outcome unknown, checking with PayPal.", unknown: true });
    if (err.kind === "never_sent") {
      console.error("paypal request not sent", err.message, err.cause);
      return json(502, { error: "Could not reach PayPal with our credentials" });
    }
    console.warn("paypal refused", status, issue, debugId);
    if (status === 401 || status === 403) return json(502, { error: "PayPal rejected our credentials" });
    if (status === 429) return json(503, { error: "PayPal is rate-limiting us, try again shortly" });
    if (status && status >= 400 && status < 500) return json(status, { error: reason ?? "PayPal rejected the request", issue, debugId });
    return json(502, { error: "PayPal error, try again", debugId });
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
