// Runs inside the worker container: the only place the PR's code ever runs. It loads the modules the
// signed tests import (from the read-only checkout at /work) and answers calls over a Unix socket. The
// worker's code shares this process, so all it can change is the values it returns: the tests and their
// assertions run in another container.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { encode, encodeError, decode } from "./wire.mjs";

const [, , root, sock] = process.argv;
const loaded = new Map();
function load(rel) {
  const file = path.resolve(root, rel);
  if (!file.startsWith(path.resolve(root) + path.sep)) return Promise.reject(new Error(`${rel} is outside the checkout`));
  if (!loaded.has(file)) loaded.set(file, import(file));
  return loaded.get(file);
}

try { fs.unlinkSync(sock); } catch {}
net.createServer((c) => {
  let buf = "";
  c.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let req;
      try { req = JSON.parse(line); } catch { continue; }
      const { id, module, name, args } = req;
      let async = false;
      Promise.resolve()
        .then(() => load(module))
        .then((mod) => {
          const fn = name === "default" ? mod.default : mod[name];
          if (typeof fn !== "function") {
            if (fn === undefined) throw new Error(`${module} has no export ${name}`);
            return fn; // a constant export: its value
          }
          const out = fn(...decode(args));
          if (out && typeof out.then === "function") async = true;
          return out;
        })
        .then(
          (value) => c.write(JSON.stringify({ id, ok: true, async, value: encode(value) }) + "\n"),
          (e) => c.write(JSON.stringify({ id, ok: false, async, error: encodeError(e) }) + "\n"),
        );
    }
  });
}).listen(sock, () => fs.chmodSync(sock, 0o777));
