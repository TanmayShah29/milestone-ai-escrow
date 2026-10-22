// Browser-side store of the milestone links this browser holds (client and/or worker tokens).
// Per-viewer convenience only: the tokens themselves are the access control.
//
// `client` / `worker` are the roles this browser acts as. A creator's browser holds only `client`; the
// worker link it must hand over sits in `shareWorker`, which is shown for copying and never used to act.
// Only judge-mode demo projects hold both roles, so judges can switch sides.

import { readDemo } from "@/lib/client/demo";

export type Held = { id: string; title: string; client?: string; worker?: string; shareWorker?: string };

const KEY = "milestone:links";

const isDemo = (id: string) => !!readDemo()?.milestones.some((m) => m.id === id);

/**
 * Entries saved before the split held both tokens for milestones made on /new. Outside judge mode,
 * demote the worker token to share-only so the client can no longer act as the worker. Applied on read,
 * not saved: judge mode stores its links just before it records which milestones are demos.
 */
function migrate(h: Held): Held {
  if (!h.client || !h.worker || isDemo(h.id)) return h;
  const { worker, ...rest } = h;
  return { ...rest, shareWorker: h.shareWorker ?? worker };
}

function stored(): Held[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as Held[];
  } catch {
    return [];
  }
}

export function heldLinks(): Held[] {
  return stored().map(migrate);
}

// A link opened in this tab that would change a milestone this browser already holds. It is kept in
// memory only until the server accepts it, so a forged or stale `?t=` link can't replace a working one.
const pending = new Map<string, Held>();

const tokensOf = (h: Held | undefined) => [h?.client, h?.worker, h?.shareWorker].filter((t): t is string => !!t);

/**
 * Merge an entry into this browser's links. A worker token that this browser only holds to share (the
 * client opened their own worker link) stays share-only: it doesn't make the client the worker too.
 *
 * A token this browser doesn't know yet, for a milestone it already holds a link to, is not saved: it
 * waits in `pending` (and `linkFor` offers it for this visit) until a later call confirms it. A call with
 * no tokens, made after the server accepted the request (e.g. to save the title), confirms it.
 */
export function rememberLink(entry: Held): void {
  const prev = stored().find((h) => h.id === entry.id);
  const known = tokensOf(prev);
  const incoming = tokensOf(entry);
  if (known.length && incoming.some((t) => !known.includes(t))) {
    pending.set(entry.id, entry);
    return;
  }
  const waiting = incoming.length ? undefined : pending.get(entry.id);
  pending.delete(entry.id);
  save(waiting ? { ...waiting, title: entry.title || waiting.title } : entry);
}

/** Save a pending link for this milestone once the server has accepted it. */
export function confirmLink(id: string): void {
  const p = pending.get(id);
  pending.delete(id);
  if (p) save(p);
}

/** Drop a pending link the server refused, so this tab goes back to the saved links. */
export function discardLink(id: string): void {
  pending.delete(id);
}

function save(entry: Held): void {
  try {
    const all = stored().filter((h) => h.id !== entry.id);
    const prev = stored().find((h) => h.id === entry.id);
    const next: Held = { ...prev, ...entry };
    if (!entry.title && prev?.title) next.title = prev.title;
    const shared = prev && migrate(prev).shareWorker;
    if (entry.worker && prev?.client && shared === entry.worker && !isDemo(entry.id)) {
      delete next.worker;
      next.shareWorker = shared;
    }
    localStorage.setItem(KEY, JSON.stringify([next, ...all].slice(0, 50)));
  } catch {
    // storage unavailable (private window): links still work from the URL
  }
}

/**
 * The links to act with on this milestone. While a link opened in this tab is pending, it alone is
 * offered, so the page tries it (and a success confirms it); a reload falls back to the saved links.
 */
export function linkFor(id: string): Held | undefined {
  const p = pending.get(id);
  if (p) return { id, title: p.title, ...(p.client ? { client: p.client } : {}), ...(p.worker ? { worker: p.worker } : {}) };
  return heldLinks().find((h) => h.id === id);
}

/** The worker token to show the client for sharing (never to authenticate with). */
export function workerShareToken(h: Held | undefined): string | undefined {
  return h?.shareWorker ?? h?.worker;
}

// Whether the client has dismissed "Save your client link" for a milestone. Only ids are stored here,
// never tokens. Per-browser convenience: if storage is unavailable, the reminder simply shows again.
const SAVED_KEY = "milestone:link-saved";

function savedIds(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SAVED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Remember that the client saved (or chose to dismiss the reminder for) this milestone's link. */
export function markLinkSaved(id: string): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify([id, ...savedIds().filter((x) => x !== id)].slice(0, 200)));
  } catch {
    // storage unavailable (private window): the reminder shows again next time
  }
}

/** A client link this browser holds that the client hasn't confirmed saving. Judge-mode demos never ask. */
export function needsLinkReminder(h: Held | undefined): boolean {
  return !!h?.client && !isDemo(h.id) && !savedIds().includes(h.id);
}

/** The full client link for a milestone this browser holds as the client (the only way back to it). */
export function clientLinkUrl(origin: string, h: Held | undefined): string | undefined {
  return h?.client ? `${origin}/milestones/${h.id}?t=${encodeURIComponent(h.client)}` : undefined;
}
