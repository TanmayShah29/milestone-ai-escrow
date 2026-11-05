
---

## #35 — Bryntum Gantt constraints

Research-only (no live Bryntum run). Files: `src/app/timeline/*`, `src/lib/timeline.ts`, `src/lib/schedule.ts`, `src/app/api/milestones/[id]/[action]/route.ts`, `package.json`, `README.md`, `docs/*`, `tests/timeline.test.ts`, `tests/holds.test.ts`.

### F1 — MEDIUM (CONFIRMED) — Trial package contradicts “no watermark” claim
- `package.json:15` aliases `@bryntum/gantt` → `npm:@bryntum/gantt-trial@^7.3.7`.
- `README.md:218` says trial with watermark; `docs/MILESTONE_PLAN.md:33` says trial with watermark.
- `docs/DEVPOST.md:156` says “Bryntum license applied, so no watermark in the timeline shot.”
Trial bundle has a 45-day `isExpired` check and watermark. Use a fresh profile for demo; the license must actually be applied or the Devpost line changed.

### F2 — MEDIUM/SUSPECTED — Reauthorization can move/null the stored hold expiry, shifting the cap
- `flow.ts:479,484,488` overwrite `authorization_expires_at` with `a.expirationTime ?? null`.
- `timeline.ts:89-93` uses it for `latestDueAt`; `null` falls back to `max(created_at, now) + 26 days`.
PayPal does **not** extend the 29-day validity on reauth. If PayPal returns a later/missing `expiration_time`, the cap can move or overestimate. Not verified in sandbox.

### F3 — MEDIUM (CONFIRMED) — 3-day margin hard-coded; objection window configurable with no matching cap
- `timeline.ts:78` `DUE_MARGIN_DAYS = 3`; `timeline.ts:69-72` reads `OBJECTION_WINDOW_SECONDS`; `deadlines.ts:5-8`; `terms.ts:48` allows `.min(0)`.
A 72-hour objection window + 3-day margin fits (work ≤ expiry−3, review+1, objection+3), but a 48-hour window can land capture at/after expiry. The signed policy is not used for this calculation.

### F4 — MEDIUM/LOW (CONFIRMED) — No warning when due is between cap−margin and expiry
- `timeline.ts:101-105` warns only when `due > authorization_expires_at`.
- `timeline.ts:186-189` adds `finishnolaterthan` only when `workEnd <= limit`; past-cap rows get no constraint.
Dates in that band are allowed with no margin warning.

### F5 — MEDIUM/LOW (CONFIRMED) — Downstream bars unconstrained past the hold expiry
- `timeline.ts:131-135` builds Work/Review/Window/Payout; only Work gets `finishnolaterthan` (`:188-203`).
With large objection windows, Window/Payout can end after expiry (display/risk issue).

### F6 — LOW (CONFIRMED) — Honor period stale after reauthorization
- `timeline.ts:115` uses first `hold:authorized`; `:179` sets `honorEnd = held + 3 days`; `flow.ts:489` emits `hold:reauthorized` but the Gantt never reads it.

### F7 — LOW (CONFIRMED) — Rework hides interval; first submission shown
- `timeline.ts:109,116,131-132` use `find` for first submission; Review extends across rework.

### F8 — LOW (CONFIRMED) — `setDueDate` update + audit non-atomic
- `schedule.ts:20-22` calls `updateFields` then `audit` separately; `repo.ts:157-163` autocommits; `db.ts:44-53` serializes but no rollback on audit failure.

### F9 — LOW (CONFIRMED) — `?m` can be ignored on `/timeline` due to role-switch ordering
- `timeline/page.tsx:35-40`; `client/links.ts:35-37,57-59,99` stores unknown tokens in `pending` but `heldLinks()` ignores them and the page doesn’t use `linkFor()`.

### F10 — LOW (CONFIRMED) — Load/save errors can leave stale UI
- `timeline/page.tsx:41-48,61,78` use `Promise.all`/calls with no `catch`; a failed redraw can leave a bar at the moved position.

### F11 — LOW (CONFIRMED) — Validation/display gaps
- `schedule.ts:13` rejects only dates >60 s in the past, not `due >= holdStart`; `timeline.ts:131` can display `workEnd != due_at`.
- UTC cap formatting vs local tooltips (`timeline.ts:82`, `GanttView.tsx:189,226`).
- `api/milestones/[id]/timeline/route.ts:15` reads all audit rows; parallel fetch of up to 50 milestones.

### F12 — INFO (CONFIRMED) — “Bryntum engine” tests don’t exercise Bryntum
- `tests/holds.test.ts:55`, `tests/timeline.test.ts` test pure helpers only; no browser/Playwright drag/refusal test.

