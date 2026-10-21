"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { DemoTour } from "@/components/DemoTour";
import { heldLinks, rememberLink } from "@/lib/client/links";

// Bryntum renders in the browser only.
const GanttView = dynamic(() => import("./GanttView"), { ssr: false, loading: () => <p className="p-4 text-sm opacity-70">Loading the timeline…</p> });

type Timeline = { role: "client" | "worker"; tasks: unknown[]; dependencies: unknown[]; warnings: string[] };

export default function TimelinePage() {
  const [data, setData] = useState<{ tasks: unknown[]; dependencies: unknown[] }>();
  const [roles, setRoles] = useState<Record<string, { role: string; token: string }>>({});
  const [msgs, setMsgs] = useState<string[]>([]);

  const load = useCallback(async () => {
    // Shared demo links: /timeline?m=<id>.<token>,<id>.<token>
    const q = new URLSearchParams(window.location.search).get("m");
    for (const pair of q?.split(",") ?? []) {
      const [id, token] = pair.split(".");
      if (id && token) rememberLink({ id, title: "", ...(token.startsWith("mwt_") ? { worker: token } : { client: token }) });
    }
    const held = heldLinks();
    const results = await Promise.all(
      held.map(async (h) => {
        const token = h.client ?? h.worker;
        if (!token) return undefined;
        const r = await fetch(`/api/milestones/${h.id}/timeline`, { headers: { "x-milestone-token": token } });
        return r.ok ? { id: h.id, token, t: (await r.json()) as Timeline } : undefined;
      }),
    );
    const ok = results.filter((x): x is { id: string; token: string; t: Timeline } => !!x);
    setRoles(Object.fromEntries(ok.map((x) => [x.id, { role: x.t.role, token: x.token }])));
    setMsgs(ok.flatMap((x) => x.t.warnings));
    const byStart = (a: unknown, b: unknown) => String((a as { startDate: string }).startDate).localeCompare(String((b as { startDate: string }).startDate));
    setData({ tasks: ok.flatMap((x) => x.t.tasks).sort(byStart), dependencies: ok.flatMap((x) => x.t.dependencies).filter((d) => ok.some((x) => String((d as { fromTask: string }).fromTask).startsWith(x.id))) });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const canReschedule = useCallback((id: string) => roles[id]?.role === "client", [roles]);
  const onReschedule = useCallback(
    async (id: string, dueAt: Date) => {
      const r = await fetch(`/api/milestones/${id}/schedule`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-milestone-token": roles[id]?.token ?? "" },
        body: JSON.stringify({ dueAt: dueAt.toISOString() }),
      });
      const b = await r.json();
      setMsgs(r.ok ? (b.warnings ?? []) : [b.error]);
      load();
    },
    [roles, load],
  );

  return (
    <main className="flex h-[calc(100vh-3.25rem)] flex-col">
      <DemoTour onTimeline />
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3 border-b border-rule bg-panel">
        <Link href="/" className="text-sm underline">
          ← Milestones
        </Link>
        <h1 className="font-semibold">Timeline</h1>
        <p className="text-sm opacity-70">Money gates the schedule: work starts when the PayPal hold is placed, and pays out after review and the objection window.</p>
      </header>
      {msgs.length > 0 && <div className="mx-4 mt-2 rounded-md border border-held/40 bg-held-field p-2 text-sm">{msgs.join(" ")}</div>}
      <div className="min-h-0 flex-1">
        {data && data.tasks.length > 0 ? (
          <GanttView data={data} canReschedule={canReschedule} onReschedule={onReschedule} />
        ) : (
          <p className="p-4 text-sm opacity-70">{data ? "No milestones yet: create one first." : ""}</p>
        )}
      </div>
    </main>
  );
}
