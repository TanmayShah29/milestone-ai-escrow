// Proof Bench, step 0: run Milestone's real pre-signing attack (src/lib/contract/attack.ts) on the bench contract,
// the way it runs on every contract before anyone signs. A second AI plays the cheating worker; if its fake
// passes, the tests are strengthened and kept only when that fake now fails. The outcome, and the hardened
// tests if any, go to bench/hardened.json, which `npm run bench` then scores as a third approver.
//   DATABASE_URL=postgres://localhost:5432/milestone tsx --env-file=.env scripts/bench-harden.ts
// Uses a throwaway DRAFT milestone in the given database (2 model calls at most), deleted afterwards.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attackTerms, storedAttack } from "@/lib/contract/attack";
import { storedTerms } from "@/lib/contract/terms";
import { db } from "@/lib/db";
import { seed } from "@/lib/demo";
import { BENCH_DIR, benchTerms } from "@/lib/bench";

async function main() {
  const now = Date.now();
  const m = await seed({ title: "Proof Bench contract", brief: "Add src/initials.ts exporting initials(name: string): string.", cents: 1200, created: now, due: now + 86_400_000, terms: benchTerms, history: [], set: { state: "DRAFT", client_signed_hash: null, worker_signed_hash: null } });
  try {
    const after = await attackTerms(m.id);
    const attack = storedAttack(after);
    if (!attack) throw new Error("the attack recorded no result");
    const terms = storedTerms(after)!;
    const out = {
      at: attack.at,
      model: attack.model,
      status: attack.status,
      explanation: attack.explanation,
      fake: attack.fake,
      caughtBy: attack.caughtBy,
      ...(attack.hardenIssue ? { hardenIssue: attack.hardenIssue } : {}),
      criteria: attack.status === "hardened" ? terms.criteria.filter((c) => c.test).map((c) => ({ id: c.id, path: c.test!.path, code: c.test!.code })) : null,
    };
    await writeFile(join(BENCH_DIR, "hardened.json"), `${JSON.stringify(out, null, 2)}\n`);
    console.log(`attack: ${attack.status} (${attack.model}): ${attack.explanation}`);
  } finally {
    for (const t of ["audit_log", "money_actions"]) await db().query(`delete from ${t} where milestone_id = $1`, [m.id]);
    await db().query("delete from milestones where id = $1", [m.id]);
    await db().end();
  }
}

main().catch((err) => {
  console.error(String(err).slice(0, 500));
  process.exit(1);
});
