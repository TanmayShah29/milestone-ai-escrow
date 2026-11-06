// Imported by the generated proxy modules in the tests container. call() is synchronous, so tests written
// as `assert.equal(slugify("A b"), "a-b")` run unchanged; an export that returned a promise in the worker
// gets a promise back here.
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { decode, decodeError, encode } from "./wire.mjs";

const TIMEOUT_MS = 10_000;
const shared = new SharedArrayBuffer(4);
const flag = new Int32Array(shared);
const { port1, port2 } = new MessageChannel();
const io = new Worker(new URL("./io.mjs", import.meta.url), { workerData: { sock: process.env.RPC_SOCK, port: port2, shared }, transferList: [port2] });
io.unref();
port1.unref();
let n = 0;

export function call(module, name, args) {
  const id = ++n;
  Atomics.store(flag, 0, 0);
  port1.postMessage({ id, module, name, args: args.map(encode) });
  if (Atomics.wait(flag, 0, 0, TIMEOUT_MS) === "timed-out") throw new Error(`timed out after ${TIMEOUT_MS / 1000} s calling ${name}`);
  const msg = receiveMessageOnPort(port1)?.message;
  if (!msg || msg.id !== id) throw new Error(`no reply calling ${name}`);
  if (msg.ok) return msg.async ? Promise.resolve(decode(msg.value)) : decode(msg.value);
  const err = decodeError(msg.error);
  if (msg.async) return Promise.reject(err);
  throw err;
}
