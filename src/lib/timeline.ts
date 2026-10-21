import type { Milestone } from "@/lib/milestones/repo";

// Builds the Gantt view of a milestone: its phases as tasks, the money gates between them as
// finish-to-start dependencies, and the hold's lifetime (day-3 honor period, day-29 expiry) as indicators.
// Planned dates make the bars readable at project scale; what actually happened (from the audit log)
// sets status, progress and the tooltip. Pure: no DB or network, so it is unit-tested directly.

export type PhaseStatus = "done" | "active" | "blocked" | "failed" | "todo";

export type TimelineTask = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  manuallyScheduled: true;
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
  honorEnd?: string; // hold: end of the 3-day honor period
  holdExpiry?: string; // hold: 29-day expiry
  holdWarn?: boolean; // the work is due after the hold expires
  milestoneId: string;
  phase?: string;
};

export type TimelineDependency = { id: string; fromTask: string; toTask: string; type: 2; cls?: string };
export type Timeline = { tasks: TimelineTask[]; dependencies: TimelineDependency[]; warnings: string[] };

type AuditRow = { event: string; to_state: string | null; created_at: Date | string };

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const t = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : undefined);

const ICON: Record<string, string> = {
  terms: "fa fa-file-signature",
  hold: "fa fa-sack-dollar",
  work: "fa fa-code",
  review: "fa fa-magnifying-glass",
  window: "fa fa-hourglass-half",
  payout: "fa fa-money-bill-wave",
};

const COLOR: Record<PhaseStatus, string> = { done: "green", active: "blue", blocked: "gray", failed: "red", todo: "gray" };

export function objectionMs(): number {
  const s = Number(process.env.OBJECTION_WINDOW_SECONDS ?? "120");
  return (Number.isFinite(s) && s >= 0 ? s : 120) * 1000;
}

/** When the hold needs reauthorizing before the work is due (PayPal holds expire after 29 days). */
export function holdWarning(m: Pick<Milestone, "due_at" | "authorization_expires_at" | "state">): string | undefined {
  const due = t(m.due_at);
  const expiry = t(m.authorization_expires_at);
  if (!due || !expiry || ["RELEASED", "PAID_OUT", "CANCELLED"].includes(m.state)) return undefined;
  return due > expiry ? "The work is due after the PayPal hold expires: reauthorize the hold or move the date." : undefined;
}

