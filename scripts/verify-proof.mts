// Check a milestone's proof chain from the command line, with the same code the /proof page runs:
//   npx tsx scripts/verify-proof.mts https://milestone-ai-escrow.onrender.com/api/proof/<id>
//   npx tsx scripts/verify-proof.mts ./milestone-proof-<id>.json        (a downloaded chain)
// The keys come from /.well-known/milestone-proof-keys.json on the same host when checking a URL, not
// from the chain's own response. Exit code 0 = verified, 1 = failed.
import { readFileSync } from "node:fs";
import { verifyChain, type ProofEvent, type ProofKey } from "../src/lib/proof/verify.ts";

type Chain = { milestoneId: string; events: ProofEvent[]; keys?: ProofKey[] };

const src = process.argv[2];
if (!src) {
  console.error("usage: verify-proof.mts <https://…/api/proof/<id> | chain.json>");
  process.exit(2);
}

let chain: Chain;
let keys: ProofKey[];
if (/^https?:\/\//.test(src)) {
  chain = (await (await fetch(src)).json()) as Chain;
  const wellKnown = new URL("/.well-known/milestone-proof-keys.json", src);
  keys = ((await (await fetch(wellKnown)).json()) as { keys: ProofKey[] }).keys;
} else {
  chain = JSON.parse(readFileSync(src, "utf8")) as Chain;
  keys = chain.keys ?? [];
}

const check = await verifyChain(chain.milestoneId, chain.events, keys);
for (const e of check.events) console.log(`${e.ok ? "✓" : "✗"} ${String(e.seq).padStart(3)} ${e.body?.event ?? "?"}${e.ok ? "" : `  ${e.problems.join("; ")}`}`);
console.log(check.ok ? `VERIFIED: ${check.events.length} events, head ${check.head}` : `FAILED: ${check.problems.length} problem(s)`);
process.exit(check.ok ? 0 : 1);
