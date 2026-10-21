import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

// "Tests that bite": an acceptance test is only worth signing if it fails when the work isn't done. Each
// AI-written test runs once against an EMPTY implementation (every module it imports replaced by a stub
// whose exports are functions that do nothing) and must (a) load and (b) fail. A test that passes
// against nothing checks nothing; one that can't load can never pass.
//
// This runs AI-generated test code, never worker code, and never on a PR. The child process gets:
// PATH as its only env var (no secrets), a fresh temp dir as cwd, Node's permission model (reads and
// writes only inside that dir, no child processes, workers or native addons), no eval/new Function,
// a 128 MB heap, network calls stubbed out, and a hard 10 s kill. Node calls its permission model a
// seat belt, not a sandbox for hostile code. That fits: the code comes from our model, prompted with a
// client's brief framed as data, so it is semi-trusted. The check catches honest mistakes (no-op or
// always-true asserts, syntax errors); a test written to fool it (say, one that fails only without a
// CI env var) is for the people signing to spot, as before.

export type TestProblem = { kind: "weak" | "broken"; reason: string };
export type TestToCheck = { id: string; path: string; code: string };
/** id → problem; a test that bites (or that can't be judged here) has no entry. */
export type TestChecker = (tests: TestToCheck[]) => Promise<Map<string, TestProblem>>;

const TIMEOUT_MS = 10_000;
const MARK = "@@testcheck ";
const RUNNABLE = /\.(ts|mts|js|mjs)$/;

