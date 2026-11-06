// Which of the worker's modules each signed test imports, and which names, so the tests container can get a
// proxy at the same relative path. Relative imports only: node builtins load as usual, and packages from
// the PR are never loaded in the tests container.
import path from "node:path/posix";

const IDENT = /^[A-Za-z_$][\w$]*$/;

export function importsOf(code) {
  const specs = new Map();
  const get = (s) => {
    if (!specs.has(s)) specs.set(s, { specifier: s, names: new Set(), default: false });
    return specs.get(s);
  };
  const named = (s, list) => {
    for (const part of list.split(",")) {
      const p = part.trim().replace(/^type\s+/, "");
      if (!p) continue;
      const name = p.split(/\s+as\s+|\s*:\s*/)[0].trim();
      if (name === "default") s.default = true;
      else if (IDENT.test(name)) s.names.add(name);
    }
  };
  const bare = code.replace(/(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
  const members = (s, ns) => {
    for (const hit of bare.matchAll(new RegExp(`\\b${ns.replace(/\$/g, "\\$")}\\.([A-Za-z_$][\\w$]*)`, "g"))) {
      if (hit[1] === "default") s.default = true;
      else s.names.add(hit[1]);
    }
  };
  for (const m of code.matchAll(/^\s*import\s+(type\s+)?([\w$*{}\s,]+?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    if (m[1]) continue;
    const s = get(m[3]);
    const c = m[2].trim();
    const braces = /\{([^}]*)\}/.exec(c);
    if (braces) named(s, braces[1]);
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(c);
    if (ns) members(s, ns[1]);
    if (/^([A-Za-z_$][\w$]*)\s*(,|$)/.test(c)) s.default = true;
  }
  for (const m of code.matchAll(/(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const s = get(m[2]);
    if (m[1].startsWith("{")) named(s, m[1].slice(1, -1));
    else members(s, m[1]);
  }
  return [...specs.values()].filter((s) => s.specifier.startsWith("./") || s.specifier.startsWith("../"));
}

/** The proxies one test needs: { file (relative to the checkout root), module, names, default }. */
export function proxiesFor(testPath, code) {
  return importsOf(code).map((s) => {
    const file = path.normalize(path.join(path.dirname(testPath), s.specifier));
    if (file.startsWith("../") || path.isAbsolute(file)) throw new Error(`${testPath} imports ${s.specifier}, outside the repository`);
    if (file.startsWith("acceptance/")) throw new Error(`${testPath} imports ${s.specifier} from acceptance/, which the signed tests own`);
    return { file, names: [...s.names], default: s.default };
  });
}

/** A proxy module: every export forwards to the worker container. */
export function proxySource(p, client = "/harness/client.mjs") {
  const lines = [`import { call } from ${JSON.stringify(client)};`];
  p.names.forEach((n, i) => lines.push(`const __p${i} = (...a) => call(${JSON.stringify(p.file)}, ${JSON.stringify(n)}, a);`, `export { __p${i} as ${n} };`));
  if (p.default) lines.push(`export default (...a) => call(${JSON.stringify(p.file)}, "default", a);`);
  return lines.join("\n") + "\n";
}
