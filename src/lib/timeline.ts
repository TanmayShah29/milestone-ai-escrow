import type { Milestone } from "@/lib/milestones/repo";
import { signedObjectionMs } from "@/lib/review/deadlines";

// Builds the Gantt view of a milestone: its phases as tasks, the money gates between them as
// dependencies, and the hold's lifetime (day-3 honor period, day-29 expiry) as indicators and bands.
// Planned dates make the bars readable at project scale; what actually happened (from the audit log)
// sets status, progress and the tooltip. Pure: no DB or network, so it is unit-tested directly.
// Scheduling: a phase that already ended (it has a real timestamp) is pinned (`manuallyScheduled`); a
// future phase is auto-scheduled by Bryntum's engine, so moving the Work bar's end pushes Review, the
// objection window and the payout along the dependencies. Work carries the hold's cap as a
// "finish no later than" constraint (Bryntum's name for "must finish on or before").
//
// The chart reacts to what happened, from the audit log:
// - every submission and review cycle is drawn: a failed review gets its own red bar, then a "Rework" bar
//   up to the next submission, and the later phases move right by the time that took. They carry a
//   baseline (Bryntum's Baselines feature) where they would have been had the first review passed, and an
//   event marker ("Review failed: C2 — rescheduled") says why they moved;
// - a voided or expired hold (CANCELLED) marks every phase that hadn't finished as cancelled;
// - a reauthorized hold shows its new 3-day honor period from the reauthorization;
// - a PayPal dispute gets a marker; a payout gets a milestone diamond at the real time, with the amount.
// Nothing here moves money: it only reads the audit log. The schedule API is the only write the Gantt makes.

// "unfunded": the PayPal hold has not been placed yet (nothing is held, so it is never shown as active).
// "cancelled": the hold was voided or expired (or the deal was cancelled) before this phase finished.
export type PhaseStatus = "done" | "active" | "blocked" | "failed" | "todo" | "unfunded" | "cancelled";

/** An event pinned to a bar's row (drawn by the Gantt's Indicators feature, with this text as its tooltip). */
export type TimelineMarker = {
  date: string;
  label: string;
  kind: "review_failed" | "reauthorized" | "voided" | "expired" | "cancelled" | "dispute" | "paid";
};

export type TimelineTask = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  manuallyScheduled: boolean;
  percentDone: number;
  cls: string;
  iconCls: string;
  status: PhaseStatus;
  note: string;
  draggable: boolean;
  resizable: boolean | "end";
  deadlineDate?: string;
  expanded?: boolean;
  children?: TimelineTask[];
  eventColor: string;
  honorStart?: string; // hold: start of the current 3-day honor period (the authorization, or the last reauthorization)
  honorEnd?: string; // hold: end of the 3-day honor period
  holdExpiry?: string; // hold: 29-day expiry
  holdWarn?: boolean; // the work is due after the hold expires
  dueLimit?: string; // work: the latest due date the PayPal hold allows (see latestDueAt)
  canReschedule?: boolean; // work: the due date can still be moved (the API accepts it in this state)
  constraintType?: "finishnolaterthan"; // work: Bryntum's "must finish on or before", at dueLimit
  constraintDate?: string;
  holdExpiring?: boolean; // hold: live and within 3 days of its expiry (drawn red)
  /** Where this phase was planned before a failed review pushed it (Bryntum baselines). */
  baselines?: { startDate: string; endDate: string }[];
  /** Why this phase moved, in words (shown in the tooltip). */
  movedBy?: string;
  markers?: TimelineMarker[];
  milestoneId: string;
  phase?: string;
};

// Bryntum dependency types: 0 start-to-start, 2 finish-to-start. `active: false` draws a link without scheduling by it.
export type TimelineDependency = { id: string; fromTask: string; toTask: string; type: 0 | 2; cls?: string; active?: boolean };
export type Timeline = { tasks: TimelineTask[]; dependencies: TimelineDependency[]; warnings: string[] };

export type AuditRow = { event: string; to_state: string | null; created_at: Date | string; detail?: unknown };

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const t = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : undefined);

const ICON: Record<string, string> = {
  terms: "fa fa-file-signature",
  hold: "fa fa-sack-dollar",
  work: "fa fa-code",
  review: "fa fa-magnifying-glass",
  reviewFailed: "fa fa-circle-xmark",
  rework: "fa fa-rotate-left",
  window: "fa fa-hourglass-half",
  payout: "fa fa-money-bill-wave",
  paid: "fa fa-circle-check",
};