export function buildTimeline(m: Milestone, audit: AuditRow[], now = Date.now()): Timeline {
  const at = (pred: (a: AuditRow) => boolean) => t(audit.find(pred)?.created_at);
  const last = (pred: (a: AuditRow) => boolean) => t([...audit].reverse().find(pred)?.created_at);
  const money = (c: number | null | undefined) => (c == null ? "" : `$${(c / 100).toFixed(2)}`);

  const created = t(m.created_at)!;
  const agreed = at((a) => a.event === "terms:agreed");
  const held = at((a) => a.event === "hold:authorized");
  const submitted = at((a) => a.event === "deliverable:submitted");
  const decided = last((a) => /^review:(passed|changes_requested|human_check|approved_by_client)/.test(a.event));
  const passed = last((a) => a.to_state === "PASSED");
  const released = at((a) => a.to_state === "RELEASED");
  const paid = at((a) => a.to_state === "PAID_OUT");
  const cancelled = at((a) => a.to_state === "CANCELLED");
  const due = t(m.due_at) ?? created + 7 * DAY;
  const s = m.state;

  // What happened uses its real dates; what hasn't happened yet uses the plan. Every bar is at least five
  // minutes long so a phase that took seconds (a live demo run) is still visible after zoom-to-fit.
  const MIN_BAR = 5 * 60_000;
  const span = (start: number, end: number) => [start, Math.max(end, start + MIN_BAR)] as const;
  const [termsStart, termsEnd] = span(created, agreed ?? created + DAY);
  const holdStart = held ?? termsEnd;
  const [workStart, workEnd] = span(holdStart, submitted ?? Math.max(due, holdStart + DAY));
  const [reviewStart, reviewEnd] = span(workEnd, decided && submitted ? decided : workEnd + DAY);
  const [windowStart, windowEnd] = span(reviewEnd, released ?? (passed && t(m.release_after) ? t(m.release_after)! : reviewEnd + Math.max(objectionMs(), 2 * DAY)));
  const [payoutStart, payoutEnd] = span(windowEnd, paid ?? windowEnd + DAY);
  const [, holdEnd] = span(holdStart, released ?? cancelled ?? t(m.authorization_expires_at) ?? holdStart + 29 * DAY);

  const after = (states: string[]) => states.includes(s);
  const status = {
    terms: agreed ? "done" : s === "DRAFT" ? "active" : cancelled ? "failed" : "todo",
    hold: cancelled && held ? "failed" : held ? (after(["RELEASED", "PAID_OUT", "PAYOUT_FAILED"]) ? "done" : "active") : s === "AGREED" ? "active" : "blocked",
    work: submitted ? (s === "CHANGES_REQUESTED" ? "active" : "done") : held ? (now > due ? "failed" : "active") : "blocked",
    review: s === "CHANGES_REQUESTED" ? "failed" : decided && after(["PASSED", "CONTESTED", "RELEASED", "PAID_OUT", "PAYOUT_FAILED", "HUMAN_CHECK"]) ? (s === "HUMAN_CHECK" ? "active" : "done") : after(["SUBMITTED", "IN_REVIEW"]) ? "active" : "blocked",
    window: s === "CONTESTED" ? "failed" : passed && after(["RELEASED", "PAID_OUT", "PAYOUT_FAILED"]) ? "done" : s === "PASSED" ? "active" : "blocked",
    payout: s === "PAID_OUT" ? "done" : s === "PAYOUT_FAILED" ? "failed" : s === "RELEASED" ? "active" : "blocked",
  } satisfies Record<string, PhaseStatus>;
  if (cancelled) for (const k of Object.keys(status) as (keyof typeof status)[]) if (status[k] === "blocked" || status[k] === "todo" || status[k] === "active") status[k] = "failed";

  const fmt = (x?: number) => (x ? new Date(x).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "not yet");
  const editableDue = !submitted && ["DRAFT", "AGREED", "FUNDED"].includes(s);
  const phase = (key: keyof typeof status, name: string, start: number, end: number, note: string, extra: Partial<TimelineTask> = {}): TimelineTask => ({
    id: `${m.id}:${key}`,
    name,
    startDate: iso(start),
    endDate: iso(end),
    manuallyScheduled: true,
    percentDone: status[key] === "done" ? 100 : status[key] === "active" ? 50 : 0,
    cls: `ms-phase ms-${status[key]}`,
    iconCls: status[key] === "blocked" ? "fa fa-lock" : ICON[key]!,
    eventColor: COLOR[status[key]],
    status: status[key],
    note,
    draggable: false,
    resizable: false,
    milestoneId: m.id,
    phase: key,
    ...extra,
  });

  const honorEnd = held ? held + 3 * DAY : undefined;
  const expiry = t(m.authorization_expires_at);
  const warning = holdWarning(m);
  // Honor-period and expiry markers only matter while the hold is live (not after capture or void).
  const holdLive = !!held && !released && !cancelled;
  const holdMarks = holdLive ? { ...(honorEnd ? { honorEnd: iso(honorEnd) } : {}), ...(expiry ? { holdExpiry: iso(expiry) } : {}), holdWarn: !!warning } : {};

  const children: TimelineTask[] = [
    phase("terms", "Terms signed", termsStart, termsEnd, `Fingerprint ${m.criteria_hash?.slice(0, 12) ?? "pending"} · agreed ${fmt(agreed)}`),
    phase("hold", `PayPal hold ${money(m.authorized_cents ?? m.amount_cents)}`, holdStart, holdEnd, `Authorization ${m.paypal_authorization_id ?? "not yet"} · held ${fmt(held)} · expires ${fmt(expiry)}${warning ? ` · ${warning}` : ""}`, {
      ...holdMarks,
      ...(warning && holdLive ? { eventColor: "orange", cls: "ms-phase ms-warn" } : {}),
    }),
    phase("work", "Work", workStart, workEnd, `Due ${fmt(due)} · submitted ${fmt(submitted)}${m.pr_url ? ` · ${m.pr_url}` : ""}`, {
      deadlineDate: iso(due),
      resizable: editableDue ? "end" : false,
    }),
    phase("review", "Review (CI + AI, fixed rules)", reviewStart, reviewEnd, `Decision ${fmt(decided)} · state ${s}`),
    phase("window", "Objection window", windowStart, windowEnd, `Release after ${fmt(t(m.release_after))}`),
    phase("payout", `Payout ${money(m.payout_cents)}`, payoutStart, payoutEnd, `Captured ${fmt(released)} · paid ${fmt(paid)}${m.paypal_payout_item_id ? ` · item ${m.paypal_payout_item_id}` : ""}`),
  ];

  const allDone = s === "PAID_OUT";
  const parent: TimelineTask = {
    id: m.id,
    name: `${m.title} · ${money(m.amount_cents)}`,
    startDate: iso(termsStart),
    endDate: iso(Math.max(payoutEnd, holdEnd)),
    manuallyScheduled: true,
    percentDone: Math.round((children.filter((c) => c.status === "done").length / children.length) * 100),
    cls: `ms-milestone ${allDone ? "ms-done" : cancelled ? "ms-failed" : ""}`,
    iconCls: "fa fa-flag",
    eventColor: allDone ? "green" : cancelled ? "red" : "indigo",
    status: allDone ? "done" : cancelled ? "failed" : "active",
    note: `State ${s}`,
    draggable: false,
    resizable: false,
    expanded: true,
    children,
    milestoneId: m.id,
  };

  const chain: (keyof typeof status)[] = ["terms", "hold", "work", "review", "window", "payout"];
  const dependencies: TimelineDependency[] = chain.slice(1).map((k, i) => ({
    id: `${m.id}:dep:${chain[i]}-${k}`,
    fromTask: `${m.id}:${chain[i]}`,
    toTask: `${m.id}:${k}`,
    type: 2,
    cls: status[chain[i]!] === "done" ? "ms-dep-open" : "ms-dep-gate",
  }));
  if (m.after_milestone_id) {
    // Payment tranche: this milestone's work waits on the previous milestone's payout.
    dependencies.push({ id: `${m.id}:dep:after`, fromTask: `${m.after_milestone_id}:payout`, toTask: `${m.id}:work`, type: 2, cls: "ms-dep-tranche" });
  }

  return { tasks: [parent], dependencies, warnings: warning ? [warning] : [] };
}
