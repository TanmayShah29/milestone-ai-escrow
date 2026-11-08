# Devpost submission: Milestone

**Tagline:** Pay freelancers and AI agents through PayPal only when their work passes tests. AI writes the
contract and attacks it before anyone signs; only code moves the money.

**Links**
- Live app: https://milestone-ai-escrow.onrender.com (judge mode, no login: `/demo`)
- Code (MIT): https://github.com/TanmayShah29/milestone-ai-escrow
- Demo repo with real paid PRs: https://github.com/TanmayShah29/milestone-demo (PRs #1–#3, #10)
- Proof Bench (an LLM-only approver vs Milestone on the same 12 PRs): https://milestone-ai-escrow.onrender.com/bench

**Judge's path:** 30 s: `/timeline` or `/ledger` show the latest live judge runs with real sandbox PayPal ids.
2 min: `/demo` → **Run it live** (real hold, real PR, real CI, a live AI review, then capture and payout, or the
cheat caught). 5 min: `/bench`. 15 min: the MCP server, or the guided tour on `/demo`.
- Video: _(YouTube link, under 3 minutes)_

---

## Inspiration

Freelance code work breaks down at both ends. The worker starts without knowing the money exists, and the
client pays without knowing the work is done. Escrow fixes the first problem but not the second: someone
still has to decide what "done" means, and that is where disputes start. Coding agents make this sharper.
An agent can take a bounty and open a PR in minutes, but no one wants to give an agent the power to pay
itself. We wanted a payment that is released by **proof**, where AI does the reading and writing and plain
code makes the money decision.

## What it does

Milestone is a pay-on-proof layer on PayPal, with GitHub pull requests as the first deliverable type.

1. **Agree.** The client writes a brief. An AI model drafts acceptance criteria and writes `node:test` tests
   for the testable ones. Before anyone can sign, each test runs against an empty implementation and must
   fail, because a test that passes against nothing proves nothing. Then a second AI attacks the contract: it
   plays the cheating worker and writes fake code to pass the tests, and code runs it. If the fake wins, the
   tests are strengthened and the same fake must fail. Both sides sign the SHA-256 fingerprint of the exact terms.
2. **Fund.** The client's money is placed on a **PayPal authorization hold**: held, not captured.
3. **Deliver.** The worker, a person or an AI agent over MCP, opens a PR that cites the fingerprint.
4. **Verify.** CI runs the signed tests through a harness taken from the base branch. The AI reviews only
   the criteria that tests can't check. A fixed policy decides: pass, changes requested, or a human check.
   Text in the PR aimed at the AI reviewer is detected and blocks automatic payment.
5. **Release.** After an objection window, code captures the hold and pays the worker through PayPal
   Payouts, minus a platform fee. If the client objects, one second review runs on the same commit with a
   different model. If it passes, the money releases 72 hours later. If it can't decide, the client has 72
   hours to decide before the money releases. A client can't park the money forever: the worst case is
   about 6 extra days, inside PayPal's 29-day hold.

**v2: proof anyone can check, and agents with budgets.**
- **A trusted runner** (our own workflow) runs the signed tests with the PR's code in a separate container:
  no network, read-only. It signs the results through GitHub's Sigstore attestations, and Milestone checks
  the signature, the exact workflow identity, the digest and a fresh nonce before counting them. We ran it
  live on a demo PR: its signed result is entry 3714238852 in the public Rekor log, and an edited copy and
  a replayed result were both rejected.
- **An AI panel:** three different free models judge what tests can't check, each seeing the criteria in a
  different order. A vote counts only if code finds its quote word for word in the diff. Two grounded
  passes and no grounded fail make a pass, and a model's self-reported confidence decides nothing. The
  panel has its own test set of 27 hand-labelled cases (separate from the 12-PR Proof Bench below), and
  `/bench` shows the cases run so far; free-model rate limits mean it is not finished.
- **Evidence floors and partial pay:** each criterion names the least evidence it settles on, and a signed
  pay schedule lets PayPal capture only the earned share, releasing the rest of the hold in the same call.