const COLOR: Record<PhaseStatus, string> = { done: "green", active: "blue", blocked: "gray", failed: "red", todo: "gray", unfunded: "gray", cancelled: "gray" };

/** States in which the client can still move the work's due date (the schedule API enforces the same rule). */
export const RESCHEDULABLE_STATES = ["DRAFT", "AGREED", "FUNDED"] as const;
export const canMoveDueDate = (state: string) => (RESCHEDULABLE_STATES as readonly string[]).includes(state);

// PayPal holds (authorizations) are valid for 29 days from the original authorization. Reauthorizing
// gives a new 3-day honor period but never extends the 29 days, so a milestone's work must be due with
// margin to review, wait out the objection window and capture before the hold expires.
export const HOLD_VALID_DAYS = 29;
export const DUE_MARGIN_DAYS = 3;
/** A live hold this close to its expiry is drawn red (it must be captured or it lapses). */
export const HOLD_EXPIRING_DAYS = 3;
const HONOR_DAYS = 3;

const capDate = (x: number) => new Date(x).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * The latest due date the PayPal hold allows: its expiry minus 3 days once funded. Before funding the
 * hold doesn't exist yet and will be placed no earlier than now, so 29 − 3 = 26 days from creation (or
 * from now, if the milestone was created earlier: a later hold expires later).
 */
export function latestDueAt(m: Pick<Milestone, "created_at" | "authorization_expires_at">, now = Date.now()): Date {
  const expiry = t(m.authorization_expires_at);
  if (expiry) return new Date(expiry - DUE_MARGIN_DAYS * DAY);
  return new Date(Math.max(t(m.created_at) ?? now, now) + (HOLD_VALID_DAYS - DUE_MARGIN_DAYS) * DAY);
}

/** Why a due date past latestDueAt is refused (shown by the schedule API and the Gantt). */
export function dueCapMessage(limit: Date): string {
  return `PayPal holds last ${HOLD_VALID_DAYS} days, so the work must be due by ${capDate(limit.getTime())}. Split longer work into milestones.`;
}

/** The work is due after the PayPal hold expires (holds can't be extended past 29 days). */
export function holdWarning(m: Pick<Milestone, "title" | "due_at" | "authorization_expires_at" | "state">): string | undefined {
  const due = t(m.due_at);
  const expiry = t(m.authorization_expires_at);
  if (!due || !expiry || ["RELEASED", "PAID_OUT", "CANCELLED"].includes(m.state)) return undefined;
  return due > expiry ? `“${m.title}”: the work is due after the PayPal hold expires on ${capDate(expiry)}. Move the date earlier; holds can't be extended past ${HOLD_VALID_DAYS} days.` : undefined;
}

/** "2d 4h", "35 min": how long something took, for "why it moved" notes. */
export function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

const DECISION = /^review:(passed|changes_requested|human_check|approved_by_client|changes_by_client|second)$/;

/** The criteria a failed review names ("C2, C3 failed" in its reasons), or undefined. */
export function failedCriteria(detail: unknown): string[] | undefined {
  const reasons = (detail as { reasons?: unknown } | null | undefined)?.reasons;
  if (!Array.isArray(reasons)) return undefined;
  const ids = reasons.flatMap((r) => (typeof r === "string" && /\bfailed\b/.test(r) ? (r.match(/\bC\d+\b/g) ?? []) : []));
  return ids.length ? [...new Set(ids)] : undefined;
}

/** The words for a review that sent the work back: "Review failed: C2 — rescheduled". */
export function reviewFailedLabel(row: Pick<AuditRow, "event" | "detail">): string {
  if (row.event === "review:changes_by_client") return "The client asked for changes — rescheduled";
  const ids = failedCriteria(row.detail);
  const injection = (row.detail as { injection?: unknown } | null | undefined)?.injection === true;
  if (ids) return `Review failed: ${ids.join(", ")}${injection ? " (and text aimed at the reviewer)" : ""} — rescheduled`;
  return injection ? "Review failed: text aimed at the reviewer — rescheduled" : "Review failed — rescheduled";
}

type Cycle = { submitted: number; decided?: number; failed: boolean; row?: AuditRow };

/**
 * Every submission and the review that settled it (the last decision before the next submission, so a
 * pass the client later sent back counts as sent back).
 */
