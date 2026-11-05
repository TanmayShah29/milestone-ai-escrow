// Runs inside the worker container. Loads the worker's module and answers JSON-RPC calls over a Unix socket.
// The worker's code shares this process, so it can only change the values it returns: the tests and their
// assertions run in a different container.
import net from "node:net";
import fs from "node:fs";
const [, , modPath, sock] = process.argv;
let mod;
try { mod = await import(modPath); } catch (e) { mod = { __loadError: String(e) }; }
try { fs.unlinkSync(sock); } catch {}
net.createServer((c) => {
  let buf = "";
  c.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const { id, fn, args } = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      Promise.resolve()
        .then(() => { if (typeof mod[fn] !== "function") throw new Error(mod.__loadError ?? `no export ${fn}`); return mod[fn](...args); })
        .then((value) => c.write(JSON.stringify({ id, ok: true, value }) + "\n"), (e) => c.write(JSON.stringify({ id, ok: false, error: String(e?.message ?? e) }) + "\n"));
    }
  });
}).listen(sock, () => fs.chmodSync(sock, 0o777));
