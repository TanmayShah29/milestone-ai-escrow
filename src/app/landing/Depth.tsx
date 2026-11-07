import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { STATES, TRANSITIONS } from "@/lib/milestones/states";
import { DepthView, type DepthFacts } from "./DepthView";

// Act 4: how much is in it, counted from the repository when the page is built, never typed by hand
// (PRODUCT.md: no invented numbers). The landing page is static, so this runs once per build.

function walk(dir: string, out: string[] = []): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (n === "node_modules" || n.startsWith(".")) continue;
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.test\.m?tsx?$/.test(n)) out.push(p);
  }
  return out;
}

function facts(): DepthFacts {
  const root = process.cwd();
  const files = ["src", "tests", "scripts", "mcp", "runner"].flatMap((d) => walk(path.join(root, d)));
  const tests = files.reduce((n, f) => n + (readFileSync(f, "utf8").match(/^\s*(test|it)\(/gm)?.length ?? 0), 0);

  let attacks: string[] = [];
  try {
    const readme = readFileSync(path.join(root, "README.md"), "utf8");
    const block = readme.split("## Threat model")[1]?.split("\n## ")[0] ?? "";
    attacks = [...block.matchAll(/^\| \*\*([^*]+)\*\*/gm)].map((m) => m[1]!.trim());
  } catch {}

  const edges = STATES.flatMap((from) => TRANSITIONS[from].map((to) => [from, to] as [string, string]));
  return { tests, testFiles: files.length, attacks, states: [...STATES], edges };
}

export function Depth() {
  return <DepthView facts={facts()} />;
}
