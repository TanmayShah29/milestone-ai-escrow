# Milestone v2: proof you can check yourself

Written Nov 5, 2026, after the prior-art review in `docs/PRIOR_ART.md`. This plan ignores the calendar, as
asked. It still keeps every hard limit: PayPal sandbox only, free tiers only, the free model cap of 50 AI
calls a day, and the money rules in `CLAUDE.md`. Where an idea would bend a money rule, it is marked
**DECISION** and needs your yes.

---

## 0. What judges should feel

Today's pitch is "AI reviews the PR and PayPal pays". Plenty of hackathon projects say that. v2's pitch:

> **Every dollar Milestone moves comes with a receipt anyone can check: who agreed to what, which tests ran
> where, which models said what, which rule decided, and what PayPal did. Check it in your browser, without
> trusting us.**

Six things nobody else has together:
1. **Test results with a cryptographic signature.** The signed tests run in our own runner, and GitHub and
   Sigstore sign the result. Today we trust the job's name.
2. **A rule for how much proof each criterion needs.** No payment moves on evidence weaker than what that
   criterion requires. A single model's opinion is never enough for a must-have (the RAILS idea).
3. **Partial pay agreed up front.** The money each criterion is worth is set at signing. A partial PayPal
   capture pays exactly what was earned, and the rest of the hold is released automatically. Upwork and
   Escrow.com have no equivalent.
4. **A neutral judge at the end, paid by whoever loses.** Either side can lock the money. An AI drafts the
   ruling from the evidence, a named human arbitrator signs it, and the losing side's fee hold pays the
   arbitrator. This combines the AAA AI arbitrator, SmartInvoice and Kleros, on PayPal rails.
5. **Agents that spend inside a budget the human signed.** The client signs a spending mandate once. Their
   agent can then post and fund bounties inside it, with no click per hold (Google's AP2 idea, on a vaulted
   card).
6. **A public, append-only record.** Every decision is signed and chained to the one before. Checkpoints go
   into Sigstore's public transparency log, Rekor.

---

## 1. Principles (the old ones stay; five are new)

Kept, unchanged: the AI never moves money. Idempotency keys, never capturing more than was authorized,
storing every PayPal id, an audit row per change, verified webhooks, and amounts as integer cents.

New:
- **P1. Nothing settles on evidence below its floor.** Each criterion names the minimum level of evidence it
  needs (§3.2), and the decision engine refuses anything weaker.
- **P2. Everything that decides is signed before work starts.** The signed contract pins:
  - the decision-policy version and the evidence floors;
  - which models review, and which bench version measured them;
  - the runner, the arbitrator and the fees;
  - the payment schedule.
- **P3. Anyone can check.** Every state change is a signed event in a hash chain. A browser page and an
  `npx` command recheck the whole chain from public data.
- **P4. A disagreement always ends with someone neutral.** It never ends with "the client decides".
- **P5. Deadlines run on their own clock.** Deadlines are scheduled jobs. Anyone can trigger the tick, and
  there are at least two independent free pingers. Both sides are told before money moves.

---

## 2. The target design

```
            ┌───────────────────────── signed event chain (ledger) ─────────────────────────┐
            │ IntentMandate → Obligation → Funding → Submission → Evidence* → Decision →     │
            │ (Lock → Award) → Settlement → Receipt          checkpoints ─► Sigstore Rekor   │
            └────────────────────────────────────────────────────────────────────────────────┘
 Client ──passkey──► Obligation v3 ◄──passkey/agent key── Worker / agent
   │                     │
   │  mandate + vault    ▼
   └──────────► Money engine (flow.ts v2) ── PayPal: authorize, partial capture, void, payout,
                         ▲                           refund, dispute evidence
                         │ settlement instruction (deterministic)
                 Decision engine (policy v2: evidence floors, payment schedule, timeouts)
                         ▲
        ┌────────────────┼──────────────────────────┐
  Trusted runner     AI panel (3 models,        Resolution desk
  (milestone-runner  grounded quotes,           (lock, evidence pack, AI draft
   repo, Docker,     spotlighting, measured     award, a human signs,
   Sigstore-signed)  on Proof Bench v2)         fee holds)
```

The pipeline today: PR workflow → check-run names → one AI call → `decide()` → capture, then payout.

The v2 pipeline:
1. A submission arrives.
2. The trusted runner runs the tests and returns a signed result (level E3).
3. If any tested must-have fails, the work goes back for changes. No AI calls are spent.
4. Otherwise the AI panel judges the criteria tests can't check (level E1).
5. The decision engine works out how much each criterion earned.
6. The objection window and pre-release notices follow.
7. A settlement instruction runs: partial capture, release of the rest, payout.
8. A receipt is issued and anchored in Rekor.

---

## 3. Workstreams

Each workstream lists what it is, why (from prior art), the design, the code it touches, and the spike that
must pass first. The spikes are collected in §5.

