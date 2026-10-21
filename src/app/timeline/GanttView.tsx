"use client";

import { ProjectModel, StringHelper, TaskModel, type Column, type ColumnStore, type Gantt, type ViewPresetConfig } from "@bryntum/gantt";
import { BryntumGantt, type BryntumGanttProps } from "@bryntum/gantt-react";
import { useEffect, useMemo, useRef, useState } from "react";
import "@bryntum/gantt/gantt.css";
import "@bryntum/gantt/svalbard-light.css";
import "@bryntum/gantt/fontawesome/css/fontawesome.css";
import "@bryntum/gantt/fontawesome/css/solid.css";
import "./gantt.css";
import { dueCapMessage } from "@/lib/timeline";

// The money-aware Gantt: each milestone is a row with its phases; the PayPal hold gates the work
// (finish-to-start), the hold's day-3 honor period and day-29 expiry are indicators on its bar, and the
// client can drag the Work bar to move the due date, up to the latest date the hold allows (`dueLimit`: the
// hold's day-29 expiry minus 3 days; holds can't be extended, so a drag past it is refused). Whether a
// Work bar can be dragged comes from the data (`canReschedule`, set by lib/timeline.ts and the viewer's role).
// Theme: gantt.css maps Bryntum's palette onto our tokens, so the chart follows light and dark.
// Note: the React wrapper takes features as `<name>Feature` props; a `features` object is ignored.

class MilestoneTask extends TaskModel {
  // Bryntum declares `fields` as a static getter, so a static class property throws at runtime.
  static get fields() {
    return [
      { name: "status", type: "string" },
      { name: "milestoneId", type: "string" },
      { name: "phase", type: "string" },
      { name: "honorEnd", type: "date" },
      { name: "holdExpiry", type: "date" },
      { name: "holdWarn", type: "boolean" },
      { name: "canReschedule", type: "boolean" },
      { name: "dueLimit", type: "date" },
    ];
  }
}

type Data = { tasks: unknown[]; dependencies: unknown[] };

// Weeks over day numbers: one readable label per week, and a one-day bar is wide enough to grab.
const PRESET: ViewPresetConfig = {
  base: "weekAndDay",
  tickWidth: 32,
  displayDateFormat: "ll",
  shiftUnit: "week",
  timeResolution: { unit: "hour", increment: 6 },
  headers: [
    { unit: "week", dateFormat: "D MMM YYYY" },
    { unit: "day", dateFormat: "D" },
  ],
};

// Under Tailwind's `sm` the grid shrinks to the task names so the bars stay visible.
const NARROW = "(max-width: 639px)";
const GRID = { wide: { name: 320, status: 140 }, narrow: { name: 150 } };
const STATUS_LABEL: Record<string, string> = { unfunded: "not funded" };

const canDrag = (t: TaskModel) => t.get("phase") === "work" && !!t.get("canReschedule");

const pastLimit = (t: TaskModel, end: Date | null | undefined) => {
  const limit = t.get("dueLimit") as Date | null;
  return limit && end && end.getTime() > limit.getTime() ? limit : null;
};