export function reviewCycles(audit: AuditRow[]): Cycle[] {
  const subs = audit.filter((a) => a.event === "deliverable:submitted").map((a) => t(a.created_at)!);
  const decisions = audit.filter((a) => DECISION.test(a.event));
  return subs.map((submitted, i) => {
    const next = subs[i + 1] ?? Infinity;
    const row = decisions.filter((d) => t(d.created_at)! >= submitted && t(d.created_at)! < next).at(-1);
    return { submitted, decided: t(row?.created_at), failed: row?.to_state === "CHANGES_REQUESTED", ...(row ? { row } : {}) };
  });
}

type Key = string;
type Phase = {
  key: Key;
  name: string;
  start: number;
  end: number;
  status: PhaseStatus;
  note: string;
  auto: boolean;
  icon: string;
  extra?: Partial<TimelineTask>;
};

export function buildTimeline(m: Milestone, audit: AuditRow[], now = Date.now()): Timeline {
  const at = (pred: (a: AuditRow) => boolean) => t(audit.find(pred)?.created_at);
  const last = (pred: (a: AuditRow) => boolean) => t([...audit].reverse().find(pred)?.created_at);
  const money = (c: number | null | undefined) => (c == null ? "" : `$${(c / 100).toFixed(2)}`);

  const created = t(m.created_at)!;
  const agreed = at((a) => a.event === "terms:agreed");
  const held = at((a) => a.event === "hold:authorized");
  const reauths = audit.filter((a) => a.event === "hold:reauthorized").map((a) => t(a.created_at)!);
  const cycles = reviewCycles(audit);
  const submitted = cycles[0]?.submitted;
  const lastCycle = cycles.at(-1);
  const passed = last((a) => a.to_state === "PASSED");
  const released = at((a) => a.to_state === "RELEASED");
  const paid = at((a) => a.to_state === "PAID_OUT");
  const cancelled = at((a) => a.to_state === "CANCELLED");
  const endRow = audit.find((a) => a.event === "hold:voided" || a.event === "hold:ended");
  const disputed = audit.find((a) => a.event === "dispute:opened");
  const due = t(m.due_at) ?? created + 7 * DAY;
  const s = m.state;
  const live = !cancelled && s !== "PAID_OUT";

  // What happened uses its real dates; what hasn't happened yet uses the plan. Every bar is at least five
  // minutes long so a phase that took seconds (a live demo run) is still visible after zoom-to-fit.
  const MIN_BAR = 5 * 60_000;
  const span = (start: number, end: number) => [start, Math.max(end, start + MIN_BAR)] as const;
  const fmt = (x?: number) => (x ? new Date(x).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "not yet");

  const phases: Phase[] = [];
  const push = (p: Phase) => phases.push(p);

  // Terms and the hold: the parties' and PayPal's clocks, never moved by the schedule.
  const [termsStart, termsEnd] = span(created, agreed ?? created + DAY);
  push({ key: "terms", name: "Terms signed", start: termsStart, end: termsEnd, status: agreed ? "done" : s === "DRAFT" ? "active" : "todo", note: `Fingerprint ${m.criteria_hash?.slice(0, 12) ?? "pending"} · agreed ${fmt(agreed)}`, auto: false, icon: ICON.terms! });

  const holdStart = held ?? termsEnd;
  const [, holdEnd] = span(holdStart, released ?? cancelled ?? t(m.authorization_expires_at) ?? holdStart + HOLD_VALID_DAYS * DAY);
  const expiry = t(m.authorization_expires_at);
  const warning = holdWarning(m);
  const holdLive = !!held && !released && !cancelled;
  const holdExpiring = holdLive && !!expiry && expiry - now <= HOLD_EXPIRING_DAYS * DAY;
  // A reauthorization opens a new 3-day honor period (it never extends the 29 days).
  const honorStart = reauths.at(-1) ?? held;
  const honorEnd = honorStart ? honorStart + HONOR_DAYS * DAY : undefined;
  const holdMarkers: TimelineMarker[] = reauths.map((r) => ({ date: iso(r), label: "Hold reauthorized: a new 3-day honor period (the 29 days don't extend)", kind: "reauthorized" }));
  if (endRow) {
    const ended = t(endRow.created_at)!;
    holdMarkers.push(endRow.event === "hold:ended" ? { date: iso(ended), label: "PayPal ended the hold (it expired): nothing was charged", kind: "expired" } : { date: iso(ended), label: "PayPal voided the hold: nothing was charged", kind: "voided" });
  }
  const holdStatus: PhaseStatus = cancelled && held ? "cancelled" : held ? (released ? "done" : "active") : "unfunded";
  push({
    key: "hold",
    name: held ? `PayPal hold ${money(m.authorized_cents ?? m.amount_cents)}` : `PayPal hold (not funded) ${money(m.amount_cents)}`,
    start: holdStart,
    end: holdEnd,
    status: holdStatus,
    note: `${held ? "" : "Not funded yet: the client approves the hold on PayPal · "}Authorization ${m.paypal_authorization_id ?? "not yet"} · held ${fmt(held)}${reauths.length ? ` · reauthorized ${fmt(reauths.at(-1))}` : ""} · expires ${fmt(expiry)}${released ? ` · captured ${fmt(released)}` : ""}${endRow ? ` · ${endRow.event === "hold:ended" ? "expired" : "voided"} ${fmt(t(endRow.created_at))}` : ""}${warning ? ` · ${warning}` : ""}`,
    auto: false,
    icon: ICON.hold!,
    extra: {
      ...(holdLive ? { ...(honorStart ? { honorStart: iso(honorStart), honorEnd: iso(honorEnd!) } : {}), ...(expiry ? { holdExpiry: iso(expiry) } : {}), holdWarn: !!warning, holdExpiring } : {}),
      ...(holdExpiring ? { eventColor: "red", cls: "ms-phase ms-expiring" } : warning && holdLive ? { eventColor: "orange", cls: "ms-phase ms-warn" } : {}),
      ...(holdMarkers.length ? { markers: holdMarkers } : {}),
    },
  });

  // Work: from the hold to the first submission (or the due date).
  const editableDue = !submitted && canMoveDueDate(s);
  const limit = editableDue ? latestDueAt(m, now) : undefined;
  const [workStart, workEnd] = span(holdStart, submitted ?? Math.max(due, holdStart + DAY));
  const workAuto = live && !submitted;
  // The cap becomes an engine constraint only when the current plan meets it (a row already past it is
  // flagged by holdWarning instead; a constraint it already breaks would raise a conflict on load).
  const constrain = workAuto && limit && workEnd <= limit.getTime();
  push({
    key: "work",
    name: "Work",
    start: workStart,
    end: workEnd,
    status: submitted ? "done" : held ? (now > due ? "failed" : "active") : "blocked",
    note: `Due ${fmt(due)} · submitted ${fmt(submitted)}${m.pr_url ? ` · ${m.pr_url}` : ""}`,
    auto: workAuto,
    icon: ICON.work!,
    extra: {
      deadlineDate: iso(due),
      resizable: editableDue ? "end" : false,
      canReschedule: editableDue,
      ...(limit ? { dueLimit: limit.toISOString() } : {}),
      ...(constrain ? { constraintType: "finishnolaterthan" as const, constraintDate: limit.toISOString() } : {}),
    },
  });

  // Every review that sent the work back, then the rework up to the next submission (or still going).
  const failedCycles = cycles.filter((c) => c.failed);
  const reasons: string[] = [];
  let cursor = workEnd;
  failedCycles.forEach((c, i) => {
    const k = i + 1;
    const decided = c.decided ?? c.submitted;
    const label = reviewFailedLabel(c.row ?? { event: "", detail: null });
    reasons.push(label.replace(/ — rescheduled$/, ""));
    const [rStart, rEnd] = span(c.submitted, decided);
    push({ key: `review-${k}`, name: failedCycles.length > 1 ? `Review ${k}: sent back` : "Review: sent back", start: rStart, end: rEnd, status: "failed", note: `${label.replace(/ — rescheduled$/, "")} · decided ${fmt(decided)} · the money stayed on hold`, auto: false, icon: ICON.reviewFailed! });
    const next = cycles[cycles.indexOf(c) + 1]?.submitted;
    const ongoing = next === undefined;
    const reworkStatus: PhaseStatus = ongoing ? "active" : "done"; // a cancelled deal turns an ongoing rework "cancelled" below
    const [wStart, wEnd] = span(rEnd, next ?? (cancelled ?? Math.max(now, rEnd + DAY)));
    push({
      key: `rework-${k}`,
      name: failedCycles.length > 1 ? `Rework ${k}` : "Rework",
      start: wStart,
      end: wEnd,
      status: reworkStatus,
      note: next ? `The worker fixed it and resubmitted ${fmt(next)} · took ${duration(next - rEnd)}` : cancelled ? "Not resubmitted before the hold ended" : "Waiting for the worker's fix",
      auto: false,
      icon: ICON.rework!,
      extra: { cls: `ms-phase ms-${reworkStatus} ms-rework`, markers: [{ date: iso(decided), label, kind: "review_failed" }] },
    });
    cursor = wEnd;
  });

  // The review that decides: of the last submission, unless that one was sent back (then a planned one).
  const finalDecided = lastCycle && !lastCycle.failed ? lastCycle.decided : undefined;
  const finalSubmitted = lastCycle && !lastCycle.failed ? lastCycle.submitted : undefined;
  const [reviewStart, reviewEnd] = span(finalSubmitted ?? cursor, finalDecided ?? (finalSubmitted ?? cursor) + DAY);
  const after = (states: string[]) => states.includes(s);
  const reviewStatus: PhaseStatus = finalDecided && after(["PASSED", "CONTESTED", "RELEASED", "PAID_OUT", "PAYOUT_FAILED", "DISPUTE", "HUMAN_CHECK"]) ? (s === "HUMAN_CHECK" ? "active" : "done") : after(["SUBMITTED", "IN_REVIEW"]) ? "active" : "blocked";
  push({ key: "review", name: "Review (CI + AI, fixed rules)", start: reviewStart, end: reviewEnd, status: reviewStatus, note: `Decision ${fmt(finalDecided)} · state ${s}`, auto: live && !finalDecided, icon: ICON.review! });

  const [windowStart, windowEnd] = span(reviewEnd, released ?? (passed && t(m.release_after) ? t(m.release_after)! : reviewEnd + Math.max(signedObjectionMs(m.criteria), 2 * DAY)));
  push({ key: "window", name: "Objection window", start: windowStart, end: windowEnd, status: s === "CONTESTED" ? "failed" : released || (passed && after(["RELEASED", "PAID_OUT", "PAYOUT_FAILED", "DISPUTE"])) ? "done" : s === "PASSED" ? "active" : "blocked", note: `Release after ${fmt(t(m.release_after))}`, auto: live && !released, icon: ICON.window! });

  const [payoutStart, payoutEnd] = span(windowEnd, paid ?? windowEnd + DAY);
  const payoutMarkers: TimelineMarker[] = disputed ? [{ date: iso(t(disputed.created_at)!), label: "PayPal dispute opened: PayPal decides it, not Milestone", kind: "dispute" }] : [];
  push({
    key: "payout",
    name: `Payout ${money(m.payout_cents)}`,
    start: payoutStart,
    end: payoutEnd,
    status: paid || s === "PAID_OUT" ? "done" : s === "PAYOUT_FAILED" ? "failed" : s === "RELEASED" ? "active" : "blocked",
    note: `Captured ${fmt(released)} · paid ${fmt(paid)}${m.paypal_payout_item_id ? ` · item ${m.paypal_payout_item_id}` : ""}${disputed ? ` · dispute opened ${fmt(t(disputed.created_at))}` : ""}`,
    auto: live && !paid,
    icon: ICON.payout!,
    extra: payoutMarkers.length ? { markers: payoutMarkers, cls: "ms-phase ms-done ms-dispute" } : {},
  });

  // Paid: a milestone (zero-length task, drawn as a diamond) at the moment PayPal paid the worker.
  if (paid) push({ key: "paid", name: `Paid ${money(m.payout_cents)}`, start: paid, end: paid, status: "done", note: `PayPal paid the worker ${money(m.payout_cents)} after fees${m.paypal_payout_item_id ? ` · payout item ${m.paypal_payout_item_id}` : ""} · ${fmt(paid)}`, auto: false, icon: ICON.paid! });

  // A voided or expired hold (or a cancelled deal) ends everything that hadn't finished.
  if (cancelled) {
    const why = endRow ? (endRow.event === "hold:ended" ? "PayPal ended the hold (it expired)" : "PayPal voided the hold") : "The deal was cancelled before funding";
    // Phases that never started are drawn as short hatched stubs after the cancellation, not at their
    // old planned dates (they will never happen), so the chart ends where the deal did.
    let stub = cancelled;
    for (const p of phases) {
      if (!["blocked", "todo", "active", "unfunded"].includes(p.status)) continue;
      p.status = "cancelled";
      p.note = `Cancelled: ${why}. Nothing was charged. · ${p.note}`;
      p.auto = false;
      if (p.start >= cancelled) {
        p.start = stub;
        p.end = stub + MIN_BAR;
        stub = p.end;
      }
    }
    if (!endRow) phases[0]!.extra = { ...phases[0]!.extra, markers: [{ date: iso(cancelled), label: why, kind: "cancelled" }] };
  }

  // Why the later phases moved: they'd have started at the first submission had its review passed.
  const shift = failedCycles.length && submitted ? reviewStart - submitted : 0;
  if (shift > 0) {
    const movedBy = `Moved ${duration(shift)} later: ${reasons.join("; ")}, then rework`;
    for (const p of phases) {
      if (!["review", "window", "payout", "paid"].includes(p.key) || p.status === "cancelled") continue;
      p.extra = { ...p.extra, baselines: [{ startDate: iso(p.start - shift), endDate: iso(p.end - shift) }], movedBy };
    }
  }

  const children: TimelineTask[] = phases.map((p) => ({
    id: `${m.id}:${p.key}`,
    name: p.name,
    startDate: iso(p.start),
    endDate: iso(p.end),
    manuallyScheduled: !p.auto,
    percentDone: p.status === "done" ? 100 : p.status === "active" ? 50 : 0,
    cls: `ms-phase ms-${p.status}`,
    iconCls: p.status === "blocked" || p.status === "unfunded" ? "fa fa-lock" : p.status === "cancelled" ? "fa fa-ban" : p.icon,
    eventColor: COLOR[p.status],
    status: p.status,
    note: p.note,
    draggable: false,
    resizable: false,
    milestoneId: m.id,
    phase: p.key,
    ...p.extra,
    // A cancelled phase is cancelled, whatever its extra styling said while the hold was live.
    ...(p.status === "cancelled" ? { cls: `ms-phase ms-cancelled${p.key.startsWith("rework") ? " ms-rework" : ""}`, eventColor: COLOR.cancelled } : {}),
  }));

  const allDone = s === "PAID_OUT";
  const auto = phases.some((p) => p.auto);
  const parent: TimelineTask = {
    id: m.id,
    name: `${m.title} · ${money(m.amount_cents)}`,
    startDate: iso(termsStart),
    endDate: iso(Math.max(...phases.map((p) => p.end), holdEnd)),
    // A pinned parent ignores its children; while any phase can move, the parent rolls them up instead.
    manuallyScheduled: !auto,
    percentDone: Math.round((children.filter((c) => c.status === "done").length / children.length) * 100),
    cls: `ms-milestone ${allDone ? "ms-done" : cancelled ? "ms-cancelled" : s === "DISPUTE" ? "ms-dispute" : ""}`,
    iconCls: "fa fa-flag",
    eventColor: allDone ? "green" : cancelled ? "gray" : s === "DISPUTE" ? "orange" : "indigo",
    status: allDone ? "done" : cancelled ? "cancelled" : "active",
    note: `State ${s}`,
    draggable: false,
    resizable: false,
    expanded: true,
    children,
    milestoneId: m.id,
  };

  // The gates, in order. The hold bar spans the hold's whole life, so it gates the work's start
  // (start-to-start): work begins when the money is held, not when the hold ends. Every other gate is
  // finish-to-start; a link out of a failed review is the rework loop.
  const dependencies: TimelineDependency[] = phases.slice(1).map((p, i) => {
    const from = phases[i]!;
    return {
      id: `${m.id}:dep:${from.key}-${p.key}`,
      fromTask: `${m.id}:${from.key}`,
      toTask: `${m.id}:${p.key}`,
      type: p.key === "work" ? 0 : 2,
      cls: from.key.startsWith("review-") ? "ms-dep-rework" : from.status === "done" ? "ms-dep-open" : "ms-dep-gate",
    };
  });
  if (m.after_milestone_id) {
    // Payment tranche: this milestone's work waits on the previous milestone's payout. Drawn, not
    // scheduled by: each milestone's dates are planned (and capped) against its own hold on the server.
    dependencies.push({ id: `${m.id}:dep:after`, fromTask: `${m.after_milestone_id}:payout`, toTask: `${m.id}:work`, type: 2, cls: "ms-dep-tranche", active: false });
  }

  return { tasks: [parent], dependencies, warnings: warning ? [warning] : [] };
}
