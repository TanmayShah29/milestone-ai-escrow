// Judge mode in the browser: which seeded milestones belong to the guided tour (per-viewer convenience).
export type DemoStory = "paid" | "caught" | "fund";
export type DemoState = { milestones: { id: string; title: string; story: DemoStory }[]; dismissed?: boolean };

const KEY = "milestone:demo";

export function readDemo(): DemoState | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as DemoState) : undefined;
  } catch {
    return undefined;
  }
}

export function writeDemo(state: DemoState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // storage unavailable: the tour simply won't show
  }
}
