// The Gantt chunk (Bryntum) is large; a cold load takes seconds. Other screens (e.g. /demo) can call
// preloadTimeline() when the timeline is likely next, so the chunk is already cached when it opens.
// The page loads its view through the same function, so both share one chunk.
export const loadGanttView = () => import("./GanttView");

let started: Promise<unknown> | undefined;
export function preloadTimeline(): void {
  if (typeof window === "undefined" || started) return;
  started = loadGanttView().catch(() => {
    started = undefined; // let a later call retry
  });
}
