# Milestone: plan to win

## Status, Nov 3 (second pass)

Done since Nov 2: Run it live, agent hires agent, the AI attack before signing, the new pitch, and today:
- **AI is visible in the live run.** C4 is a nice-to-have the AI reviews live; it can't gate money, and a busy
  model falls back to the last verdict on the same commit, then to "unclear". CI streams per test; a money rail
  and the fee arithmetic are shown.
- **Proof Bench (`/bench`)**: 12 PRs, LLM-only approver vs Milestone. Milestone paid 1 of 9 cheats (a newline
  gap no test covers), the LLM-only approver paid 1 of the 8 it judged (hidden injection) and missed every attack
  quote. It exposed a real bug: the hardener could replace a check with a weaker one. Hardening now only adds.
- **Sponsor pages are never empty**: `/timeline`, `/ledger` and `/milestones` show recent live runs with real
  PayPal ids to first-time visitors (`/api/showcase`). The Gantt redraws from PayPal and review events (rework,
  void, reauthorization, dispute, payout): Bryntum's "agent-driven rescheduler" idea.
- **Keep-warm**: a GitHub Action ticks every 10 minutes and smoke-tests the judge pages daily (closes the pinger item).

Still yours: the video (outline in `docs/DEVPOST.md`), 5 user conversations (`docs/INTERVIEWS.md`), the Devpost
draft for the early check, `ALLOW_DEV_ACTIONS=0` and `RATE_LIMIT_SALT` on Render, a GitHub token valid past
Dec 21, and the APIMatic form around Nov 10. Not built: the dispute evidence pack (roadmap).

Written Nov 2, 2026. Deadline Nov 13, 1:30 AM IST. No plan can promise a win: about 14,500 people had
registered by Oct 15, and the gallery isn't public yet, so rivals were only seen through public GitHub repos.

## The verdict

The engineering is already strong. **What's missing is everything a judge sees first.** The five criteria are
equally weighted, and the rules say judges "may choose to judge based solely on the text description, images,
and video". Today there is no video, so one fifth of the score has nothing behind it.

| Criterion (equal weight) | Now (my estimate) | What holds it back |
|---|---|---|
| Technological Implementation | 8.5 | Open audit bugs; the finished demo milestones use fake `DEMO-*` PayPal ids |
| Design | 7.5 | Good UI, but a judge watches a replay, not a live run |
| Potential Impact | 6 | No named audience on the landing page, no evidence from real users |
| Innovation | 7.5 | "Escrow with AI" sounds familiar until the differentiators are shown |
| Presentation | 0 | No video |

**The position to own:** nearly everyone in the agent category is building how agents *spend* safely (Leash,
Mandate, Allowance, Agent Payment Firewall, Guardrail, AgentSafe, Agent Shield). **Milestone is how agents
*earn* safely, on PayPal.** Other agent-escrow projects found (AGIRAILS, OnlyTrust, OutcomePay) use USDC on-chain.
Closest rivals in this hackathon: ProofPay holds funds on the platform and checks uploaded evidence; GitBounty
targets bug bounties. Milestone keeps the money on a PayPal hold, and tests both sides signed decide.

## Prize targets (decided)

The rules allow one Grand **or** one Honorable Mention prize, plus one Sponsor prize.

