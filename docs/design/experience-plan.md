# Experience plan: "Follow the money"

Status: plan only, nothing built yet (Nov 7, 2026). The deadline is Nov 12, 12:00 PM PST. The video has to be
recorded on the finished UI, so the build has to land by **Nov 10**. This plan amends one rule in
`DESIGN.md` (see section 1), which needs the user's OK.

References this draws on: bZx by Zajno (one mechanism carried through the whole page, SVG + in-view
triggers), Bartosz Ciechanowski (the reader changes the input and the diagram reacts), Stripe checkout
(motion explains state and can be removed without breaking the flow), The Pudding (a guided walk, then free
exploration), GitHub's globe (real data drives the animation, and a static SVG shows first), Cloudflare
Radar (the trap of looking credible through density), and Stripe's annual letter (scale through comparison).

---

## 0. The idea in one line

**The visitor follows one $25.00 payment from a client's card to a worker's PayPal, tries to cheat it on
the way, fails, and finishes holding a receipt they can verify themselves.**

Every animation in the product is that payment moving, a condition being proven, or an attack being
stopped. Nothing moves for decoration. That is how the motion stays informative, not childish, and how a
lot of motion still reads as one calm system.

## 1. The DESIGN.md change (needs your OK)

Replace *"Motion: one moment per page; everything else is instant"* with:

> **Motion follows the money.** Motion is allowed only when it shows where the money is, what was
> proven, or what an attack did. No scroll-reveal fades, hover lifts, parallax, count-ups or looping
> decoration. Each motion is removable without losing information (the end state is always rendered
> first). Reduced motion keeps colour, opacity and order, and drops travel.

Everything else in DESIGN.md (Clear ledger tokens, Geist, the seal, money colours, one shadow per screen)
stays as it is. This is a refinement of the existing look, not a redesign.

## 2. The journey: six acts, intriguing to satisfying

The emotional arc: **curiosity → "oh, that's how" → "but can't someone cheat?" → "they thought of
that" → "let me try it" → "it worked, and I can check it".**

| Act | Feeling | Where | What the visitor does | The motion |
|---|---|---|---|---|
| 1. The cheque | Curiosity | `/` first viewport | Flips **Honest / Cheating worker** on the cheque | Conditions tick or fail, the stamp lands: "Cleared · $23.75 paid" or "Held · $25.00 stays on PayPal" |
| 2. Follow the money | "Oh, that's how" | `/` pinned section | Scrolls, or drags the chip along the rail | The $25.00 chip travels card → hold → tests → seal → worker. Each stop names the PayPal call and the code file |
| 3. Try to break it | "But can't someone cheat?" | `/` then `/defenses` | Picks an attack from 12 real ones | The attack runs into its defense; the defense names its source and its file |
| 4. How deep it goes | "They thought of that" | `/` "Anatomy" band | Hovers or taps a number | Real counts from the code, each one opening its proof |
| 5. Do it live | "Let me try it" | `/demo` | Runs the honest or the cheating worker | Live money rail; real PayPal and GitHub ids land as stamps as they arrive |
| 6. The receipt | Satisfaction | end of the live run, `/proof/[id]` | Presses **Verify it yourself** | The proof chain checks link by link in the browser and turns green; **Tamper** breaks it at the exact link changed |

The landing page is acts 1 to 4, and every act ends with a door into the next. `/demo` is act 5, and the
receipt is act 6. A judge with one minute gets act 1, plus act 2 if they scroll once. A judge with three
minutes reaches the receipt.

### Act 1: the cheque (the hook)
- Keep the current cheque (`src/app/PayOnProofCheque.tsx`) and its real run data from milestone-demo PR #1.
- Add a two-way switch above the conditions: **Honest worker / Cheating worker**. It uses
  `role="radiogroup"` and arrow keys.
