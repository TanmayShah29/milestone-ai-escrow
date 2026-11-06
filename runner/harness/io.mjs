// The tests container's socket thread. The main thread blocks in Atomics.wait while this thread sends one
// call and waits for its reply, so the signed tests can call the worker's functions synchronously.
import net from "node:net";
import { workerData } from "node:worker_threads";

const { sock, port, shared } = workerData;
const flag = new Int32Array(shared);
let conn;
let buf = "";
let waiting = null;
function reply(msg) {
  waiting = null;
  port.postMessage(msg);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
}
function connect() {
  conn = net.createConnection(sock);
  conn.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (waiting === msg.id) reply(msg);
    }
  });
  const gone = (why) => {
    conn = null;
    if (waiting !== null) reply({ id: waiting, ok: false, error: { name: "Error", message: why } });
  };
  conn.on("error", (e) => gone(`the worker's code is unreachable (${e.code ?? e.message})`));
  conn.on("close", () => gone("the worker's code closed the connection"));
}
port.on("message", (req) => {
  waiting = req.id;
  if (!conn) connect();
  conn.write(JSON.stringify(req) + "\n");
});
