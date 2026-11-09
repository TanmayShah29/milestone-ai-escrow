"use client";

import { Check, Copy, Mail, X } from "lucide-react";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { DemoTour } from "@/components/DemoTour";
import { MoneyTracker, StatusPill } from "@/components/MoneyTracker";
import { clientLinkUrl, discardLink, forgetLink, linkFor, markLinkSaved, needsLinkReminder, rememberLink, replaceLink, workerShareToken } from "@/lib/client/links";
import { STATUS, cancelledAt, usd, type MilestoneView, type Role } from "@/lib/client/states";
import { ContractSeal } from "./ContractSeal";
import { LinksCard } from "./LinksCard";
import { MoneyPanel } from "./MoneyPanel";
import { NextStep } from "./NextStep";
import { ProofTrail, type AuditRow } from "./ProofTrail";
import { TermsCard } from "./TermsCard";
import { VerdictTable, type Review } from "./VerdictTable";

type Data = { role: Role; milestone: MilestoneView; audit: AuditRow[]; review: Review | null };

const ROLE_LABEL: Record<Role, string> = { client: "Client", worker: "Worker" };

/** The way to the resolution desk, when the signed terms name an arbitrator (src/lib/resolution/desk.ts). */
function CourtLink({ m }: { m: MilestoneView }) {
  const desk = (m.criteria as { policy?: { arbitrator?: { name: string; feeCents: number } } } | null | undefined)?.policy?.arbitrator;
  if (!desk) return null;
  const inCourt = m.state === "LOCKED" || m.state === "ARBITRATION";
  const canLock = (m.state === "PASSED" && !m.contested_at) || m.state === "HUMAN_CHECK";
  if (!inCourt && !canLock) return null;
  return (
    <div className="rounded-lg border border-rule bg-panel p-4 text-sm text-ink-2">
      {inCourt ? "This decision is with the resolution desk. " : `Disagree with this decision? Either side can take it to ${desk.name} for a ${usd(desk.feeCents)} fee hold. `}
      <Link href={`/milestones/${m.id}/court`} className="font-medium text-ink underline">
        {inCourt ? "Open the case" : "Resolution desk"}
      </Link>
    </div>
  );
}