### F13 — Adjacent (CONFIRMED) — Signed objection window not runtime source of truth
- `terms.ts:136-150,154-158` includes policy in the hash (from env at sign time); `run.ts:113` and `timeline.ts:69-72` read env at runtime. Can diverge.

**Safe design:** Gantt has no money/state actions (only `POST /api/milestones/:id/schedule`), client-only role (`[action]/route.ts:30`), server enforces `canMoveDueDate` + `latestDueAt` under advisory lock (`schedule.ts:15-23`), `due_at` not in the signed hash, editing heavily restricted (`GanttView.tsx:167-194`), bad drags cancelled (`:125-129`), cross-milestone links inactive.

**VERDICT: Partially correct and demo-safe, but not submission-ready** — apply/verify a real Bryntum license or fix `docs/DEVPOST.md:156`; fix reauth expiry handling (preserve original expiry/clamp); make the cap use the full review+objection+capture margin and warn correctly; read `hold:reauthorized`; make `setDueDate` + audit atomic; add a refusal/drag E2E test.

---

## #36 — Conformance to plan (docs vs code)

Research-only. Read `docs/MILESTONE_PLAN.md` fully, `README.md`, `PRODUCT.md`, `DESIGN.md`, `docs/DEVPOST.md`, compared to `src/lib/milestones/states.ts`, `src/lib/money/flow.ts`, `src/app/api/**`, `src/lib/review/**`.

### States & transitions
- **MATCH (mostly):** 14 states match `states.ts:3-18`; terminal set matches (`PAYOUT_FAILED`, `DISPUTE`, `CANCELLED`).
- **MISMATCH — undocumented/allowed transitions:** `dev-pass` forces `SUBMITTED/IN_REVIEW/HUMAN_CHECK/CONTESTED → PASSED` (`src/app/api/milestones/[id]/[action]/route.ts:93-96`) when `ALLOW_DEV_ACTIONS=1`. Not in the documented transition set. `release` is allowed for client from `PASSED` and ignores `release_after` (`flow.ts:335-338`) — documented as auto-release after objection/window but explicit release exists.
- **MISMATCH — enforcement location:** The plan states deadlines are enforced; HUMAN_CHECK deadlines are computed (`deadlines.ts:26-33`) and enforced by tick/review, but the signed objection window is read from env at runtime (`run.ts:113`, `deadlines.ts:5-8`) not from `terms.policy` — documented as part of the signed contract (`terms.ts:154-159`).

### API map
- **MATCH:** core routes exist (`/api/milestones`, `/:id/*`, `/api/paypal/*`, `/api/tick`, `/api/contracts/[hash]`, `/api/demo`).
- **MISMATCH — role map:** `dev-pass` maps to `["client"]` only (`[action]/route.ts:31`); `fund-card` allowed for client with no `devActionsAllowed()` check (`:26,97-98`).
- **MISMATCH — auth model:** docs describe links/tokens; platform key resolves to `"client"` (`src/lib/auth.ts:51`) — not stated in the plan.
- **MISMATCH — missing routes/endpoints:** no documented route for `/api/milestones/:id/timeline` (`src/app/api/milestones/[id]/timeline/route.ts`) in the plan text; MCP server exists (`mcp/server.mts`) but not in the API map.

