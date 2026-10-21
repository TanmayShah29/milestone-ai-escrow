import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { confirmLink, discardLink, heldLinks, linkFor, rememberLink, workerShareToken } from "@/lib/client/links";
import { writeDemo } from "@/lib/client/demo";

// Links are the keys: a client's browser must not be able to act as the worker, except in judge mode.

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});
beforeEach(() => store.clear());

describe("browser links", () => {
  it("a milestone made on /new holds the client role and a share-only worker link", () => {
    rememberLink({ id: "m1", title: "t", client: "mct_a", shareWorker: "mwt_b" });
    const h = linkFor("m1")!;
    assert.equal(h.client, "mct_a");
    assert.equal(h.worker, undefined);
    assert.equal(workerShareToken(h), "mwt_b");
  });

  it("the client opening their own worker link doesn't gain the worker role", () => {
    rememberLink({ id: "m1", title: "t", client: "mct_a", shareWorker: "mwt_b" });
    rememberLink({ id: "m1", title: "", worker: "mwt_b" });
    assert.equal(linkFor("m1")!.worker, undefined);
    assert.equal(linkFor("m1")!.client, "mct_a");
  });

  it("a worker's browser holds only the worker token", () => {
    rememberLink({ id: "m1", title: "", worker: "mwt_b" });
    assert.deepEqual(linkFor("m1"), { id: "m1", title: "", worker: "mwt_b" });
  });

  it("older entries holding both tokens are demoted to share-only, except judge-mode demos", () => {
    store.set("milestone:links", JSON.stringify([{ id: "m1", title: "t", client: "mct_a", worker: "mwt_b" }]));
    assert.deepEqual(heldLinks()[0], { id: "m1", title: "t", client: "mct_a", shareWorker: "mwt_b" });
    rememberLink({ id: "d1", title: "demo", client: "mct_c", worker: "mwt_d" });
    writeDemo({ milestones: [{ id: "d1", title: "demo", story: "fund" }] });
    assert.equal(linkFor("d1")!.worker, "mwt_d");
    assert.equal(linkFor("d1")!.client, "mct_c");
  });

  it("a forged ?t= link doesn't replace a saved token until the server accepts it", () => {
    rememberLink({ id: "m1", title: "Ship it", client: "mct_a", shareWorker: "mwt_b" });
    rememberLink({ id: "m1", title: "", client: "mct_forged" });
    // Saved links are untouched; this visit tries the new link alone.
    assert.equal(heldLinks()[0]!.client, "mct_a");
    assert.deepEqual(linkFor("m1"), { id: "m1", title: "", client: "mct_forged" });
    // Refused: the tab falls back to the saved links.
    discardLink("m1");
    assert.equal(linkFor("m1")!.client, "mct_a");
    // A forged client link can't shadow a worker's browser either.
    rememberLink({ id: "m2", title: "", worker: "mwt_w" });
    rememberLink({ id: "m2", title: "", client: "mct_forged" });
    assert.deepEqual(heldLinks().find((h) => h.id === "m2"), { id: "m2", title: "", worker: "mwt_w" });
  });

  it("a new link is saved once the page loads with it", () => {
    rememberLink({ id: "m1", title: "t", worker: "mwt_w" });
    rememberLink({ id: "m1", title: "", client: "mct_c" });
    rememberLink({ id: "m1", title: "Ship it" }); // what the deal room calls after a successful load
    assert.equal(linkFor("m1")!.client, "mct_c");
    assert.equal(linkFor("m1")!.title, "Ship it");
    rememberLink({ id: "m3", title: "", worker: "mwt_x" });
    rememberLink({ id: "m3", title: "", worker: "mwt_y" });
    confirmLink("m3");
    assert.equal(linkFor("m3")!.worker, "mwt_y");
  });
});
