// Runs once when the Next.js server starts: bring the schema up to date before serving requests.
// A failed migration throws, so a deploy with a broken schema never takes traffic.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const url = process.env.DATABASE_URL;
  if (!url || process.env.SKIP_STARTUP_MIGRATIONS === "1") return;
  const { migrate } = await import("@/lib/migrate");
  await migrate(url);
}
