import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GITHUB_LOGIN } from "@/lib/contract/signatures";
import { usd } from "@/lib/client/states";
import { workerPassport } from "@/lib/passport";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ login: string }> }): Promise<Metadata> {
  return { title: `${(await params).login}'s Milestone passport` };
}

// A worker's passport: their record from the ledger, signed with the proof key so a platform can check it.
export default async function Passport({ params }: { params: Promise<{ login: string }> }) {
  const { login } = await params;
  if (!GITHUB_LOGIN.test(login)) notFound();
  const { passport: p, keyId } = await workerPassport(login);
  const base = process.env.APP_URL ?? "https://milestone-ai-escrow.onrender.com";
  const stat = (label: string, value: string) => (
    <div className="rounded-lg border border-rule bg-panel p-4">
      <div className="text-xs text-ink-3">{label}</div>
      <div className="mt-1 text-xl font-semibold text-ink">{value}</div>
    </div>
  );
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <div>
        <h1 className="text-2xl font-semibold text-ink">@{p.githubLogin}</h1>
        <p className="mt-1 text-sm text-ink-2">
          A record built from the milestones this GitHub account delivered, and signed by Milestone (key {keyId.slice(0, 12)}…). The JSON is at{" "}
          <a href={`/api/passport/worker/${p.githubLogin}`}>/api/passport/worker/{p.githubLogin}</a>.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stat("Paid", `${p.paid} (${usd(p.paidCents)})`)}
        {stat("On time", p.onTimeRate === null ? "n/a" : `${Math.round(p.onTimeRate * 100)}%`)}
        {stat("Changes asked", String(p.changesRequested))}
        {stat("Disputes", String(p.disputes))}
      </div>
      <div className="rounded-lg border border-rule bg-panel p-4 text-sm text-ink-2">
        <p>
          Criteria passed, by evidence: <span className="text-ink">E3 {p.passedEvidence.E3}</span> (trusted runner), <span className="text-ink">E2 {p.passedEvidence.E2}</span> (CI),{" "}
          <span className="text-ink">E1 {p.passedEvidence.E1}</span> (AI panel).
        </p>
        <p className="mt-1">
          Lapsed claims: {p.lapsedClaims}. Arbitration awards: {p.awards.count}
          {p.awards.averageShareBps !== null ? `, averaging ${p.awards.averageShareBps / 100}% to this worker` : ""}.
        </p>
      </div>
      <div className="rounded-lg border border-rule bg-panel p-4 text-sm text-ink-2">
        <p className="text-ink">README badge</p>
        {/* eslint-disable-next-line @next/next/no-img-element -- an SVG badge from our own API */}
        <img className="mt-2" src={`/api/passport/worker/${p.githubLogin}/badge`} alt={`Milestone: ${p.paid} paid`} height={20} />
        <pre className="mt-2 overflow-x-auto rounded-md border border-rule bg-paper p-3 font-mono text-xs text-ink">{`[![Milestone](${base}/api/passport/worker/${p.githubLogin}/badge)](${base}/passport/${p.githubLogin})`}</pre>
      </div>
    </main>
  );
}
