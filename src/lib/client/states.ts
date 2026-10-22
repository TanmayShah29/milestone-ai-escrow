// Human language for milestone states and audit events, the five-step tracker, and where the money is.
// The UI never shows a raw state name; it shows these.

export type Role = "client" | "worker";
export type Tone = "neutral" | "held" | "paid" | "failed" | "blocked" | "active";

export type MilestoneView = Record<string, unknown> & {
  id: string;
  title: string;
  state: string;
  amount_cents: number;
  criteria_hash?: string | null;
  client_signed_hash?: string | null;
  worker_signed_hash?: string | null;
  criteria?: { criteria: unknown[] } | null;
  authorized_cents?: number | null;
  authorization_expires_at?: string | null;
  captured_cents?: number | null;
  fee_cents?: number | null;
  payout_cents?: number | null;
  payout_status?: string | null;
  release_after?: string | null;
  contested_at?: string | null;
  /** Set for a HUMAN_CHECK with a deadline (after an objection, or 3 days before the hold expires): undecided by then, fixed rules settle it. */
  decide_by?: string | null;
  /** The client's reason for objecting, shown to the worker. */
  objection_reason?: string | null;
  /** The client's reason for asking for changes, shown to the worker. */
  changes_reason?: string | null;
  human_check_at?: string | null;
  due_at?: string | null;
  paypal_authorization_id?: string | null;
};

export const usd = (cents: number | null | undefined) => (cents == null ? "—" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

export const STATUS: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: "Agreeing on terms", tone: "neutral" },
  AGREED: { label: "Waiting for funding", tone: "neutral" },
  FUNDED: { label: "Money held, work in progress", tone: "held" },
  SUBMITTED: { label: "Checking the work", tone: "active" },
  IN_REVIEW: { label: "Checking the work", tone: "active" },
  CHANGES_REQUESTED: { label: "Changes needed", tone: "failed" },
  HUMAN_CHECK: { label: "Needs the client's decision", tone: "held" },
  PASSED: { label: "Approved, releasing soon", tone: "paid" },
  CONTESTED: { label: "Objected, second review", tone: "held" },
  RELEASED: { label: "Paying out", tone: "paid" },
  PAID_OUT: { label: "Paid", tone: "paid" },
  PAYOUT_FAILED: { label: "Payout returned", tone: "failed" },
  DISPUTE: { label: "PayPal dispute open", tone: "failed" },
  CANCELLED: { label: "Cancelled", tone: "blocked" },
};

export const STEPS = ["Agree", "Fund", "Deliver", "Verify", "Release"] as const;

/** Which tracker step is current (0–4), or 5 when everything is done. */
export function stepIndex(state: string): number {
  switch (state) {
    case "DRAFT":
      return 0;
    case "AGREED":
      return 1;
    case "FUNDED":
    case "CHANGES_REQUESTED":
      return 2;
    case "SUBMITTED":
    case "IN_REVIEW":
    case "HUMAN_CHECK":
      return 3;
    case "PASSED":
    case "CONTESTED":
    case "RELEASED":
    case "PAYOUT_FAILED":
    case "DISPUTE":
      return 4;
    case "PAID_OUT":
      return 5;
    default:
      return -1; // cancelled
  }
}

/** A state's human label, for sentences ("Waiting for funding"). Never shows a raw state name. */
export function stateLabel(state: string): string {
  return STATUS[state]?.label ?? "another step";
}

/**
 * Where a cancelled milestone stopped on the tracker (0–4): the step it never got past. A voided hold
 * means Agree and Fund were done; signed terms without a hold mean only Agree was done.
 */
export function cancelledAt(m: Pick<MilestoneView, "criteria_hash" | "client_signed_hash" | "worker_signed_hash" | "paypal_authorization_id" | "authorized_cents">): number {
  if (m.paypal_authorization_id || m.authorized_cents != null) return 2;
  const hash = m.criteria_hash;
  if (hash && m.client_signed_hash === hash && m.worker_signed_hash === hash) return 1;
  return 0;
}

const shortDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

/**
 * The work is due after the PayPal hold expires (same rule as holdWarning in src/lib/timeline.ts, kept
 * here so client components don't import server modules). Only while the hold is still live.
 */
export function holdExpiryWarning(m: MilestoneView): string | undefined {
  if (!m.due_at || !m.authorization_expires_at) return undefined;
  if (["DRAFT", "AGREED", "RELEASED", "PAID_OUT", "PAYOUT_FAILED", "CANCELLED"].includes(m.state)) return undefined;
  const due = new Date(m.due_at);
  const expiry = new Date(m.authorization_expires_at);
  if (!(due.getTime() > expiry.getTime())) return undefined;
  return `Work is due ${shortDate(due)}, after the PayPal hold expires ${shortDate(expiry)}. Move the date earlier; holds can't be extended past 29 days.`;
}

