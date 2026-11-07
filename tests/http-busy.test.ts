import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toHttp } from "@/lib/http";

describe("toHttp busy errors", () => {
  it("maps a busy milestone lock to 503 with Retry-After", async () => {
    const r = toHttp(Object.assign(new Error("milestone x stayed locked for 180s"), { code: "55P03" }));
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "5");
    assert.match((await r.json()).error, /milestone is busy/);
  });
  it("maps an exhausted database pool to a generic 503", async () => {
    const r = toHttp(new Error("timeout exceeded when trying to connect"));
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /server is busy/);
  });
});
