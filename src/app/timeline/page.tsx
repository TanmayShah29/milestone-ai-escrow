"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DemoTour } from "@/components/DemoTour";
import { ShowcaseNotice, ShowcaseToggle } from "@/components/ShowcaseNotice";
import { heldLinks, rememberLink } from "@/lib/client/links";
import { fetchShowcase, type ShowcaseRunView } from "@/lib/client/showcase";
import { loadGanttView, preloadTimeline } from "./preload";

// Bryntum renders in the browser only. Its chunk is large, so a skeleton holds the space while it loads.
const GanttView = dynamic(loadGanttView, { ssr: false, loading: () => <TimelineSkeleton /> });

type Task = { id: string; phase?: string; milestoneId?: string; startDate: string; resizable?: unknown; canReschedule?: boolean; children?: Task[] };
type Timeline = { role: "client" | "worker"; tasks: Task[]; dependencies: unknown[]; warnings: string[] };
type Notice = { kind: "error" | "ok"; text: string };

// Only the client moves the due date, and only while the milestone's state allows it (from the timeline data).
function forRole(tasks: Task[], role: Timeline["role"]): Task[] {
  return tasks.map((t) => {
    const children = t.children ? forRole(t.children, role) : undefined;
    if (t.phase !== "work") return children ? { ...t, children } : t;
    const can = role === "client" && !!t.canReschedule;
    return { ...t, canReschedule: can, resizable: can ? "end" : false };
  });
}

type Data = { tasks: unknown[]; dependencies: unknown[] };

// The judge runs as one read-only chart, in the showcase's order (the paid run, then the caught cheat).
const showcaseData = (runs: ShowcaseRunView[]): Data => ({ tasks: runs.flatMap((r) => r.timeline.tasks), dependencies: runs.flatMap((r) => r.timeline.dependencies) });