### Money rules / deadlines
- **MATCH:** Min $10, USD, decimal strings to PayPal, integer cents in DB, capture ≤ authorized, payout = captured − platform fee, every money-moving POST has `PayPal-Request-Id`, webhooks verified, audit log exists.
- **MISMATCH — 29-day cap:** Reauthorize overwrites `authorization_expires_at` (`flow.ts:467-493`), causing `latestDueAt()` and HUMAN_CHECK/lapsed logic to extend the cap (see #34 F1). Plan states “Reauthorize: once, days 4–29, no extension [VERIFIED]”.
- **MISMATCH — fees:** Platform fee can come from signed `policy.platformFeeBps` or env fallback for legacy contracts (`amounts.ts:56-66`, `flow.ts:326`) — documented as signed policy but fallback not emphasized.
- **MISMATCH — refunds:** Plan states refunds “not implemented (cut)” (`docs/MILESTONE_PLAN.md:147`); code has no refund implementation — matches the cut, but listed as missing capability.
- **MISMATCH — multiparty:** Plan says multiparty NO-GO in sandbox (`docs/MULTIPARTY.md`); code uses hold→capture→payout.

### Demo script / claims
- **MATCH:** `/demo` seeds a project, judge flow exists, test card funding works.
- **MISMATCH — timing:** Plan says “live demo uses two minutes” for objection window; `deadlines.ts:5-8` defaults to 120 s if unset. If `OBJECTION_WINDOW_SECONDS` is missing in prod this is true by default but depends on env.
- **MISMATCH — dev actions:** README states “Leave it unset in production” for `ALLOW_DEV_ACTIONS`; plan/runbook recorded `ALLOW_DEV_ACTIONS=1` on Render (#29 F1). 

### README / setup
- **MISMATCH — startup:** README:229 and `CLAUDE.md:74` say migrations run at startup; `package.json:8` is `next start`, no `render.yaml`/`prestart`/`instrumentation.ts` found (#32 F5).
- **MISMATCH — env:** `.env.example` missing `AI_DAILY_CAP`; `OBJECTION_WINDOW_SECONDS` not listed; `ALLOW_DEV_ACTIONS` present but production guidance conflicts. 
- **MISMATCH — commands:** README references `npm run db:migrate` but startup auto-migration not wired from the repo.

### DEVPOST claims
- **POTENTIAL OVERCLAIM:** “Bryntum license applied, so no watermark in the timeline shot” (`docs/DEVPOST.md:156`) contradicts trial package (#35 F1).
- **MATCH:** APIMatic Context Plugin mentioned as used; PayPal APIs, OpenRouter, Render listed.
- **MATCH:** Demo repo and live app referenced.

### Top 5 mismatches
1. **29-day cap vs reauth** — reauthorize overwrites `authorization_expires_at` (code) vs “no extension” (docs). CRITICAL for the money/timeline guarantee.
2. **Signed policy not enforced at runtime** — objection window and some fees can differ from signed terms (env vs stored policy).
3. **Dev bypass in prod config** — `ALLOW_DEV_ACTIONS` present/enabled historically, `dev-pass` allows skipping verification.
4. **Migration startup** — docs claim auto-migrate; repo/start command don’t show it.
5. **Bryntum license/watermark** — trial used vs “no watermark” claim.

**VERDICT: Partially** — the core flow and money rules match the plan, but timing/contract enforcement (reauth cap, env vs signed policy) and operational/config claims (startup migrations, dev flag, Bryntum license) do not conform.

---

## #37 — PII, data retention, deletion

Research-only. Files: `src/lib/contract/terms.ts`, `src/app/api/contracts/[hash]/route.ts`, `src/lib/money/webhooks.ts`, `db/migrations/*`, `src/lib/auth.ts`, `src/lib/client/links.ts`, `src/app/milestones/*`, `src/app/timeline/*`, `src/app/api/milestones/*`, `mcp/server.mts`, `src/lib/review/*`, `src/lib/ratelimit.ts`, `src/lib/demo.ts`, `src/app/api/demo/route.ts`, `src/lib/http.ts`, `src/app/api/paypal/webhook/route.ts`, `scripts/seed-demo.ts`, `scripts/create-platform.ts`, `README.md`, `PayPal_Sandbox_Guide.md`, `.env.example`, `next.config.ts`.

### PII map
- **Milestones:** `client_email`, `freelancer_email`, `title`, `brief`, `pr_url`, `criteria` (includes test code), `deliverable_text`, `objection_reason`, `changes_reason` (`001_init.sql:5-33`).
- **Tokens:** SHA-256 hashes stored (`003_auth.sql:4-14`); raw tokens never stored/returned after creation (`auth.ts:15-26`).
- **Reviews/webhooks/AI:** `reviews.verdict` JSON, `webhook_events.payload` full JSON (`002_webhook_events.sql:9`), `ai_calls.error` (500 chars, `004_contract_and_ai.sql:17-26`).
- **Other:** IPs hashed with optional salt (`ratelimit.ts:24-34`), GitHub usernames/repo names.

### F1 — CRITICAL (CONFIRMED) — Public contract endpoint leaks worker PayPal email
- `terms.ts:143` `workerPayPalEmail: m.freelancer_email` included in `contractDocument`.
- `app/api/contracts/[hash]/route.ts:8-13` unauthenticated; `terms.ts:455-460` returns `{ hash, document: canonical(...) }` only if `termsAgreed`.
- PRs publish `Milestone-Terms: <hash>` (`mcp/server.mts:66`, `verifiers.ts:33-44`); CI fetches it.
**Impact:** Anyone reading a public PR can fetch the worker’s PayPal email, repo, amount, and full terms. Email is hash-bound, so redaction/deletion would break verification.

### F2 — HIGH (CONFIRMED) — Raw PayPal webhook payloads archived forever
- `webhooks.ts:66-70` inserts `JSON.stringify(e)` into `webhook_events` before matching; schema `002_webhook_events.sql:9` `payload jsonb not null`.
- Unmatched/dispute events stored (`:78-82,132-136`). No purge.
**Impact:** Likely contains payer email/name/address; indefinite retention of third-party PII.

### F3 — HIGH (CONFIRMED) — No deletion/retention policy or erasure path
- No `DELETE` routes. Only `rate_events` pruned opportunistically at 5% (`ratelimit.ts:62-65`). `demo.ts:62` only clears a demo’s audit rows.
- `milestones`, `webhook_events`, `audit_log`, `ai_calls`, `reviews`, `money_actions` persist indefinitely.
- README only mentions holds expiring; no GDPR/CCPA path.

### F4 — HIGH (CONFIRMED) — Permanent bearer capability links
- Tokens never expire/rotate/revoked (`auth.ts:15-26`). Stored up to 50 in `localStorage` (`client/links.ts:12,89`). Stripped from URL after load (`milestones/[id]/page.tsx:113-114`) but first request carries them. `Referrer-Policy: no-referrer` set; CSP lacks protections. XSS would exfiltrate them.
- MCP returns raw `workerLink`/`clientLink` (`mcp/server.mts:200`); platform key in env.
- Timeline share links use `?m=<id>.<token>` (`timeline/page.tsx:34-38`).

### F5 — HIGH (CONFIRMED) — Broad PII in API responses
- `publicMilestone()` strips token hashes but returns emails, brief, PayPal ids, criteria/test code, reasons (`auth.ts:69-74`).
- `GET /api/milestones` returns up to 100 rows via `publicMilestone` (`api/milestones/route.ts:18-19`).
- `client_email` accepted from any caller (`route.ts:55,60-61`) but not used by UI (dead PII).

### F6 — HIGH (CONFIRMED) — Third-party/AI data exposure
- Review sends PR title/body and up to 60k chars of diff to OpenRouter (`verifiers.ts:229-234`).
- `injection.quotes[0]` and feedback stored in `reviews.verdict`; review posts a PR comment with reasons/evidence (`run.ts:27-32,116-135`).
- AI evidence URLs rendered clickable (`VerdictTable.tsx:27,31`).
- Provider retention/DPA not documented.

### F7 — MEDIUM (CONFIRMED/SUSPECTED) — IP hashing & logs
- `ipKey` falls back to unsalted SHA-256 if `RATE_LIMIT_SALT` unset (`ratelimit.ts:24-34`); comment says guessable. CLAUDE.md lists setting it as open; production state unknown.
- `/api/tick` leaks `String(err).slice(0,200)` (`run.ts:349-350,364-365`, `api/tick/route.ts:19-20`) — can include repo paths.
- `console.warn` logs repo paths (`http.ts:21`); webhook errors log details (`paypal/webhook/route.ts:23,35`).
- Render access-log retention unknown (SUSPECTED).

### F8 — MEDIUM (CONFIRMED) — Unbounded demo data
- `/api/demo` seeds 3 milestones per call, 5/IP/h + 30/h global (`api/demo/route.ts:9-16`), no cleanup (`demo.ts:97-200`). Sandbox-only.

### F9 — LOW/MEDIUM (CONFIRMED) — Token/key printing & dead fields
- `scripts/seed-demo.ts:9` prints full timeline URLs with tokens; `scripts/create-platform.ts:17` prints raw `msk_`.
- `client_email` accepted but unused.

**Positive controls:** hashes only at rest, `timingSafeEqual`, `publicMilestone` strips hashes, `/api/status` sanitized, audit API filters to `schedule:due_changed`, no app `console.log`, `.env` untracked, sandbox emails documented fake, ledger has no email columns, tokens sent via headers, `Referrer-Policy: no-referrer`.

**VERDICT: Partially defensible** — strong token hygiene, no-account design, and sanitization in places. **Not defensible as-is for production PII handling:** public contract endpoint leaks worker PayPal email; raw PayPal webhook payloads and all deal PII retained indefinitely with no deletion/erasure path; permanent unexpirable bearer links; broad PII in API responses and third-party/AI flows; IP fallback is guessable; debug logs can leak paths. These must be addressed before handling real PII or leaving the sandbox.

---

# Final summary (as requested)
The audit log is in `opencode-audit.md` with Waves 1–3 complete (34 of 50 agents) and reports appended as they returned: money/state/webhooks (#1–#13), auth/injection/DoS/tests/AI (#14–#20,#22–#25), caching/determinism/validation/demo/contracts/terms/schema/data/time (#26–#34), Gantt (#35), plan conformance (#36), PII/retention (#37). Agents #21 (XSS) and #36 were re-run to capture full reports; #21’s report was completed in-session above. Waves 4 (#38–#50) remain pending.
