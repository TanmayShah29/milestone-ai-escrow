// Runs one signed acceptance test file and decides pass or fail from the test events, never from the
// exit code. Runs from the base branch's copy of this file (see the workflow), so a PR can't change it.
//
// Plain `node --test` reports success when the code under test ends the process early (process.exit(0)
// at import time, or inside a test): the file "exited 0" and no test failed. So here:
//  - a wrapper imports the signed file and registers one sentinel test AFTER it. Top-level tests run in
//    order, so the sentinel can only pass if every signed test before it finished.
//  - the run passes only with: no failed, cancelled, skipped or todo tests; at least one signed test
//    passed; and the sentinel passed exactly once, as the last top-level test.
//  - node:assert is frozen before the signed file (and the code it imports) loads, so the code under
//    test can't replace assert.equal and friends with no-ops.
//  - only tests registered by the signed file count, and the sentinel is matched by its random name AND
//    the file and line that registered it, so code under test can't stand in for it.
//  - the code under test gets no GitHub Actions file commands (GITHUB_OUTPUT, GITHUB_ENV, ...).
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { run } from "node:test";

const testPath = process.argv[2] ?? "";
if (!/^acceptance\/[\w.-]+\.test\.(ts|js|mjs)$/.test(testPath)) {
  console.error("Usage: run-tests.mjs acceptance/<name>.test.(ts|js|mjs)");
  process.exit(1);
}

const sentinel = `milestone: every signed test ran ${randomBytes(16).toString("hex")}`;
const wrapper = resolve(dirname(testPath), `.milestone-run-${randomBytes(8).toString("hex")}.mjs`);
const signedFile = resolve(testPath);
const wrapperSource = [
  `import assert from "node:assert";`,
  `import { test } from "node:test";`,
  `Object.freeze(assert);`,
  `Object.freeze(assert.strict);`,
  `await import(${JSON.stringify(`./${basename(testPath)}`)});`,
  `test(${JSON.stringify(sentinel)}, () => {});`,
];
const SENTINEL_LINE = wrapperSource.length; // the sentinel is identified by name AND by where it was registered
writeFileSync(wrapper, `${wrapperSource.join("\n")}\n`);

for (const k of Object.keys(process.env)) {
  if (/^(GITHUB_(OUTPUT|ENV|PATH|STATE|STEP_SUMMARY|TOKEN)|ACTIONS_)/.test(k)) delete process.env[k];
}

const top = []; // top-level results, in the order they finished
const problems = [];
for await (const e of run({ files: [wrapper], concurrency: 1, timeout: 10 * 60_000 })) {
  const d = e.data ?? {};
  if (e.type === "test:stdout" || e.type === "test:stderr") process.stdout.write(d.message ?? "");
  if (e.type === "test:fail") {
    const shown = d.name === sentinel ? "sentinel" : d.name;
    problems.push(`failed: ${shown}`);
    console.log(`✖ ${shown}\n  ${String(d.details?.error?.cause ?? d.details?.error ?? "").split("\n").join("\n  ")}`);
  }
  if (e.type === "test:pass") {
    if (d.skip || d.todo) problems.push(`skipped or todo: ${d.name}`);
    if (d.nesting === 0) top.push({ name: d.name, file: d.file, line: d.line });
    if (d.name !== sentinel && d.name !== wrapper) console.log(`✔ ${d.name}`);
  }
}
rmSync(wrapper, { force: true });

const isSentinel = (t) => t.name === sentinel && t.file === wrapper && t.line === SENTINEL_LINE;
const signed = top.filter((t) => t.file === signedFile);
const stray = top.filter((t) => t.file !== signedFile && !isSentinel(t) && t.file !== wrapper);
if (top.filter((t) => t.name === sentinel).length !== 1 || !top.length || !isSentinel(top.at(-1))) {
  problems.push("the run ended before every signed test finished (did the code under test exit the process?)");
}
if (signed.length === 0) problems.push("no signed test passed");
if (stray.length) problems.push(`tests registered outside the signed file: ${stray.map((t) => t.name).join(", ")}`);

if (problems.length) {
  console.log(`\nAcceptance FAILED for ${testPath}:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nAcceptance passed for ${testPath}: ${signed.length} signed test(s), all ran to completion.`);
