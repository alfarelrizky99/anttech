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

export interface BuildResultSummary {
  planKey: string;
  buildNumber: number;
  state: string; // Successful | Failed | InProgress | Unknown
  lifeCycleState: string; // InProgress | Finished | NotBuilt | Queued
  buildReason: string;
  startedTime: string | null;
  url: string;
}

interface BambooResultResponse {
  planName: string;
  buildResultKey: string;
  buildNumber: number;
  state?: string;
  lifeCycleState: string;
  buildReason?: string;
  buildStartedTime?: string;
  link: { href: string };
}

function toBuildSummary(raw: BambooResultResponse): BuildResultSummary {
  return {
    planKey: raw.buildResultKey,
    buildNumber: raw.buildNumber,
    state: raw.state ?? "Unknown",
    lifeCycleState: raw.lifeCycleState,
    buildReason: raw.buildReason ?? "",
    startedTime: raw.buildStartedTime ?? null,
    url: raw.link.href
  };
}

/**
 * Fetches the latest build result for a plan (REST API: /rest/api/latest/result/{planKey}/latest).
 * `planKey` looks like "PROJ-PLAN".
 */
export async function getLatestBuildResult(cfg: RestServiceConfig, planKey: string): Promise<BuildResultSummary> {
  assertEnabled(cfg, "bamboo");
  const url = new URL(`/rest/api/latest/result/${encodeURIComponent(planKey)}/latest`, cfg.baseUrl);
  url.searchParams.set("expand", "");

  const data = await fetchJson<BambooResultResponse>(url.toString(), {
    method: "GET",
    headers: headers(cfg),
    tls: cfg.tls
  });

  return toBuildSummary(data);
}

export interface DeploymentEnvironmentStatus {
  environmentName: string;
  deploymentVersionName: string | null;
  deploymentState: string; // SUCCESS | FAILED | IN_PROGRESS | NOT_BUILT | UNKNOWN
  startedDate: string | null;
  finishedDate: string | null;
}

interface BambooDeploymentProjectRef {
  id: number;
  name: string;
}

interface BambooDeploymentProject extends BambooDeploymentProjectRef {
  environments: Array<{ id: number; name: string }>;
}

interface BambooEnvironmentResult {
  deploymentVersionName?: string;
  deploymentState: string;
  startedDate?: number;
  finishedDate?: number;
}

/**
 * Resolves a deployment project id. Prefers the fast `forPlan` lookup when a build plan key is
 * known (one project, no full-list scan); falls back to scanning `/deploy/project/all` by display
 * name, which can be slow on instances with thousands of plans.
 */
async function resolveDeploymentProjectId(
  cfg: RestServiceConfig & { baseUrl: string },
  deploymentProjectName: string,
  planKey?: string
): Promise<number> {
  if (planKey) {
    const forPlanUrl = new URL("/rest/api/latest/deploy/project/forPlan", cfg.baseUrl);
    forPlanUrl.searchParams.set("planKey", planKey);
    const candidates = await fetchJson<BambooDeploymentProjectRef[]>(forPlanUrl.toString(), {
      method: "GET",
      headers: headers(cfg),
      tls: cfg.tls
    });
    const match = candidates.find((p) => p.name.toLowerCase() === deploymentProjectName.toLowerCase());
    if (match) return match.id;
    if (candidates.length === 1) return candidates[0].id;
    if (candidates.length > 0) {
      throw new Error(
        `planKey "${planKey}" has multiple deployment projects: ${candidates.map((p) => p.name).join(", ")}. ` +
          `Set deploymentProjectName to one of these exactly.`
      );
    }
    // No deployment project tied to that plan — fall through to the full scan below.
  }

  const listUrl = new URL("/rest/api/latest/deploy/project/all", cfg.baseUrl);
  const projects = await fetchJson<BambooDeploymentProjectRef[]>(listUrl.toString(), {
    method: "GET",
    headers: headers(cfg),
    tls: cfg.tls
  });
  const project = projects.find((p) => p.name.toLowerCase() === deploymentProjectName.toLowerCase());
  if (!project) {
    throw new Error(`No Bamboo deployment project named "${deploymentProjectName}" found.`);
  }
  return project.id;
}

/**
 * Resolves a deployment project by its (human-readable) name — fast path via `planKey` when
 * provided, otherwise a full scan of `/deploy/project/all` — then fetches the latest result for
 * each of its environments via /rest/api/latest/deploy/environment/{environmentId}/results.
 */
export async function getDeploymentStatus(
  cfg: RestServiceConfig,
  deploymentProjectName: string,
  planKey?: string
): Promise<DeploymentEnvironmentStatus[]> {
  assertEnabled(cfg, "bamboo");

  const projectId = await resolveDeploymentProjectId(cfg, deploymentProjectName, planKey);
  const projectUrl = new URL(`/rest/api/latest/deploy/project/${projectId}`, cfg.baseUrl);
  const project = await fetchJson<BambooDeploymentProject>(projectUrl.toString(), {
    method: "GET",
    headers: headers(cfg),
    tls: cfg.tls
  });

  const results: DeploymentEnvironmentStatus[] = [];
  for (const env of project.environments) {
    const resUrl = new URL(
      `/rest/api/latest/deploy/environment/${env.id}/results`,
      cfg.baseUrl
    );
    resUrl.searchParams.set("max-results", "1");
    try {
      const envResult = await fetchJson<{ results: BambooEnvironmentResult[] }>(resUrl.toString(), {
        method: "GET",
        headers: headers(cfg),
        tls: cfg.tls
      });
      const latest = envResult.results[0];
      results.push({
        environmentName: env.name,
        deploymentVersionName: latest?.deploymentVersionName ?? null,
        deploymentState: latest?.deploymentState ?? "UNKNOWN",
        startedDate: latest?.startedDate ? new Date(latest.startedDate).toISOString() : null,
        finishedDate: latest?.finishedDate ? new Date(latest.finishedDate).toISOString() : null
      });
    } catch {
      results.push({
        environmentName: env.name,
        deploymentVersionName: null,
        deploymentState: "UNKNOWN",
        startedDate: null,
        finishedDate: null
      });
    }
  }

  return results;
}
