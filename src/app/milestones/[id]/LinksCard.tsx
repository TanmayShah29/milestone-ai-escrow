"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { MilestoneView, Role } from "@/lib/client/states";

type Post = (action: string, body: Record<string, unknown>) => Promise<{ ok: boolean; body: Record<string, unknown> }>;

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function NewLink({ label, link }: { label: string; link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2">
      <input
        readOnly
        value={link}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        className="w-full rounded-md border border-rule-strong bg-paper px-3 py-2 font-mono text-xs text-ink"
      />
      <button
        type="button"
        onClick={() => navigator.clipboard.writeText(link).then(() => setCopied(true), () => setCopied(false))}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-rule-strong bg-panel px-3 py-1.5 text-xs text-ink hover:bg-paper"
      >
        {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}

/**
 * Link controls and data erasure. Links are the only keys (no accounts), so a leaked one is reissued here:
 * the old one stops working at once. The client can erase a paid or cancelled milestone's personal data.
 */
export function LinksCard({
  m,
  role,
  post,
  onReissued,
  onErased,
}: {
  m: MilestoneView;
  role: Role;
  post: Post;
  onReissued: (which: Role, token: string) => void;
  onErased: () => void;
}) {
  const [issued, setIssued] = useState<{ which: Role; link: string }>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirmErase, setConfirmErase] = useState(false);
  const canReissueWorker = role === "client" && !m.worker_signed_at;

  const reissue = async (which: Role) => {
    setBusy(which);
    setError(undefined);
    const { ok, body } = await post("rotate-link", { link: which });
    setBusy(undefined);
    if (!ok || typeof body.token !== "string") return setError(String(body.error ?? "Couldn't reissue the link. Try again."));
    onReissued(which, body.token);
    setIssued({ which, link: `${window.location.origin}/milestones/${m.id}?t=${encodeURIComponent(body.token)}` });
  };

  const erase = async () => {
    setBusy("erase");
    setError(undefined);
    const { ok, body } = await post("erase", {});
    setBusy(undefined);
    setConfirmErase(false);
    if (!ok) return setError(String(body.error ?? "Couldn't erase the data. Try again."));
    onErased();
  };

  return (
    <section aria-labelledby="links-h" className="rounded-lg border border-rule bg-panel p-4 text-sm">
      <h2 id="links-h" className="text-sm font-medium text-ink-2">
        Links and your data
      </h2>
      <p className="mt-2 text-xs leading-relaxed text-ink-2">
        Links are the keys to this milestone. If one may have leaked, reissue it: the old link stops working at once.
        {m.links_expire_at ? ` Both links stop working on ${day(m.links_expire_at)}.` : " Both links stop working 30 days after the milestone closes."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!!busy}
          onClick={() => reissue(role)}
          className="rounded-md border border-rule-strong bg-panel px-3 py-1.5 text-xs text-ink hover:bg-paper disabled:opacity-60"
        >
          {busy === role ? "Reissuing…" : "Reissue my link"}
        </button>
        {canReissueWorker && (
          <button
            type="button"
            disabled={!!busy}
            onClick={() => reissue("worker")}
            className="rounded-md border border-rule-strong bg-panel px-3 py-1.5 text-xs text-ink hover:bg-paper disabled:opacity-60"
          >
            {busy === "worker" ? "Reissuing…" : "Reissue the worker link"}
          </button>
        )}
      </div>
      {issued && (
        <div role="status" className="mt-3 text-xs text-ink">
          {issued.which === role
            ? "Your new link. Save it now: the old one no longer works."
            : "The new worker link. Send it to the worker: the old one no longer works."}
          <NewLink label={issued.which === role ? "Your new link" : "The new worker link"} link={issued.link} />
        </div>
      )}
      {role === "client" && (
        <div className="mt-4 border-t border-rule pt-3">
          {m.erase_blocker ? (
            <p className="text-xs leading-relaxed text-ink-3">Erasing personal data: {m.erase_blocker}</p>
          ) : confirmErase ? (
            <div className="text-xs text-ink">
              <p>
                This removes the title, brief, emails, terms, deliverable and reviews, and both links stop working. The PayPal ids, amounts and the audit trail
                stay. It can&apos;t be undone.
              </p>
              <div className="mt-2 flex gap-2">
                <button type="button" disabled={!!busy} onClick={erase} className="rounded-md border border-failed bg-failed-field px-3 py-1.5 font-medium text-failed disabled:opacity-60">
                  {busy === "erase" ? "Erasing…" : "Yes, erase it"}
                </button>
                <button type="button" onClick={() => setConfirmErase(false)} className="rounded-md px-3 py-1.5 text-ink-2 hover:text-ink">
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmErase(true)} className="text-xs text-ink-2 underline hover:text-ink">
              Erase this milestone&apos;s personal data
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-failed">
          {error}
        </p>
      )}
    </section>
  );
}
