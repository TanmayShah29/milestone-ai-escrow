"use client";

import { ProjectModel, StringHelper, TaskModel } from "@bryntum/gantt";
import { BryntumGantt, type BryntumGanttProps } from "@bryntum/gantt-react";
import { useEffect, useMemo, useRef } from "react";
import "@bryntum/gantt/gantt.css";
import "@bryntum/gantt/svalbard-light.css";
import "@bryntum/gantt/fontawesome/css/fontawesome.css";
import "@bryntum/gantt/fontawesome/css/solid.css";
import "./gantt.css";

// The money-aware Gantt: each milestone is a row with its phases; the PayPal hold gates the work
// (finish-to-start), the hold's day-3 honor period and day-29 expiry are indicators on its bar, and the
// client can drag the Work bar to move the due date (flagged when it passes the hold's expiry).
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
    ];
  }
}

type Data = { tasks: unknown[]; dependencies: unknown[] };

export default function GanttView(props: { data: Data; canReschedule: (milestoneId: string) => boolean; onReschedule: (milestoneId: string, dueAt: Date) => void }) {
  const { data, canReschedule, onReschedule } = props;

  const ref = useRef<BryntumGantt>(null);
  const project = useMemo(() => new ProjectModel({ taskModelClass: MilestoneTask, tasks: data.tasks as never[], dependencies: data.dependencies as never[] }), [data]);

  const config = useMemo<BryntumGanttProps>(
    () => ({
      project,
      viewPreset: "weekAndDayLetter",
      rowHeight: 50,
      barMargin: 10,
      columns: [
        { type: "name", width: 330 },
        {
          text: "Status",
          field: "status",
          width: 110,
          renderer: ({ record }: { record: MilestoneTask }) => (record.isLeaf ? String(record.get("status") ?? "") : `${Math.round(record.percentDone)}% done`),
        },
      ],
      taskEditFeature: false,
      taskMenuFeature: false,
      cellEditFeature: false,
      dependencyEditFeature: false,
      taskDragFeature: false,
      taskDragCreateFeature: false,
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
            return { startDate: d, name: warn ? "Hold expires (day 29) before the work is due: reauthorize" : "Hold expires (day 29)", iconCls: warn ? "fa fa-triangle-exclamation" : "fa fa-hourglass-end", cls: warn ? "ms-ind-danger" : "ms-ind-expiry" };
          },
        },
      },
      taskTooltipFeature: {
        template: ({ taskRecord }: { taskRecord: TaskModel }) =>
          `<b>${StringHelper.encodeHtml(taskRecord.name)}</b><br>${StringHelper.encodeHtml(String(taskRecord.get("note") ?? ""))}` +
          (taskRecord.get("phase") === "work" && canReschedule(String(taskRecord.get("milestoneId"))) ? "<br><i>Drag the end of this bar to move the due date.</i>" : ""),
      },
      onBeforeTaskResize: ({ taskRecord }: { taskRecord: TaskModel }) => taskRecord.get("phase") === "work" && canReschedule(String(taskRecord.get("milestoneId"))),
      onTaskResizeEnd: ({ changed, taskRecord }: { changed: boolean; taskRecord: TaskModel }) => {
        if (changed && taskRecord.endDate) onReschedule(String(taskRecord.get("milestoneId")), taskRecord.endDate as Date);
      },
    }),
    [project, canReschedule, onReschedule],
  );

  // Fit the view to the data: a live run takes minutes, a real project weeks.
  useEffect(() => {
    const id = setTimeout(() => ref.current?.instance?.zoomToFit({ leftMargin: 40, rightMargin: 60 }), 300);
    return () => clearTimeout(id);
  }, [project]);

  return <BryntumGantt ref={ref} {...config} />;
}
