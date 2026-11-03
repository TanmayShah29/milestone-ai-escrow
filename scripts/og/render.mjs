// Renders scripts/og/og.html to public/og.png (1200×630) with Playwright and the installed Chrome.
// Run: node scripts/og/render.mjs
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const page = fileURLToPath(new URL("./og.html", import.meta.url));
const out = fileURLToPath(new URL("../../public/og.png", import.meta.url));
const browser = await chromium.launch({ channel: "chrome" });
try {
  const tab = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await tab.goto(`file://${page}`, { waitUntil: "networkidle" });
  await tab.evaluate(() => document.fonts.ready);
  await tab.screenshot({ path: out });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
