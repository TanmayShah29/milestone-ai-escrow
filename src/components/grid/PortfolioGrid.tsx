"use client";

import { AgGridReact } from "ag-grid-react";
import type { CellKeyDownEvent, ColDef, GridApi, ValueFormatterParams } from "ag-grid-community";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef } from "react";
import type { PortfolioRow } from "@/lib/client/ledger";
import { usd } from "@/lib/client/states";
import { HoldCell, MoneyNowCell, NextActionCell, PortfolioStatusCell, TitleCell } from "./cells";
import { GRID_MODULES, gridTheme, resetColumns, restoreColumns, saveColumns } from "./setup";

const COLUMNS_KEY = "milestone:portfolio-columns";

const fmtDue = (p: ValueFormatterParams<PortfolioRow, string | null>) => {
  if (!p.value) return "No date";
  const d = new Date(p.value);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) });
};

/** Wrapped cells (they grow the row) read at text line height, not the grid's single-line row height. */
const WRAP = { lineHeight: "1.35", paddingTop: "12px", paddingBottom: "12px" };

/** Sort live holds by days left, most urgent first; milestones with no live hold go last either way. */
const holdComparator = (a: number | null, b: number | null, _na: unknown, _nb: unknown, desc: boolean) => {
  if (a == null && b == null) return 0;
  if (a == null) return desc ? -1 : 1;
  if (b == null) return desc ? 1 : -1;
  return a - b;
};

export default function PortfolioGrid({ rows }: { rows: PortfolioRow[] }) {
  const router = useRouter();
  const api = useRef<GridApi<PortfolioRow>>(null);

  const columnDefs = useMemo<ColDef<PortfolioRow>[]>(
    () => [
      { field: "title", headerName: "Milestone", cellRenderer: TitleCell, tooltip: true, filter: "agTextColumnFilter", pinned: "left", lockPinned: true, flex: 1.3, minWidth: 150 },
      { field: "status", headerName: "Status", cellRenderer: PortfolioStatusCell, filter: "agTextColumnFilter", width: 255 },
      {
        colId: "next",
        headerName: "Next action",
        valueGetter: (p) => p.data?.next.text,
        cellRenderer: NextActionCell,
        filter: "agTextColumnFilter",
        wrapText: true,
        autoHeight: true,
        cellStyle: WRAP,
        flex: 1,
        minWidth: 150,
      },
      {
        field: "holdDays",
        headerName: "Hold ends",
        headerTooltip: "Days left on the PayPal hold. PayPal holds last 29 days at most.",
        cellRenderer: HoldCell,
        valueFormatter: (p) => (p.value == null ? "No live hold" : `${p.value} days left`),
        comparator: holdComparator,
        filter: "agNumberColumnFilter",
        sort: "asc",
        wrapText: true,
        autoHeight: true,
        cellStyle: WRAP,
        width: 135,
      },
      {
        colId: "money",
        headerName: "Money now",
        valueGetter: (p) => p.data?.money.word,
        cellRenderer: MoneyNowCell,
        filter: "agTextColumnFilter",
        width: 130,
      },
      { field: "amountCents", headerName: "Amount", valueFormatter: (p) => usd(p.value as number), filter: "agNumberColumnFilter", type: "rightAligned", width: 95 },
      { field: "due", headerName: "Due", valueFormatter: fmtDue, width: 80 },
      { field: "role", headerName: "Your role", valueFormatter: (p) => (p.value === "client" ? "Client" : "Worker"), filter: false, width: 100 },
    ],
    [],
  );

  const defaultColDef = useMemo<ColDef>(() => ({ sortable: true, resizable: true }), []);
  const save = useCallback(() => api.current && saveColumns(api.current, COLUMNS_KEY), []);
  const open = (id: string | undefined) => id && router.push(`/milestones/${id}`);

  return (
    <section aria-label="Your milestones">
      <AgGridReact<PortfolioRow>
        modules={GRID_MODULES}
        theme={gridTheme}
        rowData={rows}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        getRowId={(p) => p.data.id}
        domLayout="autoHeight"
        tooltipShowDelay={300}
        rowClass="cursor-pointer"
        onGridReady={(e) => {
          api.current = e.api;
          restoreColumns(e.api, COLUMNS_KEY);
        }}
        onSortChanged={save}
        onColumnMoved={(e) => e.finished && save()}
        onColumnResized={(e) => e.finished && save()}
        onColumnVisible={save}
        onRowClicked={(e) => open(e.data?.id)}
        onCellKeyDown={(e) => {
          const k = e as CellKeyDownEvent<PortfolioRow>;
          if ((k.event as KeyboardEvent | undefined)?.key === "Enter") open(k.data?.id);
        }}
      />
      <div className="mt-2 flex justify-end">
        <button type="button" onClick={() => api.current && resetColumns(api.current, COLUMNS_KEY)} className="text-sm text-ink-2 underline hover:text-ink">
          Reset columns
        </button>
      </div>
    </section>
  );
}