export type ImportSpec = { specifier: string; names: Set<string>; default: boolean };

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** Every module a test imports (static, dynamic, require) with the names it uses from each. */
export function parseImports(code: string): ImportSpec[] {
  const specs = new Map<string, ImportSpec>();
  const get = (specifier: string) => {
    let s = specs.get(specifier);
    if (!s) specs.set(specifier, (s = { specifier, names: new Set(), default: false }));
    return s;
  };
  const named = (s: ImportSpec, list: string) => {
    for (const part of list.split(",")) {
      const p = part.trim().replace(/^type\s+/, "");
      if (!p) continue;
      const name = p.split(/\s+as\s+|\s*:\s*/)[0]!.trim();
      if (name === "default") s.default = true;
      else if (IDENT.test(name)) s.names.add(name);
    }
  };
  // A namespace binding (`* as m`, `const m = await import()`) uses whatever `m.x` the test touches.
  const bare = code.replace(/(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""'); // no string contents
  const members = (s: ImportSpec, ns: string) => {
    for (const hit of bare.matchAll(new RegExp(`\\b${ns.replace(/\$/g, "\\$")}\\.([A-Za-z_$][\\w$]*)`, "g"))) {
      if (hit[1] === "default") s.default = true;
      else s.names.add(hit[1]!);
    }
  };
  const bind = (s: ImportSpec, clause: string) => {
    const c = clause.trim();
    const braces = /\{([^}]*)\}/.exec(c);
    if (braces) named(s, braces[1]!);
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(c);
    if (ns) members(s, ns[1]!);
    const def = /^([A-Za-z_$][\w$]*)\s*(,|$)/.exec(c);
    if (def) s.default = true;
  };

  for (const m of code.matchAll(/^\s*import\s+(type\s+)?([\w$*{}\s,]+?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    if (m[1]) continue; // `import type` is erased
    bind(get(m[3]!), m[2]!);
  }
  for (const m of code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) get(m[1]!);
  for (const m of code.matchAll(/(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*(?:await\s+import|require)\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const s = get(m[2]!);
    if (m[1]!.startsWith("{")) named(s, m[1]!.slice(1, -1));
    else {
      s.default = true;
      members(s, m[1]!);
    }
  }
  for (const m of code.matchAll(/(?:\bimport|\brequire)\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const s = get(m[1]!);
    s.default = true;
  }
  return [...specs.values()];
}

/** An empty implementation: every export is a function that does nothing and returns undefined. */
export function stubSource(spec: ImportSpec, file: string): string {
  if (file.endsWith(".json")) return "{}\n";
  const names = [...spec.names];
  if (file.endsWith(".cjs")) return `module.exports = { ${names.map((n) => `${JSON.stringify(n)}: function () {}`).join(", ")} };\n`;
  const lines = names.map((n, i) => `const __stub${i} = function () {};\nexport { __stub${i} as ${n} };`);
  if (spec.default) lines.push("export default function () {}");
  return `// empty implementation for the test check\n${lines.join("\n")}\n`;
}

const RUNNER_FILES = {
  // Structured results, so a test's own console output can't be mistaken for them by accident.
  "reporter.mjs": `export default async function* (source) {
  for await (const e of source) {
    if (e.type !== "test:pass" && e.type !== "test:fail") continue;
    const err = e.data.details?.error;
    const c = err?.cause ?? err;
    yield ${JSON.stringify(MARK)} + JSON.stringify({ ok: e.type === "test:pass", name: c?.name ?? null, code: c?.code ?? null, message: c ? String(c.message ?? c).slice(0, 300) : null }) + "\\n";
  }
}
`,
  // No network: a test must not reach out, and the check must not depend on the internet.
  "nonet.mjs": `import net from "node:net";
import dgram from "node:dgram";
const deny = () => { throw Object.assign(new Error("network access is disabled in the test check"), { code: "ERR_ACCESS_DENIED" }); };
net.Socket.prototype.connect = deny;
dgram.createSocket = deny;
globalThis.fetch = async () => deny();
`,
};

type RunResult = { code: number | null; killed: boolean; stdout: string; stderr: string };

function runNode(args: string[], cwd: string): Promise<RunResult> {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv; // PATH only: no secrets
  return new Promise((done, fail) => {
    execFile(
      process.execPath,
      args,
      { cwd, env, timeout: TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 512 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as { code?: number | string | null; killed?: boolean } | null;
        if (e && typeof e.code === "string" && e.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return fail(err); // couldn't start node at all
        done({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, killed: !!e?.killed, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

const flags = (() => {
  const has = (f: string) => process.allowedNodeEnvironmentFlags.has(f);
  return {
    permission: has("--permission") ? "--permission" : "--experimental-permission",
    strip: has("--experimental-strip-types") ? ["--experimental-strip-types"] : [],
  };
})();

/** Strip temp paths and stack noise from an error so it reads well in the UI and the retry prompt. */
function clean(text: string, root: string): string {
  return text.split(root + sep).join("").split(root).join(".").replace(/\s+/g, " ").trim().slice(0, 200);
}

function loadError(stderr: string, root: string): string {
  const line = stderr.split("\n").find((l) => /^\w*Error\b.*:/.test(l.trim()) || /^\w*Error \[\w+\]:/.test(l.trim()));
  return clean(line ?? stderr.split("\n").find((l) => l.trim()) ?? "it exited with an error before running any test", root);
}

/** Lay out the test and stubs of everything it imports in a fresh dir, run it, and judge the result. */
export async function checkOne(test: TestToCheck): Promise<TestProblem | undefined> {
  if (!RUNNABLE.test(test.path)) return undefined; // only JS/TS tests run here
  // The real path: on macOS the temp dir is behind a symlink, and the permission model checks real paths.
  const root = await realpath(await mkdtemp(join(tmpdir(), "milestone-testcheck-")));
  try {
    const testFile = resolve(root, test.path);
    const packages = new Map<string, Map<string, ImportSpec>>();
    for (const spec of parseImports(test.code)) {
      const s = spec.specifier;
      if (isBuiltin(s)) continue;
      if (s.startsWith(".") || s.startsWith("/")) {
        if (s.startsWith("/")) return { kind: "broken", reason: `imports an absolute path (${s}); use a path relative to the test` };
        const target = resolve(dirname(testFile), s);
        if (relative(root, target).startsWith("..")) return { kind: "broken", reason: `imports ${s}, which is outside the repository` };
        if (!/\.[cm]?[jt]sx?$|\.json$/.test(target)) return { kind: "broken", reason: `imports '${s}' without a file extension; Node needs the full file name, e.g. '${s}.ts'` };
        if (target === testFile) continue;
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, stubSource(spec, target));
      } else {
        // A package: stub it under node_modules with an exports map for each subpath used.
        const parts = s.split("/");
        const pkg = s.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
        const sub = "." + s.slice(pkg.length);
        if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(pkg)) continue;
        if (!packages.has(pkg)) packages.set(pkg, new Map());
        packages.get(pkg)!.set(sub, spec);
      }
    }
    for (const [pkg, subs] of packages) {
      const dir = join(root, "node_modules", ...pkg.split("/"));
      await mkdir(dir, { recursive: true });
      const exports: Record<string, string> = {};
      let i = 0;
      for (const [sub, spec] of subs) {
        const file = `__stub${i++}.js`;
        exports[sub] = `./${file}`;
        await writeFile(join(dir, file), stubSource(spec, file));
      }
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: pkg, type: "module", exports }));
    }
    await mkdir(dirname(testFile), { recursive: true });
    await writeFile(testFile, test.code);
    const runner = join(root, ".testcheck");
    await mkdir(runner);
    for (const [name, src] of Object.entries(RUNNER_FILES)) await writeFile(join(runner, name), src);

    // Run the file directly rather than through `node --test`: the runner would need to spawn a child
    // process per file, which the permission model rightly forbids. node:test reports the same way.
    const res = await runNode(
      [
        ...flags.strip,
        "--disallow-code-generation-from-strings",
        flags.permission,
        `--allow-fs-read=${root}`,
        `--allow-fs-write=${root}`,
        "--max-old-space-size=128",
        "--no-warnings",
        "--import",
        "./.testcheck/nonet.mjs",
        "--test-reporter=./.testcheck/reporter.mjs",
        "--test-reporter-destination=stdout",
        posix.normalize(test.path),
      ],
      root,
    );
    if (res.killed) return { kind: "broken", reason: `didn't finish within ${TIMEOUT_MS / 1000} seconds` };
    const results = res.stdout
      .split("\n")
      .filter((l) => l.startsWith(MARK))
      .map((l) => JSON.parse(l.slice(MARK.length)) as { ok: boolean; name: string | null; code: string | null; message: string | null });
    if (!results.length) return res.code === 0 ? { kind: "weak", reason: "defines no tests" } : { kind: "broken", reason: `doesn't load: ${loadError(res.stderr, root)}` };
    const fails = results.filter((r) => !r.ok);
    // A ReferenceError can't come from a stub (all its exports exist): the test itself is wrong, e.g.
    // jest's `expect` without an import. It would fail against any implementation.
    const ref = fails.find((r) => r.name === "ReferenceError");
    if (ref) return { kind: "broken", reason: `fails whatever the code does: ReferenceError: ${clean(ref.message ?? "", root)}` };
    // Failures from the sandbox itself (child processes, eval, network) say nothing about the test.
    const sandbox = (r: (typeof results)[number]) => r.code === "ERR_ACCESS_DENIED" || r.name === "EvalError";
    if (fails.some((r) => !sandbox(r))) return undefined; // it bites
    if (fails.length) return undefined; // can't judge it here; CI will run it for real
    return { kind: "weak", reason: "passes against an empty implementation, so it doesn't check the requirement" };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Check every test (a few at a time). Infrastructure failures leave a test unjudged rather than blocking. */
export const checkTests: TestChecker = async (tests) => {
  const out = new Map<string, TestProblem>();
  const queue = [...tests];
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      try {
        const p = await checkOne(t);
        if (p) out.set(t.id, p);
      } catch (err) {
        console.warn(`test check for ${t.id} could not run: ${String(err).slice(0, 200)}`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
};
