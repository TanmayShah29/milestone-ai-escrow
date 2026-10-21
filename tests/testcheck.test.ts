import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkOne, checkTests, parseImports } from "@/lib/contract/testcheck";

// "Tests that bite": AI-written tests run against an empty implementation and must load and fail.
// No database and no AI here: only the checker.

const H = "import test from 'node:test';\nimport assert from 'node:assert/strict';\n";
const t = (code: string, path = "acceptance/c1.test.ts") => ({ id: "C1", path, code: H + code });

describe("test check", () => {
  it("a test that fails against the empty stub bites", async () => {
    assert.equal(await checkOne(t("import { slugify } from '../src/slugify.ts';\ntest('s', () => { assert.equal(slugify('A B'), 'a-b'); });")), undefined);
  });

  it("flags a no-op test as weak", async () => {
    const p = await checkOne(t("import { slugify } from '../src/slugify.ts';\ntest('s', () => { assert.ok(true); });"));
    assert.equal(p?.kind, "weak");
    assert.match(p!.reason, /passes against an empty implementation/);
  });

  it("flags a file with no tests as weak", async () => {
    assert.deepEqual(await checkOne({ id: "C1", path: "acceptance/c1.test.ts", code: "import assert from 'node:assert';\nassert.ok(true);" }), { kind: "weak", reason: "defines no tests" });
  });

  it("flags a syntax error as broken, without temp paths in the reason", async () => {
    const p = await checkOne(t("test('s', () => { const = 1; });"));
    assert.equal(p?.kind, "broken");
    assert.match(p!.reason, /^doesn't load: SyntaxError/);
    assert.doesNotMatch(p!.reason, /milestone-testcheck-/);
  });

  it("flags a test that fails whatever the code does (jest's expect without an import)", async () => {
    const p = await checkOne(t("test('s', () => { expect(1).toBe(1); });"));
    assert.equal(p?.kind, "broken");
    assert.match(p!.reason, /ReferenceError: expect is not defined/);
  });

  it("flags imports Node can't resolve in CI: no extension, outside the repo", async () => {
    assert.match((await checkOne(t("import { a } from '../src/a';\ntest('s', () => { assert.equal(a(), 1); });")))!.reason, /without a file extension/);
    assert.match((await checkOne(t("import { a } from '../../../etc/a.ts';\ntest('s', () => { assert.equal(a(), 1); });")))!.reason, /outside the repository/);
  });

  it("stubs default, namespace, dynamic and package imports", async () => {
    const code = [
      "import def, { x } from 'some-pkg/sub';",
      "import * as m from '../src/m.js';",
      "test('s', async () => {",
      "  const { slug } = await import('../src/s.ts');",
      "  assert.equal(def() ?? x() ?? slug('x') ?? m.go(), 2);",
      "});",
    ].join("\n");
    assert.equal(await checkOne(t(code)), undefined);
    const specs = parseImports(code);
    assert.deepEqual(
      specs.map((s) => [s.specifier, [...s.names].sort(), s.default]),
      [
        ["some-pkg/sub", ["x"], true],
        ["../src/m.js", ["go"], false],
        ["../src/s.ts", ["slug"], true],
      ],
    );
  });

  it("runs with no secrets in the env and no writes outside its temp dir, and cleans up", async () => {
    process.env.TESTCHECK_CANARY = "secret";
    const outside = join(tmpdir(), `testcheck-escape-${process.pid}`);
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith("milestone-testcheck-")).length;
    // If the env leaked, this test would fail and count as biting; stripped, it passes and is weak.
    const env = await checkOne(t("test('s', () => { assert.equal(process.env.TESTCHECK_CANARY, undefined); assert.equal(process.env.DATABASE_URL, undefined); });"));
    assert.equal(env?.kind, "weak");
    await checkOne(t(`import fs from 'node:fs';\ntest('s', () => { fs.writeFileSync(${JSON.stringify(outside)}, 'x'); });`));
    assert.equal(existsSync(outside), false);
    assert.equal(readdirSync(tmpdir()).filter((f) => f.startsWith("milestone-testcheck-")).length, before);
    delete process.env.TESTCHECK_CANARY;
  });

  it("checks several tests at once and skips languages it can't run", async () => {
    const out = await checkTests([
      { id: "C1", path: "acceptance/c1.test.ts", code: H + "test('s', () => {});" },
      { id: "C2", path: "acceptance/c2.test.ts", code: H + "import { f } from '../src/f.ts';\ntest('s', () => { assert.equal(f(), 1); });" },
      { id: "C3", path: "acceptance/c3.test.py", code: "def test_x():\n    assert True" },
    ]);
    assert.deepEqual([...out.keys()], ["C1"]);
  });
});
