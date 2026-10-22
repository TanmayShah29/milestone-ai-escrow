"use client";

import { ProjectModel, StringHelper, TaskModel, type Column, type ColumnStore, type Gantt, type TimeSpanConfig, type ViewPresetConfig } from "@bryntum/gantt";
import { BryntumGantt, type BryntumGanttProps } from "@bryntum/gantt-react";
import { useEffect, useMemo, useRef, useState } from "react";
import "@bryntum/gantt/gantt.css";
import "@bryntum/gantt/svalbard-light.css";
import "@bryntum/gantt/fontawesome/css/fontawesome.css";
import "@bryntum/gantt/fontawesome/css/solid.css";
import "./gantt.css";
import { dueCapMessage } from "@/lib/timeline";

// The money-aware Gantt: each milestone is a row with its phases; the PayPal hold gates the work, the
// hold's day-3 honor period, life and day-29 expiry are bands behind the milestone's rows, and the client
// can drag the Work bar to move the due date, up to the latest date the hold allows (`dueLimit`: the
// hold's day-29 expiry minus 3 days; holds can't be extended, so a drag past it is refused). Whether a
// Work bar can be dragged comes from the data (`canReschedule`, set by lib/timeline.ts and the viewer's role).
// Scheduling: future phases are auto-scheduled (lib/timeline.ts), so Bryntum's engine pushes Review, the
// objection window and the payout along the dependencies when Work's end moves. The resize feature has no
// live propagation, so during the drag those bars are previewed at their pushed position (CSS `translate`,
// which composes with Bryntum's own `transform` positioning); the engine then places them for real on drop.
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
      { name: "holdExpiring", type: "boolean" },
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

// The later phases of the same milestone that the engine moves with this one (auto-scheduled siblings
// after it; lib/timeline.ts chains them finish-to-start).
const pushedBy = (t: TaskModel): TaskModel[] => {
  const siblings = (t.parent?.children ?? []) as TaskModel[];
  return siblings.slice(siblings.indexOf(t) + 1).filter((s) => !s.manuallyScheduled);
};

const DAY_FMT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

// Bands behind every phase row of a milestone with a live hold: the 3-day honor period, the rest of the
// hold's life, and its expiry line (red once the hold is within 3 days of expiring). Drawn as Indicators
// items (one span per item and row; in 7.3.7 the taskRenderer gets no indicators array, despite its docs).
function liveHold(t: TaskModel) {
  if (!t.isLeaf) return null;
  const hold = ((t.parent?.children ?? []) as TaskModel[]).find((c) => c.get("phase") === "hold");
  const honorEnd = hold?.get("honorEnd") as Date | null | undefined;
  const expiry = hold?.get("holdExpiry") as Date | null | undefined;
  return hold?.startDate && honorEnd && expiry ? { start: hold.startDate as Date, honorEnd, expiry, expiring: !!hold.get("holdExpiring") } : null;
}
const holdBands: Record<string, (t: TaskModel) => TimeSpanConfig | null> = {
  honorBand: (t) => {
    const h = liveHold(t);
    return h && { startDate: h.start, endDate: h.honorEnd, name: "Honor period (days 0–3): the hold can be captured in full", cls: "ms-band ms-band-honor" };
  },
  holdBand: (t) => {
    const h = liveHold(t);
    return h && { startDate: h.honorEnd, endDate: h.expiry, name: "PayPal hold life (to day 29): capture before it ends", cls: "ms-band ms-band-hold" };
  },
  expiryLine: (t) => {
    const h = liveHold(t);
    return h && { startDate: h.expiry, name: h.expiring ? "Hold expires within 3 days: capture or it lapses" : "Hold expires (day 29), can't be extended", cls: `ms-band-expiry${h.expiring ? " ms-band-danger" : ""}` };
  },
};