### A. Contract v3: the obligation (foundation)
**Why:** ERC-8183 fixes the judge when the job is created. RAILS has an obligation object with a minimum
standard of evidence. Today our hash leaves out `CONFIDENCE_FLOOR`, the policy and the models (see
`terms.ts:46`).

**Design:** `terms.ts` gets a `version: 3` shape, still with optional fields, so v2 hashes keep working:
```ts
obligation = {
  criteria: [{ id, text, kind: "must"|"nice", weightBps, evidenceFloor: "E3"|"E2"|"E1"|"E0", test? }],
  paySchedule: { mustBaseBps, niceBonusBps[] },      // e.g. musts 80%, each nice 10%
  verification: { runner: "milestone-runner@<sha>", panel: [{model, benchAccuracy}], benchVersion,
                  policyVersion: "policy-2", groundingRequired: true },
  resolution: { arbitrator: { id, name, payoutEmail }, feeCents, lockWindowSeconds },
  timing: { dueAt, objectionWindowSeconds, preReleaseNoticeSeconds, humanTimeoutSeconds },
  parties: { client: { passkeyId | agentKey }, worker: { githubLogin, passkeyId | agentKey } },
  money: { amountCents, mode: "hold"|"captured", platformFeeBps, mandateId? },
}
```
- **Worker is tied to a GitHub login.** Today any PR that cites the fingerprint counts, because the PR
  author is never checked (`github.ts` doesn't read it). v3 requires the PR author to equal
  `parties.worker.githubLogin`.
- **Each party signs the terms, not just a hash.** Signing uses a WebAuthn passkey in the browser (free,
  built into browsers) or an Ed25519 key for agents (from the MCP `accept_terms` with a signature). This
  replaces "whoever holds the link" with something the other side can't later deny. Links still work as a
  way in, but signing needs the key.
- **Files:** `src/lib/contract/terms.ts` (schema v3 and migration), a new `src/lib/contract/signing.ts`, and
  migration `014_obligation_v3.sql` (`parties`, `pay_schedule`, `evidence_floors`, `passkeys` table).

### B. The ledger: a signed event chain and transparency
**Why:** AP2's chain of signed mandates, and RAILS' "clearing passport". Nobody in the freelance market lets
outsiders check the escrow's decisions.

**Design:**
- A new `ledger_events` table (`seq`, `milestone_id`, `type`, `body_json`, `body_hash`, `prev_hash`,
  `server_sig`, `party_sigs`). It is written in the same transaction as each `audit_log` row (keep the audit
  log for operations).
- Event types:
  - `IntentMandate`, `Obligation` (both party signatures), `Funding` (PayPal order and authorization ids);
  - `Submission` (PR, head SHA, author), `Evidence` (runner attestation, panel votes);
  - `Decision` (policy version, inputs hash, the share each criterion earned);
  - `Lock`, `Award`, `Settlement` (capture, void and payout ids), `Receipt`.
- The server signing key is Ed25519 from WebCrypto, in env `LEDGER_SIGNING_KEY`. The public key is
  published at `/.well-known/milestone-ledger.json`.
- **Rekor anchoring:** on each `Receipt`, and hourly, upload a `hashedrekord` entry with the chain head's
  hash to the public Sigstore Rekor log (free, no account). The Rekor entry id is stored in the next event.
- **Verifier:**
  - `/proof/<milestone>` runs entirely in the browser. It fetches the chain and checks every hash and
    signature with WebCrypto, checks the runner attestation's Sigstore bundle, and checks Rekor
    inclusion.
  - A small `npx milestone-verify <url>` package does the same.
  - **This is the "mind-blown" button in the video.**
- **Files:** new `src/lib/ledger/` (`append.ts`, `verify.ts`, `rekor.ts`) and `src/app/proof/[id]/`. Every
  function in `flow.ts` and `run.ts` that changes state calls `append` inside its existing transaction.

### C. Trusted runner (evidence level E3)
**Why:** this closes both residual risks we admit today: the workflow YAML comes from the PR, and the tests
share a process with the worker's code. It also lets an objection re-run CI, which today can only re-read it.

**Design:**
- A new public repo, `TanmayShah29/milestone-runner`, with one workflow, `run.yml`, triggered by
  `workflow_dispatch`. Its inputs are `repo, pr, head_sha, fingerprint, nonce`.
- Milestone dispatches it with a fine-grained token that has Actions: write on **that repo only**. This is a
  user action: a new token.
- The job:
  1. Fetch the contract by fingerprint and recheck its hash.
  2. Check out the PR at `head_sha` as data. Nothing from the PR runs on the host.
  3. Build **two containers** on the GitHub-hosted runner, which has Docker:
     - **worker:** the PR's code plus a small RPC shim that exposes the interface named in the contract
       (`module.exports` → JSON-RPC over a Unix socket), with `--network none` and a read-only root;
     - **tests:** the signed tests with a stub module that forwards calls over the socket.
     The worker's code can only affect the *values it returns*. It can't touch the assertions, the reporter
     or `process.exit` in the test process. This is real isolation, not "freeze `assert`".
  4. Write `results.json` (one result per criterion, plus the nonce, `head_sha`, fingerprint and image
     digests).
  5. `actions/attest` with a **custom predicate** signs `results.json` through GitHub's OIDC and Sigstore.
     The bundle is uploaded as an artifact.
- Milestone downloads the bundle and checks it with `sigstore-js`. The certificate identity must be
  `https://github.com/TanmayShah29/milestone-runner/.github/workflows/run.yml@refs/heads/main`, and the
  subject digest must match `results.json`. That makes it **E3** evidence.
- The PR's own `milestone.yml` becomes optional, kept only as a check the worker can see (level E2). The
  tampering flag for `.github/` changes goes away, because the PR's workflow no longer counts.
- **Bonus:** the runner image is chosen by `stack`, so Python and pytest come almost free. The contract
  declares the interface; the shim exists per language.
- **Files:** a new `milestone-runner` repo, and `src/lib/review/runner.ts` (dispatch, poll, download,
  check). Replace the check-run binding in `verifiers.ts:60` with this, keeping the old path as E2.
- **Free tier:** Actions minutes are free for public repos. An attestation for a public repo goes to the
  public Sigstore instance.

### D. AI panel (evidence level E1, measured)
**Why:** the 2026 judge studies found judges can be consistent and still biased (position bias above 0.10),
and swayed by the prompt. A model's self-reported confidence is not evidence.

**Design:**
- **Three different free models**, pinned in the contract. Each one scores the criteria tests can't check,
  in a **different random order** (to cancel out position bias).
- **Grounding is checked by code:** a "pass" must cite `file:line-range` and a quote taken word for word from
  the diff at those lines. `grounding.ts` checks every quote. A vote without grounding counts as "unclear".
- **Decision:** at least 2 of 3 grounded passes, and no grounded fail, is a pass. Any grounded fail with
  quotes is a fail. Anything else escalates. `confidence` is kept for display and has no role in the
  decision.
- **Prompt-injection defence in layers:**
  - *spotlighting / datamarking* (Microsoft's technique): untrusted text is interleaved with a marker and
    the model is told that marked text is data;
  - the existing deterministic scan, extended with zero-width and look-alike folding plus a short
    multilingual phrase list (Hindi, Spanish, Chinese, Russian, …);
  - each panel member flags injection on its own, and any flag escalates.
- **Budget:** 3 calls per review that reaches the AI stage. Tested must-haves gate first, so failing PRs
  cost 0 AI calls. Around 13 full reviews a day fit under the 40-call cap. `AI_PANEL_SIZE=2` is a fallback,
  where a tie escalates. The verdict cache by `(head_sha, fingerprint)` stays.
- **Files:** a rewrite of `verifiers.ts` `aiReview`; new `src/lib/review/panel.ts`, `grounding.ts`,
  `spotlight.ts`; `injection.ts` extended.

### E. Proof Bench v2: calibrate the judges, out in the open
**Why:** it turns "we picked a free model" into "we measured them". Judges love numbers.

**Design:**
- Grow the bench from 12 PRs to about 60 hand-labelled cases:
  - good work, subtly wrong work, gamed tests, padded code;
  - injections in 6 languages and invisible-character injections;
  - "works but ignores the spec" cases.
- The labels are the ground truth. Per model and per panel, measure:
  - accuracy and Cohen's κ;
  - position bias (score the same case with criteria in two orders);
  - grounding rate;
  - injection catch rate.
- Publish `/bench` with the bench version hash. The contract pins `benchVersion`, so a signed deal says
  "these judges, measured this well".
- **Budget:** about 60 cases × 3 models × 2 orders = 360 calls, run over about 9 days under the cap and
  cached forever. **This is the long pole: start it early.**
- **Files:** `src/lib/bench.ts` and `bench-score.ts` (already there) grow; new `bench/cases/` fixtures.

### F. Decision engine v2: proof floors and earned shares
**Why:** P1 and the payment schedule. It replaces `decide()` in `policy.ts`.

**Design:** a pure function, fully unit-tested, with the version pinned in the contract:
```
input:  obligation, evidence[] (level, verdict per criterion), flags
for each criterion: met = verdict==pass && level >= evidenceFloor
musts all met              → share = mustBaseBps + Σ niceBonusBps[i] for met nice-to-haves
any must failed (≥ floor)  → CHANGES_REQUESTED (share 0)
must unmet only for lack of evidence (below the floor, unclear) → ESCALATED
injection/tamper flags     → ESCALATED (never auto-void; see G)
output: { decision, shareBps, perCriterion[], reasons[], policyVersion }
```
- `humanTimeoutOutcome` moves into the resolution desk (G). **The timeout default stops voiding to the
  client without a hearing.** It now auto-locks for arbitration.
- **Files:** `src/lib/review/policy.ts` becomes `policy-2`, and `policy-1` is kept so v2 contracts still
  decide the same way.

### G. Resolution desk: a neutral party at the end
**Why:** our weakest point today (`PRIOR_ART.md` §3.1). The model comes from SmartInvoice (either side can
lock, a named arbitrator), the AAA (AI draft, a human signs) and Kleros (the loser pays).

**Design:**
- **Lock:**
  - **either party** can lock during the objection window or after an escalation;
  - locking requires a fee hold: the locker funds a small PayPal authorization (for example $5, set by
    `resolution.feeCents`). The worker can do this too, with a sandbox login or test card;
  - the other party has 72 h to match the fee, or the decision so far stands. This is the Kleros-style
    deterrent.
- **Evidence pack:** built automatically and hashed into the ledger. It holds:
  - the contract and both signatures;
  - the diff;
  - the runner attestation;
  - every panel vote with its quotes;
  - the decision trace;
  - each side's written statement, limited to 2,000 characters.
- **AI draft award:** one call. It proposes a share in basis points with reasons tied to evidence ids. It is
  shown as a **draft**.
- **Arbitrator signs:** the arbitrator named in the contract (a registry; the default is "Milestone
  Resolution Desk", you, on a sandbox account) accepts or edits the share and signs with a passkey. **The
  signed award is the only input to settlement.** The AI still moves nothing.
- **Settlement of an award:**
  - the work's hold is partially captured at the share, and the rest is released;
  - the loser's fee hold is captured and paid out to the arbitrator through Payouts;
  - the winner's fee hold is voided.
- **Arbitrator silence:** an arbitrator who doesn't rule by the deadline means the decision so far stands,
  and both fee holds are voided. Silence is never a default win for the client.
- **After capture, PayPal disputes:** when a `CUSTOMER.DISPUTE.CREATED` arrives, the evidence pack is
  rendered to PDF and **submitted through `/v1/customer/disputes/{id}/provide-evidence`**. The demo uses the
  sandbox-only `adjudicate` action (in the guide, §7). This closes the "platform absorbs the loss" gap as
  far as a sandbox can.
- **New states:** `LOCKED`, `ARBITRATION`, `AWARDED`. `HUMAN_CHECK` is renamed `ESCALATED`.
- **Files:** a new `src/lib/resolution/` (`lock.ts`, `pack.ts`, `award.ts`), `src/app/milestones/[id]/court/`,
  and migration `015_resolution.sql` (`locks`, `fee_holds`, `awards`, `arbitrators`).

### H. Money engine v2
**Partial settlement** (needed by F and G):
- capture `shareBps × amount` with `final_capture: true`, which releases the rest of the authorization;
- payout = captured − PayPal fee − payout fee − platform fee (same formula as today);
- **spike H1** verifies this live.

**Second mode, `captured`, for work over 26 days** (**DECISION**):
- capture at funding (intent CAPTURE) into the platform balance;
- release = payout; a rejection or award = full or partial **refund** of the capture;
- this removes the 29-day ceiling;
- the costs are stated plainly: PayPal keeps its fee on refunds, and in production this is custody, which
  needs money-transmitter compliance (Escrow.com is licensed for this);
- sandbox only, labelled.

**Spending mandates for agents** (**DECISION**: this extends money rule 1):
- the client vaults a card once (card vault is verified working);
- the client signs an `IntentMandate` with a passkey:
  `{maxPerMilestoneCents, totalCents, expiresAt, allowedRepos[], allowedVerifiers[], maxOpenBounties}`;
- the client's procurement agent may then call `post_bounty` over MCP;
- **deterministic code** checks the mandate and authorizes the vaulted card as a merchant-initiated charge.
  The model chooses *what to buy*, and code decides whether the signed mandate allows it, as in AP2;
- capture, void, payout and refund stay off every tool list;
- this answers "a human must approve each hold", which today limits the agentic story;
- **spike H3** must confirm a vaulted-card authorization with no buyer present.

**Dispute evidence submission:** see G. This is a REST call, not in the toolkit.

**Files:** `src/lib/money/flow.ts` (partial capture, refund paths, fee holds, mandate funding),
`src/lib/paypal/rest.ts`, and `src/lib/money/mandates.ts`.

### I. Open bounties, the market and passports
**Why:** Algora's `/claim` and Virtuals ACP's request and negotiation phase. Today a milestone needs a link
handed to a specific worker.

**Design:**
- **Open bounty:** state `OFFERED`. Anyone, human or agent, `claim`s with a GitHub login and a signature,
  which makes them a candidate.
- **Submitting:** any candidate's PR citing the fingerprint is run in the runner. Running costs no AI calls.
- **The winner:** the first PR to reach a passing decision gets the hold. The rest get a signed "attempt
  receipt".
- **Spam limits:** claims are rate-limited per login, and AI panel calls run only for PRs whose tests
  already pass.
- **Counter-offer:** before signing, the worker can propose a different amount or due date, once each. The
  client accepts or refuses. This is the negotiation phase, kept small.
- **Passports:**
  - a per-worker page and a signed JSON file of receipts: paid count, on-time rate, mix of evidence levels,
    disputes, awards;
  - a README badge SVG;
  - a **client passport too**: objection rate, timeouts, awards against. Fairness in both directions is
    rare, and judges notice it;
  - all built from ledger events, so anyone can check them.
- **Files:** `src/app/bounties/`, `src/app/passport/[login]/`, MCP v2 tools `list_bounties`, `claim_bounty`,
  `post_bounty` (mandate only).

### J. Liveness, notifications, platform API
- **Jobs table** (`jobs`: `run_at`, `kind`, `milestone_id`, `attempts`, `locked_until`) using `FOR UPDATE
  SKIP LOCKED`.
  - Deadlines become jobs: release, pre-release notice, lock window, arbitrator deadline, hold expiry minus
    3 days.
  - `tickAll` drains due jobs. `/api/tick` stays permissionless.
- **Two free clocks:** a scheduled workflow in `milestone-runner` (`cron: */5 * * * *`) that curls
  `/api/tick`, plus cron-job.org. Either can fail without anything breaking.
- **Notifications:**
  - PR comments to the worker (already there);
  - outbound **signed webhooks** for platforms: HMAC, retries, an event catalogue matching the ledger
    types;
  - email to both sides through a free provider (**DECISION**: e.g. Resend's free tier needs an account
    but no card).
  - The rule: **24 h notice before any money moves**, as Escrow.com does, scaled down in demo mode.
- **Platform API:**
  - an OpenAPI 3.1 spec for `/api/*`;
  - `Idempotency-Key` on our own POSTs;
  - ERC-8183-style **policy hooks** per platform (`beforeFund`, `beforeSettle`: for example a KYC allowlist
    or a maximum amount), which may only block, never move money;
  - a generated TypeScript SDK.

### K. What people see
- **`/proof/<id>`, the Proof Explorer:**
  - the ledger as a vertical chain;
  - a badge per criterion showing its evidence level against its floor;
  - links to the runner attestation and the Rekor entry;
  - a **"Verify independently"** button with green ticks as each check passes, in the browser.
- **`/milestones/<id>/court`, the courtroom:** both statements, the evidence pack, the AI draft award with
  clickable evidence links, the arbitrator's signature, and the fee holds.
- **Settlement card:** "Earned 90% ($90.00): must-haves 80% + C5 10%. Captured $90.00, $10.00 released back
  to the card."
- **Bounty board and passports.**
- **Gantt:** add the mandate's budget burn-down, lock and arbitration periods as bars, and fee holds as
  money gates.

---

## 4. New state machine

```
DRAFT ─► OFFERED (open bounty) ─claim/sign─► AGREED ─► FUNDED ─► SUBMITTED ─► VERIFYING
VERIFYING ─► CHANGES_REQUESTED ─► SUBMITTED
VERIFYING ─► ESCALATED ─(either side)─► LOCKED
VERIFYING ─► PASSED(shareBps) ─window─► SETTLING ─► SETTLED ─► (DISPUTE)
PASSED ─lock─► LOCKED ─fee matched─► ARBITRATION ─signed award─► AWARDED ─► SETTLING
LOCKED ─fee not matched in 72h─► previous decision stands
ARBITRATION ─arbitrator silent─► previous decision stands, fee holds voided
any pre-capture state ─void/expire─► CANCELLED
```
`RELEASED`, `PAID_OUT` and `PAYOUT_FAILED` become sub-states of `SETTLING`/`SETTLED` with the PayPal ids on
the settlement row. `states.ts` keeps a mapping table from the old names, so v2 milestones still show
correctly.

---

## 5. Phase 0: spikes before any build (all real calls)

Each spike is recorded in `PayPal_Sandbox_Guide.md` or a new `docs/SPIKES_V2.md`, tagged [VERIFIED].

| # | Spike | Pass = |
|---|---|---|
| H1 | $10 authorization, capture $8 with `final_capture: true` | capture COMPLETED $8; authorization goes to `PARTIALLY_CAPTURED`/`CAPTURED` with the remainder released |
| H2 | Intent CAPTURE $10, then a partial refund of $3 and a full refund | refunds COMPLETED; note the fee kept |
| H3 | Vault a test card (setup token → payment token), then an `AUTHORIZE` order with `payment_source.card.vault_id` and `stored_credential` (merchant-initiated) and **no buyer present** | authorization CREATED. If this fails, mandates fall back to "one click per bounty" |
| H4 | Open a dispute as the sandbox client on a capture, then `provide-evidence` (multipart PDF), then sandbox `adjudicate` | evidence accepted, dispute RESOLVED; webhooks seen |
| H5 | Payout to a third sandbox personal account (the arbitrator) | SUCCESS |
| C1 | `workflow_dispatch` on `milestone-runner` with a fine-grained token, plus a two-container RPC test harness | a run with `results.json` |
| C2 | `actions/attest` with a custom predicate, checked in Node with `sigstore-js` against the workflow identity | the check passes; a tampered `results.json` fails it |
| B1 | Upload a `hashedrekord` to public Rekor from Render, then fetch an inclusion proof in the browser | an entry id and a proof that checks |
| A1 | A WebAuthn passkey registers and signs on `milestone-ai-escrow.onrender.com` (RP id), in Chrome and Safari | an assertion is checked on the server |
| D1 | The current free model list (`:free` + structured outputs). Pick 3 different providers | 3 models answer the panel schema |

If **H1** fails, partial pay is dropped and work is paid all or nothing, with awards limited to release or
void. If **C2** fails, E3 becomes "a runner we own, unsigned" (still better than today). If **H3** fails,
the agent posts the bounty and the human funds it with one click.

---

## 6. Build order

Each phase leaves the app working and better for the demo. Sizes are rough, for one person working with
Claude.

**Progress:**
- **Nov 5:** Phase 0 done (`docs/SPIKES_V2.md`).
- **Phase 2 core built:**
  - contract pins (policy version, confidence floor, review models, verifier);
  - the signed proof chain (`src/lib/proof/`, migration 014) with `/proof/<id>`, `/api/proof/<id>`,
    `/.well-known/milestone-proof-keys.json` and `scripts/verify-proof.mts`;
  - passkey and agent-key signatures on the terms (migration 015, `src/lib/contract/signatures.ts`);
  - the worker's GitHub account, which binds who may submit.
- **Phase 6 (resolution desk) core built (Nov 6):**
  - `src/lib/resolution/`: `config.ts` (the arbitrator from env), `fees.ts`, `pack.ts`, `desk.ts`;
  - migration 018 adds `locks` and `fee_holds`, and two new states, `LOCKED` and `ARBITRATION`;
  - **lock and match:** either side locks a PASSED in its window, or a HUMAN_CHECK, by funding a fee hold
    (PayPal checkout or the sandbox test card). The other side matches within 72 h, or the earlier decision
    stands;
  - **fee holds:** every fee call (order, authorize, capture, void, payout to the arbitrator) runs through
    `flow.ts runWrite`, so each has its own claim and `PayPal-Request-Id`;
  - **evidence pack:** frozen when the lock is matched. Its hash is in the proof chain (`lock:matched`);
  - **AI draft award:** one call, with evidence ids checked against the pack. It's shown only;
  - **award:** signed by the arbitrator's **ES256 key** (pinned in the terms as
    `policy.arbitrator.keyId`), from `scripts/sign-award.mts`. The private key stays on your machine. A
    passkey would need an arbitrator account; the key does the same job and keeps the server unable to
    forge an award. The arbitrator reads a case with a signed, time-limited request;
  - **settlement:** a partial capture at the award's share (or a void at 0%), the paying side's fee
    captured and paid out to the arbitrator, the other side's fee voided. A silent arbitrator leaves the
    earlier decision standing and both fees are voided;
  - **UI:** `/milestones/<id>/court`, a link from the milestone page, and next-step text for the new
    states. Checked in the browser against a seeded local case: no console errors, and no sideways
    scrolling at 375 px;
  - tests: `tests/resolution.test.ts`, 12 cases;
  - **needs you:**
    1. make the arbitrator key (`npx tsx scripts/sign-award.mts keygen ~/arbitrator.jwk`) and set
       `ARBITRATOR_PUBLIC_JWK`;
    2. create a third sandbox personal account and set its email as `ARBITRATOR_PAYPAL_EMAIL`, on Render
       and locally;
    3. your OK to make an undecided HUMAN_CHECK lock instead of voiding. It's unchanged until then;
  - **live end-to-end run [VERIFIED Nov 6]** on milestone `6c339a15…` ($20, milestone-demo PR #17):
    - the terms pinned policy-2 and the desk;
    - test-card hold `3L210557SR9793746`;
    - the review passed at E3 on the trusted runner (run 42196865986, Rekor 3714238852);
    - the client locked, the worker matched, and the pack froze as `bfa24034…`;
    - the AI drafted 95%: it wrongly subtracted the platform fee, and the prompt is now fixed;
    - the award was signed with the arbitrator's key at 100%;
    - settlement: the $20 capture `8U75459516038431S` and the worker payout of $17.63 (SUCCESS); the
      client's $5 fee captured and $4.29 paid out to the arbitrator (`HJCQG7NP4FMZQ`, SUCCESS); the
      worker's fee hold `8PF37759AP812603M` VOIDED. PayPal's own API confirmed each of these;
  - **not built yet:** sending the evidence pack to PayPal disputes (`provide-evidence`), renaming
    `HUMAN_CHECK` to `ESCALATED`, and a registry of several arbitrators.
- **Phase 5 (partial pay) built (Nov 6):**
  - a signed `paySchedule` in the terms (`mustBaseBps` plus `niceBonusBps` per nice-to-have). It must add
    up to 100% and give the must-haves at least half, and the must-haves alone must pay at least $10. Terms
    without one hash as before;
  - `decide2` returns `shareBps`: the base, plus each nice-to-have met at its evidence floor. The share is
    stored as `share_bps` (migration 017) on every PASSED: a review, a second review, the client's
    approval, or a HUMAN_CHECK timeout;
  - the release captures `floor(amount × share)` with `final_capture: true`, which releases the rest of the
    hold [VERIFIED H1]. The payout is split from what was captured, as before;
  - the money panel and the PR comment show the share. The audit rows (`review:passed`, `hold:captured`)
    carry `shareBps`, which is already a proof-chain fact;
  - tests: `tests/shares.test.ts`, 11 cases;
  - **left for later:**
    - `captured` mode needs your decision (§ Decisions, item 2);
    - fee holds belong with the lock and arbitration flow (Phase 6), where they're used;
    - a second capture for bonuses (H1b) isn't needed while bonuses are decided in the same review.
- **Phase 3 built (Nov 6), live since `ef2104f`:**
  - `runner/` holds the production `run.yml` and harness for `milestone-runner`. Each tested criterion
    runs in a fresh pair of containers. The tests call the worker's exports **synchronously** through
    proxies (a worker thread plus `Atomics.wait`), so contracts signed before this run unchanged. Checked
    locally in Docker: the honest worker passes; the evil one can't patch `assert`, fake the report,
    rewrite the harness or reach the network; the one that calls `process.exit` fails the test;
  - `src/lib/review/runner.ts`: dispatch with a random nonce, find the run by name, download
    `results.json`, then check the Sigstore signature, workflow identity, digest, predicate, nonce,
    commit, PR and contract (migration 016 `runner_runs`);
  - the verifier uses the runner for policy-2 terms (E3) and falls back to the PR's CI (E2). Under the
    runner, `.github/` and `acceptance/` edits are not tampering. An objection's second review re-runs
    the tests. The proof chain carries `runnerRunId` and `rekorLogIndex`;
  - `RUNNER_GITHUB_TOKEN` is set locally and on Render (expires Jan 5, 2027). The `milestone-runner`
    ruleset blocks force pushes and deletion of `main`, with no bypass;
  - tests: `tests/runner.test.ts`, 16 cases;
  - **live [VERIFIED Nov 6]:** `runner/` is pushed to `milestone-runner` `main` (`0566545`). One run against
    milestone-demo PR #1 (contract `48a51380…`), dispatched by the app's own `runnerApi()`:
    - run `42166461492` finished in 33 s: C1, C2 and C3 passed;
    - `checkAttested` verified it with real Sigstore in 1.2 s (Rekor log index 3709803464);
    - an edited copy and a replay under another nonce were both rejected;
    - `gh attestation verify` passed on it too;
  - deployed Nov 6 (`ef2104f`).
- **Phase 4 core built (Nov 6):**
  - the AI panel (`src/lib/review/panel.ts`): up to `AI_PANEL_SIZE` (default 3) different models, a random
    order each, and at most that many calls per review;
  - grounding checked by code (`grounding.ts`);
  - spotlighting (`spotlight.ts`), and a scan for the usual phrasing in six more languages (`injection.ts`);
  - `policy-2` with evidence floors (`evidenceFloor` per criterion). `policy-1` terms decide exactly as
    before. New terms pin `policy-2` and verifier `@2`;
  - a failing tested must-have costs 0 AI calls;
  - audit rows record the panel's models and votes, and the proof chain carries `panelModels` and
    `panelVotes` facts.
  - Tests: `tests/panel.test.ts`, 28 cases.
- **Phase 4 still open:**
  - earned shares (`shareBps`), which wait on Phase 5's partial capture;
  - the timeout default moving to the resolution desk (Phase 6);
  - one live panel run on the real free models, to be spent from the daily budget when you say so.
- **Phase 2 still open:** Rekor anchoring of chain heads. It writes to a public, permanent log, so it needs
  your OK first.
- **Not started:** Phase 1 (Proof Bench v2 labelling).

| Phase | Builds | Depends on | Size |
|---|---|---|---|
| 0 | Spikes (§5) | none | 1.5 d |
| 1 | **E starts now**: write and label the bench cases and start the slow AI runs (cap-limited, runs in the background for the whole project) | D1 | 1 d + background |
| 2 | **A + B**: contract v3, passkeys and agent keys, the ledger, Rekor, `/proof` checking in the browser | A1, B1 | 3.5 d |
| 3 | **C**: trusted runner, two-container harness, Sigstore check, E3 evidence | C1, C2, 2 | 3 d |
| 4 | **D + F**: AI panel, grounding, spotlighting, multilingual scan, decision engine v2 with floors and shares | 3, D1 | 2.5 d |
| 5 | **H**: partial-capture settlement, `captured` mode (if yes), fee holds | H1, H2, 4 | 2 d |
| 6 | **G**: lock, evidence pack, draft award, arbitrator signing, courtroom, PayPal dispute evidence | 5, H4, H5 | 3 d |
| 7 | **J**: jobs table, two clocks, notices, signed webhooks, OpenAPI and SDK, hooks | 2 | 2 d |
| 8 | **I + mandates**: open bounties, claims, counter-offer, passports, `post_bounty` under a mandate | 5, H3 | 2.5 d |
| 9 | **K** polish, publish Bench v2, rewrite the threat model and README, Devpost text, video v2 | all | 2 d |

**Total: about 23 working days.** That is well past Nov 12. You said to ignore the calendar, so this is the
whole plan. **If the deadline comes back into play,** cut in this order and keep what's above each line:
- after Phase 4: signed ledger, trusted runner, panel. That's already a different class of project;
- after Phase 6: adds partial pay and the courtroom;
- 7–8 are the agent-market story;
- 9 is always needed.

**Testing:** every phase adds to `tests/*.test.ts`:
- the decision engine gets table tests across every floor and share combination;
- the ledger gets tamper tests (flip one byte, and the check must fail);
- the runner gets a "malicious worker" fixture set that tries `process.exit`, monkeypatching, reading the
  socket and network calls;
- the money paths keep the mock PayPal deps pattern from `flow.ts`, plus one real sandbox run per phase.

---

## 7. Demo v2 (under 3 minutes)

1. **0:00 Mandate.** The client signs a $300 spending mandate with a passkey. Their procurement agent posts
   an open bounty over MCP. The hold appears on the vaulted card with no click. The Gantt shows the budget
   burning down.
2. **0:35 Two agents compete.** Agent A's PR hides an instruction in Hindi in a comment. The scan and two of
   the three panel models flag it, so it goes to ESCALATED. Agent B's PR goes to the runner, and the
   attestation shows as a green "E3 ✓ signed by GitHub/Sigstore".
3. **1:15 Earned share.** B passes every must-have and one of two nice-to-haves, earning 90%. The settlement
   card shows PayPal capturing $90 and releasing $10 automatically. The payout lands.
4. **1:45 Unfair objection.** The client locks and pays the fee hold, and the worker matches it. The
   courtroom shows the AI draft award ("90% stands; the evidence is the C5 test and two grounded quotes"),
   and the arbitrator signs. The client's fee hold is captured and paid to the arbitrator.
5. **2:25 Don't trust us.** Click "Verify independently": hashes, signatures, the Sigstore bundle and Rekor
   inclusion all go green in the browser. Then flip one byte in the downloaded chain and run
   `npx milestone-verify`, which shows red.
6. **2:50** "Pay-on-proof: every dollar comes with proof you can check."

---

## 8. Risks, stated plainly

- **Free AI cap.** The panel triples the calls per review, and the bench needs about 360 calls. Mitigations:
  tests gate first, verdicts are cached, the bench runs over many days, and `AI_PANEL_SIZE=2` is a fallback.
  Buying $10 of OpenRouter credit would raise the cap to 1,000 a day, but you've said no card, so the plan
  doesn't count on it.
- **Sigstore and Rekor are outside services.** If they're down, evidence drops to E2 and the decision
  engine escalates rather than paying. That is the honest behavior.
- **Passkeys need a stable domain.** The `onrender.com` subdomain works as the RP id. A domain change later
  breaks registered passkeys.
- **Arbitration in a sandbox is staged.** You are the arbitrator, on a sandbox account. Say so in the video
  and the README. The registry is real; the pool is one person.
- **`captured` mode and mandates bend today's rules** (the two DECISION items). Without them, the plan
  still works: holds only, one click per funding.
- **Complexity is a risk for judges too.** The UI must show *one* clear chain. The extra machinery lives
  behind "show proof". The Proof Explorer is the single place it all comes together.

## 9. Deliberately not built
- Blockchain anything: Rekor gives us public transparency without a chain.
- A token-staked juror pool like Kleros. A loser-pays fee hold gets the same incentive on PayPal.
- Design and document deliverables. They stay on the roadmap, and code (plus `rubric_text`) stays the scope.
- Multiparty and Partner Referrals. These are NO-GO in the sandbox; they stay the production path.

---

## Decisions needed from you before Phase 5
1. **Spending mandates:** may deterministic code fund a hold on a vaulted card when the client's
   passkey-signed mandate allows it, with no click per hold? (Money rule 1 would read: "the AI never
   moves money; code may fund only within a mandate the human signed".)
2. **`captured` mode:** may we offer capture-first custody for long work, sandbox only, with the refund-fee
   cost shown?
3. **Email notices:** may we sign up for a free email service (account, no card)?
4. **New GitHub token:** a fine-grained token with Actions: write on `milestone-runner` only.