- **A neutral party at the end:** either side can lock a decision by funding a $5 fee hold. The evidence
  pack is frozen into the proof chain, an AI drafts an award, and only the arbitrator's own key can sign the
  award that settles. We ran it end to end in the sandbox: the client's fee was captured and $4.29 paid to
  the arbitrator, and the worker's fee hold was voided.
- **Agents with budgets:** a person signs a spending mandate with a passkey. Their agent posts bounties over
  MCP, and fixed code funds each hold on a vaulted card as a merchant-initiated charge, only within the
  signed limits. Anyone, human or agent, claims a bounty, and passports record how both sides behaved.

**Agents that buy are covered; agents that earn are not.** PayPal's agent tools help an AI agent pay for things.
Milestone is the other half of agentic commerce: an agent (or a person) does paid work, and PayPal pays it only
once the work is proven, with no tool that lets the agent pay itself.

**Measured, not claimed: Proof Bench.** Most AI escrow asks a model "is this done?". We gave that approver and
Milestone the same signed contract and 12 pull requests: 3 honest, 9 cheats (a stub, broken code, three prompt
injections including one hidden with invisible and look-alike characters, a rewritten CI workflow, a
`process.exit(0)` harness escape, hard-coded test inputs, and a newline bug no test covers). Milestone flagged all 5
attacks with the exact quote, blocked no honest work, answered every case and paid only 1 of the 9 cheats. The
LLM-only approver paid 1 of the 8 cheats it judged (the hidden injection), gave no verdict on one, and mentioned none of
the attacks. Milestone's one miss is the newline bug: it can only be as strict as the tests both sides sign, and
the page says so. Reproducible with `npm run bench`; a unit test re-checks Milestone's side on every run.

