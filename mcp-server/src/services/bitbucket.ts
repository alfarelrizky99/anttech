import type { RestServiceConfig } from "../config.js";
import { buildAuthHeader, fetchJson } from "../httpClient.js";

function assertEnabled(cfg: RestServiceConfig, name: string): asserts cfg is RestServiceConfig & { baseUrl: string } {
  if (!cfg.enabled || !cfg.baseUrl) {
    throw new Error(`${name} is not configured. Set ${name.toUpperCase()}_BASE_URL and credentials.`);
  }
}

function headers(cfg: RestServiceConfig): Record<string, string> {
  return { ...buildAuthHeader(cfg.auth), Accept: "application/json" };
}

export interface PullRequestSummary {
  id: number;
  title: string;
  state: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  updated: string;
  url: string;
  approvalsCount: number;
}

interface BitbucketServerPr {
  id: number;
  title: string;
  state: string;
  author: { user: { displayName: string } };
  fromRef: { displayId: string };
  toRef: { displayId: string };
  updatedDate: number;
  reviewers: Array<{ approved: boolean }>;
  links: { self: Array<{ href: string }> };
}

interface BitbucketServerPagedResponse<T> {
  size: number;
  isLastPage: boolean;
  values: T[];
}

function toSummary(raw: BitbucketServerPr): PullRequestSummary {
  return {
    id: raw.id,
    title: raw.title,
    state: raw.state,
    author: raw.author.user.displayName,
    sourceBranch: raw.fromRef.displayId,
    targetBranch: raw.toRef.displayId,
    updated: new Date(raw.updatedDate).toISOString(),
    url: raw.links.self[0]?.href ?? "",
    approvalsCount: raw.reviewers.filter((r) => r.approved).length
  };
}

/**
 * Lists pull requests for a repository on Bitbucket Server/Data Center
 * (REST API 1.0: /rest/api/1.0/projects/{projectKey}/repos/{repoSlug}/pull-requests).
 *
 * `state` follows Bitbucket's own values: OPEN (default), MERGED, DECLINED, ALL.
 */
export async function listPullRequests(
  cfg: RestServiceConfig,
  projectKey: string,
  repoSlug: string,
  state: "OPEN" | "MERGED" | "DECLINED" | "ALL" = "OPEN"
): Promise<PullRequestSummary[]> {
  assertEnabled(cfg, "bitbucket");
  const url = new URL(
    `/rest/api/1.0/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/pull-requests`,
    cfg.baseUrl
  );
  url.searchParams.set("state", state);
  url.searchParams.set("limit", "50");

  const data = await fetchJson<BitbucketServerPagedResponse<BitbucketServerPr>>(url.toString(), {
    method: "GET",
    headers: headers(cfg),
    tls: cfg.tls
  });

  return data.values.map(toSummary);
}

/**
 * Fetches a single pull request's current status (useful for "is PR #42 merged yet?").
 */
export async function getPullRequest(
  cfg: RestServiceConfig,
  projectKey: string,
  repoSlug: string,
  pullRequestId: number
): Promise<PullRequestSummary> {
  assertEnabled(cfg, "bitbucket");
  const url = new URL(
    `/rest/api/1.0/projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repoSlug)}/pull-requests/${pullRequestId}`,
    cfg.baseUrl
  );

  const data = await fetchJson<BitbucketServerPr>(url.toString(), {
    method: "GET",
    headers: headers(cfg),
    tls: cfg.tls
  });

  return toSummary(data);
}
