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
  due_at?: string | null;
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
  CONTESTED: { label: "Client objected", tone: "failed" },
  RELEASED: { label: "Paying out", tone: "paid" },
  PAID_OUT: { label: "Paid", tone: "paid" },
  PAYOUT_FAILED: { label: "Payout returned", tone: "failed" },
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
      return 4;
    case "PAID_OUT":
      return 5;
    default:
      return -1; // cancelled
  }
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
      return { headline: "Hold released", detail: "Nothing was charged. The PayPal hold was voided.", tone: "blocked" };
    case "RELEASED":
      return { headline: "Captured, paying the worker", detail: `${usd(m.captured_cents)} captured; ${usd(m.payout_cents)} is on its way to the worker.`, tone: "paid" };
    case "PAID_OUT":
      return { headline: `Paid ${usd(m.payout_cents)} to the worker`, detail: `${usd(m.captured_cents)} captured, ${usd(m.fee_cents)} platform fee.`, tone: "paid" };
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
  "hold:reauthorized": "Hold renewed",
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
  "review:comment_failed": "Could not comment on the PR",
  "review:dev-pass": "Review marked passed (dev)",
  "release:objected": "Client objected; money stays held",
  "schedule:due_changed": "Due date moved",
};

export function eventLabel(event: string): string {
  if (EVENT_COPY[event]) return EVENT_COPY[event]!;
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
