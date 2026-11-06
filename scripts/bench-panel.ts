// Proof Bench v2: run the production AI panel over bench/panel/cases.ts and write bench/panel/results.json.
//   npm run bench:panel -- --budget 18        at most 18 model calls this run (3 per case-order with 3 models)
//   npm run bench:panel -- --order ba         judge the other criteria order (for position bias)
//   npm run bench:panel -- --only injection-es,good-readme
// Cached forever: a (case, order) already judged is never asked again. Free models allow ~50 calls a day on
// the shared key, and the live app needs some too, so keep the budget small and run it again tomorrow.
import { readFile, writeFile } from "node:fs/promises";
import { AiBusy, AiUnreadable, callsToday, configuredModels } from "@/lib/ai/client";
import { cases, PANEL_BENCH_VERSION, runCase, scorePanel, type Order, type PanelResults } from "@/lib/bench-panel";

const PATH = "bench/panel/results.json";

function args() {
  const a = process.argv.slice(2);
  const val = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return { budget: Number(val("--budget") ?? "18"), orders: (val("--order") ? [val("--order")] : ["ab", "ba"]) as Order[], only: val("--only")?.split(",") };
}

async function load(): Promise<PanelResults> {
  try {
    const r = JSON.parse(await readFile(PATH, "utf8")) as PanelResults;
    return { version: PANEL_BENCH_VERSION, runs: r.runs.filter((x) => cases.some((c) => c.id === x.caseId)) };
  } catch {
    return { version: PANEL_BENCH_VERSION, runs: [] };
  }
}

async function main() {
  const { budget, orders, only } = args();
  const models = configuredModels().slice(0, 3);
  if (models.length < 2) throw new Error("set AI_MODEL and at least one fallback: the panel needs two or three models");
  const results = await load();
  const start = await callsToday();
  let spent = 0;
  // Order ab for every case first, then ba: the bench is useful before position bias is measured.
  for (const order of orders) {
    for (const c of cases) {
      if (only && !only.includes(c.id)) continue;
      if (results.runs.some((r) => r.caseId === c.id && r.order === order)) continue;
      if (spent + models.length > budget) {
        console.log(`budget reached (${spent} calls)`);
        return finish(results);
      }
      try {
        const run = await runCase(c, order, models);
        results.runs.push(run);
        console.log(`${c.id} ${order}: ${Object.entries(run.panel).map(([k, v]) => `${k}=${v}`).join(" ")}${run.members.some((m) => m.error) ? " (a member failed)" : ""}`);
      } catch (err) {
        if (!(err instanceof AiBusy || err instanceof AiUnreadable)) throw err;
        console.log(`${c.id} ${order}: AI busy (${err.message}); stopping for now`);
        return finish(results);
      } finally {
        spent = (await callsToday()) - start;
      }
      await writeFile(PATH, JSON.stringify(results, null, 1) + "\n"); // keep progress if a later case fails
    }
  }
  return finish(results);
}

async function finish(results: PanelResults) {
  await writeFile(PATH, JSON.stringify(results, null, 1) + "\n");
  const s = scorePanel(results);
  console.log(JSON.stringify({ version: s.version, judged: `${s.runs} runs over ${s.cases} of ${cases.length} cases`, panel: s.panel, injection: s.injection, models: s.models.map((m) => ({ model: m.model, accuracy: m.accuracy, kappa: m.kappa, grounding: m.groundingRate })) }, null, 1));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
