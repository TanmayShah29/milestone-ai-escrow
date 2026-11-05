// Runs inside the tests container. rpc(fn, args) calls the worker's export through the socket.
import net from "node:net";
let n = 0, conn = null, buf = "";
const pending = new Map();
function fail(err) { for (const p of pending.values()) p.rej(err); pending.clear(); conn = null; }
function connect() {
  if (conn) return conn;
  conn = net.createConnection(process.env.RPC_SOCK);
  conn.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      const p = pending.get(m.id);
      if (!p) continue;
      pending.delete(m.id);
      m.ok ? p.res(m.value) : p.rej(new Error(m.error));
    }
  });
  conn.on("error", fail);
  conn.on("close", () => fail(new Error("the worker closed the connection")));
  conn.unref();
  return conn;
}
export function rpc(fn, args = []) {
  return new Promise((resolve, reject) => {
    const id = ++n;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout calling ${fn}`)); }, 5000);
    pending.set(id, { res: (v) => { clearTimeout(t); resolve(v); }, rej: (e) => { clearTimeout(t); reject(e); } });
    connect().write(JSON.stringify({ id, fn, args }) + "\n");
  });
}
