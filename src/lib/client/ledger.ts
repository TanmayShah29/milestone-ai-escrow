// Pure builders for the money ledger (/ledger) and the milestones portfolio grid (/milestones).
// No fetches, no storage, no tokens: rows are built from what GET /api/milestones/:id returns
// (milestone, audit, actions), and they never carry the link token used to fetch them.

import { STATUS, type MilestoneView, type Role, type Tone } from "@/lib/client/states";

/** A money_actions claim row, as the milestone API returns it. */
export type ActionRow = { action: string; attempt: number; status: string; paypal_id: string | null; created_at: string };
/** An audit_log row, as the milestone API returns it. */
export type AuditRow = { id: number | string; actor: string; event: string; paypal_id: string | null; created_at: string };

export type LedgerKind = "order" | "hold" | "capture" | "void" | "payout" | "reauthorize";
export type LedgerStatus = "succeeded" | "pending" | "failed" | "unknown";

export type LedgerRow = {
  key: string;
  milestoneId: string;
  milestone: string;
  role: Role;
  /** ISO time: the matching audit event's time, else when the claim was made. */
  at: string;
  kind: LedgerKind;
  action: string;
  /** Integer cents, or null when the milestone doesn't record an amount for this action. */
  amountCents: number | null;
  status: LedgerStatus;
  /** Claim attempt (1, 2, …), or null for a row recorded only in the proof trail. */
  attempt: number | null;
  /** The PayPal-Request-Id sent with this attempt, or null for a proof-trail-only row. */
  requestId: string | null;
  paypalId: string | null;
  actor: string;
  /** "claim" = from the idempotency engine's own record; "trail" = from the audit log only. */
  source: "claim" | "trail";
};

export type LedgerInput = { role: Role; milestone: MilestoneView; audit: AuditRow[]; actions: ActionRow[] };

/**
 * The PayPal-Request-Id for a claim attempt. Mirrors requestIdFor in src/lib/money/claims.ts (a server
 * module); tests/ledger.test.ts checks the two agree.
 */
export const requestIdOf = (milestoneId: string, action: string, attempt: number) => `ms_${milestoneId}_${action}_${attempt}`;

const kindOf = (action: string): LedgerKind | undefined => {
  if (action === "create_order") return "order";
  if (action === "authorize") return "hold";
  if (action === "capture" || action === "void" || action === "payout") return action;
  if (/^reauthorize_\d+$/.test(action)) return "reauthorize";
  return undefined;
};

export const KIND_LABEL: Record<LedgerKind, string> = {
  order: "Order",
  hold: "Hold",
  capture: "Capture",
  void: "Void",
  payout: "Payout",
  reauthorize: "Reauthorize",
};

/** The audit event a successful action writes. */
const SUCCESS_EVENT: Record<LedgerKind, string> = {
  order: "order:created",
  hold: "hold:authorized",
  capture: "hold:captured",
  void: "hold:voided",
  payout: "payout:created",
  reauthorize: "hold:reauthorized",
};

/** Money events in the proof trail that stand for an action even when no claim row exists (seeded demos). */
const TRAIL_EVENT: Record<string, LedgerKind> = {
  "order:created": "order",
  "hold:authorized": "hold",
  "hold:captured": "capture",
  "hold:voided": "void",
  "hold:reauthorized": "reauthorize",
  "payout:created": "payout",
  "payout:succeeded": "payout",
};

export const STATUS_COPY: Record<LedgerStatus, { label: string; tone: Tone; help: string }> = {
  succeeded: { label: "Succeeded", tone: "paid", help: "PayPal confirmed this call." },
  pending: { label: "In flight", tone: "active", help: "Sent to PayPal; waiting for the answer." },
  unknown: { label: "Rechecking", tone: "held", help: "The answer was lost. A sync re-reads PayPal before anything is retried." },
  failed: { label: "Refused", tone: "failed", help: "PayPal refused this attempt. Nothing moved; the next attempt gets a new key." },
};

const asStatus = (s: string): LedgerStatus => (s === "succeeded" || s === "pending" || s === "failed" || s === "unknown" ? s : "unknown");

export const ACTOR_LABEL: Record<string, string> = {
  client: "Client",
  freelancer: "Worker",
  worker: "Worker",
  system: "Fixed rules",
  paypal: "PayPal",
  ai: "AI reviewer",
  dev: "Dev action",
};
export const actorLabel = (actor: string | undefined) => (actor ? (ACTOR_LABEL[actor] ?? actor) : "Fixed rules");

/** The amount a money action moved (or would move), from the milestone's cent columns. */
export function amountFor(kind: LedgerKind, m: MilestoneView): number | null {
  const n = (v: unknown) => (typeof v === "number" ? v : null);
  switch (kind) {
    case "order":
      return m.amount_cents;
    case "hold":
    case "void":
    case "reauthorize":
      return n(m.authorized_cents) ?? m.amount_cents;
    case "capture":
      return n(m.captured_cents);
    case "payout":
      return n(m.payout_cents);
  }
}

