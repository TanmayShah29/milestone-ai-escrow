# v2 Phase 0 spikes: results (Nov 5, 2026)

These spikes back `docs/V2_PLAN.md` §5. Every result below comes from a real call or a real run, unless
marked otherwise. Scripts are in `spikes/`. The PayPal ids are also in `PayPal_Sandbox_Guide.md` (last
section).

| # | Spike | Result |
|---|---|---|
| H1 | Partial capture with `final_capture: true` | ✅ **PASS** |
| H1b | Several captures on one hold | ✅ **PASS** |
| H2 | Capture first, then refunds | ✅ **PASS**, with a cost |
| H3 | Vaulted card, authorized with no buyer present | ✅ **PASS** |
| H4 | Dispute evidence and adjudication | ◐ **Evidence PASS**: a PDF evidence pack was accepted at both the inquiry and claim stages, escalation worked, and webhooks fired. Sandbox `adjudicate` was refused every time (`ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE`) |
| H5 | Payout to a third party (arbitrator) | ✅ **PASS** |
| C1 | Runner: worker and tests in separate containers | ✅ **PASS** locally and on GitHub Actions, started from the API |
| C2 | Signed results checked with `sigstore-js` | ✅ **PASS** end to end: signed by `actions/attest@v2`, checked by `sigstore-js` and `gh attestation verify` |
| B1 | Rekor inclusion | ◐ **PASS for runner results**: our attestations are in Rekor and their inclusion is checked. Ledger checkpoints (our own `hashedrekord` uploads) not done |
| A1 | Passkey signs the terms fingerprint | ✅ **PASS locally** (virtual authenticator). A real device on the Render domain is still to do |
| D1 | Three free models from different providers | ✅ **PASS** |

## Details

### H1: partial pay works exactly as the plan needs
- A $10 authorization, then a capture of $8 with `final_capture: true`. The capture COMPLETED (fee $0.70),
  and the authorization moved straight to `CAPTURED`. The remaining $2 is released, and a later capture gets
  422 `AUTHORIZATION_ALREADY_CAPTURED`.
- **Design consequence:** settling an earned share is a single call, with no separate void. The idempotency
  key stays `milestone:<id>:settle`.

### H1b: two captures on one hold
- $5 with `final_capture: false` left the authorization `PARTIALLY_CAPTURED`. Then $3 with
  `final_capture: true` moved it to `CAPTURED`.
- **Design consequence:** an option for later is to pay must-haves first and the nice-to-have bonus as a
  second capture, inside the same 29 days.

### H2: capture-first mode works, and PayPal keeps its fee on refunds
- A CAPTURE of $10 (fee $0.75), then a $3 partial refund, then a refund of the remaining $7. Both refunds
  COMPLETED, and the capture ended `REFUNDED`.
- `seller_payable_breakdown.paypal_fee` was **$0.00** on both refunds. The $0.75 isn't returned.
- **Design consequence:** `captured` mode costs about 3.5% + $0.49 per rejected milestone. The contract has
  to say who bears it, perhaps from the platform fee. It stays a **DECISION**.

### H3: spending mandates are feasible
- Card vault: setup token `67138953HP356183E` (APPROVED), then payment token `38597659ja3344047`.
- Then `AUTHORIZE` orders with `payment_source.card.vault_id`, both with and without
  `stored_credential {payment_initiator: MERCHANT, payment_type: UNSCHEDULED, usage: SUBSEQUENT}`. Each
  returned an authorization CREATED in one call, with **no buyer and no browser**. Both were voided.
- **Design consequence:** an agent can fund a bounty within a signed mandate, with code doing the
  authorizing. Send `stored_credential` (merchant-initiated) anyway, because production card networks expect
  it. PayPal-wallet vault is still limited release, so mandates are card-only.

### H5: arbitrator fees can be paid
- A $1 payout to a third sandbox account reached SUCCESS in under 40 s (batch `P49D2AFDXM4HU`).
- For the real arbitrator, create a third sandbox personal account. The client account stood in for this
  spike.

### C1: real isolation, tested against cheating workers
`spikes/runner/run-local.sh <fixture>` runs the worker's module in one container: no network, read-only
root, uid 1000, reached only through a JSON-RPC shim on a Unix socket in a Docker volume. The signed tests
run in another container that holds the only writable `/out`.

| Fixture | What it tried | Result |
|---|---|---|
| `honest` | correct `add`, `slug` | C1 ✅, C2 ✅ |
| `evil` | `assert.equal = () => {}`: patched, but in its own process, so **no effect** | C1 ❌ (honest result for `a - b`) |
| | write a fake `/out/junit.xml` | blocked: `ENOENT`, `/out` doesn't exist there |
| | rewrite `/harness/target.mjs` | blocked: `EROFS` |
| | `fetch` to the internet | failed (`TimeoutError`, no network) |
| `exiter` | `process.exit(0)` inside `slug` | C1 ✅, C2 ❌: the connection dropped, so the test failed rather than passing |

