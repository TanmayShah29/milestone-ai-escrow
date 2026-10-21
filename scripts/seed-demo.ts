// Seeds three demo milestones with realistic histories (no PayPal calls; the ids are illustrative) and
// prints a /timeline link that opens them. Used for local screenshots and, later, judge mode.
//   DATABASE_URL=... npx tsx scripts/seed-demo.ts [base-url]
import { db } from "../src/lib/db";
import { hashTerms, type Terms } from "../src/lib/contract/terms";
import { createMilestone, type Milestone } from "../src/lib/milestones/repo";

const DAY = 86_400_000;
const base = process.argv[2] ?? "http://localhost:3000";

const terms = (what: string): Terms => ({
  criteria: [
    { id: "C1", text: `${what} is exported with the agreed signature`, kind: "must", check: "test", test: { path: "acceptance/c1.test.ts", code: "import test from 'node:test';\ntest('c1', () => {});" } },
    { id: "C2", text: `${what} handles the edge cases in the brief`, kind: "must", check: "test", test: { path: "acceptance/c2.test.ts", code: "import test from 'node:test';\ntest('c2', () => {});" } },
    { id: "C3", text: "README documents it with an example", kind: "must", check: "review" },
  ],
  testCommand: "node --test 'acceptance/*.test.ts'",
});

async function seed(opts: { title: string; cents: number; created: number; due: number; after?: string; history: [string, string | null, number, Record<string, unknown>?][]; set: Record<string, unknown> }) {
  const { milestone, clientToken } = await createMilestone({ title: opts.title, brief: opts.title, amountCents: opts.cents, freelancerEmail: "sb-puo47p53461265@personal.example.com", dueAt: new Date(opts.due), ...(opts.after ? { afterMilestoneId: opts.after } : {}) });
  const t = terms(opts.title.split(" ").slice(1, 3).join(" "));
  const m = { ...milestone, repo: "TanmayShah29/milestone-demo" } as Milestone;
  const hash = hashTerms(m, t);
  const cols = { repo: m.repo, criteria: JSON.stringify(t), criteria_hash: hash, client_signed_hash: hash, worker_signed_hash: hash, created_at: new Date(opts.created), ...opts.set };
  const keys = Object.keys(cols);
  await db().query(`update milestones set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1`, [m.id, ...keys.map((k) => (cols as Record<string, unknown>)[k])]);
  await db().query("delete from audit_log where milestone_id = $1", [m.id]);
  for (const [event, to, at, detail] of [["created", "DRAFT", opts.created] as [string, string | null, number], ...opts.history]) {
    await db().query("insert into audit_log (milestone_id, actor, event, to_state, created_at, detail) values ($1, 'system', $2, $3, $4, $5)", [m.id, event, to, new Date(at), detail ? JSON.stringify(detail) : null]);
  }
  return { id: m.id, token: clientToken };
}

async function main() {
  const now = Date.now();
  const a0 = now - 12 * DAY;
  const a = await seed({
    title: "Phase 1: slugify utility",
    cents: 2500,
    created: a0,
    due: a0 + 5 * DAY,
    history: [
      ["terms:agreed", "AGREED", a0 + 0.5 * DAY],
      ["hold:authorized", "FUNDED", a0 + 1 * DAY],
      ["deliverable:submitted", "SUBMITTED", a0 + 4 * DAY],
      ["review:passed", "PASSED", a0 + 4.2 * DAY],
      ["hold:captured", "RELEASED", a0 + 6.3 * DAY],
      ["payout:succeeded", "PAID_OUT", a0 + 6.4 * DAY],
    ],
    set: { state: "PAID_OUT", paypal_order_id: "6KT46740HF272241V", paypal_authorization_id: "21K55705SN297842N", authorized_cents: 2500, authorization_expires_at: new Date(a0 + 30 * DAY), paypal_capture_id: "5B824331RB0677324", capture_status: "COMPLETED", captured_cents: 2500, fee_cents: 125, payout_cents: 2375, payout_status: "SUCCESS", paypal_payout_item_id: "GJKNAZHUVZ4E4", pr_url: "https://github.com/TanmayShah29/milestone-demo/pull/1" },
  });
  const b0 = now - 5 * DAY;
  const b = await seed({
    title: "Phase 2: wordCount utility",
    cents: 1500,
    created: b0,
    due: now + 4 * DAY,
    after: a.id,
    history: [
      ["terms:agreed", "AGREED", b0 + 0.3 * DAY],
      ["hold:authorized", "FUNDED", b0 + 1 * DAY],
    ],
    set: { state: "FUNDED", paypal_order_id: "DEMO-ORDER-B", paypal_authorization_id: "DEMO-AUTH-B", authorized_cents: 1500, authorization_expires_at: new Date(b0 + 30 * DAY) },
  });
  const c0 = now - 2 * DAY;
  const c = await seed({
    title: "Phase 3: search API (long build)",
    cents: 6000,
    created: c0,
    due: c0 + 40 * DAY, // past the hold's 29-day expiry → reauthorize warning
    after: b.id,
    history: [
      ["terms:agreed", "AGREED", c0 + 0.2 * DAY],
      ["hold:authorized", "FUNDED", c0 + 0.5 * DAY],
    ],
    set: { state: "FUNDED", paypal_order_id: "DEMO-ORDER-C", paypal_authorization_id: "DEMO-AUTH-C", authorized_cents: 6000, authorization_expires_at: new Date(c0 + 0.5 * DAY + 29 * DAY) },
  });
  console.log(`${base}/timeline?m=${[a, b, c].map((x) => `${x.id}.${x.token}`).join(",")}`);
  await db().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
