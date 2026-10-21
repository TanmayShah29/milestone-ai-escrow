// Seeds a judge-mode project (the same one /demo creates) and prints a /timeline link that opens it.
//   DATABASE_URL=... npx tsx scripts/seed-demo.ts [base-url]
import { db } from "../src/lib/db";
import { seedDemoProject } from "../src/lib/demo";

async function main() {
  const base = process.argv[2] ?? "http://localhost:3000";
  const ms = await seedDemoProject();
  console.log(`${base}/timeline?m=${ms.map((m) => `${m.id}.${m.client}`).join(",")}`);
  await db().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
