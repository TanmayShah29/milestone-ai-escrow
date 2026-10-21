// Browser-side store of the milestone links this browser holds (client and/or worker tokens).
// Per-viewer convenience only: the tokens themselves are the access control.

export type Held = { id: string; title: string; client?: string; worker?: string };

const KEY = "milestone:links";

export function heldLinks(): Held[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as Held[];
  } catch {
    return [];
  }
}

export function rememberLink(entry: Held): void {
  try {
    const all = heldLinks().filter((h) => h.id !== entry.id);
    const prev = heldLinks().find((h) => h.id === entry.id);
    localStorage.setItem(KEY, JSON.stringify([{ ...prev, ...entry }, ...all].slice(0, 50)));
  } catch {
    // storage unavailable (private window): links still work from the URL
  }
}

export function linkFor(id: string): Held | undefined {
  return heldLinks().find((h) => h.id === id);
}