const time = (s: string) => new Date(s).getTime();

/**
 * One row per money action. Each claim row is joined with the audit event it wrote (same PayPal id, or
 * the matching event nearest after the claim) for its time and actor. Money events in the proof trail
 * with no claim row (seeded demo history) are added as "trail" rows, with no attempt.
 */
export function buildLedgerRows(input: LedgerInput): LedgerRow[] {
  const { role, milestone: m, audit, actions } = input;
  const used = new Set<string>();
  const rows: LedgerRow[] = [];
  const base = { milestoneId: m.id, milestone: m.title, role };

  actions.forEach((a, i) => {
    let kind = kindOf(a.action);
    if (!kind) return;
    const events = new Set([SUCCESS_EVENT[kind], `${a.action}:refused`, `${a.action}:unknown`, `${a.action}:settled`]);
    if (kind === "payout") events.add("payout:succeeded");
    // Card funding: one create_order call returns the authorization itself and writes hold:authorized.
    if (kind === "order") events.add("hold:authorized");
    const candidates = audit.filter((e) => !used.has(String(e.id)) && events.has(e.event));
    const match =
      (a.paypal_id && candidates.find((e) => e.paypal_id === a.paypal_id)) ||
      candidates.find((e) => time(e.created_at) >= time(a.created_at) - 5_000) ||
      undefined;
    if (match) used.add(String(match.id));
    if (kind === "order" && match?.event === "hold:authorized") kind = "hold";
    const status = asStatus(a.status);
    rows.push({
      ...base,
      key: `${m.id}:claim:${i}`,
      at: match?.created_at ?? a.created_at,
      kind,
      action: KIND_LABEL[kind],
      amountCents: status === "failed" && (kind === "capture" || kind === "payout") ? null : amountFor(kind, m),
      status,
      attempt: a.attempt,
      requestId: requestIdOf(m.id, a.action, a.attempt),
      paypalId: a.paypal_id ?? match?.paypal_id ?? null,
      actor: actorLabel(match?.actor),
      source: "claim",
    });
  });

  const claimed = new Set(rows.map((r) => r.kind));
  const hasPayoutCreated = audit.some((e) => e.event === "payout:created");
  audit.forEach((e) => {
    const kind = TRAIL_EVENT[e.event];
    if (!kind || used.has(String(e.id)) || claimed.has(kind)) return;
    // payout:succeeded only stands in for the payout when the trail has no payout:created.
    if (e.event === "payout:succeeded" && hasPayoutCreated) return;
    rows.push({
      ...base,
      key: `${m.id}:trail:${e.id}`,
      at: e.created_at,
      kind,
      action: KIND_LABEL[kind],
      amountCents: amountFor(kind, m),
      status: "succeeded",
      attempt: null,
      requestId: null,
      paypalId: e.paypal_id,
      actor: actorLabel(e.actor),
      source: "trail",
    });
  });

  return rows.sort((a, b) => time(a.at) - time(b.at));
}

/** States in which the PayPal hold is live: money held, not captured. */
const LIVE_HOLD = new Set(["FUNDED", "SUBMITTED", "IN_REVIEW", "CHANGES_REQUESTED", "HUMAN_CHECK", "PASSED", "CONTESTED"]);
const CAPTURED = new Set(["RELEASED", "PAID_OUT", "PAYOUT_FAILED", "DISPUTE"]);

export type LedgerTotals = { heldNow: number; captured: number; paypalFees: number; platformFees: number; paidOut: number };

const cents = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Where the money stands across these milestones, in cents. */
export function ledgerTotals(milestones: MilestoneView[]): LedgerTotals {
  const t: LedgerTotals = { heldNow: 0, captured: 0, paypalFees: 0, platformFees: 0, paidOut: 0 };
  for (const m of milestones) {
    if (LIVE_HOLD.has(m.state)) t.heldNow += cents(m.authorized_cents ?? m.amount_cents);
    if (CAPTURED.has(m.state)) {
      t.captured += cents(m.captured_cents);
      t.paypalFees += cents(m.paypal_fee_cents) + cents(m.payout_fee_cents);
      t.platformFees += cents(m.fee_cents);
    }
    if (m.state === "PAID_OUT") t.paidOut += cents(m.payout_cents);
  }
  return t;
}

/** Pinned bottom rows for the ledger: one labelled row per total (the label sits in the Action column). */
export type TotalRow = { key: string; action: string; amountCents: number; help: string };