export default function GanttView(props: { data: Data; onReschedule: (milestoneId: string, dueAt: Date) => void; onRefuse?: (message: string) => void }) {
  const { data, onReschedule, onRefuse } = props;

  const ref = useRef<BryntumGantt>(null);
  const refused = useRef<TaskModel | null>(null); // the Work bar whose drag ended past the hold's limit
  const resizing = useRef<TaskModel | null>(null); // the Work bar being dragged (names a conflict's cause)
  const conflicted = useRef(false); // the engine rejected the last change (see schedulingConflict)
  const shifted = useRef<HTMLElement[]>([]); // bars previewed at their pushed position during a drag
  const refuseRef = useRef(onRefuse);
  refuseRef.current = onRefuse;
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  const initialNarrow = useRef(narrow);
  const project = useMemo(
    () =>
      new ProjectModel({
        taskModelClass: MilestoneTask,
        tasks: data.tasks as never[],
        dependencies: data.dependencies as never[],
        listeners: {
          // Backstop for the constraint on Work (finish no later than the hold's cap) and any other conflict
          // the engine finds: cancel the change (the bars go back) and say why, instead of Bryntum's
          // resolution popup, whose options (drop the constraint or the gate) aren't the client's to choose.
          schedulingConflict: ({ schedulingIssue, continueWithResolutionResult }) => {
            conflicted.current = true;
            continueWithResolutionResult("Cancel"); // EffectResolutionResult.Cancel (not exported by name)
            const limit = resizing.current?.get("dueLimit") as Date | null | undefined;
            refuseRef.current?.(limit ? dueCapMessage(limit) : `${schedulingIssue.getDescription()}.`);
          },
        },
      }),
    [data],
  );

  const clearPreview = () => {
    for (const el of shifted.current) el.style.translate = "";
    shifted.current = [];
    (ref.current?.instance as Gantt | undefined)?.element.classList.remove("ms-previewing");
  };

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
      displaySchedulingIssueResolutionPopup: false, // conflicts are handled on the project (above)
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
        // 7.3.7 passes the record as `taskRecord`/`eventRecord` here (its docs say `record`).
        validatorFn: (ctx: { taskRecord?: TaskModel; record?: TaskModel; endDate: Date }) => {
          const record = ctx.taskRecord ?? ctx.record;
          refused.current = record && pastLimit(record, ctx.endDate) ? record : null;
          return !refused.current;
        },
        tooltipTemplate: ({ record, endDate, valid }: { record: TaskModel; endDate: Date; valid: boolean }) => {
          const limit = pastLimit(record, endDate);
          if (!valid && limit) return `<b>Too late</b><br>${StringHelper.encodeHtml(dueCapMessage(limit))}`;
          // Where the pushed payout lands (the engine keeps each later phase's length).
          const last = pushedBy(record as TaskModel).at(-1);
          const moved = last?.endDate && record.endDate ? new Date((last.endDate as Date).getTime() + endDate.getTime() - (record.endDate as Date).getTime()) : null;
          return `Due ${StringHelper.encodeHtml(endDate.toDateString())}` + (moved ? `<br>Review, objection window and payout move with it: paid by ${StringHelper.encodeHtml(moved.toLocaleDateString(undefined, DAY_FMT))}` : "");
        },
      },
      percentBarFeature: { allowResize: false }, // progress comes from the milestone's state, not a drag
      dependenciesFeature: { allowCreate: false },
      timeRangesFeature: { showCurrentTimeLine: true },
      // A hold about to lapse is outlined red on its bar (its fill is already red from the data).
      taskRenderer: ({ taskRecord, renderData }: { taskRecord: TaskModel; renderData: { cls: unknown } }) => {
        (renderData.cls as Record<string, boolean>)["ms-expiring"] = !!taskRecord.get("holdExpiring");
        return "";
      },
      indicatorsFeature: {
        items: {
          ...holdBands, // first, so the icons below draw over them
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
      onTaskResizeStart: ({ taskRecord }: { taskRecord: TaskModel }) => {
        resizing.current = taskRecord;
        conflicted.current = false;
      },
      // Live preview: slide the phases the engine will push by the same distance as Work's end.
      onTaskPartialResize: ({ taskRecord, endDate, resizeData }: { taskRecord: TaskModel; endDate: Date; resizeData: { originalEndDate: Date }[] }) => {
        const g = ref.current?.instance as Gantt | undefined;
        const from = resizeData[0]?.originalEndDate ?? (taskRecord.endDate as Date);
        if (!g || !from || !endDate) return;
        const dx = g.getCoordinateFromDate(endDate) - g.getCoordinateFromDate(from);
        clearPreview();
        g.element.classList.add("ms-previewing");
        for (const t of pushedBy(taskRecord)) {
          const el = g.getElementFromTaskRecord(t, false);
          if (!el) continue;
          el.style.translate = `${dx}px 0`;
          shifted.current.push(el);
        }
      },
      onTaskResizeEnd: async ({ changed, taskRecord }: { changed: boolean; taskRecord: TaskModel }) => {
        resizing.current = null;
        if (refused.current === taskRecord) {
          refused.current = null;
          clearPreview();
          onRefuse?.(dueCapMessage(taskRecord.get("dueLimit") as Date));
          return;
        }
        await project.commitAsync(); // let the engine push the later phases before the preview is dropped
        clearPreview();
        if (conflicted.current) return; // cancelled by the engine: nothing to save (and already explained)
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
