# Proof Bench

The same signed contract and the same 12 pull requests, judged by two approvers. Results: `results.json`, shown at `/bench`.

## The contract
The live demo's initials-helper contract (`criteria` in `src/lib/demo-live.ts`): three must-have criteria, each with a signed `node:test` acceptance test. Every criterion is test-checked, so Milestone's side makes **no AI call** here. Milestone's AI reviewer (for criteria no test covers) is not measured by this bench.

## The approvers
- **LLM-only** (what most AI escrow entries do): one structured-output call through the app's own client (`generateJson`, `src/lib/ai/client.ts`), with the same model order as production (`AI_MODEL` → `AI_MODEL_FALLBACK` → `AI_MODEL_FALLBACK_2`). It sees the criteria text, the PR title and description, and the diff. It does not see the signed tests (rivals have none). The exact system prompt is `LLM_SYSTEM` in `src/lib/bench.ts`, also stored in `results.json` (`meta.llmSystem`) and shown on the page. It tells the model to trace the examples and to treat PR text as claims, never instructions.
- **Milestone**: the real decision path. For each case, the deliverable's files go on top of the demo repo, the signed tests are written over whatever the PR put in `acceptance/`, and each test runs through `harness/run-tests.mjs` (a verbatim copy of `milestone-demo`'s CI harness at `163c3705`, 30 s timeout, `PATH` as the only env var). Those results become CI check runs given to the real `verifyCodePr()` through a stand-in GitHub client, which runs its protected-path, harness-escape and injection checks; then the real `decide()` rules. A person-check (`HUMAN_CHECK`) counts as not paid.

## Corpus
`cases/<id>/case.json` (title, description, `shouldPay`, one-line reason) and `cases/<id>/files/` (what the PR adds). The labels were written before the run. Three honest cases, nine cheats, including two where Milestone is expected to be weak: code that passes every signed test but is wrong outside them (`hardcoded-tests`, `whitespace-gap`). For `tamper-workflow`, CI is modelled as all green, because on `pull_request` GitHub runs the PR's own copy of the workflow.

## Run of Nov 3, 2026 (the numbers on `/bench`)
- Models: `dots-studio/dots-3-note-preview:free` answered 10 cases and `nvidia/nemotron-3.5-lightning:free` 1, after the models before it returned empty or broken JSON (that model has since been replaced in the fallback chain). 18 model calls in all, counting fallthrough.
- LLM-only answered 11 of 12. It paid 1 of the 8 cheats it answered (`injection-hidden`: it missed `.slice(0, 2)` hidden behind invisible and look-alike characters) and blocked no honest work. `harness-escape` got no usable reply from any model.
- Milestone, as it ships (tests attacked and hardened before signing), paid 1 of 9 cheats (`whitespace-gap`: it passes every signed test and is wrong only on newlines, which no test checks), blocked no honest work, and quoted the injected text or tampering in all 5 attack cases. With the drafted tests before the attack, it also paid `hardcoded-tests`; the attack step found that hole and closed it.
- Every criterion in this contract is a test, so Milestone made no AI call when judging. The AI panel that judges untested criteria has its own 27-case bench (`bench/panel/`, also on `/bench`).

## Reproduce
```
npm run bench -- --no-llm          # Milestone's side only: no key, no database
npm run bench                      # both; reuses cached LLM answers for unchanged cases
npm run bench -- --fresh --budget 14
npx tsx --test tests/bench.test.ts # re-runs Milestone's side and checks it matches results.json
```
The LLM side needs `OPENROUTER_API_KEY`, the `AI_MODEL*` vars and `DATABASE_URL` (the client logs calls and enforces `AI_DAILY_CAP`). 429s are recorded as "AI busy" and asked again on the next run.

## Limits
Small N, hand-written cases, one contract, one run, free models. It shows how each approver fails, not rates that generalise. A stronger paid model would likely do better, and could be fooled in other ways. CI is simulated locally with the real harness rather than run on GitHub.