export default function GanttView(props: { data: Data; onReschedule: (milestoneId: string, dueAt: Date) => void; onRefuse?: (message: string) => void }) {
  const { data, onReschedule, onRefuse } = props;

  const ref = useRef<BryntumGantt>(null);
  const refused = useRef<TaskModel | null>(null); // the Work bar whose drag ended past the hold's limit
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  const initialNarrow = useRef(narrow);
  const project = useMemo(() => new ProjectModel({ taskModelClass: MilestoneTask, tasks: data.tasks as never[], dependencies: data.dependencies as never[] }), [data]);

  const config = useMemo<BryntumGanttProps>(
    () => ({
      project,
      // Open at the start of the work (a day before), not the empty days the time axis pads in before it.
      visibleDate: { date: new Date(Math.min(...data.tasks.map((t) => Date.parse((t as { startDate: string }).startDate))) - 86_400_000), block: "start" },
      ariaLabel: "Milestone timeline: each milestone's phases and PayPal hold over time",
      viewPreset: PRESET,
      rowHeight: 50,
      barMargin: 10,
      columns: [
        { id: "name", type: "name", width: initialNarrow.current ? GRID.narrow.name : GRID.wide.name },
        {
          id: "status",
          text: "Status",
          field: "status",
          width: GRID.wide.status,
          hidden: initialNarrow.current,
          renderer: ({ record }: { record: MilestoneTask }) => {
            if (!record.isLeaf) return `${Math.round(record.percentDone)}% done`;
            const s = String(record.get("status") ?? "");
            return STATUS_LABEL[s] ?? s;
          },
        },
      ],
      taskEditFeature: false,
      taskMenuFeature: false,
      cellEditFeature: false,
      dependencyEditFeature: false,
      taskDragFeature: false,
      taskDragCreateFeature: false,
      taskResizeFeature: {
        leftHandle: false,
        reservedSpace: 0,
        // The hold's limit is a hard stop: a drop past it is refused here and by the schedule API.
        validatorFn: ({ record, endDate }: { record: TaskModel; endDate: Date }) => {
          refused.current = pastLimit(record, endDate) ? record : null;
          return !refused.current;
        },
        tooltipTemplate: ({ record, endDate, valid }: { record: TaskModel; endDate: Date; valid: boolean }) => {
          const limit = pastLimit(record, endDate);
          return valid || !limit ? `Due ${StringHelper.encodeHtml(endDate.toDateString())}` : `<b>Too late</b><br>${StringHelper.encodeHtml(dueCapMessage(limit))}`;
        },
      },
      percentBarFeature: { allowResize: false }, // progress comes from the milestone's state, not a drag
      dependenciesFeature: { allowCreate: false },
      timeRangesFeature: { showCurrentTimeLine: true },
      indicatorsFeature: {
        items: {
          earlyDates: false,
          lateDates: false,
          constraintDate: false,
          deadlineDate: true, // the Work task's due date
          honor: (t: TaskModel) => {
            const d = t.get("honorEnd") as Date | null;
            return d ? { startDate: d, name: "Honor period ends (day 3)", iconCls: "fa fa-clock", cls: "ms-ind-honor" } : null;
          },
          expiry: (t: TaskModel) => {
            const d = t.get("holdExpiry") as Date | null;
            if (!d) return null;
            const warn = !!t.get("holdWarn");
            return { startDate: d, name: warn ? "Hold expires (day 29) before the work is due: move the date earlier" : "Hold expires (day 29), can't be extended", iconCls: warn ? "fa fa-triangle-exclamation" : "fa fa-hourglass-end", cls: warn ? "ms-ind-danger" : "ms-ind-expiry" };
          },
          dueLimit: (t: TaskModel) => {
            const d = t.get("dueLimit") as Date | null;
            return d && canDrag(t) ? { startDate: d, name: "Latest due date the PayPal hold allows", iconCls: "fa fa-ban", cls: "ms-ind-limit" } : null;
          },
        },
      },
      taskTooltipFeature: {
        template: ({ taskRecord }: { taskRecord: TaskModel }) =>
          `<b>${StringHelper.encodeHtml(taskRecord.name)}</b><br>${StringHelper.encodeHtml(String(taskRecord.get("note") ?? ""))}` +
          (taskRecord.get("phase") !== "work" ? "" : canDrag(taskRecord) ? `<br><i>Drag the end of this bar to move the due date${taskRecord.get("dueLimit") ? ` (up to ${StringHelper.encodeHtml((taskRecord.get("dueLimit") as Date).toDateString())}: PayPal holds last 29 days)` : ""}.</i>` : "<br><i>The due date is fixed: work was submitted, or only the client can move it.</i>"),
      },
      onBeforeTaskResize: ({ taskRecord }: { taskRecord: TaskModel }) => canDrag(taskRecord),
      onTaskResizeEnd: ({ changed, taskRecord }: { changed: boolean; taskRecord: TaskModel }) => {
        if (refused.current === taskRecord) {
          refused.current = null;
          onRefuse?.(dueCapMessage(taskRecord.get("dueLimit") as Date));
          return;
        }
        if (changed && taskRecord.endDate) onReschedule(String(taskRecord.get("milestoneId")), taskRecord.endDate as Date);
      },
    }),
    [project, data, onReschedule, onRefuse],
  );

  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // Apply a breakpoint change to the live grid (the config above only sets the initial layout).
  useEffect(() => {
    const g = ref.current?.instance as Gantt | undefined;
    if (!g) return;
    const columns = g.columns as ColumnStore;
    const name = columns.getById("name") as Column | undefined;
    const status = columns.getById("status") as Column | undefined;
    if (name) name.width = narrow ? GRID.narrow.name : GRID.wide.name;
    if (status) status.hidden = narrow;
  }, [narrow]);

  return <BryntumGantt ref={ref} {...config} />;
}