This closes both residual risks in the README, provided the worker container is the only place PR code
runs. Limits found along the way:
- **The tests must `await` every call.** Calls cross a socket, so the signed tests call
  `await rpc("add", [2, 3])` (in production, generated named proxies). The contract generator must write
  async tests. A synchronous proxy is possible (a worker thread plus `Atomics.wait`) if needed.
- **Values must survive JSON.** Functions, classes and object identity can't cross. The contract has to
  declare the interface as JSON-serialisable functions, or as a CLI or HTTP surface.
- **Docker Desktop on macOS can't share a Unix socket through a bind mount between containers**, so the
  harness uses a named volume. That also works on GitHub's Linux runners.

**On GitHub Actions** [VERIFIED Nov 5]:
- The public repo https://github.com/TanmayShah29/milestone-runner (MIT) holds this harness with `run.yml`
  (copy in `spikes/runner/.github/workflows/`).
- Three `POST /repos/TanmayShah29/milestone-runner/actions/workflows/run.yml/dispatches` calls each
  returned **204**. These were made with the `gh` token; the app's token still needs Actions: write.
- All three runs succeeded in 22 s–2.5 min. The first run pulled the image cold.
- The results were the same as locally:

| Run | Fixture | Result |
|---|---|---|
| `42068641461` | honest | C1 ✓, C2 ✓ |
| `42068647378` | evil | C1 ✗, C2 ✓ |
| `42068652107` | exiter | C1 ✓, C2 ✗ |

- The evil worker's log on GitHub: `{"assertPatched":true,"fakeReport":"ENOENT","network":"TimeoutError","rewroteHarness":"EROFS"}`.
- A dispatch returns no run id. Milestone must find the run by the nonce (list runs and match the input or
  the run name), or use `return_run_details` if the API offers it. That's a detail for the build.

### C2 + B1: checking signed results (verifier side)
- `spikes/verify-bundle.mjs` loaded a real GitHub Actions Sigstore bundle: the SLSA provenance of
  `sigstore@5.0.1` on npm, built by `sigstore/sigstore-js/.github/workflows/release.yml@refs/heads/main`.
  This is the same DSSE and in-toto bundle format `actions/attest` produces.
- It checked the bundle with `sigstore@3.1.0`, pinning the issuer
  `https://token.actions.githubusercontent.com` and the exact workflow identity:

| Case | Result |
|---|---|
| Genuine bundle, right workflow | **VERIFIED** (1.6 s, including fetching the trust root) |
| Genuine bundle, wrong workflow identity | **REJECTED** `UNTRUSTED_SIGNER_ERROR` |
| One byte of the payload flipped | **REJECTED** `TLOG_BODY_ERROR: DSSE payload hash mismatch` |

**Our own runner's attestations** [VERIFIED Nov 5]:
- `actions/attest@v2` signed each `results.json` with our predicate type. The bundle is fetched with
  `GET /repos/TanmayShah29/milestone-runner/attestations/sha256:<digest>` (no auth needed, public repo).
- `spikes/verify-runner.mjs` checks four things:
  1. the Sigstore signature;
  2. the certificate identity, exactly
     `https://github.com/TanmayShah29/milestone-runner/.github/workflows/run.yml@refs/heads/main`;
  3. the in-toto subject digest equals `sha256(results.json)`;
  4. the signed predicate equals the file, nonce included.

| Case (evil run `42068647378`) | Result |
|---|---|
| Genuine | **VERIFIED** (C1 ✗, C2 ✓, nonce `spike-evil-1793897449`) |
| `results.json` edited to all-pass | **REJECTED** (digest is not the signed subject) |
| Checked against the milestone-demo workflow identity | **REJECTED** `UNTRUSTED_SIGNER_ERROR` |
| One byte of the signed payload flipped | **REJECTED** `TLOG_BODY_ERROR` |

- `gh attestation verify results.json -R TanmayShah29/milestone-runner --predicate-type … --signer-workflow
  TanmayShah29/milestone-runner/.github/workflows/run.yml` exits 0. That's an independent tool anyone can
  use.
- The attestations are in Rekor at log indexes 3696652421 (honest) and 3696651884 (evil).
- **Note:** sigstore only checks the envelope. Steps 3 and 4 are ours, and are what bind the file to the
  signature. Skipping them would accept an edited file.

The npm bundle carried Rekor log index 3692194993 with an inclusion proof, and verification checks it. So the
"Rekor inclusion" half of B1 passes. Still open:
- uploading our own `hashedrekord` checkpoints (permanent and public);
- whether `sigstore-js` runs in the browser for `/proof`. The fallback is to check on the server, plus the
  `npx` CLI, plus `gh attestation verify` for anyone who wants their own tool.

### A1: passkeys sign the contract
- `spikes/passkey-spike.mjs` drives headless Chrome with a CDP virtual authenticator against a local page.
- It registers a passkey, then signs with **the terms fingerprint as the WebAuthn challenge**. Verification
  uses `@simplewebauthn/server@13.3.3`.

