"use client";

import { Check, Copy, CreditCard, Hourglass, Loader2, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { decideByCopy, holdExpiryWarning, usd, type MilestoneView, type Role } from "@/lib/client/states";
import { humanTimeoutOutcome } from "@/lib/review/policy";
import { HoldWarning } from "./MoneyPanel";
import type { Call } from "./TermsCard";
import type { Review } from "./VerdictTable";

// One next action per person, or a plain statement of who we're waiting on. This is the panel people read
// first; everything it says matches the server's rules (signing, funding, review, objection window).

const primary = "inline-flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50";
const secondary = "inline-flex items-center justify-center gap-2 rounded-md border border-rule-strong bg-panel px-4 py-2.5 text-sm font-medium text-ink hover:bg-paper disabled:opacity-50";

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function CopyLine({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-stretch gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md border border-rule bg-paper px-3 py-2 font-mono text-xs text-ink" title={text}>
        {text}
      </code>
      <button
        className={secondary}
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        aria-label={label}
      >
        {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Waiting({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm text-ink-2">
      <Hourglass className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** Releasing the hold can't be undone, so it takes two steps: ask, then confirm (or keep it). */
function CancelHold({ amount, busy, onConfirm }: { amount: string; busy: boolean; onConfirm: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    (asking ? keepRef : cancelRef).current?.focus();
  }, [asking]);
  const toggle = (v: boolean) => {
    moved.current = true;
    setAsking(v);
  };
  if (!asking) {
    return (
      <button ref={cancelRef} className={secondary} disabled={busy} onClick={() => toggle(true)}>
        Cancel and release the hold
      </button>
    );
  }
  return (
    <div role="group" aria-labelledby="cancel-q" className="space-y-3 rounded-md border border-rule-strong bg-paper p-3">
      <p id="cancel-q" className="text-sm text-ink">
        Release the {amount} hold? The worker will be told the milestone is cancelled.
      </p>
      <div className="flex flex-wrap gap-2">
        <button className={primary} disabled={busy} onClick={onConfirm}>
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}Confirm, release the hold
        </button>
        <button ref={keepRef} className={secondary} disabled={busy} onClick={() => toggle(false)}>
          Keep it
        </button>
      </div>
    </div>
  );
}

function FieldError({ id, text }: { id: string; text?: string }) {
  if (!text) return null;
  return (
    <p id={id} role="status" className="rounded-md border border-failed/40 bg-failed-field/60 px-3 py-2 text-sm text-ink">
      {text}
    </p>
  );
}

const REASON_MAX = 1000; // same limit as the server (src/lib/review/run.ts)

/** A reason the worker will read: optional for an objection or a first change request, required after an objection. */
function ReasonField({ id, label, value, onChange, required, error }: { id: string; label: string; value: string; onChange: (v: string) => void; required: boolean; error?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label} <span className="font-normal text-ink-2">{required ? "(required; the worker reads this)" : "(optional; the worker reads this)"}</span>
      </label>
      <textarea
        id={id}
        rows={3}
        maxLength={REASON_MAX}
        className="w-full rounded-md border border-rule-strong bg-panel px-3 py-2 text-sm aria-[invalid=true]:border-failed"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-required={required}
        {...(error ? { "aria-invalid": true, "aria-describedby": `${id}-error` } : {})}
      />
      <FieldError id={`${id}-error`} text={error} />
    </div>
  );
}

/** The client's own words, shown to the worker. */
function ClientReason({ text }: { text?: unknown }) {
  if (typeof text !== "string" || !text.trim()) return null;
  return (
    <blockquote className="rounded-md border border-rule bg-paper px-3 py-2 text-sm text-ink">
      <span className="font-medium">The client&apos;s reason:</span> <span className="whitespace-pre-wrap">{text}</span>
    </blockquote>
  );
}

export function NextStep(props: { m: MilestoneView; role: Role; review: Review | null; call: Call; workerLink?: string }) {
  const { m, role, review, call, workerLink } = props;
  const [busy, setBusy] = useState<string>();
  const [prUrl, setPrUrl] = useState(String(m.pr_url ?? ""));
  const [text, setText] = useState("");
  const [submitError, setSubmitError] = useState<string>();
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string>();
  const holdWarning = role === "client" ? holdExpiryWarning(m) : undefined;
  const releaseAt = m.release_after ? new Date(m.release_after).getTime() : 0;
  const now = useNow(m.state === "PASSED");
  const hash = m.criteria_hash ?? "";
  const signedMine = !!hash && (role === "client" ? m.client_signed_hash : m.worker_signed_hash) === hash;
  const signedTheirs = !!hash && (role === "client" ? m.worker_signed_hash : m.client_signed_hash) === hash;
  const due = m.due_at ? new Date(m.due_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
  const releaseDate = m.release_after ? new Date(m.release_after).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "a date set by the rules";
  // After an objection, PASSED comes from the second review, or from the client's decision (or its
  // 72 h deadline) on a HUMAN_CHECK that came after the objection. Either way, no second objection.
  const contestedAt = m.contested_at ? new Date(m.contested_at).getTime() : 0;
  const decidedAfterObjection = m.state === "PASSED" && !!contestedAt && !!m.human_check_at && new Date(m.human_check_at).getTime() >= contestedAt;
  const secondReviewPassed = m.state === "PASSED" && !!contestedAt && !decidedAfterObjection;
  // What fixed rules do if the client leaves a HUMAN_CHECK undecided: the same rule the server applies.
  const timeout = humanTimeoutOutcome(review?.verdict);
  const decideBy = decideByCopy(m, role, timeout.outcome);
  // After an objection, asking for changes needs a reason: it is the client's one objection.
  const reasonRequired = m.state === "HUMAN_CHECK" && !!contestedAt;
  const withReason = async (label: string, action: string) => {
    const r = reason.trim();
    if (reasonRequired && label === "changes" && !r) {
      setReasonError("Say what needs to change. You already objected once, so this is your one request for changes.");
      return;
    }
    setReasonError(undefined);
    const res = await act(label, action, r ? { reason: r } : {});
    if (!res.ok) setReasonError(res.error ?? "That didn't go through. Try again.");
    else setReason("");
  };
  const cancelButton = (
    <CancelHold
      amount={usd(m.authorized_cents ?? m.amount_cents)}
      busy={!!busy}
      onConfirm={async () => {
        await act("cancel", "cancel");
      }}
    />
  );

  const act = async (label: string, action: string, body: Record<string, unknown> = {}) => {
    setBusy(label);
    const r = await call(action, body);
    setBusy(undefined);
    return r;
  };
  const submit = async (body: Record<string, unknown>) => {
    setSubmitError(undefined);
    const r = await act("submit", "submit", body);
    if (!r.ok) setSubmitError(r.error ?? "That didn't go through. Try again.");
  };
  const errorProps = submitError ? { "aria-invalid": true, "aria-describedby": "submit-error" } : {};
  const spin = (label: string) => busy === label && <Loader2 className="size-4 animate-spin" aria-hidden="true" />;

  let title = "";
  let body: React.ReactNode = null;

  switch (m.state) {
    case "DRAFT":
      if (!hash) {
        title = role === "client" ? "Draft the terms" : "Waiting for the terms";
        body = role === "client" ? <p className="text-sm text-ink-2">Start below: the AI drafts criteria and tests from your brief, and you can edit them before anyone signs.</p> : <Waiting>The client is drafting the terms. You&apos;ll be able to read and sign them here.</Waiting>;
      } else if (!signedMine) {
        title = role === "client" ? "Review and sign the terms" : "Read the terms, then sign";
        body = (
          <div className="space-y-3">
            <p className="text-sm text-ink-2">
              {role === "client" ? "Signing seals exactly these terms. The fingerprint goes onto the PayPal order, so nobody can change them later." : "Once both sides sign, the client funds a PayPal hold. You're paid when the work meets these terms."}
            </p>
            <button className={primary} disabled={!!busy} onClick={() => act("sign", "sign-terms", { hash })}>
              {spin("sign")}Sign terms {hash.slice(0, 8)}
            </button>
          </div>
        );
      } else {
        title = role === "client" ? "Waiting for the worker to sign" : "Waiting for the client to sign";
        body = (
          <div className="space-y-3">
            <Waiting>You signed these terms. {signedTheirs ? "" : `When the ${role === "client" ? "worker" : "client"} signs, they're sealed.`}</Waiting>
            {role === "client" &&
              (workerLink ? (
                <>
                  <p className="text-sm text-ink-2">Send the worker (a person or an AI agent) their link:</p>
                  <CopyLine text={workerLink} label="Copy worker link" />
                </>
              ) : (
                <p className="text-sm text-ink-2">Send the worker (a person or an AI agent) the worker link you were given when you created this milestone.</p>
              ))}
          </div>
        );
      }
      break;
    case "AGREED":
      if (role === "client") {
        title = `Fund ${usd(m.amount_cents)}`;
        body = (
          <div className="space-y-3">
            <p className="text-sm text-ink-2">PayPal holds the money; nothing is charged until the work passes. If it never does, the hold is released.</p>
            <div className="flex flex-wrap gap-2">
              <button className={primary} disabled={!!busy} onClick={() => act("card", "fund-card")}>
                {spin("card") || <CreditCard className="size-4" aria-hidden="true" />}Fund with sandbox test card
              </button>
              <button className={secondary} disabled={!!busy} onClick={() => act("fund", "fund")}>
                {spin("fund") || <Wallet className="size-4" aria-hidden="true" />}Fund with PayPal login
              </button>
            </div>
          </div>
        );
      } else {
        title = "Waiting for the client to fund";
        body = <Waiting>Don&apos;t start yet. You&apos;ll see the PayPal hold here before any work is due.</Waiting>;
      }
      break;
    case "FUNDED":
    case "CHANGES_REQUESTED":
      if (role === "worker") {
        title = m.state === "CHANGES_REQUESTED" ? "Fix and resubmit" : `${usd(m.authorized_cents ?? m.amount_cents)} is held. Deliver the work.`;
        const fix = m.state === "CHANGES_REQUESTED" ? <ClientReason text={m.changes_reason} /> : null;
        body =
          m.verifier === "rubric_text" ? (
            <div className="space-y-3">
              {fix}
              <textarea
                rows={6}
                className="w-full rounded-md border border-rule-strong bg-panel px-3 py-2 text-sm aria-[invalid=true]:border-failed"
                placeholder="Paste the deliverable"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setSubmitError(undefined);
                }}
                aria-label="Deliverable text"
                {...errorProps}
              />
              <FieldError id="submit-error" text={submitError} />
              <button className={primary} disabled={!!busy || text.length < 20} onClick={() => submit({ text })}>
                {spin("submit")}Submit
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {fix}
              <p className="text-sm text-ink-2">
                Open a pull request in <span className="font-mono">{String(m.repo ?? "the repository")}</span>{due ? ` by ${due}` : ""}, with this line in its description so CI runs the signed tests:
              </p>
              <CopyLine text={`Milestone-Terms: ${hash}`} label="Copy terms line" />
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  className="min-w-0 flex-1 rounded-md border border-rule-strong bg-panel px-3 py-2 text-sm aria-[invalid=true]:border-failed"
                  placeholder="https://github.com/owner/repo/pull/1"
                  value={prUrl}
                  onChange={(e) => {
                    setPrUrl(e.target.value);
                    setSubmitError(undefined);
                  }}
                  aria-label="Pull request URL"
                  {...errorProps}
                />
                <button className={primary} disabled={!!busy || !prUrl} onClick={() => submit({ prUrl })}>
                  {spin("submit")}
                  {m.state === "CHANGES_REQUESTED" ? "Resubmit" : "Submit pull request"}
                </button>
              </div>
              <FieldError id="submit-error" text={submitError} />
            </div>
          );
      } else {
        title = m.state === "CHANGES_REQUESTED" ? "Waiting for the worker's fix" : "Waiting for the delivery";
        body = (
          <div className="space-y-3">
            <Waiting>{m.state === "CHANGES_REQUESTED" ? "The work didn't pass. The money stays held while the worker fixes it." : `The money is held and the worker has been told to start${due ? `; due ${due}` : ""}.`}</Waiting>
            {cancelButton}
          </div>
        );
      }
      break;
    case "SUBMITTED":
    case "IN_REVIEW":
      title = "Checking the work";
      body = <Waiting>{review?.status === "pending" ? (review.reasons?.[0] ?? "CI is running the signed tests") : "CI is running the signed tests; then the AI reviews what tests can't check."}. This page checks again every 15 seconds.</Waiting>;
      break;
    case "HUMAN_CHECK":
      if (role === "client") {
        title = "Your decision";
        body = (
          <div className="space-y-3">
            <p className="text-sm text-ink-2">The rules couldn&apos;t decide on their own ({review?.reasons?.join("; ") ?? "see the verdict"}). Read the verdict below, then:</p>
            {decideBy && <p className="text-sm font-medium text-ink">{decideBy}</p>}
            <ReasonField
              id="changes-reason"
              label="What needs to change"
              value={reason}
              onChange={(v) => {
                setReason(v);
                setReasonError(undefined);
              }}
              required={reasonRequired}
              error={reasonError}
            />
            <div className="flex flex-wrap gap-2">
              <button className={primary} disabled={!!busy} onClick={() => act("approve", "approve")}>
                {spin("approve")}Approve the work
              </button>
              <button className={secondary} disabled={!!busy} onClick={() => withReason("changes", "request-changes")}>
                {spin("changes")}Ask for changes
              </button>
            </div>
            {/* After an objection the money flow refuses a cancel: approve or ask for changes instead. */}
            {!contestedAt && cancelButton}
          </div>
        );
      } else {
        title = "Waiting for the client's decision";
        body = (
          <div className="space-y-3">
            <Waiting>The rules sent this to the client to decide. The money stays held meanwhile.{decideBy && ` ${decideBy}`}</Waiting>
            {contestedAt > 0 && <ClientReason text={m.objection_reason} />}
          </div>
        );
      }
      break;
    case "PASSED": {
      if (decidedAfterObjection) {
        const paidWhen = releaseAt > now ? `on ${releaseDate}` : "now";
        title = "Approved after the objection";
        body =
          role === "client" ? (
            <div className="space-y-3">
              <p className="text-sm text-ink-2">The decision after your objection is settled, so no further objection is possible. The money is captured and the worker is paid {paidWhen}.</p>
              <button className={secondary} disabled={!!busy} onClick={() => act("release", "release")}>
                {spin("release")}Release now
              </button>
            </div>
          ) : (
            <Waiting>Your work is approved. You&apos;re paid {paidWhen}.</Waiting>
          );
        break;
      }
      if (secondReviewPassed) {
        title = "Second review passed";
        body =
          role === "client" ? (
            <div className="space-y-3">
              <p className="text-sm text-ink-2">The same commit passed a second review after your objection. The money is captured and the worker is paid on {releaseDate}.</p>
              <button className={secondary} disabled={!!busy} onClick={() => act("release", "release")}>
                {spin("release")}Release now
              </button>
            </div>
          ) : (
            <Waiting>Your work passed the second review. You&apos;re paid on {releaseDate}.</Waiting>
          );
        break;
      }
      const left = Math.max(0, Math.ceil((releaseAt - now) / 1000));
      const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
      title = left > 0 ? `Approved. Releasing in ${mmss}` : "Releasing now";
      body =
        role === "client" ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-2">Every must-have passed. Unless you object before the window closes, the money is captured and the worker is paid automatically.</p>
            {left > 0 && (
              <ReasonField
                id="objection-reason"
                label="Why you object"
                value={reason}
                onChange={(v) => {
                  setReason(v);
                  setReasonError(undefined);
                }}
                required={false}
                error={reasonError}
              />
            )}
            <div className="flex flex-wrap gap-2">
              {left > 0 && (
                <button className={secondary} disabled={!!busy} onClick={() => withReason("object", "object")}>
                  {spin("object")}Object and keep the money held
                </button>
              )}
              <button className={secondary} disabled={!!busy} onClick={() => act("release", "release")}>
                {spin("release")}Release now
              </button>
            </div>
          </div>
        ) : (
          <Waiting>Every must-have passed. You&apos;re paid when the client&apos;s objection window closes.</Waiting>
        );
      break;
    }
    case "RELEASED":
      title = "Paying the worker";
      body = <Waiting>The money was captured. PayPal is sending {usd(m.payout_cents)} to the worker, usually within a minute.</Waiting>;
      break;
    case "PAID_OUT":
      title = role === "worker" ? `You were paid ${usd(m.payout_cents)}` : "Done. The worker was paid.";
      body = <p className="text-sm text-ink-2">Every step is recorded below with its PayPal reference.</p>;
      break;
    case "PAYOUT_FAILED":
      title = "The payout came back";
      body = <p className="text-sm text-ink-2">PayPal returned it ({String(m.payout_status ?? "")}). Check the worker&apos;s PayPal email; the money is with the platform, not lost.</p>;
      break;
    case "CONTESTED":
      if (role === "client") {
        title = "Objection recorded";
        body = <p className="text-sm text-ink-2">A second review runs on the same commit; if it passes, payment releases on {releaseDate}. The money stays held meanwhile.</p>;
      } else {
        title = "The client objected";
        body = (
          <div className="space-y-3">
            <Waiting>A second review runs; if it passes, you&apos;re paid on {releaseDate}.</Waiting>
            <ClientReason text={m.objection_reason} />
          </div>
        );
      }
      break;
    case "CANCELLED":
      title = "Cancelled";
      body = <p className="text-sm text-ink-2">The hold was released; nothing was charged.</p>;
      break;
  }

  return (
    <section aria-labelledby="next-h" className="rounded-lg border border-ink/25 bg-panel p-4 shadow-[0_1px_2px_rgb(19_35_58/0.06),0_8px_24px_-12px_rgb(19_35_58/0.18)] sm:p-5">
      <h2 id="next-h" className="text-xl font-semibold text-ink">
        {title}
      </h2>
      <div className="mt-2">{body}</div>
      {holdWarning && <HoldWarning text={holdWarning} />}
    </section>
  );
}