/**
 * The HUMAN_CHECK decision deadline as words for each side, or undefined when there is none (no
 * objection and no known hold expiry). `outcome` is what fixed rules do at the deadline: release to the
 * worker, void the hold when the review flagged tampering or text aimed at the reviewer, or wait when the
 * rules can't settle it (see humanTimeoutOutcome in src/lib/review/policy.ts).
 */
export function decideByCopy(m: MilestoneView, role: Role, outcome: "release" | "void" | "wait" = "release"): string | undefined {
  if (m.state !== "HUMAN_CHECK" || !m.decide_by) return undefined;
  const d = new Date(m.decide_by);
  if (Number.isNaN(d.getTime())) return undefined;
  const date = d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  if (outcome === "void") {
    return role === "client"
      ? `Decide by ${date}; after that the hold is released back to you and nothing is charged, because the review flagged this work.`
      : `If the client doesn't decide by ${date}, the hold is released back to the client, because the review flagged this work.`;
  }
  if (outcome === "wait") {
    return role === "client"
      ? `Decide by ${date}. The rules can't settle this on their own; if you don't decide, the PayPal hold lapses and nothing is charged.`
      : `The client needs to decide by ${date}. The rules can't settle this on their own; if the hold lapses, you aren't paid.`;
  }
  const why = m.contested_at ? "the work passed its first review" : "the PayPal hold would otherwise run out";
  return role === "client" ? `Decide by ${date}; after that the payment releases to the worker, because ${why}.` : `If the client doesn't decide by ${date}, you're paid.`;
}

/** Where the money is right now, in one line. */
export function moneyLine(m: MilestoneView): { headline: string; detail: string; tone: Tone } {
  const held = m.authorized_cents ?? m.amount_cents;
  const days = m.authorization_expires_at ? Math.max(0, Math.ceil((new Date(m.authorization_expires_at).getTime() - Date.now()) / 86_400_000)) : null;
  switch (m.state) {
    case "DRAFT":
    case "AGREED":
      return { headline: "Not funded yet", detail: `${usd(m.amount_cents)} will be held on PayPal once both sides sign and the client funds.`, tone: "neutral" };
    case "CANCELLED":
      return cancelledAt(m) >= 2
        ? { headline: "Hold released", detail: "Nothing was charged. The PayPal hold was voided.", tone: "blocked" }
        : { headline: "Cancelled before funding", detail: "Nothing was held or charged.", tone: "blocked" };
    case "CONTESTED":
      return { headline: `${usd(held)} held on PayPal`, detail: "Not charged. The client objected, so the money stays held while the same commit is reviewed a second time.", tone: "held" };
    case "RELEASED":
      return { headline: "Captured, paying the worker", detail: `${usd(m.captured_cents)} captured; ${usd(m.payout_cents)} is on its way to the worker.`, tone: "paid" };
    case "PAID_OUT":
      return { headline: `Paid ${usd(m.payout_cents)} to the worker`, detail: `${usd(m.captured_cents)} captured; ${usd((typeof m.paypal_fee_cents === "number" ? m.paypal_fee_cents : 0) + (typeof m.payout_fee_cents === "number" ? m.payout_fee_cents : 0))} PayPal fees, ${usd(m.fee_cents)} platform fee.`, tone: "paid" };
    case "DISPUTE":
      return { headline: "In a PayPal dispute", detail: `The client opened a dispute on the ${usd(m.captured_cents)} captured. PayPal decides it; nothing moves from here.`, tone: "failed" };
    case "PAYOUT_FAILED":
      return { headline: "Payout came back", detail: `PayPal returned the payout (${m.payout_status ?? "failed"}). The money is with the platform; check the worker's PayPal email.`, tone: "failed" };
    default:
      return { headline: `${usd(held)} held on PayPal`, detail: days != null ? `Not charged yet. The hold lasts ${days} more day${days === 1 ? "" : "s"}; it is captured only when the work passes.` : "Not charged yet; captured only when the work passes.", tone: "held" };
  }
}

