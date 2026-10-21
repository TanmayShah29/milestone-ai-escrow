"use client";

import { Check, Copy, CreditCard, Hourglass, Loader2, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { usd, type MilestoneView, type Role } from "@/lib/client/states";
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

export function NextStep(props: { m: MilestoneView; role: Role; review: Review | null; call: Call; workerLink?: string }) {
  const { m, role, review, call, workerLink } = props;
  const [busy, setBusy] = useState<string>();
  const [prUrl, setPrUrl] = useState(String(m.pr_url ?? ""));
  const [text, setText] = useState("");
  const releaseAt = m.release_after ? new Date(m.release_after).getTime() : 0;
  const now = useNow(m.state === "PASSED");
  const hash = m.criteria_hash ?? "";
  const signedMine = !!hash && (role === "client" ? m.client_signed_hash : m.worker_signed_hash) === hash;
  const signedTheirs = !!hash && (role === "client" ? m.worker_signed_hash : m.client_signed_hash) === hash;
  const due = m.due_at ? new Date(m.due_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;

  const act = async (label: string, action: string, body: Record<string, unknown> = {}) => {
    setBusy(label);
    await call(action, body);
    setBusy(undefined);
  };
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
            {role === "client" && workerLink && (
              <>
                <p className="text-sm text-ink-2">Send the worker (a person or an AI agent) their link:</p>
                <CopyLine text={workerLink} label="Copy worker link" />
              </>
            )}
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
        body =
          m.verifier === "rubric_text" ? (
            <div className="space-y-3">
              <textarea rows={6} className="w-full rounded-md border border-rule-strong bg-panel px-3 py-2 text-sm" placeholder="Paste the deliverable" value={text} onChange={(e) => setText(e.target.value)} aria-label="Deliverable text" />
              <button className={primary} disabled={!!busy || text.length < 20} onClick={() => act("submit", "submit", { text })}>
                {spin("submit")}Submit
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-ink-2">
                Open a pull request in <span className="font-mono">{String(m.repo ?? "the repository")}</span>{due ? ` by ${due}` : ""}, with this line in its description so CI runs the signed tests:
              </p>
              <CopyLine text={`Milestone-Terms: ${hash}`} label="Copy terms line" />
              <div className="flex flex-col gap-2 sm:flex-row">
                <input className="min-w-0 flex-1 rounded-md border border-rule-strong bg-panel px-3 py-2 text-sm" placeholder="https://github.com/owner/repo/pull/1" value={prUrl} onChange={(e) => setPrUrl(e.target.value)} aria-label="Pull request URL" />
                <button className={primary} disabled={!!busy || !prUrl} onClick={() => act("submit", "submit", { prUrl })}>
                  {spin("submit")}
                  {m.state === "CHANGES_REQUESTED" ? "Resubmit" : "Submit pull request"}
                </button>
              </div>
            </div>
          );
      } else {
        title = m.state === "CHANGES_REQUESTED" ? "Waiting for the worker's fix" : "Waiting for the delivery";
        body = (
          <div className="space-y-3">
            <Waiting>{m.state === "CHANGES_REQUESTED" ? "The work didn't pass. The money stays held while the worker fixes it." : `The money is held and the worker has been told to start${due ? `; due ${due}` : ""}.`}</Waiting>
            {m.state === "FUNDED" && (
              <button className={secondary} disabled={!!busy} onClick={() => act("cancel", "cancel")}>
                {spin("cancel")}Cancel and release the hold
              </button>
            )}
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
            <div className="flex flex-wrap gap-2">
              <button className={primary} disabled={!!busy} onClick={() => act("approve", "approve")}>
                {spin("approve")}Approve the work
              </button>
              <button className={secondary} disabled={!!busy} onClick={() => act("changes", "request-changes")}>
                {spin("changes")}Ask for changes
              </button>
            </div>
          </div>
        );
      } else {
        title = "Waiting for the client's decision";
        body = <Waiting>The rules sent this to the client to decide. The money stays held meanwhile.</Waiting>;
      }
      break;
    case "PASSED": {
      const left = Math.max(0, Math.ceil((releaseAt - now) / 1000));
      const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
      title = left > 0 ? `Approved. Releasing in ${mmss}` : "Releasing now";
      body =
        role === "client" ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-2">Every must-have passed. Unless you object before the window closes, the money is captured and the worker is paid automatically.</p>
            <div className="flex flex-wrap gap-2">
              {left > 0 && (
                <button className={secondary} disabled={!!busy} onClick={() => act("object", "object")}>
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
      title = "The client objected";
      body = <p className="text-sm text-ink-2">The money stays held. Resolving objections is on the roadmap.</p>;
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
    </section>
  );
}