| Case | Result |
|---|---|
| Registration | **VERIFIED** |
| Signature over the signed terms | **VERIFIED** |
| The same signature presented for other terms | **REJECTED** (challenge mismatch) |

What we store per party: the credential id, a 42-byte COSE public key and a counter. Two notes:
- `onrender.com` is on the **Public Suffix List**, so the RP id must be the full host,
  `milestone-ai-escrow.onrender.com`. That's fine, but a custom domain later would orphan the passkeys.
- In production the challenge should be `sha256(fingerprint ‖ server nonce)` to prevent replay, and the
  nonce should be stored in the ledger event.

### D1: the AI panel's models (Nov 5 list)
- The same grounded-verdict prompt (`add` returns `a - b`) went to each candidate. All three returned valid
  JSON with `fail` and the exact diff line as the quote:

| Model | Provider |
|---|---|
| `dots-studio/dots-3-note-preview:free` | AtlasCloud |
| `nvidia/nemotron-3.5-super-vl:free` | Nvidia |
| `cohere/north-mini-code:free` | Cohere (tools only, no `structured_outputs`, but `json_object` worked) |

- `xingchen-agi/xing4.0-29b-a4b:free` returned 429 (rate-limited upstream). `google/gemma-4-*` still have a
  reputation for 429s.
- This used about 7 calls of the day's budget (an output-parsing bug in the first run wasted 3).

### H4: dispute evidence from the platform [VERIFIED Nov 5]
**Setup:** wallet order `0GJ349494P3749310`, approved by the client in the browser (Visa ••3106) and
captured through the API. Capture `9SN506710E881745H`, $5.00, fee $0.66. The client then opened a dispute
in the sandbox UI: item type **Service**, "not received", refund $5.00. That created dispute
`PP-R-QEE-10196672`, reason `MERCHANDISE_OR_SERVICE_NOT_RECEIVED`.

**What happened:**
- The dispute's `disputed_transactions[]` held the capture id and **our `custom_id`** (`spike-h4`). So
  matching a dispute to a milestone by `custom_id` works as `webhooks.ts` assumes.
- Webhooks `CUSTOMER.DISPUTE.CREATED` and then `UPDATED` ×2 were sent to our listener within about 90 s,
  seen in `GET /v1/notifications/webhooks-events`. That's the first time we've seen them live.
- **Opening the dispute froze the money:** the capture became `PENDING` with reason `BUYER_COMPLAINT`. In
  v2, a milestone in DISPUTE must not pay out, and any payout not yet sent must wait.
- The stages: `OPEN/UNDER_PAYPAL_REVIEW` (about 3 min), then `WAITING_FOR_SELLER_RESPONSE` in the inquiry
  stage. The available links were `send_message, make_offer, provide_evidence, accept_claim, escalate`.
- **`provide-evidence` worked**: multipart `input` (JSON: `evidence_type: PROOF_OF_FULFILLMENT`, notes,
  documents) plus `file1` (PDF from `spikes/evidence_pdf.py`) returned HTTP 200. The dispute listed
  `milestone-evidence.pdf` as `SUBMITTED_BY_SELLER`.
- The status then went to `WAITING_FOR_BUYER_RESPONSE`. Our `POST …/escalate` with a note returned 200, and
  about 3 min later the stage was `CHARGEBACK` (the claim) with `WAITING_FOR_SELLER_RESPONSE`.
- Evidence was submitted again for the claim (200), and the status became `UNDER_REVIEW` /
  `UNDER_PAYPAL_REVIEW`, with only `provide_supporting_info` available.

**Not working:**
- **Sandbox `POST …/adjudicate {"adjudication_outcome":"SELLER_FAVOR"}` returned 400
  `ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE` at every stage.** That includes 4+ minutes of
  `UNDER_REVIEW` in the claim stage (debug ids `f247195ee3f59`, `f239392543664`).
- It may need longer under review, or it may not apply to disputes opened in the UI. To retry later:
  `GET /v1/customer/disputes/PP-R-QEE-10196672`, then adjudicate.

**Design consequences for workstream G:**
- The resolution desk's evidence pack can go into PayPal's own dispute process as a PDF, at both the inquiry
  and the claim stage.
- Escalating to a claim is our call. Whether to escalate stays a fixed rule: escalate only if the pack
  shows E3 evidence for every must-have. The AI never decides it.
- The demo should show a dispute reaching "evidence submitted" rather than counting on adjudication.

## Leftovers in the sandbox
- Two spike captures were kept, not refunded: $8 (`725455390F957230V`) and $5 + $3 (order
  `3DM06959R2466240M`). They can be refunded on request, which also gives a refund-after-authorization data
  point.
- Both H3 authorizations are voided.
- The vaulted card payment token `38597659ja3344047` is still stored, and can be reused for mandate work.