**Run it live, for judges.** One click on `/demo` places a real PayPal sandbox hold, opens a real PR from a
prepared branch, streams each signed test's CI status, has the AI reviewer read the diff for the one criterion no
test can check (a nice-to-have, so it can't decide the money), then captures the hold and pays out, or catches
the cheater with the money still held. A money rail shows where the $12.00 is at each step, and the payout line
shows every fee. Judge runs use $12.00 (the landing page follows an earlier $25.00 run). PayPal's card fee has a
fixed part per payment, so fees take a smaller share of a larger milestone. Afterwards `/timeline` and `/ledger` show these runs, with their real PayPal ids, to every
visitor; the Bryntum Gantt redraws itself from PayPal and review events (a failed review adds a rework bar and
moves the later phases, a voided hold greys out what's left, a reauthorization moves the honor period).

Real sandbox runs are public: PR #1 passed and was paid; PR #2 hid a prompt injection, was caught with the
money still held, then fixed and paid; PR #3 was done end to end by an AI agent through our MCP server and
paid; PR #10 was an agent hired by another agent: its rushed first attempt failed the signed tests with no
money moved, it fixed the code from the verdict, and it was paid. The MCP server has **no** tools that fund,
capture, release or refund. An agent can earn, never take.

## How we built it

- **PayPal:** Orders v2 with `intent: AUTHORIZE` (PayPal wallet approval or the sandbox test card), then
  authorize, capture, void and reauthorize, all through the **APIMatic-generated PayPal TypeScript SDK**.
  Payouts and webhook signature verification are small typed REST functions, because the SDK doesn't cover
  them. Dispute webhooks move captured milestones to a DISPUTE state.
- **Money safety:** every money-moving call is claimed in Postgres first and sends a `PayPal-Request-Id`
  derived from the milestone and action. Money actions run under a per-milestone lock. A timeout or an
  unparseable 2xx is recorded as an *unknown* outcome and settled by re-reading PayPal, never by blind
  retry. Every PayPal id and every state change goes to an audit log.
- **AI:** free OpenRouter models through the Vercel AI SDK, with a three-model fallback chain. Each task is
  one structured-output call validated with zod, with no agent tool loops. There is a daily budget and a
  cache per commit.
- **CI:** a GitHub Actions workflow in the target repo loads the contract by fingerprint, re-hashes it,
  overwrites `acceptance/` with the signed tests, and runs one job per criterion. Each job name contains
  the fingerprint, so Milestone can tell a run of the signed contract from any other run.
- **App:** Next.js 15 + TypeScript on **Render**, Neon Postgres, a **Bryntum Gantt** timeline where the
  PayPal hold gates the work and shows its day-3 honor period and day-29 expiry, and an MCP server for
  agents.

## Challenges we ran into

- **`node --test` passes when the code under test calls `process.exit(0)`.** We wrote a harness that
  decides from test events, freezes `node:assert`, and requires a sentinel test registered after the signed
  file to pass last.
- **Holds don't last forever.** We verified in the sandbox that reauthorizing returns
  `REAUTHORIZATION_TOO_SOON` before day 4, and PayPal allows it only once, on days 4–29, without extending
  the 29 days. So the app caps due dates at the hold's life and tells clients to split long work into
  milestones.
- **Paying the worker directly.** We tested PayPal Multiparty in the sandbox. `platform_fees`, delayed
  disbursement and partner referrals all need partner approval (`PLATFORM_FEES_NOT_SUPPORTED`,
  `DELAYED_DISBURSEMENT_NOT_SUPPORTED`, 403 on partner-referrals). We kept hold → capture → payout and
  documented the production path.
- **Free models** rate-limit, return broken JSON and come and go. Fallbacks, a budget and an honest "AI busy,
  retry" state were necessary.
- **The SDK and Next.js:** the bundler loaded two copies of the SDK, which broke `instanceof` on errors, and
  authorize without a body returned 415. Both are recorded in `paypal-plan.md`.

## Accomplishments that we're proud of

- Real end-to-end sandbox payouts driven by real PRs and CI, including one by an AI agent.
- A prompt-injection PR that was caught by a deterministic scan the model can't override, with the money
  still on hold.
- The AI never touches money, and the code enforces it: there are no money tools for the model or the agent.
- An honest threat model in the README, residual risks included.
- Proof Bench: a measured, reproducible comparison with the approach most rivals take, with our own miss shown.

## What we learned

- An authorization hold is a natural fit for escrow-like flows, but its 29-day life shapes the product. You
  have to design around it, not pretend it doesn't exist.
- "AI judges the work" is weak alone. "AI writes tests both sides sign, the tests judge, and AI covers
  only the rest" is much stronger, and it's easy to explain to the person paying.
- AI that strengthens tests can quietly weaken them. Our first bench run caught the hardener replacing a
  drafted check with a narrower one. Now code refuses any rewrite that drops a drafted assertion: hardening
  can only add checks.
- Idempotency is not enough on its own. You also need a rule for the case where you don't know whether
  PayPal acted.

## What's next

- Pass the frozen evidence pack to PayPal disputes (`provide-evidence`) when a buyer disputes a capture.
- A registry of several arbitrators, and racing bounties where the first passing PR wins.
- **PayPal Commerce Platform (Multiparty):** onboard workers as sellers, set `payee.merchant_id`, and take
  the fee with `platform_fees` at capture. The worker is paid in one step and is merchant of record.
- Refunds and dispute evidence packs, paid models with an SLA, and more verifiers (design and document
  review, deterministic API checks).

## Built with

TypeScript, Next.js, React, Node.js, PostgreSQL (Neon), PayPal Orders v2 / Payments v2 / Payouts / Webhooks
(sandbox), the APIMatic PayPal TypeScript SDK, APIMatic Context Plugin, OpenRouter, Vercel AI SDK, zod,
Model Context Protocol (MCP) TypeScript SDK, GitHub Actions, Sigstore (`actions/attest`, `sigstore-js`, Rekor),
Docker, WebAuthn passkeys (SimpleWebAuthn), PayPal Vault, Bryntum Gantt, AG Grid, Render, Tailwind CSS, Geist,
Playwright, Claude Code.

## Tools and models used, and how

| Tool / model | How it was used |
|---|---|
| `dots-studio/dots-3-note-preview:free` (primary), `nvidia/nemotron-3.5-super-vl:free`, `nvidia/nemotron-3.5-lightning:free` (fallbacks), via OpenRouter + Vercel AI SDK | In the product: drafting criteria and tests, regenerating a test, fixing a test that doesn't bite, attacking the tests with fake code and strengthening them, reviewing untested criteria, and the post-objection second review on a different model. One structured call per task. The model's output is a recommendation; fixed code decides |
| PayPal APIs (sandbox) | Orders v2 (AUTHORIZE), authorizations (capture, void, reauthorize), Payouts, webhook signature verification, dispute webhooks |
| APIMatic Context Plugin + the APIMatic-generated PayPal TypeScript SDK | Used in Claude Code while building the PayPal integration. Every SDK signature, header and error arm in `paypal-plan.md` was looked up in the SDK map |
| Claude Code (Anthropic) | Development assistant for writing code, tests, docs and audits. Not part of the running product |
| Bryntum Gantt (trial) | The `/timeline` view: auto-scheduled phases (dragging work pushes review, objection window and payout), a constraint at the hold's limit, honor and expiry bands. It redraws from PayPal and review events: rework bars with baselines showing what moved and why, voided holds, reauthorized honor periods, dispute markers, the payout milestone |
| AG Grid Community | `/ledger`: every PayPal call with its attempt and idempotency key, money totals, filters, CSV export. `/milestones`: a portfolio grid sorted by hold expiry |
| Render | Hosting for the live app (free web service, auto-deploys from `main`) |
| GitHub Actions | Runs the signed acceptance tests per criterion in the worker's repo; a scheduled workflow keeps the free Render instance awake and smoke-tests the judge pages daily |
| PayPal Vault (sandbox) | Spending mandates: the test card is vaulted once, and each bounty's hold is an AUTHORIZE order on `vault_id` with a merchant-initiated stored credential (verified live Nov 6) |
| GitHub Actions + Sigstore | The trusted runner (`TanmayShah29/milestone-runner`): two containers per criterion, results signed with `actions/attest` and checked with `sigstore-js` |
| Model Context Protocol | An MCP server so AI agents can find, claim and deliver work, and, with a signed mandate, post bounties. It has no capture, release or refund tools |

---

## Video script outline v2 (target 2:50, hard limit under 3:00)

Record the pieces separately and cut all waiting. Every step below exists in the live app.

| Time | Scene | On screen | Say (gist) |
|---|---|---|---|
| 0:00–0:10 | What it is | Landing hero, the cheque passing its conditions | "Milestone pays people and AI agents through PayPal only when the work is proven, and the proof is something you can check." |
| 0:10–0:35 | A budget for an agent | `/mandates/new`: limits, save the sandbox card, sign with a passkey; the agent key | "I give my agent a budget, signed with my passkey. Code, not the agent, decides what it may spend." |
| 0:35–0:55 | The agent posts work | The MCP `post_bounty` call, the bounty on `/bounties` already held on PayPal with no click, the hold id | "The agent posts a bounty. The hold lands on the saved card within my limits, with no approval click." |
| 0:55–1:20 | Someone tries to cheat | A PR with a Hindi comment telling the reviewer to pass everything; the scan and the panel flag it; the money stays held | "This worker hid an instruction in Hindi. The scan and the AI panel both caught it, and nothing was paid." |
| 1:20–1:50 | Real proof | An honest PR; the trusted runner's run, "E3, signed", the Rekor entry; the verdict table with grounded panel votes | "Our own runner ran the signed tests, with the worker's code in a sealed container, and Sigstore signed the result." |
| 1:50–2:25 | A fair ending | The client locks with a $5 fee hold, the worker matches; the court page with the frozen evidence pack and the AI draft; the arbitrator signs from a terminal; capture, payout and the fee to the arbitrator | "If they disagree, a named arbitrator decides. The AI only drafts. The signed award is the only thing that moves the money." |
| 2:25–2:45 | Don't trust us | `/proof/<id>` chain, `/bench` panel numbers, the passport | "Every step is signed. Our AI judges are measured in public, and both sides build a record." |
| 2:45–2:50 | Close | Credits | "Pay-on-proof on PayPal. Built with PayPal, APIMatic, Bryntum, AG Grid and Render." |

Recording checklist:
- Wake the service first (`/api/health`). Check `/api/status` shows `busy: false`.
- Say "PayPal", "sandbox" and "AI" by name. No copyrighted music. Captions on; zoom so text reads on a phone.
- Bryntum runs on the public trial package (watermark) unless the hackathon license is applied.
- After uploading: paste the YouTube link here and at the top of the README.
