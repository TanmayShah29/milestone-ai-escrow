"use client";

import {
  CellStyleModule,
  ClientSideRowModelModule,
  ColumnApiModule,
  CsvExportModule,
  DateFilterModule,
  ExternalFilterModule,
  NumberFilterModule,
  PinnedRowModule,
  QuickFilterModule,
  RowApiModule,
  RowAutoHeightModule,
  RowStyleModule,
  TextFilterModule,
  TooltipModule,
  ValidationModule,
  createPart,
  themeQuartz,
  type ColumnState,
  type GridApi,
  type Module,
} from "ag-grid-community";

// AG Grid Community (MIT) set up for Milestone: only the modules the two grids use, and a Quartz theme
// whose every colour is one of our CSS tokens, so dark mode follows the page with no second theme.

export const GRID_MODULES: Module[] = [
  ClientSideRowModelModule,
  ColumnApiModule,
  TextFilterModule,
  NumberFilterModule,
  DateFilterModule,
  QuickFilterModule,
  ExternalFilterModule,
  PinnedRowModule,
  TooltipModule,
  CsvExportModule,
  CellStyleModule,
  RowApiModule,
  RowAutoHeightModule,
  RowStyleModule,
  // Warns in the console about a missing module or a bad option; left out of production builds.
  ...(process.env.NODE_ENV === "production" ? [] : [ValidationModule]),
];

// Quartz draws a 1px focused-cell border; our focus ring is 2px everywhere (DESIGN.md), drawn inside the cell.
const focusRing = createPart({
  feature: "milestoneFocusRing",
  css: `.ag-cell-focus:not(.ag-cell-range-selected):focus-within, .ag-header-cell:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }`,
});

export const gridTheme = themeQuartz.withPart(focusRing).withParams({
  browserColorScheme: "inherit",
  fontFamily: "var(--font-public-sans), system-ui, sans-serif",
  headerFontFamily: "var(--font-public-sans), system-ui, sans-serif",
  cellFontFamily: "var(--font-public-sans), system-ui, sans-serif",
  fontSize: 14,
  headerFontSize: 13,
  headerFontWeight: 600,
  backgroundColor: "var(--panel)",
  foregroundColor: "var(--ink)",
  textColor: "var(--ink)",
  subtleTextColor: "var(--ink-3)",
  headerBackgroundColor: "var(--paper)",
  headerTextColor: "var(--ink-2)",
  chromeBackgroundColor: "var(--paper)",
  borderColor: "var(--rule)",
  rowBorder: { color: "var(--rule)" },
  headerRowBorder: { color: "var(--rule-strong)" },
  wrapperBorder: { color: "var(--rule)" },
  wrapperBorderRadius: 8,
  borderRadius: 6,
  accentColor: "var(--focus)",
  iconColor: "var(--ink-2)",
  rowHoverColor: "color-mix(in srgb, var(--ink) 5%, transparent)",
  oddRowBackgroundColor: "var(--panel)",
  rangeSelectionBorderColor: "var(--focus)",
  focusShadow: { spread: 2, color: "var(--focus)" },
  inputFocusBorder: { color: "var(--focus)" },
  pinnedRowBorder: { color: "var(--rule-strong)", width: 1 },
  pinnedRowBackgroundColor: "var(--paper)",
  pinnedRowTextColor: "var(--ink)",
  pinnedRowFontWeight: 600,
  menuBackgroundColor: "var(--panel)",
  menuTextColor: "var(--ink)",
  menuBorder: { color: "var(--rule-strong)" },
  tooltipBackgroundColor: "var(--ink)",
  tooltipTextColor: "var(--panel)",
  tooltipBorder: false,
  inputBackgroundColor: "var(--panel)",
  inputBorder: { color: "var(--rule-strong)" },
  inputTextColor: "var(--ink)",
  inputPlaceholderTextColor: "var(--ink-3)",
  rowHeight: 44,
  headerHeight: 40,
  spacing: 7,
});

// Column setup (order, width, sort, visibility) is a per-viewer convenience: kept in localStorage and
// simply forgotten when storage is unavailable.

export function restoreColumns(api: GridApi, key: string): void {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const state = JSON.parse(raw) as ColumnState[];
    if (Array.isArray(state)) api.applyColumnState({ state, applyOrder: true });
  } catch {
    // unreadable or blocked storage: keep the default columns
  }
}

export function saveColumns(api: GridApi, key: string): void {
  try {
    localStorage.setItem(key, JSON.stringify(api.getColumnState()));
  } catch {
    // storage unavailable (private window): the setup lasts this visit only
  }
}

export function resetColumns(api: GridApi, key: string): void {
  api.resetColumnState();
  try {
    localStorage.removeItem(key);
  } catch {
    // nothing stored
  }
}
