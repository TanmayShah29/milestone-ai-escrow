// node:test reporter for the tests container: one JSON line per finished test, to /out only.
export default async function* reporter(source) {
  for await (const e of source) {
    if (e.type !== "test:pass" && e.type !== "test:fail") continue;
    if (e.data.details?.type === "suite") continue;
    const err = e.data.details?.error;
    const c = err?.cause ?? err;
    yield JSON.stringify({ ok: e.type === "test:pass", name: e.data.name, message: c ? String(c.message ?? c).slice(0, 300) : null }) + "\n";
  }
}
