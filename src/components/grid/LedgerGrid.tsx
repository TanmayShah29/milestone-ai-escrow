"use client";

import { AgGridReact } from "ag-grid-react";
import type { CellKeyDownEvent, ColDef, GridApi, IRowNode, RowClickedEvent, ValueFormatterParams } from "ag-grid-community";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STATUS_COPY, ledgerTotals, totalRows, type LedgerRow, type TotalRow } from "@/lib/client/ledger";
import { usd, type MilestoneView } from "@/lib/client/states";
import { AttemptCell, LedgerMilestoneCell, LedgerStatusCell, MonoCell, attemptTooltip } from "./cells";
import { GRID_MODULES, gridTheme, resetColumns, restoreColumns, saveColumns } from "./setup";

const COLUMNS_KEY = "milestone:ledger-columns";

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const fmtDate = (p: ValueFormatterParams<LedgerRow, string>) => (p.value ? dateFmt.format(new Date(p.value)) : "");
const fmtUsd = (p: ValueFormatterParams<LedgerRow, number | null>) => (p.value == null ? "—" : usd(Math.round(p.value * 100)));

/** Date filter on ISO strings: compare the row's local calendar day with the filter's. */
const dateFilterParams = {
  comparator: (filterDate: Date, cell: string) => {
    if (!cell) return -1;
    const d = new Date(cell);
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return day === filterDate.getTime() ? 0 : day < filterDate.getTime() ? -1 : 1;
  },
};

type Props = {
  rows: LedgerRow[];
  /** The loaded milestones, for the milestone filter and the pinned totals. */
  milestones: MilestoneView[];
};

