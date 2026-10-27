"use client";

import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type GridApi, type IRowNode } from "ag-grid-community";

import { PartNumberCell } from "@/components/copy-part-number";

// Every workspace grid imports this module, so registration happens before any grid renders.
ModuleRegistry.registerModules([AllCommunityModule]);

export function workspaceGridTheme(rowHeight: number) {
  return themeQuartz.withParams({
    accentColor: "var(--primary)",
    backgroundColor: "var(--card)",
    borderColor: "var(--border)",
    foregroundColor: "var(--foreground)",
    headerBackgroundColor: "var(--muted)",
    headerTextColor: "var(--muted-foreground)",
    rowHoverColor: "var(--muted)",
    selectedRowBackgroundColor: "var(--accent)",
    fontFamily: "var(--font-geist-sans), ui-sans-serif",
    fontSize: 13,
    headerFontSize: 11,
    headerFontWeight: 650,
    rowHeight,
    headerHeight: 42,
    wrapperBorderRadius: 0,
    spacing: 6,
  });
}

export const partNumberColumn = {
  field: "partNumber",
  equals: () => false, // Obsoletion can change while the displayed part number stays the same.
  cellRenderer: PartNumberCell,
  cellRendererParams: { suppressMouseEventHandling: () => true },
  headerName: "PART",
  minWidth: 155,
  pinned: "left",
  cellClass: "font-mono font-semibold",
} as const satisfies ColDef<{ partNumber: string }>;

/** Checkbox selection that mirrors an id list held in React state; each grid adds selectAll and isRowSelectable. */
export const BASE_ROW_SELECTION = {
  mode: "multiRow",
  checkboxes: true,
  headerCheckbox: true,
  hideDisabledCheckboxes: false,
  enableClickSelection: false,
} as const;

export const SELECTION_COLUMN_DEF = { width: 48, pinned: "left", resizable: false } as const;

// Grid props are compared by reference. A new defaultColDef object on each render makes the grid
// reapply every column's configured width, undoing the user's column resizes.
export const DEFAULT_COL_DEF = { sortable: true, filter: false, resizable: true } as const;
export const FILTERABLE_COL_DEF = { sortable: true, filter: true, resizable: true } as const;

/** False for selection events caused by syncGridSelection or row data changes rather than the user. */
export function isUserSelectionSource(source: string) {
  return !["api", "rowDataChanged", "gridInitializing", "selectableChanged"].includes(source);
}

/** Pushes the React-held selection into the grid; run on grid ready, row data updates and selection changes. */
export function syncGridSelection<T>(api: GridApi<T> | undefined, isSelected: (row: T) => boolean) {
  if (!api || api.isDestroyed()) return;
  const toSelect: IRowNode<T>[] = [];
  const toDeselect: IRowNode<T>[] = [];
  api.forEachNode((node) => {
    if (!node.data) return;
    (isSelected(node.data) ? toSelect : toDeselect).push(node);
  });
  if (toSelect.length) api.setNodesSelected({ nodes: toSelect, newValue: true, source: "api" });
  if (toDeselect.length) api.setNodesSelected({ nodes: toDeselect, newValue: false, source: "api" });
}
