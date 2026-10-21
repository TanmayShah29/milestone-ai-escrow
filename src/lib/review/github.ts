// Read-only GitHub calls the code_pr verifier needs (plus an optional PR comment). Uses GITHUB_TOKEN
// when set (5,000 req/h); unauthenticated works for public repos at 60 req/h.

export type GitHub = {
  pr(owner: string, repo: string, n: number): Promise<PullRequest>;
  files(owner: string, repo: string, n: number): Promise<PrFile[]>;
  checkRuns(owner: string, repo: string, sha: string): Promise<CheckRun[]>;
  comment(owner: string, repo: string, n: number, body: string): Promise<void>;
};

export type PullRequest = { number: number; title: string; body: string; state: string; merged: boolean; headSha: string; baseRepo: string; htmlUrl: string };
export type PrFile = { filename: string; status: string; additions: number; deletions: number; patch?: string };
export type CheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  startedAt: string | null;
  /** Slug of the GitHub App that created the run ("github-actions" for workflow jobs). Only those are trusted. */
  app: string | null;
  headSha: string;
  /** The Actions workflow run the job belongs to, read from its details URL, when there is one. */
  workflowRunId: number | null;
};

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** "owner/repo" the request was about, for a human error message. Never holds a token. */
    readonly repo?: string,
  ) {
    super(message);
  }
}

const repoOf = (path: string) => /^\/repos\/([\w.-]+\/[\w.-]+)\//.exec(path)?.[1];

export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | undefined {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : undefined;
}

export function githubClient(fetchImpl: typeof fetch = fetch, token = process.env.GITHUB_TOKEN): GitHub {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "milestone-escrow" };
  if (token) headers.authorization = `Bearer ${token}`;
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetchImpl(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new GitHubError(res.status, `GitHub ${res.status} for ${path}`, repoOf(path));
    return (await res.json()) as T;
  };
  return {
    async pr(owner, repo, n) {
      const p = await get<{ number: number; title: string; body: string | null; state: string; merged: boolean; head: { sha: string }; base: { repo: { full_name: string } }; html_url: string }>(
        `/repos/${owner}/${repo}/pulls/${n}`,
      );
      return { number: p.number, title: p.title, body: p.body ?? "", state: p.state, merged: p.merged, headSha: p.head.sha, baseRepo: p.base.repo.full_name, htmlUrl: p.html_url };
    },
    async files(owner, repo, n) {
      const out: PrFile[] = [];
      for (let page = 1; page <= 3; page++) {
        const batch = await get<PrFile[]>(`/repos/${owner}/${repo}/pulls/${n}/files?per_page=100&page=${page}`);
        out.push(...batch.map(({ filename, status, additions, deletions, patch }) => ({ filename, status, additions, deletions, ...(patch ? { patch } : {}) })));
        if (batch.length < 100) break;
      }
      return out;
    },
    async checkRuns(owner, repo, sha) {
      const r = await get<{
        check_runs: { name: string; status: string; conclusion: string | null; html_url: string; details_url: string | null; started_at: string | null; head_sha: string; app: { slug: string } | null }[];
      }>(`/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`);
      return r.check_runs.map((c) => ({
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        url: c.html_url,
        startedAt: c.started_at,
        app: c.app?.slug ?? null,
        headSha: c.head_sha,
        workflowRunId: Number(/\/actions\/runs\/(\d+)/.exec(c.details_url ?? "")?.[1]) || null,
      }));
    },
    async comment(owner, repo, n, body) {
      if (!token) return; // posting needs a token with pull-requests: write on the repo
      const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/issues/${n}/comments`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new GitHubError(res.status, `GitHub ${res.status} posting a comment`, `${owner}/${repo}`);
    },
  };
}