const EVENT_COPY: Record<string, string> = {
  created: "Milestone opened",
  "terms:drafted": "AI drafted the terms",
  "terms:edited": "Client edited the terms",
  "terms:signed:client": "Client signed the terms",
  "terms:signed:worker": "Worker signed the terms",
  "terms:agreed": "Terms sealed by both sides",
  "order:created": "PayPal checkout opened",
  "order:superseded": "Expired PayPal checkout replaced",
  "hold:authorized": "Money held on PayPal",
  "hold:voided": "Hold voided, nothing charged",
  "hold:reauthorized": "Honor period renewed",
  "hold:captured": "Money captured",
  "payout:created": "Payout sent to the worker",
  "payout:succeeded": "Worker received the payout",
  "payout:status": "Payout status changed",
  "deliverable:submitted": "Work submitted",
  "review:started": "Review started",
  "review:passed": "Review passed",
  "review:changes_requested": "Changes requested",
  "review:human_check": "Sent to the client to decide",
  "review:approved_by_client": "Client approved the work",
  "review:changes_by_client": "Client asked for changes",
  "review:human_timeout": "Client didn't decide in time; fixed rules settled it",
  "review:comment_failed": "Could not comment on the PR",
  "review:dev-pass": "Review marked passed (dev)",
  "release:objected": "Client objected; money stays held for a second review",
  "review:second": "Second review after the objection",
  "dispute:opened": "Client opened a PayPal dispute",
  "dispute:updated": "PayPal dispute updated",
  "dispute:resolved": "PayPal dispute resolved",
  "dispute:not_applied": "PayPal dispute recorded",
  "schedule:due_changed": "Due date moved",
};

const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const asDay = (v: unknown) => {
  if (typeof v !== "string" && !(v instanceof Date)) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : dayFmt.format(d);
};

/** Extra words for an audit row, from its detail (e.g. "from Nov 2, 2026 to Nov 9, 2026"). */
export function eventDetail(event: string, detail: Record<string, unknown> | null | undefined): string | undefined {
  if (!detail) return undefined;
  if (event === "review:human_timeout") {
    if (detail.outcome === "release") return "released to the worker";
    if (detail.outcome === "void") return "hold released back to the client";
    if (detail.outcome === "wait") return "the rules can't settle it; waiting for the client";
  }
  if ((event === "release:objected" || event === "review:changes_by_client") && typeof detail.reason === "string" && detail.reason) {
    return `“${detail.reason.length > 140 ? `${detail.reason.slice(0, 140)}…` : detail.reason}”`;
  }
  if (event === "schedule:due_changed") {
    const from = asDay(detail.from);
    const to = asDay(detail.to);
    if (from && to) return `from ${from} to ${to}`;
    if (to) return `set to ${to}`;
  }
  return undefined;
}

// PayPal webhook events, in words. Unlisted ones fall back to the event name.
const WEBHOOK_COPY: Record<string, string> = {
  "PAYMENT.AUTHORIZATION.CREATED": "PayPal confirmed the hold",
  "PAYMENT.AUTHORIZATION.VOIDED": "PayPal confirmed the hold was released",
  "PAYMENT.CAPTURE.COMPLETED": "PayPal confirmed the capture",
  "PAYMENT.CAPTURE.REFUNDED": "PayPal confirmed a refund",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED": "PayPal confirmed the worker's payout",
  "PAYMENT.PAYOUTSBATCH.SUCCESS": "PayPal confirmed the payout batch",
  "CHECKOUT.ORDER.APPROVED": "PayPal confirmed the client approved the hold",
  "CUSTOMER.DISPUTE.CREATED": "PayPal reported a dispute",
};

export function eventLabel(event: string): string {
  if (EVENT_COPY[event]) return EVENT_COPY[event]!;
  if (event.startsWith("webhook:") && WEBHOOK_COPY[event.slice(8)]) return WEBHOOK_COPY[event.slice(8)]!;
  if (event.startsWith("webhook:")) return `PayPal confirmed: ${event.slice(8).toLowerCase().replaceAll("_", " ").replaceAll(".", " ")}`;
  if (event.endsWith(":refused")) return `PayPal refused ${event.split(":")[0]!.replace("_", " ")}`;
  if (event.endsWith(":unknown")) return `Waiting on PayPal for ${event.split(":")[0]!.replace("_", " ")}`;
  if (event.endsWith(":settled")) return `PayPal outcome confirmed (${event.split(":")[0]!.replace("_", " ")})`;
  if (event.startsWith("state:")) return `Status: ${STATUS[event.slice(6)]?.label ?? event.slice(6)}`;
  return event.replaceAll(":", " ").replaceAll("_", " ");
}

/** Link for a PayPal or GitHub reference shown in the proof trail. */
export function referenceHref(ref: string | null | undefined): string | undefined {
  if (!ref) return undefined;
  if (/^https:\/\/github\.com\//.test(ref)) return ref;
  return undefined;
}
