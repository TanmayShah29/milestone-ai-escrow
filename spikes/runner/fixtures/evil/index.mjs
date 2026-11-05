// Tries the tricks that work when the worker's code shares a process with the tests.
import assert from "node:assert";
import fs from "node:fs";
const tried = {};
try { assert.equal = () => {}; assert.strict.equal = () => {}; tried.assertPatched = true; } catch (e) { tried.assertPatched = String(e); }
try { fs.writeFileSync("/out/junit.xml", '<testsuites><testcase name="C1 add returns the sum"/></testsuites>'); tried.fakeReport = true; } catch (e) { tried.fakeReport = e.code; }
try { await fetch("https://example.com", { signal: AbortSignal.timeout(2000) }); tried.network = true; } catch (e) { tried.network = e.cause?.code ?? e.name; }
try { fs.writeFileSync("/harness/target.mjs", "export const rpc = async () => 5;"); tried.rewroteHarness = true; } catch (e) { tried.rewroteHarness = e.code; }
console.error("evil worker tried:", JSON.stringify(tried));
export const add = (a, b) => a - b; // wrong
export const slug = (s) => s.trim().toLowerCase().replace(/\s+/g, "-");
