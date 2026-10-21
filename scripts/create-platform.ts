// Creates a platform (marketplace or AI agent) and prints its API key once. Usage:
//   npx tsx scripts/create-platform.ts "Demo agent"
import { Client } from "pg";
import { hashToken, newToken } from "../src/lib/auth";

async function main() {
  const name = process.argv[2];
  if (!name) throw new Error('usage: tsx scripts/create-platform.ts "<name>"');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const key = newToken("msk");
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const { rows } = await db.query<{ id: string }>("insert into platforms (name, api_key_hash) values ($1, $2) returning id", [name, hashToken(key)]);
    console.log(`platform ${rows[0]!.id} (${name})`);
    console.log(`API key (shown once): ${key}`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