export default function TimelinePage() {
  const [data, setData] = useState<Data>();
  // A browser with no milestone links of its own sees the recent live judge runs instead (read only).
  const [showcase, setShowcase] = useState<ShowcaseRunView[]>();
  const [view, setView] = useState<"own" | "showcase">("own");
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice>();

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
    setTokens(Object.fromEntries(ok.map((x) => [x.id, x.token])));
    setWarnings(ok.flatMap((x) => x.t.warnings));
    const runs = await fetchShowcase();
    setShowcase(runs);
    if (!ok.length && runs.length) setView("showcase");
    const byStart = (a: Task, b: Task) => a.startDate.localeCompare(b.startDate);
    setData({
      tasks: ok.flatMap((x) => forRole(x.t.tasks, x.t.role)).sort(byStart),
      dependencies: ok.flatMap((x) => x.t.dependencies).filter((d) => ok.some((x) => String((d as { fromTask: string }).fromTask).startsWith(x.id))),
    });
  }, []);

  // The Gantt is a 1.8 MB chunk: desktops load it at once, phones get a light preview and load it on request.
  const [gantt, setGantt] = useState(false);
  useEffect(() => {
    if (window.matchMedia("(min-width: 1024px)").matches) {
      setGantt(true);
      preloadTimeline(); // fetch the Gantt chunk while the data loads, not after
    }
    load();
  }, [load]);

  const onReschedule = useCallback(
    async (id: string, dueAt: Date) => {
      try {
        const r = await fetch(`/api/milestones/${id}/schedule`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-milestone-token": tokens[id] ?? "" },
          body: JSON.stringify({ dueAt: dueAt.toISOString() }),
        });
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        const day = dueAt.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
        setNotice(r.ok ? { kind: "ok", text: `Due date moved to ${day}.` } : { kind: "error", text: `The due date was not moved: ${(b.error ?? `the server replied ${r.status}`).replace(/\.$/, "")}.` });
      } catch {
        setNotice({ kind: "error", text: "The due date was not moved: the server could not be reached." });
      }
      load(); // redraw from the server either way (puts the bar back if the move was refused)
    },
    [tokens, load],
  );

  // A drag past the hold's limit is refused in the Gantt before any request is made.
  const onRefuse = useCallback((message: string) => setNotice({ kind: "error", text: `The due date was not moved: ${message}` }), []);

  const showing = view === "showcase" && !!showcase?.length;
  const showcaseChart = useMemo(() => (showcase?.length ? showcaseData(showcase) : undefined), [showcase]);
  const ownCount = data?.tasks.length ?? 0;

  return (
    <main className="flex h-[calc(100vh-3.25rem)] flex-col">
      <DemoTour onTimeline />
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3 border-b border-rule bg-panel">
        <Link href="/milestones" className="text-sm underline">
          ← Milestones
        </Link>
        <h1 className="font-semibold">Timeline</h1>
        <p className="text-sm text-ink-2">Money gates the schedule: work starts when the PayPal hold is placed, and pays out after review and the objection window. A failed review reschedules what follows.</p>
        {!showing && ownCount > 0 && !!showcase?.length && <ShowcaseToggle onShow={() => setView("showcase")} />}
      </header>
      {showing && <ShowcaseNotice count={showcase!.length} onBack={ownCount > 0 ? () => setView("own") : undefined} className="mx-4 mt-2" />}
      <div role="status" aria-live="polite" className="empty:hidden mx-4 mt-2 flex flex-col gap-2">
        {!showing && notice && (
          <p className={`rounded-md border p-2 text-sm ${notice.kind === "error" ? "border-failed/40 bg-failed-field" : "border-paid/40 bg-paid-field"}`}>
            {notice.text}
          </p>
        )}
        {!showing && warnings.map((w, i) => (
          <p key={`${i}:${w}`} className="rounded-md border border-held/40 bg-held-field p-2 text-sm">
            {w}
          </p>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {!data ? (
          <TimelineSkeleton />
        ) : !gantt && (showing || data.tasks.length > 0) ? (
          <TimelinePreview tasks={(showing ? showcaseChart!.tasks : data.tasks) as Task[]} onOpen={() => setGantt(true)} />
        ) : showing ? (
          <GanttView key="showcase" data={showcaseChart!} readOnly fit />
        ) : data.tasks.length > 0 ? (
          <GanttView key="own" data={data} onReschedule={onReschedule} onRefuse={onRefuse} />
        ) : (
          <p className="p-4 text-sm text-ink-2">
            No milestones yet: <Link href="/new" className="underline">create one first</Link>.
          </p>
        )}
      </div>
    </main>
  );
}

type Bar = Task & { name?: string; endDate?: string; status?: string };
const BAR: Record<string, string> = { done: "bg-paid", active: "bg-ink", failed: "bg-failed", cancelled: "bg-blocked", todo: "bg-blocked", blocked: "bg-blocked", unfunded: "bg-blocked" };

// Phones: the same data as plain bars in the money colours, with no Gantt chunk until asked for.
function TimelinePreview({ tasks, onOpen }: { tasks: Task[]; onOpen: () => void }) {
  return (
    <div className="h-full overflow-auto px-4 py-4">
      <ol className="space-y-6">
        {(tasks as Bar[]).map((m) => {
          const kids = (m.children ?? []) as Bar[];
          const t0 = Math.min(...kids.map((k) => +new Date(k.startDate)));
          const t1 = Math.max(...kids.map((k) => +new Date(k.endDate ?? k.startDate)));
          const span = Math.max(t1 - t0, 1);
          return (
            <li key={m.id}>
              <p className="text-sm font-semibold text-ink">{m.name}</p>
              <ol className="mt-2 space-y-1.5">
                {kids.map((k) => {
                  const a = +new Date(k.startDate);
                  const b = +new Date(k.endDate ?? k.startDate);
                  return (
                    <li key={k.id} className="grid grid-cols-[7.5rem_1fr] items-center gap-2 text-xs">
                      <span className="truncate text-ink-2" title={k.name}>
                        {k.name}
                      </span>
                      <span className="relative h-3 rounded-sm bg-paper">
                        <span className={`absolute inset-y-0 rounded-sm ${k.phase === "hold" && k.status === "active" ? "bg-held" : (BAR[k.status ?? "todo"] ?? "bg-blocked")}`} style={{ left: `${((a - t0) / span) * 100}%`, width: `max(4px, ${((b - a) / span) * 100}%)` }} />
                      </span>
                    </li>
                  );
                })}
              </ol>
            </li>
          );
        })}
      </ol>
      <button type="button" onClick={onOpen} className="mt-6 min-h-11 w-full rounded-md border border-rule-strong bg-panel px-4 text-sm font-medium text-ink">
        Open the interactive Gantt (Bryntum, about 1.8 MB)
      </button>
    </div>
  );
}

// Static placeholder in the Gantt's shape (grid on the left, bars on the right). No shimmer: motion is
// reserved for one moment per page.
function TimelineSkeleton() {
  const bars = [
    [0, 70],
    [0, 12],
    [12, 40],
    [16, 34],
    [50, 10],
    [60, 12],
    [72, 8],
  ];
  return (
    <div aria-busy="true" className="flex h-full min-h-64 border-t border-rule bg-panel">
      <span className="sr-only">Loading the timeline…</span>
      <div aria-hidden className="w-[150px] shrink-0 border-r border-rule-strong sm:w-[450px]">
        <div className="h-[49px] border-b border-rule" />
        {bars.map((_, i) => (
          <div key={i} className="flex h-[50px] items-center border-b border-rule px-3">
            <div className={`h-2.5 rounded-sm bg-blocked-field ${i === 0 ? "w-3/4" : "ml-4 w-1/2"}`} />
          </div>
        ))}
      </div>
      <div aria-hidden className="relative min-w-0 flex-1 overflow-hidden">
        <div className="flex h-[49px] items-end border-b border-rule px-3 pb-2 text-xs text-ink-3">Loading the timeline…</div>
        {bars.map(([left, width], i) => (
          <div key={i} className="relative h-[50px] border-b border-rule">
            <div className="absolute top-[13px] h-6 rounded-sm bg-blocked-field" style={{ left: `${left}%`, width: `${width}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}