- **Honest:** the four conditions tick in order, 140 ms apart. The seal inks in and the green stamp lands.
- **Cheating** (the real PR #2 run):
  - two CI conditions fail;
  - a fifth line slides into view: the injected PR text, quoted in mono and struck through, labelled
    "Aimed at the AI reviewer. Ignored.";
  - the amber stamp lands: "Held · $25.00 stays on PayPal".
- A small **Replay** control.
- This is the first-viewport moment. It autoplays the honest run once, then waits for the visitor. Total
  under 1.4 s.

### Act 2: follow the money (the mechanism, scrollytelling)
- One pinned panel replaces the static "How a milestone works" grid. Its spine is the `MoneyRail` already
  in `src/app/demo/LiveRun.tsx`, made into a shared component.
- Five stops: **Agree, Fund, Deliver, Verify, Release**. At each stop the panel shows three things:
  1. what happens, in one sentence (the existing STEPS copy);
  2. **the call**: the actual PayPal or GitHub operation, e.g. `POST /v2/checkout/orders/{id}/authorize`
     and the `PayPal-Request-Id` it carries;
  3. **the guard**: the file that enforces it, e.g. `src/lib/money/flow.ts`, linked to GitHub.
- The visitor can scroll through it (scroll-driven, via `IntersectionObserver` steps, not scroll-jacking),
  drag the chip, or use the step buttons. On phones it's a horizontal swipe carousel with snap points.
- The seal draws itself at Agree, then stays on the rail as the payment travels: one object throughout,
  the bZx lesson.
- A red line under the rail reads "The AI can't reach this line", and the AI's box sits visibly on the
  other side of it. This makes money rule 1 visible.

### Act 3: try to break it (the depth, part one)
- A landing band with 6 attack cards, linking to a new `/defenses` page with all 12 rows from the
  README threat model.
- Each attack is a small, deterministic replay, not a video:

| Attack | What the visitor sees |
|---|---|
| Prompt injection | The PR text is scanned; the injected line lights up; the zero-width characters are revealed as visible boxes |
| Fake code that passes the tests | **Run the fake**: the real `toRoman` fake and its tests run in the browser. It passes the first draft and fails the hardened tests |
| Swapped tests | The PR's test file is overwritten with the signed one, and the fingerprint hashes are compared |
| Early `process.exit(0)` | The harness ignores the exit code; the sentinel test is missing, so the run fails |
| Double capture | Two capture clicks send one `PayPal-Request-Id`; the second returns the first's result |
| Spoofed webhook | The signature check fails and the event is dropped |

- Every card carries three lines: **Attack**, **Defense** (with its file), and **Source** (the outside
  practice it follows, e.g. OWASP Top 10 for LLM Apps (LLM01 prompt injection), PayPal's idempotency and
  webhook-verification docs, mutation testing, Sigstore and Rekor for signed CI results, Certificate
  Transparency's hash-chained logs for the proof chain).
- Every source link is checked by hand before it ships. None is invented.
- The **Residual risk** column stays visible on `/defenses`. Saying where it can still fail is what makes
  the rest believable (the Bench already does this well).

### Act 4: how deep it goes (scale without invented numbers)
- PRODUCT.md forbids invented usage numbers, so "scale" here means the scope of the engineering, counted
  from the code by a build script, never typed by hand.
- `scripts/scale-facts.mts` writes `src/generated/scale.json` at build time. It counts:
  - PayPal operations used (orders, authorize, capture, void, reauthorize, payouts, refunds, disputes,
    webhooks verified);
  - milestone states and allowed transitions (from `states.ts` and the flow);
  - attacks defended (threat-model rows);
  - automated tests in the repo;
  - real paid runs, from the public PRs;
  - proof events signed (the live count from the API, falling back to the build count).
- The band shows 5 or 6 figures in large tabular type. They render at their final value; no count-up.
  Tapping one expands the list behind it (e.g. "9 PayPal operations" opens the 9, each with its endpoint).
  Density comes only on request, the Cloudflare lesson.
- Below it, a **live ledger strip**: the last real sandbox runs from `/ledger`, each row with its PayPal
  order id and PR link, newest first. A new row slides in when one arrives. This is the GitHub-globe
  lesson (real data, actually moving) at our honest size.

### Act 5: do it live (`/demo`)
- `LiveRun` already exists and works. The upgrade:
  - the shared money rail is bigger and moves on a transform (it animates `left` and `width` today);
  - each real id (order, authorization, check run, capture, payout batch) lands as a small stamped chip
    on the rail stop it belongs to;
  - the CI step shows each criterion's check flipping as GitHub reports it;
  - the waiting time is honest and filled with something real: while CI runs, a panel shows the signed
    test that's running and links to the live job;
  - the cheating run ends with the injected line quoted, and the money chip visibly stays on the hold.
- Ends with a door to act 6: **Your receipt →**.

### Act 6: the receipt (the satisfying end)
- A receipt view at the end of the live run, also reachable at `/proof/[id]`. It is cheque-shaped and
  uses the same seal. It lists:
  - every step with its time and id;
  - the fee split (the existing `MoneyPanel` receipt);
  - one primary button: **Verify it yourself**.
- Verifying runs the existing WebCrypto check (`src/lib/proof/verify.ts`), now visible: each link of the
  chain draws a hairline to the next and turns green, 60 ms apart, ending in the seal inking and
  "Verified in your browser · 0 servers trusted".
- **Tamper** flips one character, and the chain breaks red at that exact link.
- Then a quiet close: "Share this receipt" (copies the public proof URL) and "Make your own milestone".

## 3. The other surfaces

These pages are where people do things, so motion here is feedback, not story. Everything here is under
300 ms.

| Surface | Changes |
|---|---|
| Deal room `/milestones/[id]` | When polling brings a new state: the tracker segment fills along its line (250 ms); the money panel's tint crossfades (held amber → paid green); the new proof-trail row slides in with a 1.5 s highlight; the next-step panel swaps with a short crossfade. A small "Updated just now · checking every 15 s" line says where the change came from |
| Terms and signing | Signing inks the seal (the stroke draws, 600 ms, the one focal moment on this page). The fingerprint characters settle left to right as the hash is computed |
| `/new` (AI draft) | The draft streams in criterion by criterion, as it arrives. The attack step shows the fake running against each test live. "AI busy" stays a calm state, not an error |
| Proof Bench `/bench` | The Pudding pattern: a short guided walk (3 cases: one caught by both, one cheat the AI-only approver paid, one Milestone got wrong), then the full table, with a filter by honest or cheat |
| Timeline (Bryntum) | Keep it; preload its chunk from the landing page once the page is idle, not only from `/demo` |
| Ledger, bounties | Row-arrival highlight only |
| Guided tour (`DemoTour`) | Each step outlines the element it talks about with a soft ring (no dark overlay, still non-modal); the panel slides between steps instead of jumping |
| Navigation | View Transitions between landing → demo → receipt, so the cheque, the rail and the seal carry across pages as the same object. A plain cut where the browser has no support |

## 4. Motion system

Implemented in `globals.css` plus a few small components. **No animation library**: CSS transitions and
keyframes, plus the Web Animations API for sequences.

**Timing tokens**

| Token | Value | Used for |
|---|---|---|
| `--t-tap` | 120 ms | press feedback, toggles |
| `--t-state` | 220 ms | state changes, crossfades |
| `--t-travel` | 480 ms | the money chip moving one stop |
| `--t-focal` | 700 ms | seal ink, stamp landing (once per page) |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | arrivals |
| `--ease-in` | `cubic-bezier(0.7, 0, 0.84, 0)` | exits, about 30% shorter than entries |
| `--stagger` | 140 ms per item, capped at 5 items | condition ticks, chain links |

**Primitives** (in `src/components/motion/`)
- `MoneyRail`: the chip, stops and stamped ids. Shared by the landing, demo, deal room and receipt.
- `Stamp`: lands with scale 1.08 → 1 and a slight rotation; no bounce.
- `InkSeal`: wraps `GuillocheSeal` and animates `stroke-dashoffset` from dashed to inked.
- `Tick`: a condition passing or failing, with its icon stroke drawn.
- `ArrivingRow`: a new row with a fading highlight background.
- `ChainVerify`: the hairline link-by-link check.

**Rules**
- Animate only `transform`, `opacity`, `stroke-dashoffset`, `clip-path` and colour.
- The final state is in the server-rendered HTML; JavaScript only animates toward it, so a script failure
  still shows the right result.
- `IntersectionObserver` starts each sequence when it enters view, at most once per visit unless replayed.
- Nothing loops. The only exception is the live "running" indicator, which stops when the tab is hidden.
- `prefers-reduced-motion` replaces the global 0.01 ms kill with a real alternative: no travel or scale;
  colour, opacity and order stay; staggers shrink to 40 ms so cause and effect stay readable.
- Every animated status keeps its `role="status"` text, so screen readers get the result, not the show.

## 5. No lag

The biggest delay in the product isn't animation, it's the **Render free tier waking up (up to about a
minute)**. A judge who meets that first won't see any of the rest.

| Priority | Fix |
|---|---|
| P0 | Set up the keep-awake pinger (cron-job.org, every 10 min on `/api/tick`). It's free and still an open user action; this matters more than anything else in this plan |
| P0 | Acts 1 to 4 are fully static: prerendered, no database or API on first paint. `scale.json` is a build artifact. The ledger strip loads after first paint and hides itself if the server is asleep |
| P1 | `/demo` warms the server on hover or focus of **Run it live** (a cheap `GET /api/health`), and says "Waking the sandbox server…" honestly if it's slow |
| P1 | Prefetch the next act's route as soon as the current act is in view; preload the Bryntum chunk once idle |
| P1 | Optimistic UI on every button: the press state shows in under 100 ms, before the network answers |
| P2 | Budgets for landing on a mid phone: LCP < 1.8 s, INP < 100 ms, CLS < 0.02, landing JS < 90 KB gzipped. Checked with Lighthouse and Playwright on a 4× CPU throttle |

## 6. Phones (390 px)

- Act 1: the switch sits above the cheque, and the stamp sits under the amount.
- Act 2: the rail runs vertically, so the chip travels down a vertical line as the visitor scrolls. No
  horizontal pinning on phones.
- Act 3: attack cards become a swipe row with snap points and visible edges.
- Touch targets are at least 44 px. Drag surfaces set `touch-action: pan-y` so the page still scrolls.

## 7. Build order (cut lines marked)

| Day | Work | Done when |
|---|---|---|
| Nov 7–8 | Motion tokens and primitives; reduced-motion rewrite; act 1 (cheque switch, replay); shared `MoneyRail` on a transform | Act 1 works at 390 and 1280 px, in both themes, with reduced motion |
| Nov 8 | Act 2 scrollytelling; `scale-facts` script and act 4 band | Every number comes from `scale.json`; every call and file is linked |
| Nov 9 | Act 3 band plus `/defenses` (6 replays, 12 rows, sources checked); "Run the fake" in the browser | Each source link checked by hand |
| Nov 9–10 | Act 5 live-run upgrade; act 6 receipt with visible chain verification; view transitions | One honest and one cheating live run recorded end to end |
| Nov 10 | Deal-room state motion; tour spotlight; Bench guided walk | — |
| Nov 10 | Performance and accessibility pass: Lighthouse, Playwright screenshots, keyboard-only run, screen-reader labels | Budgets met |
| Nov 11 | Record the video along the six acts; submit | — |

**Cut first, in this order, if time runs short:** Bench guided walk → view transitions → tour spotlight →
`/defenses` page (keep the landing band) → deal-room motion. **Never cut:** acts 1, 2 and 6, the keep-awake
pinger, and reduced motion.

## 8. Honesty rules for this work

- No invented numbers, customers or quotes. Scale figures come from the code, and runs come from public PRs.
- A replay is labelled as a replay (the cheque, the attack replays); live is labelled live (act 5).
- The DEMO- placeholder ids stay marked as placeholders.
- Every outside source is linked and checked by hand; anything unverified stays out.

## 9. How it gets checked

- Playwright screenshots of each act at 390 × 844 and 1280 × 800, light and dark, with and without reduced
  motion.
- A full run in the in-app browser: landing → demo live run → receipt verify → tamper.
- Lighthouse against the budgets in section 5, on the live Render URL once it's deployed.
- The video script follows the six acts, so the UI and the video tell the same story.
