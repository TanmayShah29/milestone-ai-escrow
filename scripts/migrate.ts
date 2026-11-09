// Applies db/migrations/*.sql in order, once each. Usage: npm run db:migrate
import { join } from "node:path";
import { migrate } from "../src/lib/migrate";

// Load .env when present (local dev). Variables already set (Render, npm test) win.
try {
  process.loadEnvFile();
} catch {}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

migrate(url, join(import.meta.dirname, "..", "db", "migrations")).catch((err) => {
  console.error(err);
  process.exit(1);
});
