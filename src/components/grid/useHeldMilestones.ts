"use client";

import { useEffect, useState } from "react";
import { heldLinks, needsLinkReminder } from "@/lib/client/links";
import type { ActionRow, AuditRow } from "@/lib/client/ledger";
import type { MilestoneView, Role } from "@/lib/client/states";

// Loads every milestone this browser holds a link for, the same way /milestones always has: the client
// token if this browser holds one, else the worker token. The token only goes in the request header;
// nothing returned here carries it.

export type Held = {
  id: string;
  role: Role;
  saveLink: boolean;
  m?: MilestoneView;
  audit: AuditRow[];
  actions: ActionRow[];
  error?: string;
};

export function useHeldMilestones(): Held[] | undefined {
  const [rows, setRows] = useState<Held[]>();
  useEffect(() => {
    let live = true;
    const held = heldLinks();
    Promise.all(
      held.map(async (h): Promise<Held> => {
        const token = h.client ?? h.worker;
        const role: Role = h.client ? "client" : "worker";
        const saveLink = needsLinkReminder(h);
        const base = { id: h.id, role, saveLink, audit: [], actions: [] };
        const r = await fetch(`/api/milestones/${h.id}`, { headers: { "x-milestone-token": token ?? "" } }).catch(() => undefined);
        if (!r?.ok) return { ...base, error: "Couldn't load" };
        const body = (await r.json()) as { milestone: MilestoneView; audit?: AuditRow[]; actions?: ActionRow[] };
        return { ...base, m: body.milestone, audit: body.audit ?? [], actions: body.actions ?? [] };
      }),
    ).then((r) => live && setRows(r));
    return () => {
      live = false;
    };
  }, []);
  return rows;
}