- **Main:** Grand Prize, Best Use of Agentic Commerce, Best Use of PayPal + AI, Best Demo Delivery.
- **Sponsor: Bryntum.** Three winners, and our timeline matches their own idea list ("payment tranches marked as
  dependencies", "agent-driven rescheduler").
- **Not AG Grid.** Its $5,000 prize asks for AG Studio, custom widgets and the Studio Agent Framework, "not just AG
  Grid". We use grids only, and rebuilding isn't worth the time.

## Fix today (half a day)

1. **Push the two unpushed commits.** The live app is on `68a0cbc`, so the Oct 25 work (reissuable links, data
   retention, patched dependencies) isn't deployed.
2. **Stop publishing the worker's PayPal email.** `src/lib/contract/terms.ts:143` puts it in the public contract
   at `/api/contracts/<hash>`, and every PR links to that hash. Add contract version 2 with a salted hash of the
   email, and keep version 1 so the signed hashes of old PRs still verify.
3. **Enforce the signed objection window.** `src/lib/review/deadlines.ts:6` reads it from the environment, not
   from the signed `policy`. The product's whole promise is that the signed terms decide.
4. **Stop reauthorization moving the hold's expiry.** `src/lib/money/flow.ts:479` and `:484` return PayPal's new
   expiry, which overwrites the stored one, though PayPal doesn't extend the 29 days [VERIFIED earlier].
5. **Fix stale docs.** `docs/DEVPOST.md:121` still names `minimax/minimax-m3.1-flash:free`, which has been removed.

## Build (Nov 3–6, feature freeze Nov 6)

### 1. "Run it live" for judges (1.5 days): the biggest single upgrade
Replace the replay with two buttons on `/demo`: **Honest worker** and **Cheating worker**. One click funds a real
sandbox hold, opens a real PR on `milestone-demo` from a prepared branch, runs real CI, then captures and pays out
for real, or catches the cheat with the money held. Show each step arriving live, with its PayPal id and CI link.

- Why: today's finished milestones show `DEMO-*` ids and $0.00 PayPal fees in `/ledger`. It's disclosed honestly,
  but it's the moment a sceptical judge stops believing. Nobody else is likely to let a judge trigger real CI
  and a real payout in about 3 minutes.
- Guards: per-IP limit, one run at a time with a queue message, and no AI call in the path. Fall back to the
  labelled replay if GitHub or PayPal fails.
- Scores: Technology, Design, Best Demo Delivery.

### 2. An agent hires an agent, and the worker fails first (1 day)
`mcp/server.mts` already has `create_milestone` and `draft_terms` behind the platform key, so most of this exists.
Script the run: a buyer agent posts the job, a human approves the hold once, a worker agent submits, the signed
tests **fail and no money moves**, it reads the feedback, fixes the code, and gets paid. Money rules don't change:
neither agent gets a money tool.

- Why: PayPal's own inspiration list names "two agents negotiating and settling a payment between themselves" and
  a scheduling assistant that pays contractors when a job completes. The fail-then-fix loop is the proof.
- Scores: Best Use of Agentic Commerce, Innovation.

### 3. The schedule reacts to PayPal events (half a day)
When a webhook reports a voided hold, or a review fails, the Gantt moves or flags the affected phases by itself,
with a visible note saying why. This is Bryntum's own "agent-driven rescheduler" idea, and Mats Bryntse is a judge.

### 4. Say who it's for (half a day)
- Landing page: name the audience. Proposed: **small software teams and agencies hiring contractors or coding
  agents.** "Pay to the order of the worker" tells a judge nothing about who buys this.
- Add a short "Why PayPal" section: a client uses a payment method they already have, with no crypto wallet and no
  platform custody of the funds during the hold.
- Use evidence with its date and source: Freelancers Union 2015, average $5,968 lost to non-payment, 13% of income;
  IPSE (UK), 31% finished work and weren't paid. Don't present the old US figure as current.

### 5. Only if 1–4 are done by Nov 5: dispute evidence pack (1 day)
A dispute currently ends in a terminal `DISPUTE` state. Compile the signed terms, CI results and proof trail into
an evidence pack, with an AI summary, that a human submits through the Disputes API. It speaks directly to PayPal's
judges and completes the lifecycle. Verify the sandbox behaviour before committing to it. Otherwise it goes on the
roadmap slide.

## The video (Nov 7–9): treat it as the main deliverable

The current outline opens on the injection catch with no statement of what the product is. Judges need the anchor
first, so open with one plain sentence, then the catch.

| Time | Beat |
|---|---|
| 0:00–0:08 | "Milestone lets you hire a person or an AI agent and pay through PayPal only when tests prove the work is done." |
| 0:08–0:25 | The cheat: a PR tells the AI reviewer to pass everything. Caught, money still held |
| 0:25–0:40 | The problem and who has it, with one dated statistic and a real person's quote |
| 0:40–1:05 | Agree: the AI writes tests, a test that passes on empty code is rejected, both sides sign |
| 1:05–1:20 | Fund: a real PayPal hold with its authorization id |
| 1:20–2:05 | Agent hires agent: fails, no money moves, fixes, CI goes green, capture, payout |
| 2:05–2:25 | Proof: the ledger with idempotency keys, then the Gantt reacting to a PayPal event |
| 2:25–2:45 | "Agents will do paid work. PayPal is how they get paid safely." Same rails, wider use. Credits |

- Say "PayPal" and "AI" by name throughout, as the organisers' Oct 28 update asks.
- Cut all waiting. Zoom so text is readable at phone size. Add captions. Keep it under 2:50.
- Move the threat-model scene to the README and Devpost text; one spoken line is enough.
- Test it: show it to two people who haven't seen the project, and pause at 0:30. If they can't say what it does,
  recut the opening.

## The Devpost page

- First line names PayPal and AI. Fill in "Built With" completely.
- Add 5–6 captioned screenshots, since judges may never open the app.
- Add a short table mapping each of the five criteria to evidence. The rules allow "automated AI-driven analysis",
  so plain, explicit statements help with both people and machines.
- Put the 90-second judge guide at the top, with the live-run buttons first.

## Keep it alive through judging (Dec 1–15)

Judges may test weeks after you stop looking. A broken demo in December loses to a simpler one that works.

- [ ] The GitHub token must not expire before Dec 21. It needs a new contents-write scope on `milestone-demo` only.
- [ ] Turn off `ALLOW_DEV_ACTIONS` (`dev-pass` skips verification, which contradicts the pitch), then rerun `/demo`.
- [ ] Set `RATE_LIMIT_SALT` on Render.
- [ ] Add a free scheduled GitHub Action that runs a daily smoke test of `/demo` and `/timeline` and alerts on failure.
- [ ] Have a fallback for free models disappearing: cached drafts for sample briefs, so `/new` never dead-ends.
- [ ] Review the demo seeding limit (5 per IP per hour). My test run hit a timeout after about 5 starts, probably
  this limit, though I didn't confirm it. Judges sharing an office IP could hit it too, and the wait must explain itself.
- [ ] Look at timeline load time: one of three runs still showed the loading skeleton after 7 seconds.

Bryntum trial, tested today: in a fresh browser with the clock set to Dec 20, the live timeline rendered normally.
That was one run with a simulated date, and it doesn't cover a browser first used 45+ days earlier. Bryntum's own
prize page offers the trial, so a paid license isn't needed to compete; the Discord request is optional.

## Schedule

| Date (IST) | Work | Who |
|---|---|---|
| Nov 2 | Fixes above; start the 5 user conversations | Claude + you |
| Nov 3–4 | Run it live | Claude |
| **Nov 5** | **Submit a draft on Devpost for the free early eligibility check** (editable until the deadline) | You |
| Nov 5 | Agent hires agent | Claude |
| Nov 6 | Gantt reactions, landing page, audience. **Freeze** | Claude |
| Nov 7 | Hardening, smoke test, record the runs | Both |
| Nov 8–9 | Cut the video, test it on two people, upload to YouTube | You |
| Nov 10 | Final Devpost text and screenshots; APIMatic usage form | You |
| **Nov 11** | **Submit for real**, a day and a half early | You |

## Only you can do these

1. **Talk to 5 real people** who hire contractors or freelance (15 minutes each). Get two quotes you can use, with
   permission. Better still, have one outsider run a real sandbox deal. This is the biggest available gain on
   Impact, and almost no rival will have it. Quote only what they actually said.
2. Submit the draft by Nov 5.
3. Create the new fine-grained GitHub token and paste it on Render.
4. Record your voice for the video. A real founder's voice usually beats a synthetic one here.
5. Submit the APIMatic usage form around Nov 10.

## Not doing

AG Studio, Kernel, Elastic, Zapier, Channel3, new currencies, paid models, a visual redesign, and any
further audit rounds beyond the fixes above.
