import { readFileSync, existsSync } from "node:fs";
import type { AppConfig } from "../config.js";
import { listPullRequests, type PullRequestSummary } from "./bitbucket.js";
import { getLatestBuildResult, getDeploymentStatus } from "./bamboo.js";

export interface PersonMapping {
  nickname: string;
  bitbucketName: string;
  whatsapp: string;
}

/**
 * One repo to check. Bamboo fields are optional — Bitbucket/Bamboo have no API to auto-link a
 * repo to the plan that builds it, so that part is manual. Without them, a merged PR's stage
 * simply stays "merged" (no build/deploy detail).
 */
export interface RepoMapping {
  projectKey: string;
  repoSlug: string;
  bambooPlanKey?: string;
  bambooDeploymentProjectName?: string;
}

export interface PrMonitoringConfig {
  people: PersonMapping[];
  repos: RepoMapping[];
}

/**
 * Combined lifecycle stage for a PR, folding in the Bamboo build/deployment that corresponds to
 * its repo (when mapped). Order reflects progression: open -> merged -> building -> deployed.
 */
export type PrStage = "open" | "declined" | "merged" | "building" | "build_failed" | "deployed" | "deploy_failed";

export interface TrackedPr {
  repoKey: string; // "PROJECT/repo-slug"
  prId: number;
  title: string;
  authorBitbucketName: string;
  owner: PersonMapping | null;
  sourceBranch: string;
  targetBranch: string;
  url: string;
  stage: PrStage;
  stageDetail: string;
  updated: string;
}

function loadConfig(path: string): PrMonitoringConfig {
  if (!existsSync(path)) {
    throw new Error(
      `PR monitoring config not found at ${path}. Copy pr-monitoring.config.json and fill in ` +
        `people/repos first.`
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf-8")) as PrMonitoringConfig;
  const placeholderPattern = /^GANTI_/;
  const unfilledPeople = raw.people.filter((p) => placeholderPattern.test(p.bitbucketName) || placeholderPattern.test(p.whatsapp));
  const unfilledRepos = raw.repos.filter((r) => placeholderPattern.test(r.projectKey) || placeholderPattern.test(r.repoSlug));
  if (unfilledPeople.length > 0 || unfilledRepos.length > 0) {
    throw new Error(
      `pr-monitoring.config.json still has placeholder values (GANTI_...). Fill in ` +
        `${unfilledPeople.map((p) => p.nickname).join(", ") || "-"} (people) and ` +
        `${unfilledRepos.map((r) => `${r.projectKey}/${r.repoSlug}`).join(", ") || "-"} (repos) before using PR monitoring.`
    );
  }
  return raw;
}

function findOwner(people: PersonMapping[], bitbucketName: string): PersonMapping | null {
  return people.find((p) => p.bitbucketName.toLowerCase() === bitbucketName.toLowerCase()) ?? null;
}

/**
 * Derives the combined Bitbucket+Bamboo stage for one PR. Bamboo is only consulted for MERGED
 * Bitbucket PRs with a configured plan mapping — a stale/unrelated build on the same plan key
 * shouldn't be second-guessed for an OPEN or DECLINED PR.
 */
async function deriveStage(
  cfg: AppConfig,
  pr: PullRequestSummary,
  repo: RepoMapping
): Promise<{ stage: PrStage; detail: string }> {
  if (pr.state === "DECLINED") return { stage: "declined", detail: "Pull request declined" };
  if (pr.state === "MERGED") {
    if (!repo.bambooPlanKey) return { stage: "merged", detail: "Pull request merged" };
    try {
      const build = await getLatestBuildResult(cfg.bamboo, repo.bambooPlanKey);
      if (build.lifeCycleState !== "Finished") {
        return { stage: "building", detail: `Build #${build.buildNumber} sedang jalan (${build.lifeCycleState})` };
      }
      if (build.state !== "Successful") {
        return { stage: "build_failed", detail: `Build #${build.buildNumber} gagal (${build.state})` };
      }
      if (repo.bambooDeploymentProjectName) {
        try {
          const deployments = await getDeploymentStatus(cfg.bamboo, repo.bambooDeploymentProjectName, repo.bambooPlanKey);
          const anyFailed = deployments.find((d) => d.deploymentState === "FAILED");
          const anySuccess = deployments.find((d) => d.deploymentState === "SUCCESS");
          if (anyFailed) {
            return { stage: "deploy_failed", detail: `Deployment gagal di ${anyFailed.environmentName}` };
          }
          if (anySuccess) {
            return { stage: "deployed", detail: `Deployed ke ${anySuccess.environmentName} (${anySuccess.deploymentVersionName ?? ""})`.trim() };
          }
        } catch {
          // Deployment lookup failing shouldn't mask a known-good build result.
        }
      }
      return { stage: "merged", detail: `Build #${build.buildNumber} sukses` };
    } catch {
      return { stage: "merged", detail: "Pull request merged (status build tidak terbaca)" };
    }
  }
  return { stage: "open", detail: "Pull request masih open" };
}

/**
 * Fetches PRs across every repo configured in pr-monitoring.config.json, resolves each to an
 * owner (by Bitbucket display name) and a combined Bitbucket+Bamboo stage. Pure on-demand read —
 * no polling, no state file, no caching. Meant to be called when a user asks, not on a schedule.
 */
export async function listAllTrackedPrs(cfg: AppConfig): Promise<TrackedPr[]> {
  const monitoring = loadConfig(cfg.prMonitoringConfigPath);
  const results: TrackedPr[] = [];

  for (const repo of monitoring.repos) {
    const repoKey = `${repo.projectKey}/${repo.repoSlug}`;
    const prs = await listPullRequests(cfg.bitbucket, repo.projectKey, repo.repoSlug, "ALL");
    for (const pr of prs) {
      const { stage, detail } = await deriveStage(cfg, pr, repo);
      results.push({
        repoKey,
        prId: pr.id,
        title: pr.title,
        authorBitbucketName: pr.author,
        owner: findOwner(monitoring.people, pr.author),
        sourceBranch: pr.sourceBranch,
        targetBranch: pr.targetBranch,
        url: pr.url,
        stage,
        stageDetail: detail,
        updated: pr.updated
      });
    }
  }

  return results;
}

/**
 * Lists tracked PRs belonging to one person, matched by nickname (case-insensitive) against the
 * people mapping in pr-monitoring.config.json.
 */
export async function listTrackedPrsForPerson(cfg: AppConfig, nickname: string): Promise<TrackedPr[]> {
  const all = await listAllTrackedPrs(cfg);
  return all.filter((pr) => pr.owner?.nickname.toLowerCase() === nickname.toLowerCase());
}