export function totalRows(t: LedgerTotals): TotalRow[] {
  return [
    { key: "total:held", action: "Held now", amountCents: t.heldNow, help: "On PayPal holds that are still live. Not charged." },
    { key: "total:captured", action: "Captured", amountCents: t.captured, help: "Charged to the client after the work passed." },
    { key: "total:paypal", action: "PayPal fees", amountCents: t.paypalFees, help: "PayPal's capture and payout fees." },
    { key: "total:platform", action: "Platform fees", amountCents: t.platformFees, help: "Milestone's fee on captured money." },
    { key: "total:paid", action: "Paid out", amountCents: t.paidOut, help: "Payouts the worker received." },
  ];
}

// ---------- Portfolio (/milestones) ----------

/** Where the money is now, as one word plus amount. */
export function moneyNow(m: MilestoneView): { word: "Held" | "Captured" | "Paid" | "None"; cents: number | null; tone: Tone } {
  if (LIVE_HOLD.has(m.state)) return { word: "Held", cents: m.authorized_cents ?? m.amount_cents, tone: "held" };
  if (m.state === "PAID_OUT") return { word: "Paid", cents: m.payout_cents ?? null, tone: "paid" };
  if (CAPTURED.has(m.state)) return { word: "Captured", cents: m.captured_cents ?? null, tone: m.state === "RELEASED" ? "paid" : "failed" };
  return { word: "None", cents: null, tone: "neutral" };
}

/** Whole days left on a live PayPal hold (0 on its last day), or null when no hold is live. */
export function holdDaysLeft(m: MilestoneView, now = Date.now()): number | null {
  if (!LIVE_HOLD.has(m.state) || !m.authorization_expires_at) return null;
  const t = new Date(m.authorization_expires_at).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - now) / 86_400_000));
}

/** Under this many days a hold is urgent (shown in red, with words). */
export const HOLD_URGENT_DAYS = 3;

const usdShort = (c: number | null | undefined) => (c == null ? "" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/**
 * The phrase the deal room's next-step panel leads with, from state and role (the same titles as
 * NextStep in src/app/milestones/[id]/NextStep.tsx, without its live countdown). `yours` is true when
 * the next move is this role's.
 */
export function nextAction(m: MilestoneView, role: Role): { text: string; yours: boolean } {
  const client = role === "client";
  const other = client ? "worker" : "client";
  const hash = m.criteria_hash ?? "";
  const signedMine = !!hash && (client ? m.client_signed_hash : m.worker_signed_hash) === hash;
  switch (m.state) {
    case "DRAFT":
      if (!m.criteria) return client ? { text: "Draft the terms", yours: true } : { text: "Waiting for the terms", yours: false };
      if (!signedMine) return { text: client ? "Review and sign the terms" : "Read the terms, then sign", yours: true };
      return { text: `Waiting for the ${other} to sign`, yours: false };
    case "AGREED":
      return client ? { text: `Fund ${usdShort(m.amount_cents)}`, yours: true } : { text: "Waiting for the client to fund", yours: false };
    case "FUNDED":
      return client ? { text: "Waiting for the delivery", yours: false } : { text: "Deliver the work", yours: true };
    case "CHANGES_REQUESTED":
      return client ? { text: "Waiting for the worker's fix", yours: false } : { text: "Fix and resubmit", yours: true };
    case "SUBMITTED":
    case "IN_REVIEW":
      return { text: "Checking the work", yours: false };
    case "HUMAN_CHECK":
      return client ? { text: "Your decision", yours: true } : { text: "Waiting for the client's decision", yours: false };
    case "PASSED":
      return { text: "Approved, releasing soon", yours: false };
    case "CONTESTED":
      return client ? { text: "Objection recorded", yours: false } : { text: "The client objected", yours: false };
    case "RELEASED":
      return { text: "Paying the worker", yours: false };
    case "PAID_OUT":
      return { text: client ? "Done. The worker was paid." : `You were paid ${usdShort(m.payout_cents)}`, yours: false };
    case "PAYOUT_FAILED":
      return { text: "The payout came back", yours: false };
    case "DISPUTE":
      return { text: "PayPal is deciding the dispute", yours: false };
    case "CANCELLED":
      return { text: "Cancelled", yours: false };
    default:
      return { text: STATUS[m.state]?.label ?? "Open the deal room", yours: false };
  }
}

export type PortfolioRow = {
  id: string;
  title: string;
  role: Role;
  status: string;
  tone: Tone;
  amountCents: number;
  money: ReturnType<typeof moneyNow>;
  holdDays: number | null;
  due: string | null;
  next: { text: string; yours: boolean };
  saveLink: boolean;
};

export function portfolioRow(m: MilestoneView, role: Role, saveLink: boolean, now = Date.now()): PortfolioRow {
  const s = STATUS[m.state] ?? { label: "Open the deal room", tone: "neutral" as const };
  return {
    id: m.id,
    title: m.title,
    role,
    status: s.label,
    tone: s.tone,
    amountCents: m.amount_cents,
    money: moneyNow(m),
    holdDays: holdDaysLeft(m, now),
    due: m.due_at ?? null,
    next: nextAction(m, role),
    saveLink,
  };
}