/** The page can't open the milestone: no link in this browser, or a link that isn't for it. */
function LinkCard({ title, children, proofId }: { title: string; children: React.ReactNode; proofId?: string }) {
  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-2 text-ink-2">{children}</p>
      {proofId && (
        <p className="mt-4 text-ink-2">
          Anyone can check what happened to it on its{" "}
          <Link href={`/proof/${proofId}`} className="font-medium text-ink underline">
            public proof page
          </Link>
          , or{" "}
          <Link href="/demo" className="font-medium text-ink underline">
            run a deal of your own on /demo
          </Link>{" "}
          to see the client and worker screens.
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-4">
        <Link href="/milestones" className="underline">
          Your milestones
        </Link>
        <Link href="/" className="underline">
          Back to Milestone
        </Link>
      </div>
    </main>
  );
}

/**
 * There are no accounts: a client who closes the tab without their link has lost the milestone. Shown to
 * the client until they dismiss it. The link is rendered here and in the mailto only, never sent anywhere.
 */
function SaveClientLink({ link, title, onDismiss }: { link: string; title: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false); // clipboard blocked: the link is selectable below
    }
  };
  const mail = `mailto:?subject=${encodeURIComponent(`Your client link for "${title}"`)}&body=${encodeURIComponent(
    `This is your client link for the milestone "${title}". It's the only way back to it, so keep it safe: anyone with it can act as the client.\n\n${link}\n`,
  )}`;
  return (
    <section aria-labelledby="save-link-h" className="mb-5 rounded-lg border border-held/50 bg-held-field p-4 text-sm text-ink">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="save-link-h" className="font-semibold">
            Save your client link
          </h2>
          <p className="mt-1">It&apos;s the only way back to this milestone. Anyone with it can act as the client, so keep it private.</p>
        </div>
        <button type="button" onClick={onDismiss} aria-label="Dismiss: I've saved my link" className="-m-1 rounded p-1 text-ink-2 hover:text-ink">
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <input
        readOnly
        value={link}
        aria-label="Your client link"
        onFocus={(e) => e.currentTarget.select()}
        className="mt-3 w-full rounded-md border border-rule-strong bg-panel px-3 py-2 font-mono text-xs text-ink"
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={copy} className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 font-medium text-accent-ink">
          {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
          {copied ? "Copied" : "Copy link"}
        </button>
        <a href={mail} className="inline-flex items-center gap-1.5 rounded-md border border-rule-strong bg-panel px-3 py-1.5 text-ink no-underline hover:bg-paper">
          <Mail className="size-4" aria-hidden="true" />
          Email it to yourself
        </a>
        <button type="button" onClick={onDismiss} className="rounded-md px-3 py-1.5 text-ink-2 hover:text-ink">
          I&apos;ve saved it
        </button>
      </div>
    </section>
  );
}

export default function MilestonePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<Data>();
  const [msg, setMsg] = useState<string>();
  const [as, setAs] = useState<Role>();
  const [tokens, setTokens] = useState<{ client?: string; worker?: string }>({});
  // The worker link a client holds only to hand over (never to act as the worker).
  const [shareToken, setShareToken] = useState<string>();
  // The client's own link, shown until they confirm they saved it (see SaveClientLink).
  const [saveLink, setSaveLink] = useState<string>();
  const [ready, setReady] = useState(false);
  const [denied, setDenied] = useState(false);
  const [erased, setErased] = useState(false);
  const token = as ? tokens[as] : undefined;

  // A shared link arrives as ?t=<token>: remember it, then drop it from the address bar.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get("t");
    if (t) {
      rememberLink({ id, title: "", ...(t.startsWith("mwt_") ? { worker: t } : { client: t }) });
      q.delete("t");
      window.history.replaceState(null, "", `${window.location.pathname}${q.size ? `?${q}` : ""}`);
    }
    const held = linkFor(id);
    setTokens({ client: held?.client, worker: held?.worker });
    setShareToken(workerShareToken(held));
    setSaveLink(needsLinkReminder(held) ? clientLinkUrl(window.location.origin, held) : undefined);
    setAs(held?.client ? "client" : held?.worker ? "worker" : undefined);
    const err = q.get("error");
    if (err) setMsg(err);
    else if (q.get("funded") === "pending") setMsg("PayPal is finishing the hold. This page will update in a moment.");
    setReady(true);
  }, [id]);

  const authed = useCallback((init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers ?? {}), "x-milestone-token": token ?? "" } }), [token]);
  const load = useCallback(async () => {
    if (!token) return;
    const r = await fetch(`/api/milestones/${id}`, authed());
    const b = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) {
      discardLink(id);
      return setDenied(true);
    }
    if (!r.ok) return setMsg(b.error ?? "Couldn't load the milestone. Try again in a moment.");
    setDenied(false);
    setData(b);
    rememberLink({ id, title: b.milestone.title });
  }, [id, token, authed]);
  useEffect(() => {
    load();
  }, [load]);

  // While CI runs, the objection window ticks or a payout settles, nudge the milestone forward.
  const state = data?.milestone.state;
  useEffect(() => {
    if (!token || !state || !["SUBMITTED", "IN_REVIEW", "PASSED", "CONTESTED", "RELEASED", "LOCKED", "ARBITRATION"].includes(state)) return;
    const t = setInterval(() => fetch(`/api/milestones/${id}/check`, authed({ method: "POST" })).then(() => load()), 15_000);
    return () => clearInterval(t);
  }, [id, token, state, authed, load]);

  const call = useCallback(
    async (action: string, body: Record<string, unknown> = {}) => {
      setMsg(undefined);
      const r = await fetch(`/api/milestones/${id}/${action}`, authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      const b = await r.json().catch(() => ({}));
      if (action === "fund" && r.ok && b.approveUrl) {
        window.location.href = b.approveUrl;
        return { ok: true };
      }
      if (!r.ok || r.status === 202) setMsg(b.error);
      await load();
      return { ok: r.ok, error: b.error as string | undefined, data: b as Record<string, unknown> };
    },
    [id, authed, load],
  );

  // For actions whose response the caller needs (a reissued link's token).
  const post = useCallback(
    async (action: string, body: Record<string, unknown>) => {
      const r = await fetch(`/api/milestones/${id}/${action}`, authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      return { ok: r.ok, body: ((await r.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
    },
    [id, authed],
  );

  const reissued = (which: Role, t: string) => {
    const held = linkFor(id);
    // A client reissuing the worker link holds it only to hand over, unless this browser acts as both (judge mode).
    const patch = which === "client" ? { client: t } : as === "worker" || held?.worker ? { worker: t } : { shareWorker: t };
    replaceLink(id, patch);
    setTokens((prev) => ({ ...prev, ...(which === "client" ? { client: t } : "worker" in patch ? { worker: t } : {}) }));
    if ("shareWorker" in patch || which === "worker") setShareToken(t);
    if (which === "client") setSaveLink(undefined); // the new link is shown in the card
  };

  if (erased) {
    return (
      <LinkCard title="This milestone's personal data was erased">
        Its title, brief, emails, terms, deliverable and reviews are gone, and its links no longer work. The PayPal record and audit trail stay, as the payment rules require.
      </LinkCard>
    );
  }

  if (ready && !as) {
    return (
      <LinkCard title="This milestone needs its link" proofId={id}>
        Open it from the client or worker link you were given (it ends with <span className="font-mono">?t=…</span>). Links are the keys: there are no accounts.
      </LinkCard>
    );
  }
  if (denied && !data) {
    return (
      <LinkCard title="This link doesn't open this milestone">
        The link may be mistyped, cut short, or meant for a different milestone. Open the client or worker link you were given again (it ends with{" "}
        <span className="font-mono">?t=…</span>).
      </LinkCard>
    );
  }
  if (!data) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-16 text-ink-2" aria-busy="true">
        {msg ?? "Loading the milestone… The demo server can take up to a minute to wake up."}
      </main>
    );
  }

  const m = data.milestone;
  const status = STATUS[m.state] ?? { label: m.state, tone: "neutral" as const };
  const criteriaText = Object.fromEntries(((m.criteria?.criteria ?? []) as { id: string; text: string }[]).map((c) => [c.id, c.text]));
  const workerLink = shareToken ? `${typeof window !== "undefined" ? window.location.origin : ""}/milestones/${id}?t=${shareToken}` : undefined;

  return (
    <main className="mx-auto max-w-6xl px-4 pb-40 pt-6 sm:pb-16">
      <DemoTour currentId={id} state={data.milestone.state} />
      <header className="flex flex-col gap-4 border-b border-rule pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{m.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <StatusPill label={status.label} tone={status.tone} />
            {m.pr_url ? (
              <a href={String(m.pr_url)} target="_blank" rel="noreferrer" className="text-sm text-ink-2 underline">
                Pull request
              </a>
            ) : null}
          </div>
        </div>
        <div className="flex items-end justify-between gap-6 sm:justify-end">
          <p className="sm:text-right">
            <span className="block text-xs text-ink-2">Milestone value</span>
            <span className="text-3xl font-semibold tracking-tight">{usd(m.amount_cents)}</span>
          </p>
          <div role="group" aria-label="View as" className="flex rounded-md border border-rule-strong p-0.5 text-sm">
            {(["client", "worker"] as const).map((r) => {
              const missing = !tokens[r];
              return (
                <button
                  key={r}
                  type="button"
                  aria-disabled={missing || undefined}
                  title={missing ? `Only the ${r}'s own link can act as the ${r}.` : undefined}
                  onClick={() => !missing && setAs(r)}
                  aria-pressed={as === r}
                  className={`rounded px-2.5 py-1 ${missing ? "cursor-not-allowed text-ink-3 opacity-60" : as === r ? "bg-accent text-accent-ink" : "text-ink-2 hover:text-ink"}`}
                >
                  {ROLE_LABEL[r]}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <div className="py-5">
        <MoneyTracker state={m.state} cancelledAt={m.state === "CANCELLED" ? cancelledAt(m) : undefined} />
      </div>

      {saveLink && (
        <SaveClientLink
          link={saveLink}
          title={m.title}
          onDismiss={() => {
            markLinkSaved(id);
            setSaveLink(undefined);
          }}
        />
      )}

      {msg && (
        <p role="status" className="mb-4 rounded-md border border-held/40 bg-held-field p-3 text-sm text-ink">
          {msg}
        </p>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-5">
          <NextStep m={m} role={as!} review={data.review} call={call} workerLink={workerLink} />
          <CourtLink m={m} />
          <div className="lg:hidden">
            <MoneyPanel m={m} />
          </div>
          {data.review?.status === "done" && <VerdictTable review={data.review} criteriaText={criteriaText} />}
          <TermsCard m={m} role={as!} call={call} />
          <ProofTrail audit={data.audit} milestoneId={data.milestone.id} />
        </div>
        <aside className="min-w-0 space-y-5 lg:sticky lg:top-5 lg:self-start">
          <div className="hidden space-y-5 lg:block">
            <MoneyPanel m={m} />
            <ContractSeal m={m} />
          </div>
          <LinksCard
            m={m}
            role={as!}
            post={post}
            onReissued={reissued}
            onErased={() => {
              forgetLink(id);
              setErased(true);
            }}
          />
          <p className="text-xs leading-relaxed text-ink-3">
            The AI never moves money. It drafts terms and reviews what tests can&apos;t check; fixed rules decide, and only those rules capture or release the PayPal hold. PayPal sandbox; no real money.
          </p>
        </aside>
      </div>
    </main>
  );
}
