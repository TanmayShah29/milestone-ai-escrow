# milestone-runner (source)

The trusted runner's workflow and harness. This folder is the source of
[TanmayShah29/milestone-runner](https://github.com/TanmayShah29/milestone-runner), where it runs. Milestone
counts a result only when it was signed by that repository's `.github/workflows/run.yml` on `main`
(`src/lib/review/runner.ts`).

- `.github/workflows/run.yml`: started by Milestone with `repo, pr, head_sha, fingerprint, nonce`.
- `harness/run.mjs`: fetches the signed contract, checks its hash, and runs each tested criterion in two
  containers. `harness/shim.mjs` serves the PR's code in `worker`. `harness/client.mjs` and the generated
  proxies (`harness/plan.mjs`) call it synchronously from `tests`.
- `harness/wire.mjs`: what crosses the socket.

To try it locally, run `harness/run.mjs` with `REPO PR HEAD_SHA FINGERPRINT NONCE IMG MILESTONE_API CHECKOUT`
set, and Docker running.
