# Prior art: how others solve "review the work, then pay"

Researched Nov 5, 2026. These are the systems that matter, what they're built on, and where Milestone is weaker or
stronger than each one. Sources are listed at the end. Secondary sources are marked as such.

## 1. The systems

| System | Funds held as | Who decides "done" | If the parties disagree | Default if nobody acts |
|---|---|---|---|---|
| **Upwork** fixed-price | Captured into Upwork escrow before work starts | The client approves | Upwork mediation, then paid arbitration (secondary sources disagree on the details) | **Auto-release to the freelancer 14 days after submission**; resubmitting restarts the clock |
| **Escrow.com** milestones | Full amount wired or captured up front, held by a licensed escrow agent | The buyer, within an inspection period of 1–30 days set by the parties | Escrow.com's dispute process | Inspection period ends, then release (24 h notice first) |
| **Algora / Opire** (GitHub bounties) | Prepaid by the sponsor (Stripe Connect for Algora) | A **maintainer merges the PR** (`/claim #issue` in the PR body links it) | Little formal process: the maintainer is the judge | Nothing; unmerged means unpaid |
| **SmartInvoice** (RaidGuild) | Smart-contract escrow, per milestone | The client releases each milestone | **Either party can "lock"** the escrow; a neutral arbitrator chosen at creation (Kleros, LexDAO) rules and splits the funds | A **safety-valve date**: after it, the client can withdraw what's left |
| **Kleros** | Smart contract | Parties | Randomly drawn, staked jurors vote (Schelling-point incentives; minority voters lose stake); paid appeals | n/a |
| **ERC-8183** (draft, Feb 2026) / **Virtuals ACP** | On-chain job escrow | **One evaluator, fixed at job creation** (client, a contract or a third-party agent); ACP pays evaluators a fee | None in the core spec; reject or expire is final. Hooks (before/after each action) add policy such as KYC or bidding | **`claimRefund` after `expiredAt`, callable by anyone and not hookable** |
| **AAA-ICDR AI Arbitrator** (Nov 2025) | n/a | An AI drafts the award for documents-only construction cases | **Both parties opt in; a human arbitrator reviews and signs** | n/a |
| **RAILS** (arXiv 2606.08790, 2026) | Escrow is downstream of clearing | A "verification mesh" produces a clearing decision | Not covered in the abstract | Evidence below an obligation's "admissibility floor" can't settle; **an LLM judge alone doesn't count** |
| **Google AP2** | Normal card and wallet rails | n/a (purchase, not work) | Network disputes | Signed Intent, Cart and Payment mandates (verifiable credentials) give a non-repudiable chain of who authorized what |
| **Stripe Connect** "separate charges and transfers" | Captured to the platform, transferred to a connected (KYC'd) account later | The platform | The platform | The platform's rules |

## 2. Where Milestone is already ahead

Credit where it's due. These hold up against everything above:
- **Proof is mostly deterministic.** Tested criteria never depend on a model, which is what RAILS argues for
  ("LLM-as-judge alone is not clearing"). ERC-8183 and ACP leave the evaluator undefined, and in practice it's
  an LLM agent.
- **The contract is fixed before work and hashed.** Upwork and Escrow.com milestones are free text. Algora
  has no criteria at all beyond "the maintainer merged it".
- **"Tests that bite."** Nobody else checks that the acceptance tests fail on an empty stub.
- **Prompt-injection and CI-tamper defence.** No other system treats the deliverable as hostile input to the
  judge.
- **Money moves only through deterministic code, with idempotency keys and an audit row.** This matches the
  better smart-contract designs, without the chain.

## 3. Where Milestone is weaker, ranked

### 3.1 No neutral party at the end of the ladder (most serious)
Every mature system ends a disagreement with someone **who isn't one of the parties**: Upwork's mediators,
SmartInvoice's arbitrator chosen at creation, Kleros jurors, an AAA human who signs the AI's draft award.
In Milestone, **HUMAN_CHECK means the client decides.** The client is the party who benefits from saying no.
The deadlines (release at 72 h, or 3 days before the hold expires) soften this, but:
- the **worker can't escalate.** SmartInvoice lets *either* side lock. Our worker can only resubmit;
- after tampering or injection, the deadline **voids to the client** with no one hearing the worker's side.
  A false positive from the English-only injection scan costs the worker the whole milestone;
- "Ask for changes" after an objection needs only a reason. Nobody checks the reason.

**Fix, roadmap-sized:** name a resolver in the signed terms (the platform, or an AAA-style "AI draft + human
signs"), let either side lock, and send the evidence that already exists (terms, diff, CI runs, both reviews,
the audit log) as a dispute pack. The dispute evidence pack is already on the cut list. This is why it
matters.

### 3.2 The rules that decide aren't in the signed contract
ERC-8183 fixes the evaluator when the job is created, and the parties can see it. Our fingerprint covers
the criteria, the tests, `platformFeeBps` and `objectionWindowSeconds` (`src/lib/contract/terms.ts:46`). It
does **not** cover:
- `CONFIDENCE_FLOOR`;
- the decision policy (`policy.ts`) and the HUMAN_CHECK timeout rules;
- which model reviews, and which one does the second review;
- the verifier version.

So the platform can change what "passed" means after both sides have signed. **Fix (small):** add
`policyVersion`, `confidenceFloor`, the verifier id and version, and the model list to `policySchema`, which
the server already writes at signing.

### 3.3 Self-reported model confidence is the gate
`confidence < 0.8 → HUMAN_CHECK` trusts a number the model writes about itself. The 2026 LLM-judge studies
found the two failures that make this unsafe:
- judges can be highly **reliable without being valid**: test-retest above 0.95, with position bias above
  0.10;
- judges are **sensitive to prompt bias** even when the code doesn't change.

Free models are worse calibrated still. Proof Bench (12 PRs) is a good start, but it's too small to set a
threshold from. **Fix:** gate on agreement, not stated confidence. For example, two different models must
agree on each criterion the AI judges, or the same model must agree with itself across two orderings of the
criteria. That costs one more AI call per review, within the 1–2 call budget. Or keep the floor but label
it "model-reported", and report how often the AI agreed with the tests on tested criteria as a measure of
the judge's accuracy.

### 3.4 A hold isn't escrow, and it runs out
Upwork, Escrow.com, Algora and Stripe Connect all **capture first** and hold the captured funds. Milestone
holds an **authorization**:
- it is honored for 3 days and valid for 29;
- a capture after day 3 can decline;
- reauthorizing doesn't extend it (verified).

Work longer than about 26 days can't be one milestone, and a worker can do the work and still find nothing
to capture. The README states this honestly. A judge from payments will still see it as the biggest
structural difference. **Production path:** capture at funding into the platform balance (or PayPal
Commerce Platform with delayed disbursement), refund on void. That needs custody and money-transmitter
compliance, which is exactly what Escrow.com is licensed for.

### 3.5 Nothing happens unless something calls `/api/tick`
ERC-8183 makes expiry refunds **callable by anyone**. Escrow.com and Upwork run their own clocks and **notify
both sides** before releasing. Milestone advances only when a page or the pinger calls `/api/tick`, on a
host that sleeps. There's also **no email or other notification**: nothing in `src` sends mail. So:
- the worker isn't told when work passes, an objection arrives or a deadline nears;
- the client isn't told before the auto-release.

**Fix:** set up the pinger (already an open action). Add one notification channel (email on state change)
to the roadmap.

### 3.6 All-or-nothing payment
SmartInvoice arbitrators split the funds. Upwork does partial refunds. Algora splits bounties between
contributors. Milestone pays 100% or 0%, and nice-to-haves never affect money. That pushes every partial
delivery into a dispute. **Fix (roadmap):** a weight per criterion in the terms, and a split capture plus a
void of the rest. A PayPal partial capture with `final_capture: true` releases the remainder.

### 3.7 One assigned worker per milestone
Algora and Opire bounties are **open**: anyone `/claim`s, and the first accepted PR wins. ACP has a
request-and-negotiation phase. In the "agent takes a bounty" story, Milestone still needs the client to
hand a worker link to a specific agent. For agentic commerce, that's the weakest part of the story. **Fix
(roadmap):** an open-bounty mode where the first PR that passes, citing the fingerprint, is paid, and later
claimants get "already paid".

### 3.8 No identity, KYC, tax or reputation
- Upwork, Algora (through Stripe Connect tax forms) and Escrow.com all verify identity.
- ERC-8183 emits a `reason` hash on completion so reputation registries (ERC-8004) can use it. ACP ranks
  agents.
- Milestone uses bearer links and pays out to an email address.

That's acceptable for a sandbox. Two cheap moves still help the agentic story:
- a **signed verdict receipt** per milestone (hash of terms + head SHA + decision + reasons), published next
  to `/api/contracts/<fingerprint>`, so a worker or agent can carry proof of past paid work;
- naming PayPal Commerce Platform onboarding as the KYC and tax path (the README already does, for
  Multiparty).

### 3.9 CI can still be faked through the workflow file (known)
Algora avoids this by making a human merge the only trigger. We list it as a residual risk: under
`pull_request`, the YAML comes from the PR. A GitHub App that runs the jobs, or org-level required
workflows, closes it. Leave it as stated.

## 4. What to do with this before Nov 6 (feature freeze is tomorrow)

Small enough to ship now:
1. **3.2**: put the policy version, confidence floor and model ids into the signed `policy`. It's a schema
   field, and old contracts keep their hash because the field is optional.
2. **3.8**: signed verdict receipts at a public URL. They reuse the contract-hash plumbing.

Roadmap slide and README "Limits", with these systems named as prior art:
- neutral resolver and worker-side lock (3.1);
- agreement-based gating (3.3);
- capture-first custody (3.4);
- notifications (3.5);
- weighted partial release (3.6);
- open bounties (3.7).

Naming Upwork's 14-day auto-release, SmartInvoice's lock and arbitrator, and ERC-8183's evaluator in the
Devpost text shows judges we know the field, and that our difference is deliberate: **an evaluator whose
proof is mostly tests rather than opinion.**

## Sources
- Upwork 14-day auto-release and disputes (secondary: community forum, guides): https://community.upwork.com/t5/Freelancers/Waiting-for-payment/m-p/580606 · https://www.jobbers.io/freelancer-payment-security-guide-which-platforms-protect-you-if-a-client-disputes/ · https://aiproposer.com/guides/upwork-strategy/upwork-dispute-resolution
- Escrow.com inspection period and milestones: https://escrow.com/inspection-period · https://www.escrow.com/support/faqs/milestone-transactions
- Algora `/claim` workflow: https://console.algora.io/start · Opire (secondary): https://dev.to/farkharoumy/how-to-use-opire-to-find-unclaimed-github-bounties-with-real-data-from-30-live-bounties-2dj5
- SmartInvoice lock and arbitration: https://smart-invoice-docs-mu.vercel.app/tutorials/client/lock-milestone-and-request-arbitration · https://handbook-jm7sa7sak-raidguild.vercel.app/docs/raids/escrow/how-does-it-work
- Kleros: https://typefully.com/Kleros_io/a-smarter-solution-for-freelancers-zPanoKX · https://nethermind.notion.site/Kleros-eb9ccb5eeff145d9a8bbe93f0fe9ccaa
- ERC-8183: https://eips.ethereum.org/EIPS/eip-8183 · https://ethereum-magicians.org/t/erc-8183-agentic-commerce/27902
- Virtuals ACP (secondary): https://forkast.news/the-machine-as-buyer-virtuals-acp-and-the-evaluator-problem/
- AAA-ICDR AI Arbitrator: https://www.adr.org/press-releases/aaa-icdr-ai-arbitrator-now-available/ · https://www.akingump.com/en/insights/alerts/international-arbitration-ai-arbitrator-launched-by-the-aaa-icdr
- RAILS: https://arxiv.org/abs/2606.08790
- LLM-judge reliability: https://arxiv.org/pdf/2606.19544 · https://arxiv.org/abs/2604.16790 · https://arxiv.org/abs/2603.24586
- Google AP2 (secondary): https://www.spark.money/research/google-ap2-agent-payment-protocol
- Stripe Connect separate charges and transfers: https://docs.stripe.com/connect/marketplace/tasks/accept-payment/separate-charges-and-transfers
