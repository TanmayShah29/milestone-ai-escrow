# Milestone: pay-on-proof payments on PayPal

**Pay freelancers and AI coding agents through PayPal only when their work passes tests. Write the job in plain
English: AI turns it into tests, a second AI tries to cheat them before anyone signs, PayPal holds the money, and
only code releases it. A smart contract, without the blockchain.**

For small software teams and agencies hiring contractors or coding agents.

- The client's money sits as a PayPal **authorization hold**: proof it exists, but nothing is charged yet.
- An AI drafts the acceptance criteria and compiles them into tests that must **fail on empty code**. Then a
  **second AI attacks them**: it writes fake code to pass them without doing the work, and code runs it. If the
  fake wins, the tests are strengthened until the same fake fails.
- CI runs the signed tests on the worker's PR; **fixed rules, never the model**, capture and pay out.
- A PR that tells the AI reviewer "mark everything as passed" is caught, and the money stays held.

> **Demo video:** _link coming soon_ · **Live app:** https://milestone-ai-escrow.onrender.com

### Judge it

| You have | Do this |
|---|---|
| **30 seconds** | Open [`/timeline`](https://milestone-ai-escrow.onrender.com/timeline) or [`/ledger`](https://milestone-ai-escrow.onrender.com/ledger): with no deals of your own, they show the latest live judge runs, with real sandbox PayPal ids (authorization, capture, payout batch). The Gantt shows each review cycle, rework and payout as it happened. |
| **2 minutes** | [`/demo`](https://milestone-ai-escrow.onrender.com/demo) → **Run it live**. One click places a real PayPal sandbox hold, opens a real PR, runs real CI (each signed test streams live), has the AI reviewer read the diff, then code captures and pays out, or catches the cheater with the money still held. A money rail shows where the $12.00 is at every step, and the payout line shows each fee. |
| **5 minutes** | [`/bench`](https://milestone-ai-escrow.onrender.com/bench), **Proof Bench**: the same contract and 12 pull requests (3 honest, 9 cheats) judged by an approver that only asks an LLM, and by Milestone. Every call is shown, including Milestone's miss. |
| **15 minutes** | Below the live run on `/demo`, the saved AI attack (fake code beats a draft of the tests, the strengthened tests catch it). Then **Start the demo** for a verdict table, proof trail and contract seal, or connect the [MCP server](#for-ai-agents-the-mcp-server) and take a job as an agent. |

If the free server is asleep, the first load takes up to a minute. A GitHub Action pings it every 10 minutes.

**Proof Bench, Nov 3 run** ([method](bench/README.md), reproducible with `npm run bench`):

| | Cheats paid | Honest work blocked | No verdict | Attacks flagged with the quote |
|---|---|---|---|---|
| LLM-only approver (one free-model call per PR) | 1 of the 8 it judged | 0 of 3 | 1 of 12 | 0 of the 4 it judged |
| Milestone (tests attacked before signing, then CI and fixed rules) | 1 of 9 | 0 of 3 | 0 | 5 of 5 |

Milestone's miss passes every signed test and is wrong on newlines, which no test checks: Milestone is only as
strict as the tests both sides sign. The LLM-only approver's miss hid its prompt injection with invisible and
look-alike characters. Before signing, Milestone's AI attacked its own contract: its lookup-table fake passed the
drafted tests, so a check was added (hardening may only add checks), and that closed a second hole.

Real paid runs on the PayPal sandbox, with public PRs and CI logs in
[TanmayShah29/milestone-demo](https://github.com/TanmayShah29/milestone-demo):
[#1](https://github.com/TanmayShah29/milestone-demo/pull/1) passed and paid $23.75;
[#2](https://github.com/TanmayShah29/milestone-demo/pull/2) hid a prompt injection, was caught with the money
still held, then fixed and paid; [#3](https://github.com/TanmayShah29/milestone-demo/pull/3) was delivered by
an AI agent through the MCP server and paid $14.25;
[#10](https://github.com/TanmayShah29/milestone-demo/pull/10) was an agent hired by another agent: its first
attempt failed the signed tests with no money moved, and its fix was paid $13.10.

Why it matters: in a Freelancers Union survey of over 5,000 US freelancers
([2015](https://onlabor.org/wp-content/uploads/2017/05/FU_NonpaymentReport_r3.pdf)), 71% had trouble collecting
payment at some point in their careers, and they lost an average of $5,968 to unpaid work in 2014.

| Built with | Used for |
|---|---|
| PayPal Orders v2 (create, authorize), Payments v2 (capture, void, reauthorize), Payouts, webhooks (incl. disputes) | Holds, capture on proof, payout minus fees, signature-verified webhooks |
| APIMatic Context Plugin + the APIMatic-generated PayPal TypeScript SDK | Building the PayPal integration ([`paypal-plan.md`](paypal-plan.md)) |
| Free OpenRouter models (Vercel AI SDK) | Drafting terms and tests; attacking them before signing; reviewing only what tests can't check (live in every judge run) |
| Bryntum Gantt · AG Grid · Render | `/timeline` · `/ledger` and `/milestones` · hosting |
| Model Context Protocol server | AI agents read terms, accept them, submit work and track payment; no money tools |

Everything runs on the **PayPal sandbox**, in USD only. Nothing here has handled real money.

## How it works

```
Agree ──► Fund ──► Deliver ──► Verify ──► Release
 AI drafts   PayPal     PR cites    CI runs the     capture, then
 criteria +  hold       the signed  signed tests;   payout minus
 tests; both (authorize terms       AI reviews the  the fee, after
 sides sign  intent)                rest; rules     an objection
                                    decide          window
```

1. **Agree.** The client writes a brief. One AI call drafts the criteria (must-have / nice-to-have), turns
   the testable ones into `node:test` acceptance tests, and suggests edge cases. Before anyone can sign,
   every AI-written test runs once against an **empty implementation** (each imported module replaced by a
   stub) and must load and **fail**. A test that passes against nothing checks nothing, so it blocks signing
   (one AI fix attempt is allowed). Editing a tested criterion's text marks its test stale until it is
   regenerated. Both sides then sign the SHA-256 fingerprint of the exact terms document. The locked
   document is public at `/api/contracts/<fingerprint>`.
2. **Fund.** Milestone creates a PayPal order with `intent: AUTHORIZE` and authorizes it. The money is held
   on the client's payment method, not captured. The order description carries the first 12 characters of
   the fingerprint, and `custom_id` carries the milestone id. Clients approve in the browser with a sandbox
   PayPal login, or use the sandbox test card (no login).
3. **Deliver.** The worker opens a PR whose description contains **exactly one**
   `Milestone-Terms: <fingerprint>` line, then submits the PR URL (in the browser, over the HTTP API, or
   through the MCP server).
4. **Verify.** The repo's `milestone` workflow loads the helper scripts from the **base branch**, fetches the
   contract named in the PR, re-checks its SHA-256, overwrites `acceptance/` with the signed tests, and runs
   one job per tested criterion. Each job's name includes the full fingerprint. Milestone trusts only check
   runs from the `github-actions` app, on the PR's head commit, named for the signed fingerprint. One AI call
   then reviews the diff against the criteria that have no test. A deterministic scan and the model both
   look for text aimed at the reviewer. Then the fixed policy in `src/lib/review/policy.ts` decides:
   - any must-have fails → **changes requested** (the hold stays)
   - protected files edited (`.github/`, `acceptance/`), a harness escape such as `process.exit`, prompt
     injection, an unclear verdict or confidence under 0.8 → **human check** (the client decides)
   - every must-have passes → **passed**, and the objection window starts
5. **Release.** When the window closes, code captures the authorization (never more than was authorized)
   and sends a PayPal payout of the captured amount minus the platform fee (5% by default).

**Objections.** During the window the client can object once. The money stays held, and **one** second
review runs on the **same commit** with a **different model** (CI results are re-read, not re-run).
- If it passes, the money releases 72 hours after the objection, and the client can't object again.
- If it fails, the milestone returns to changes requested, and a fixed resubmission gets a normal window.
- If no usable second review arrives within 72 hours (AI busy), it goes to human check.
- A human check reached after an objection (no usable second review in time, or the second review itself
  says human check) has a deadline: 72 hours after it starts (`decide_by` in the API). If the client doesn't
  decide by then, the money releases to the worker, because the work passed its first review and the
  client has had two chances. No model is involved; this is audited as `review:human_timeout`. The worst
  case after an objection is about 6 days of extra holding, well inside the 29-day hold.
- A human check reached **without** an objection also has a deadline: 3 days before the PayPal hold
  expires. If the client hasn't decided by then, fixed rules settle it: the payment releases to the worker,
  unless the PR tampered with CI or tried to steer the reviewer, in which case the hold is voided back to
  the client. A CI result that only couldn't be verified (say, GitHub was briefly unreachable) releases only
  if every must-have passed; otherwise it waits.
- After an objection, "Ask for changes" needs a reason the worker can read, and it counts as the client's
  one objection: the fixed resubmission, once it passes, can't be objected to again. A failed second review
  clears the objection, so the fixed resubmission gets a normal window.

The objection window is `OBJECTION_WINDOW_SECONDS`. The live demo uses 2 minutes so judges can watch a
release; a real deployment would use something like 48 hours.

**Proof you can check yourself.** Every step of a milestone (every audit row) is also an event in a signed
**proof chain** (`src/lib/proof/`):
- each event body holds the step, the PayPal id and public facts such as the terms fingerprint, the commit
  and the decision;
- personal details are committed to by a salted digest, never shown;
- each event carries the hash of the one before and an ES256 signature;
- the public keys are at `/.well-known/milestone-proof-keys.json`.

`/proof/<id>` re-checks the whole chain in the browser with WebCrypto and has a "Tamper with a copy" button
to show a one-character edit being caught. `npx tsx scripts/verify-proof.mts <url>` does the same from the
command line.

The signed terms also pin what decides: the decision-policy version, the confidence floor, the review models
and the verifier. A verdict from a model the terms don't name can't pay on its own.

Each side can sign the terms with a key instead of only its link:
- **a person uses a passkey.** The WebAuthn challenge is the SHA-256 of a statement naming the milestone,
  the side, the fingerprint and the worker's GitHub account;
- **an AI agent uses its own ES256 key** (the MCP server makes one and keeps it in
  `~/.config/milestone/agent-key.json`).

Signatures are published with the chain and checked on the proof page. When the worker names a GitHub
account, only a pull request opened by that account can be submitted.

Milestones move forward on `GET /api/tick`, which reviews after CI, runs second reviews, releases and syncs
payouts. An open milestone page runs the same step every 15 seconds (`check`), and a free uptime monitor can
ping `/api/tick`. Each step is idempotent and gated by state. On the free host, nothing moves while nobody
is calling it.

## PayPal APIs used

| Step | API | How |
|---|---|---|
| Create the hold | Orders v2 `POST /v2/checkout/orders` (`intent: AUTHORIZE`, wallet or `payment_source.card`) | APIMatic-generated TypeScript SDK (`paypal`), `orders.createOrder` |
| Authorize | `POST /v2/checkout/orders/{id}/authorize` | SDK `orders.authorizeOrder` |
| Read state | `GET /v2/checkout/orders/{id}`, `GET /v2/payments/authorizations/{id}`, `GET /v2/payments/captures/{id}` | SDK |
| Release | `POST /v2/payments/authorizations/{id}/capture` (`final_capture`; the amount is the earned share, at most the authorized amount) | SDK `payments.captureAuthorizedPayment` |
| Cancel | `POST /v2/payments/authorizations/{id}/void` | SDK `payments.voidPayment` |
| Renew honor period | `POST /v2/payments/authorizations/{id}/reauthorize` | SDK `payments.reauthorizePayment` (client-triggered, see limits) |
| Pay the worker | Payouts `POST /v1/payments/payouts`, `GET /v1/payments/payouts/{batch}` | Small typed REST functions (`src/lib/paypal/payouts.ts`); the SDK has no payouts |
| Webhooks | `POST /v1/notifications/verify-webhook-signature` before acting | REST (`src/lib/paypal/webhooks.ts`); handlers are idempotent |
| Disputes | `CUSTOMER.DISPUTE.CREATED/UPDATED/RESOLVED` webhooks | Moves a captured milestone to DISPUTE and stores the dispute id. A person answers the dispute on PayPal |

The integration contract (every field, header and error arm, looked up in the SDK map) is in
[`paypal-plan.md`](paypal-plan.md). Sandbox behaviour we verified with live calls is in
[`PayPal_Sandbox_Guide.md`](PayPal_Sandbox_Guide.md).

### Money rules (enforced in code)
1. **The AI never moves money.** Model output is data. Only deterministic code applies the policy and calls
   capture, void or payout. No AI tool and no MCP tool can fund, capture, release or refund.
2. **Idempotency.** Every money-moving POST sends a `PayPal-Request-Id` derived from the milestone and the
   action. The action is first **claimed** in the database, so a double click or a retry can't move money
   twice.
3. **Locks.** Each milestone's money actions run under a per-milestone lock, and state changes are checked
   against an explicit transition table (`src/lib/milestones/states.ts`).
4. **Unknown outcomes are settled, not guessed.** If PayPal times out or returns a 2xx we can't parse, the
   claim is marked *unknown*, and the next sync re-reads PayPal to learn whether it acted before anything is
   retried (`src/lib/money/flow.ts`).
5. Capture never exceeds the authorized amount. Payout = captured amount minus the fee. Amounts are integer
   cents in the DB and decimal strings on the wire.
   - **Partial pay** (policy-2): the terms may sign a pay schedule. For example, the must-haves pay 80%, and
     each nice-to-have adds its bonus when it's met at its evidence floor. The fixed rules work out the
     earned share (`earnedShare` in `policy.ts`), and the release captures only that share with
     `final_capture: true`. PayPal releases the rest of the hold in the same call; spike H1 verified this
     with a $10 hold captured at $8. The must-haves alone must still pay at least $10.
6. Every PayPal id (order, authorization, capture, payout batch and item, dispute) is stored on the
   milestone, and every state change writes an audit row with who or what caused it.

## AI used

Free models on [OpenRouter](https://openrouter.ai), called through the Vercel AI SDK
(`@openrouter/ai-sdk-provider`). The model is configuration, never code: `AI_MODEL`, `AI_MODEL_FALLBACK`,
`AI_MODEL_FALLBACK_2` (currently `dots-studio/dots-3-note-preview:free`, `nvidia/nemotron-3.5-super-vl:free`,
`nvidia/nemotron-3.5-lightning:free`). On a 404, 429, 5xx or unreadable output, a call falls through to the next
model.

**The AI attacks the contract before anyone signs** (`src/lib/contract/attack.ts`). A second AI plays the cheating
worker: it writes fake code to pass the must-have tests, plus a probe test showing where the fake is wrong. Code
runs both in the test sandbox, so the result is a fact and not the model's opinion. If the fake beats the tests, one
more AI call strengthens them, and the rewrite is kept only if the same fake now fails and the tests still fail on
empty code. Otherwise both sides are told the tests can be beaten. On Nov 2, a free model beat a thin draft by
hardcoding the two tested inputs, and the rewritten tests caught the same fake.

Limits: it only catches cheats the AI thinks of. It can't prove a rewritten test is fair to an honest worker, or
that it stays within the criteria's text, so people still read the tests before signing. Client-written tests are never attacked,
because they aren't run on the server. The attacker's code runs in the same sandbox as AI-written tests, so
the same limits apply (see the comment in `testcheck.ts`).

**A panel of models reviews the work, and code checks what each one cites** (`src/lib/review/panel.ts`, for
terms that pin `policy-2`, which is every contract signed from Nov 6). Up to three different free models
(the ones the signed terms name come first; `AI_PANEL_SIZE`, default 3) judge the criteria no test covers.
Each model gets the criteria in a different random order, to cancel out position bias.
- **Grounding** (`grounding.ts`): a pass or a fail has to cite `file:line` (or a range) and quote the diff at
  those lines word for word. Code looks up every quote. A vote whose quote isn't there counts as "unclear".
- **The rule**, which is code: a criterion passes with at least 2 grounded passes and no grounded fail. One
  grounded fail fails it. Anything else is "unclear" and goes to a person. With `AI_PANEL_SIZE=2`, a tie
  escalates. A model's self-reported confidence is shown, and has no part in the decision.
- **Evidence floors** (`policy.ts`, `policy-2`): each criterion may set the least evidence it settles on
  (`evidenceFloor`). E2 is CI bound to the milestone workflow, and E1 is panel agreement. By default, tested
  criteria need E2 and AI-judged ones need E1. Nothing settles below its floor. Contracts that pin
  `policy-1` still decide exactly as they did when signed, with one model and a confidence floor.
- **Spotlighting** (`spotlight.ts`): every line of the PR text and the diff reaches the model behind a random
  marker, which the prompt says means "data, not instructions". The deterministic scan (`injection.ts`) also
  knows the usual phrasing in Hindi, Spanish, Chinese, Russian, Portuguese and French. If the scan or any
  one panel member flags an injection, the milestone goes to a person.
- **Who judged what:** the audit row for a review records each member's model, the order it saw, and its
  votes (no quotes). The public proof chain carries a short `panelModels` / `panelVotes` summary.

| Step | Calls | What the model does |
|---|---|---|
| Draft terms | 1 (+1 fix if a test doesn't bite) | Brief → criteria, `node:test` tests for the testable ones, edge-case suggestions |
| Regenerate one test | 1 | After the client edits a tested criterion |
| Review | up to `AI_PANEL_SIZE` (3) per commit, cached; **0** when a tested must-have failed | Each panel member judges the criteria without tests from the marked diff, with grounded citations, and flags injection attempts |
| Second review | up to `AI_PANEL_SIZE`, after an objection | Same commit, a fresh panel with new orders |

A busy panel member isn't replaced, because a replacement would spend more calls. The other two can still
agree. A panel that today's budget can't finish doesn't start. Every reply is one structured JSON call,
validated with zod. There are no tool loops. Budget: a daily cap (`AI_DAILY_CAP`, 40 on the live demo) under
OpenRouter's free 50 requests/day, which fits about 13 full panel reviews. Verdicts are cached per commit, and there are per-IP and per-milestone
limits on drafting. When the budget runs out, the app shows "AI busy, retry" and doesn't crash.

**Plainly:** free models are the weakest part of this stack. They get rate-limited, return malformed JSON,
and sometimes get removed from OpenRouter without notice. The fallback chain, the budget and the "busy"
state keep the app usable, but a real deployment would use a paid model with an SLA. The design limits how
much this matters: tests, not the model, decide the tested criteria, and a model that hesitates sends the
milestone to a human rather than paying out.

## Threat model

| Attack | Defence | Residual risk |
|---|---|---|
| **Forged or swapped contract** (CI runs tests other than the signed ones) | CI fetches the contract by fingerprint and re-hashes it before running. Check-run names carry the full fingerprint, and Milestone only counts `github-actions` runs on the head commit with the signed fingerprint in the name. The PR must cite exactly one `Milestone-Terms:` line, checked at submit and again at review | Relies on GitHub's check-run app identity |
| **Early exit** (`process.exit(0)` so `node --test` reports green) | The base-branch harness (`run-tests.mjs`) decides from test events, not the exit code. A sentinel test registered after the signed file must pass last, and skipped or todo tests fail the run. `process.exit`, `/proc` reads and loader hooks in the diff are flagged for human check | See the residual below about sharing a process |
| **Assert monkeypatching** (make `assert.equal` a no-op) | `node:assert` and `assert.strict` are frozen before the signed file and the worker's code load. Tests registered outside the signed file make the run fail | Same process (below) |
| **Editing the workflow or tests in the PR** | `acceptance/` is overwritten with the signed tests. The helper scripts come from the base branch. Any change under `.github/` or `acceptance/` is flagged as tampering and sends the milestone to human check, never to an automatic pass. The workflow uses `pull_request` (not `pull_request_target`), so PR code never runs with write tokens or secrets | **The workflow YAML itself comes from the PR's merge commit** under `pull_request`. A PR that rewrites it can fake green jobs, and is caught only by the tampering flag (a person then decides) |
| **Prompt injection** in code, comments or PR text | A deterministic scan, independent of the model, after folding Unicode look-alikes and removing zero-width characters; invisible or bidirectional control characters are themselves flagged. Plus the model's own flag. Either one blocks automatic payment (human check, or changes requested if a must-have fails). The deliverable is framed as untrusted data | The scan only knows English phrasing; an instruction in another language, or a novel phrasing, reaches the model. That is why the model only judges criteria no test covers: tested criteria don't depend on the model at all |
| **Client parks the money** (objects forever) | One objection per approval. A passing second review releases 72 h after the objection. A post-objection human check auto-releases 72 h after it starts (worst case about 6 days) | A client can still void the hold before any delivery, by design |
| **Client acts as the worker** | Capability links: a creator's browser keeps the worker link **share-only** and never uses it to act. Signing and submitting require the worker token | There are no accounts. Whoever holds the worker link *is* the worker, and the client sees that link to hand it over. This is a UX guard, not identity |
| **Token leakage** | `Referrer-Policy: no-referrer`. Tokens are stripped from the address bar after load. Only SHA-256 hashes of tokens and API keys are stored, compared in constant time, and never sent to a browser. Either side can reissue its own link (the old one stops working at once); the client can reissue the worker link until the worker signs. Both links stop working 30 days after the milestone closes | Links shared over insecure channels are bearer secrets until reissued |
| **Personal data kept forever** | Webhook payloads are emptied after 30 days (event ids stay, so redeliveries are still recognised). The client can erase a cancelled milestone at once, or a paid one after PayPal's 180-day dispute window; the sweep erases them automatically then. Erasure removes the title, brief, emails, terms, deliverable and reviews, and revokes both links | PayPal ids, amounts and the audit trail are kept, as the money rules require |
| **AI budget abuse** | A Postgres-backed per-IP limit on create (10/h), drafting (5/h per IP, 3/day per milestone) and judge mode (5/h). IPs are stored only as hashes (HMAC with `RATE_LIMIT_SALT`). A global daily AI cap and a per-commit verdict cache | Distributed abuse can still use up the daily cap (the app then shows "AI busy") |
| **Running AI-written tests on our server** (the "tests must fail on empty code" check) | A child process with only `PATH` in its env, a fresh temp dir, Node's permission model (fs limited to that dir, no child processes, workers or addons), no `eval`, a 128 MB heap, network stubbed out and a 10 s kill. Worker code never runs on the server | Node's permission model is a seat belt, not a hostile-code sandbox. The code comes from our model, prompted with the brief as data |
| **Disputes or chargebacks after capture** | Verified dispute webhooks move the milestone to DISPUTE and store the id. Nothing moves money automatically | The platform is merchant of record and the payout has already left, so the platform absorbs the loss. Refunds are not implemented. Multiparty (below) would make the worker the merchant of record |

**Biggest residual risks, stated plainly:**
- **On contracts that use the PR's own CI (E2), the tests share a process with the worker's code**, and the
  workflow YAML comes from the PR (`pull_request` trigger). The freeze-and-sentinel harness and the
  tampering flag catch the cheap tricks, and then a person has to look.
- **The trusted runner (E3) closes both for policy-2 contracts** (`runner/`, run from
  [milestone-runner](https://github.com/TanmayShah29/milestone-runner)). Milestone dispatches our own
  workflow, never the PR's. It runs each signed test in its own container. The PR's code runs in a second
  container, with no network, a read-only file system, no capabilities and a non-root user. It can only
  change the values it returns over a socket. `results.json` is signed through GitHub's OIDC and
  Sigstore, and Milestone checks the signature and the exact workflow identity before it counts the result.
  It also checks the digest, and the nonce, commit and contract. Limits:
  - values cross as JSON, plus `undefined`, `NaN`, `Infinity`, `Date` and thrown errors. A test that needs a
    class instance or a callback can't run there;
  - only JavaScript and TypeScript tests run there, not Python yet;
  - the runner repo's `main` (force pushes and deletion blocked) is what "trusted" means;
  - each run adds a permanent public Rekor entry. It holds the fingerprint, commit, nonce and results, and
    no names or emails.
  If the runner can't give a checked result, the PR's CI stands in (E2). A criterion whose floor is E3 then
  goes to a person.
- **Free models** (see AI above).

## Limits and the real-world path

- **Holds last 29 days, and reauthorizing doesn't extend them.** [Verified Oct 22] Reauthorizing a fresh
  authorization returns `422 REAUTHORIZATION_TOO_SOON`: *"A reauthorization is only allowed once from Day 4
  to Day 29 since the date of the original authorization."* A reauthorization only renews the 3-day honor
  period, inside the same 29 days. So Milestone caps a due date at the hold's expiry minus 3 days (26 days
  out when unfunded) and tells clients to **split longer work into milestones**, each with its own hold.
  Nothing reauthorizes on a schedule. The client can renew the honor period by hand.
- **Paying the worker directly (PayPal Multiparty) is a no-go on our sandbox app.** Today the hold is on the
  platform, and release = capture, then a Payouts call minus the fee. We tried the production-shaped flow
  ([`docs/MULTIPARTY.md`](docs/MULTIPARTY.md), `scripts/multiparty-check.sh`). The sandbox returned:
  - `PLATFORM_FEES_NOT_SUPPORTED` for `platform_fees`, even with our own account as the payee
  - `DELAYED_DISBURSEMENT_NOT_SUPPORTED` for `disbursement_mode: DELAYED`
  - `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING` for a card order with a personal-account payee
  - `UNSUPPORTED_PAYMENT_INSTRUCTION` for `payment_instruction` at order create with AUTHORIZE (it belongs on
    the capture call)
  - `403 NOT_AUTHORIZED` for `POST /v2/customer/partner-referrals`

  These are partner permissions. In production the path is PayPal Commerce Platform: onboard each worker
  through Partner Referrals, set `payee.merchant_id` to the worker, and capture with
  `payment_instruction.platform_fees`. The worker is then paid in one step with no payout, and the worker,
  not the platform, is merchant of record for disputes.
- **CI is re-read, not re-run, on an objection.** The fine-grained GitHub token has no Actions permission,
  so the second review re-reads the same commit's check runs and gets a fresh AI review of the untested
  criteria.
- **Scope:** GitHub PRs with Node.js `node:test` acceptance tests (plus a `rubric_text` verifier for text
  deliverables). Sandbox only, USD only, one hold per milestone. No refunds or partial-refund splits.
- **Bryntum Gantt runs on the public trial package** (watermarked). A hackathon license has been requested.
- **Free hosting:** a Render free web service (it sleeps after 15 minutes idle) and Neon free Postgres.

## Run it locally

Requires Node 22 and Postgres 14+.

```bash
npm install
cp .env.example .env   # fill in values (names below)
createdb milestone
npm run db:migrate     # plain SQL migrations in db/migrations (also run at startup on Render)
npm run dev            # http://localhost:3000
```

Environment (names only; see `.env.example`):

| Variable | Purpose |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENVIRONMENT=SANDBOX` | A sandbox REST app linked to a **US** business account with Payouts enabled |
| `PAYPAL_WEBHOOK_ID` | From `scripts/register-webhook.sh` (needs a public `APP_URL`) |
| `OPENROUTER_API_KEY`, `AI_MODEL`, `AI_MODEL_FALLBACK`, `AI_MODEL_FALLBACK_2`, `AI_DAILY_CAP` | AI (free OpenRouter models) |
| `DATABASE_URL`, `APP_URL`, `PLATFORM_FEE_BPS` (500 = 5%) | App |
| `GITHUB_TOKEN` | Optional fine-grained token (PR read/write on the target repo) for higher rate limits and verdict comments. Public check runs need no Checks permission |
| `OBJECTION_WINDOW_SECONDS` (default 120), `OBJECTION_RELEASE_SECONDS` (default 259200 = 72 h) | Review clocks |
| `RATE_LIMIT_SALT` | Optional secret. IPs in the rate-limit table are HMAC-SHA256 hashed with it (plain salted SHA-256 if unset) |
| `ALLOW_DEV_ACTIONS` | Dev-only routes and forced PayPal errors. Leave it unset in production |

Tests use a separate database. PayPal, GitHub and the AI are faked at the `fetch` layer:

```bash
createdb milestone_test
npm test               # migrates milestone_test, then runs tests/*.test.ts with node:test
npm run typecheck && npm run lint
```

Useful scripts: `scripts/sandbox-check.sh [--deep]` (which PayPal features your app has),
`scripts/ai-check.sh` (which models answer), `npx tsx scripts/seed-demo.ts` (a demo project),
`npx tsx scripts/create-platform.ts "<name>"` (prints a platform API key once).

To verify PRs in your own repo, copy `.github/workflows/milestone.yml` and `.github/milestone/` from
[milestone-demo](https://github.com/TanmayShah29/milestone-demo/tree/main/.github) to its default branch,
and point `MILESTONE_API` at your deployment.

## For AI agents: the MCP server

An agent can post work or do it: read the signed terms, accept them, open a PR, submit it and track the
payout. There are **no tools that fund, capture, release, void or refund**. An agent can earn, never take.

```bash
claude mcp add milestone -- npx tsx mcp/server.mts   # this repo's .mcp.json already registers it
# MILESTONE_API defaults to the live app; MILESTONE_API_KEY (msk_…) adds list_milestones
```

| Tool | What it does |
|---|---|
| `get_milestone` | Brief, amount, repo, criteria with their tests, fingerprint, how to deliver |
| `accept_terms` | Sign by fingerprint (refused if the terms changed since they were read) |
| `submit_work` | Submit the PR URL (or text, for text deliverables) |
| `get_status` | Verdict per criterion, feedback, objection window, payout |
| `create_milestone`, `draft_terms` | Post a job and have the AI draft its terms |
| `list_milestones` | A platform's milestones, with `MILESTONE_API_KEY` |

Give a worker agent the milestone's **worker link** (`…/milestones/<id>?t=mwt_…`).
[milestone-demo#3](https://github.com/TanmayShah29/milestone-demo/pull/3) was done this way and paid.

`attack_terms` runs the AI attack on a draft (see [AI used](#ai-used)).

**An agent hires an agent:** `npm run agents` connects two separate MCP clients to the live app. A scripted
buyer agent posts a job and signs the terms the AI drafted. The worker agent signs the same fingerprint, then
writes code with a free AI model and opens a real PR. A person funds the hold once. The signed tests fail and no
money moves; the worker reads the verdict, pushes a fix, and fixed rules pay it.
[milestone-demo#10](https://github.com/TanmayShah29/milestone-demo/pull/10) is a real run: it failed, was fixed,
and paid $13.10 about 7 minutes after the job was posted. It used `--auto-fund`, a test flag that has the script stand in for the person.

Two limits to be plain about. The worker's first attempt is told to rush, so the failure path shows on every
run; the failure itself comes from real CI. And the boundary is the tool list, not the buyer's credentials: the
buyer agent holds the client link, which a program could use over HTTP for client actions such as `cancel` or the
sandbox-only `fund-card`. A real PayPal hold still needs a person to approve it at PayPal, and a production
buyer agent should get a token limited to posting and signing.

**HTTP API:** `POST /api/milestones/:id/:action` with the link token in `x-milestone-token` (or
`Authorization: Bearer msk_…`). Actions: `draft-terms`, `edit-terms`, `sign-terms`, `fund`, `fund-card`,
`submit`, `check`, `approve`, `request-changes`, `object`, `release`, `cancel`, `refresh-hold`, `schedule`,
`sync`, `rotate-link` (`{ "link": "client" | "worker" }`, returns the new `token` once) and `erase`. Also `GET /api/contracts/:fingerprint`, `GET /api/status` (AI budget), `GET /api/health` and
`GET /api/tick`.

## Trying it as a judge

- **No login:** open [`/demo`](https://milestone-ai-escrow.onrender.com/demo). It creates a three-milestone
  project where you are both client and worker. Fund the first milestone with PayPal's **sandbox test
  card**; that places a real sandbox authorization hold. The other two replay real runs (their PRs and CI
  logs are real and public; their PayPal ids are labelled illustrative).
- **PayPal login path:** the sandbox accounts below are fake `example.com` addresses. Passwords are
  available from the maintainer on request.

| Role | Sandbox email |
|---|---|
| Platform (business; the app's merchant) | `sb-47hvxh49451990@business.example.com` |
| Client (approves holds at sandbox.paypal.com) | `sb-eg47t53461254@personal.example.com` |
| Freelancer (receives payouts) | `sb-puo47p53461265@personal.example.com` |

## Stack and credits

- Next.js 15 (app router) + TypeScript, Postgres (Neon), `pg`, zod
- **[APIMatic Context Plugin](https://www.apimatic.io/)**: used in Claude Code to build the PayPal integration
  against the APIMatic-generated PayPal TypeScript SDK. Every SDK fact in
  [`paypal-plan.md`](paypal-plan.md) came from its SDK map, not from memory
- **[Bryntum Gantt](https://bryntum.com/products/gantt/)**: `/timeline`, where money drives the schedule.
  Future phases are auto-scheduled, so dragging the work's end pushes review, the objection window and
  payout; a finish-no-later-than constraint at the hold's limit refuses dates the PayPal hold can't cover
- **[AG Grid](https://www.ag-grid.com/)** (Community, MIT): `/ledger`, every PayPal call each milestone made,
  with the attempt and `PayPal-Request-Id` that make retries safe, totals for held / captured / fees /
  paid out, filters and CSV export; and the `/milestones` portfolio, sorted by which hold expires first
- **[Render](https://render.com)**: hosts the live app (free web service, auto-deploys from `main`)
- OpenRouter free models via the Vercel AI SDK; MCP TypeScript SDK; Playwright for screenshots

## License

[MIT](LICENSE)