export default function LedgerGrid({ rows, milestones }: Props) {
  const router = useRouter();
  const api = useRef<GridApi<LedgerRow>>(null);
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState("");
  const [shown, setShown] = useState(rows.length);
  const onlyRef = useRef(only);
  // On a phone the grid scrolls sideways; pin Action and Amount so each row (and each total) stays readable.
  const [narrow] = useState(() => window.matchMedia("(max-width: 639px)").matches);
  const totals = useMemo(() => totalRows(ledgerTotals(only ? milestones.filter((m) => m.id === only) : milestones)), [milestones, only]);

  const columnDefs = useMemo<ColDef<LedgerRow>[]>(
    () => [
      { field: "at", headerName: "Date", valueFormatter: fmtDate, filter: "agDateColumnFilter", filterParams: dateFilterParams, sort: "desc", flex: 1.1, minWidth: 180, getQuickFilterText: (p) => (p.value ? dateFmt.format(new Date(p.value)) : "") },
      { field: "milestone", headerName: "Milestone", filter: "agTextColumnFilter", cellRenderer: LedgerMilestoneCell, flex: 1.4, minWidth: 150 },
      {
        field: "action",
        headerName: "Action",
        filter: "agTextColumnFilter",
        ...(narrow ? { pinned: "left" as const, width: 132 } : { flex: 0.9, minWidth: 115 }),
        tooltip: (p) => (p.node?.rowPinned ? (p.data as unknown as TotalRow | undefined)?.help : undefined),
      },
      {
        colId: "amount",
        headerName: "Amount",
        valueGetter: (p) => (p.data?.amountCents == null ? null : p.data.amountCents / 100),
        valueFormatter: fmtUsd,
        filter: "agNumberColumnFilter",
        type: "rightAligned",
        ...(narrow ? { pinned: "left" as const, width: 100 } : { flex: 0.8, minWidth: 100 }),
      },
      {
        field: "status",
        headerName: "Status",
        cellRenderer: LedgerStatusCell,
        valueFormatter: (p) => (p.value ? STATUS_COPY[p.value as LedgerRow["status"]].label : ""),
        filter: "agTextColumnFilter",
        filterValueGetter: (p) => (p.data?.status ? STATUS_COPY[p.data.status].label : ""),
        getQuickFilterText: (p) => (p.data?.status ? STATUS_COPY[p.data.status].label : ""),
        tooltip: (p) => (p.data?.status ? STATUS_COPY[p.data.status].help : undefined),
        flex: 1.1,
        minWidth: 150,
      },
      {
        field: "attempt",
        headerName: "Attempt",
        headerTooltip: "Each attempt sends its own PayPal-Request-Id, the idempotency key that makes a retry safe.",
        cellRenderer: AttemptCell,
        tooltip: (p) => attemptTooltip(p.data),
        filter: "agNumberColumnFilter",
        type: "rightAligned",
        width: 100,
      },
      { field: "paypalId", headerName: "PayPal reference", cellRenderer: MonoCell, filter: "agTextColumnFilter", flex: 1.2, minWidth: 160 },
      { field: "actor", headerName: "Actor", filter: "agTextColumnFilter", flex: 0.8, minWidth: 100 },
      // Not shown; exported to CSV so the file carries the idempotency key of every attempt.
      { field: "requestId", headerName: "PayPal-Request-Id", hide: true },
    ],
    [narrow],
  );

  const defaultColDef = useMemo<ColDef>(() => ({ sortable: true, resizable: true, filter: true, suppressHeaderMenuButton: false }), []);

  const isExternalFilterPresent = useCallback(() => onlyRef.current !== "", []);
  const doesExternalFilterPass = useCallback((node: IRowNode<LedgerRow>) => node.data?.milestoneId === onlyRef.current, []);

  useEffect(() => {
    onlyRef.current = only;
    api.current?.onFilterChanged();
  }, [only]);

  const open = useCallback((data: LedgerRow | undefined, pinned: unknown) => {
    if (!pinned && data?.milestoneId) router.push(`/milestones/${data.milestoneId}`);
  }, [router]);

  const save = useCallback(() => api.current && saveColumns(api.current, COLUMNS_KEY), []);

  const download = () =>
    api.current?.exportDataAsCsv({
      fileName: `milestone-ledger-${new Date().toISOString().slice(0, 10)}.csv`,
      allColumns: true,
    });

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm text-ink-2">
          Search the ledger
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Milestone, PayPal id, status…"
            className="w-64 rounded-md border border-rule-strong bg-panel px-3 py-2 text-ink placeholder:text-ink-3"
          />
        </label>
        <label className="grid gap-1 text-sm text-ink-2">
          Milestone
          <select value={only} onChange={(e) => setOnly(e.target.value)} className="w-56 rounded-md border border-rule-strong bg-panel px-3 py-2 text-ink">
            <option value="">All milestones</option>
            {milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => api.current && resetColumns(api.current, COLUMNS_KEY)}
            className="rounded-md border border-rule-strong bg-panel px-3 py-2 text-sm font-medium text-ink hover:bg-paper"
          >
            Reset columns
          </button>
          <button type="button" onClick={download} className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90">
            Download CSV
          </button>
        </div>
      </div>
      <p className="mt-3 text-sm text-ink-3" aria-live="polite">
        {shown} of {rows.length} PayPal call{rows.length === 1 ? "" : "s"} shown. Totals below are for {only ? "this milestone" : "all milestones"}.
      </p>

      <section className="mt-3" aria-label="PayPal money ledger">
        <AgGridReact<LedgerRow>
          modules={GRID_MODULES}
          theme={gridTheme}
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={(p) => p.data.key}
          pinnedBottomRowData={totals}
          quickFilterText={query}
          isExternalFilterPresent={isExternalFilterPresent}
          doesExternalFilterPass={doesExternalFilterPass}
          domLayout="autoHeight"
          tooltipShowDelay={300}
          rowClass="cursor-pointer"
          overlayNoRowsTemplate="<span>No PayPal calls match.</span>"
          onGridReady={(e) => {
            api.current = e.api;
            restoreColumns(e.api, COLUMNS_KEY);
          }}
          onModelUpdated={(e) => setShown(e.api.getDisplayedRowCount())}
          onSortChanged={save}
          onColumnMoved={(e) => e.finished && save()}
          onColumnResized={(e) => e.finished && save()}
          onColumnVisible={save}
          onColumnPinned={save}
          onRowClicked={(e: RowClickedEvent<LedgerRow>) => open(e.data, e.node.rowPinned)}
          onCellKeyDown={(e) => {
            const k = e as CellKeyDownEvent<LedgerRow>;
            if ((k.event as KeyboardEvent | undefined)?.key === "Enter") open(k.data, k.node.rowPinned);
          }}
        />
      </section>
    </div>
  );
}
