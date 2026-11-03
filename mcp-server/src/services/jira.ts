import type { RestServiceConfig } from "../config.js";
import { buildAuthHeader } from "../httpClient.js";
import { fetchJson } from "../httpClient.js";

function assertEnabled(cfg: RestServiceConfig, name: string): asserts cfg is RestServiceConfig & { baseUrl: string } {
  if (!cfg.enabled || !cfg.baseUrl) {
    throw new Error(`${name} is not configured. Set ${name.toUpperCase()}_BASE_URL and credentials.`);
  }
}

function headers(cfg: RestServiceConfig): Record<string, string> {
  return { ...buildAuthHeader(cfg.auth), Accept: "application/json" };
}

export interface JiraIssueSummary {
  key: string;
  summary: string;
  status: string;
  assignee: string | null;
  priority: string | null;
  updated: string;
  url: string;
}

interface JiraSearchResponseV2 {
  issues: Array<{
    key: string;
    fields: {
      summary: string;
      status: { name: string };
      assignee: { displayName: string } | null;
      priority: { name: string } | null;
      updated: string;
    };
  }>;
  total: number;
}

function toSummary(baseUrl: string, raw: JiraSearchResponseV2["issues"][number]): JiraIssueSummary {
  return {
    key: raw.key,
    summary: raw.fields.summary,
    status: raw.fields.status.name,
    assignee: raw.fields.assignee?.displayName ?? null,
    priority: raw.fields.priority?.name ?? null,
    updated: raw.fields.updated,
    url: `${baseUrl.replace(/\/$/, "")}/browse/${raw.key}`
  };
}

/**
 * Runs a JQL search against Jira (Server/Data Center REST API v2). Works equally against
 * Jira Cloud's v2-compatible search endpoint for most JQL queries.
 */
export async function searchJiraIssues(
  cfg: RestServiceConfig,
  jql: string,
  maxResults = 20
): Promise<{ total: number; issues: JiraIssueSummary[] }> {
  assertEnabled(cfg, "jira");
  const url = new URL("/rest/api/2/search", cfg.baseUrl);
  url.searchParams.set("jql", jql);
  url.searchParams.set("maxResults", String(maxResults));
  url.searchParams.set("fields", "summary,status,assignee,priority,updated");

  const data = await fetchJson<JiraSearchResponseV2>(url.toString(), {
    method: "GET",
    headers: headers(cfg),
    tls: cfg.tls
  });

  return {
    total: data.total,
    issues: data.issues.map((issue) => toSummary(cfg.baseUrl!, issue))
  };
}

/**
 * Fetches a single Jira issue's current status/progress by key (e.g. "PROJ-123").
 */
export async function getJiraIssue(cfg: RestServiceConfig, issueKey: string): Promise<JiraIssueSummary> {
  assertEnabled(cfg, "jira");
  const url = new URL(`/rest/api/2/issue/${encodeURIComponent(issueKey)}`, cfg.baseUrl);
  url.searchParams.set("fields", "summary,status,assignee,priority,updated");

  const data = await fetchJson<JiraSearchResponseV2["issues"][number]>(url.toString(), {
    method: "GET",
    headers: headers(cfg),
    tls: cfg.tls
  });

  return toSummary(cfg.baseUrl!, data);
}

/**
 * Summarizes how many issues matching a JQL fall into each status — a quick "progress at a
 * glance" view, e.g. for a sprint or epic: `project = ABC AND sprint in openSprints()`.
 */
export async function summarizeJiraProgress(
  cfg: RestServiceConfig,
  jql: string
): Promise<{ total: number; byStatus: Record<string, number> }> {
  const { total, issues } = await searchJiraIssues(cfg, jql, 200);
  const byStatus: Record<string, number> = {};
  for (const issue of issues) {
    byStatus[issue.status] = (byStatus[issue.status] ?? 0) + 1;
  }
  return { total, byStatus };
}
