// The values that cross the socket: JSON, plus the few things JSON loses that tests commonly assert on
// (undefined, NaN, ±Infinity, -0, bigint, Date) and thrown errors (name, message, code).
export function encode(v) {
  if (v === undefined) return { $: "undefined" };
  if (typeof v === "number" && !Number.isFinite(v)) return { $: "number", v: String(v) };
  if (Object.is(v, -0)) return { $: "number", v: "-0" };
  if (typeof v === "bigint") return { $: "bigint", v: String(v) };
  if (v instanceof Date) return { $: "date", v: v.toISOString() };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === "object") {
    if (typeof v.toJSON === "function") return encode(v.toJSON());
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k === "$" ? "$$" : k] = encode(x);
    return out;
  }
  if (typeof v === "function" || typeof v === "symbol") throw new TypeError(`a ${typeof v} can't be returned across the runner boundary`);
  return v;
}

export function decode(v) {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === "object") {
    if (typeof v.$ === "string") {
      if (v.$ === "undefined") return undefined;
      if (v.$ === "number") return v.v === "-0" ? -0 : Number(v.v);
      if (v.$ === "bigint") return BigInt(v.v);
      if (v.$ === "date") return new Date(v.v);
    }
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k === "$$" ? "$" : k] = decode(x);
    return out;
  }
  return v;
}

export function encodeError(e) {
  return { name: typeof e?.name === "string" ? e.name : "Error", message: String(e?.message ?? e), ...(typeof e?.code === "string" ? { code: e.code } : {}) };
}

export function decodeError(e) {
  const err = new Error(e.message);
  err.name = e.name;
  if (e.code) err.code = e.code;
  return err;
}
