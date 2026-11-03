import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "./config.js";
import { HttpError } from "./httpClient.js";
import { getLatestBuildResult, getDeploymentStatus } from "./services/bamboo.js";
import { getPullRequest, listPullRequests } from "./services/bitbucket.js";
import { getJiraIssue, searchJiraIssues, summarizeJiraProgress } from "./services/jira.js";
import { maskToken, requestOpenShiftToken } from "./services/openshift.js";
import { listTrackedPrsForPerson } from "./services/prMonitoring.js";
import {
  checkRedisKeyExists,
  clearRedisAll,
  clearRedisKey,
  getRedisDbSize,
  getRedisKey,
  getRedisKeyInfo,
  scanRedisKeys,
  setRedisKey
} from "./services/redisOps.js";

/**
 * Wraps a tool handler so thrown errors become a normal (isError) tool result instead of
 * crashing the MCP connection, and HttpError gets a friendlier message.
 */
function safe<T extends unknown[]>(
  fn: (...args: T) => Promise<{ content: Array<{ type: "text"; text: string }> }>
) {
  return async (...args: T) => {
    try {
      return await fn(...args);
    } catch (err) {
      const message =
        err instanceof HttpError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
    }
  };
}

function text(payload: unknown) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text: body }] };
}

/**
 * Shared OpenShift auth path: falls back to the server-configured default credentials when
 * username/password aren't given, same as the openshift_generate_token tool. Used both by that
 * tool directly and internally by the Redis ops tools, which need a fresh token to `oc exec`.
 */
async function getOpenShiftToken(username?: string, password?: string) {
  if (!config.openshift.enabled) {
    throw new Error("OpenShift is not configured. Set OPENSHIFT_OAUTH_URL and OPENSHIFT_API_URL.");
  }
  const user = username ?? config.openshift.defaultUsername;
  const pass = password ?? config.openshift.defaultPassword;
  if (!user || !pass) {
    throw new Error(
      "No OpenShift credentials available. Pass username/password explicitly, or configure " +
        "OPENSHIFT_USERNAME/OPENSHIFT_PASSWORD on the MCP server for the automated flow."
    );
  }
  return requestOpenShiftToken(config.openshift, user, pass);
}

function createServer(): McpServer {
  const server = new McpServer({ name: "anttech-azzeng-mcp", version: "0.1.0" });

  // ---------------------------------------------------------------------
  // OpenShift
  // ---------------------------------------------------------------------
  server.registerTool(
    "openshift_generate_token",
    {
      description:
        "Generate (or re-generate, on expiry) a short-lived OpenShift (OKD/OCP) OAuth access token " +
        "for the in-house cluster, using a username/password challenge (equivalent to " +
        "`oc login -u <user> -p <password>`). If username/password are omitted, falls back to the " +
        "default credentials configured on the server (OPENSHIFT_USERNAME/OPENSHIFT_PASSWORD) — this " +
        "is what backs the automated '/get-token-oc' re-authentication flow. Only works if the " +
        "cluster's identity provider supports password challenges (HTPasswd/LDAP), not pure SSO/OIDC. " +
        "The caller is responsible for keeping the returned token confidential.",
      inputSchema: z.object({
        username: z.string().min(1).optional().describe("OpenShift username (defaults to configured OPENSHIFT_USERNAME)"),
        password: z
          .string()
          .min(1)
          .optional()
          .describe("OpenShift password (defaults to configured OPENSHIFT_PASSWORD; never stored beyond this call)")
      })
    },
    safe(async ({ username, password }) => {
      const result = await getOpenShiftToken(username, password);
      const ocLoginCommand = `oc login --token=${result.accessToken} --server=${config.openshift.apiUrl}`;
      return text({
        tokenType: result.tokenType,
        expiresInSeconds: result.expiresInSeconds,
        maskedToken: maskToken(result.accessToken),
        accessToken: result.accessToken,
        ocLoginCommand,
        note:
          "Treat this token like a password: whoever has it can act as this user on the cluster " +
          "until it expires. Avoid pasting it into shared or logged channels."
      });
    })
  );

  // ---------------------------------------------------------------------
  // Jira
  // ---------------------------------------------------------------------
  server.registerTool(
    "jira_search_issues",
    {
      description:
        "Search Jira issues using JQL and return a compact summary (key, status, assignee, priority). " +
        "Use this to monitor progress of a project/sprint/epic, e.g. jql=\"project = ABC AND sprint in openSprints()\".",
      inputSchema: z.object({
        jql: z.string().min(1).describe("JQL query string"),
        maxResults: z.number().int().min(1).max(100).optional().describe("Max issues to return (default 20)")
      })
    },
    safe(async ({ jql, maxResults }) => {
      const result = await searchJiraIssues(config.jira, jql, maxResults ?? 20);
      return text(result);
    })
  );

  server.registerTool(
    "jira_get_issue",
    {
      description: "Get the current status/details of a single Jira issue by key, e.g. PROJ-123.",
      inputSchema: z.object({
        issueKey: z.string().min(1).describe("Jira issue key, e.g. PROJ-123")
      })
    },
    safe(async ({ issueKey }) => text(await getJiraIssue(config.jira, issueKey)))
  );

  server.registerTool(
    "jira_progress_summary",
    {
      description:
        "Summarize progress of a set of Jira issues matched by JQL as a count per status " +
        "(e.g. To Do / In Progress / Done). Good for a quick sprint/epic progress overview.",
      inputSchema: z.object({
        jql: z.string().min(1).describe("JQL query string, e.g. \"project = ABC AND sprint in openSprints()\"")
      })
    },
    safe(async ({ jql }) => text(await summarizeJiraProgress(config.jira, jql)))
  );

  // ---------------------------------------------------------------------
  // Bitbucket
  // ---------------------------------------------------------------------
  server.registerTool(
    "bitbucket_list_pull_requests",
    {
      description:
        "List pull requests for a Bitbucket Server/Data Center repository, optionally filtered by state " +
        "(OPEN, MERGED, DECLINED, ALL). Defaults to OPEN.",
      inputSchema: z.object({
        projectKey: z.string().min(1).describe("Bitbucket project key, e.g. ABC"),
        repoSlug: z.string().min(1).describe("Repository slug, e.g. my-service"),
        state: z.enum(["OPEN", "MERGED", "DECLINED", "ALL"]).optional()
      })
    },
    safe(async ({ projectKey, repoSlug, state }) =>
      text(await listPullRequests(config.bitbucket, projectKey, repoSlug, state ?? "OPEN"))
    )
  );

  server.registerTool(
    "bitbucket_get_pull_request",
    {
      description: "Get the current status of a single pull request by its numeric ID.",
      inputSchema: z.object({
        projectKey: z.string().min(1).describe("Bitbucket project key, e.g. ABC"),
        repoSlug: z.string().min(1).describe("Repository slug, e.g. my-service"),
        pullRequestId: z.number().int().positive().describe("Pull request ID, e.g. 42")
      })
    },
    safe(async ({ projectKey, repoSlug, pullRequestId }) =>
      text(await getPullRequest(config.bitbucket, projectKey, repoSlug, pullRequestId))
    )
  );

  // ---------------------------------------------------------------------
  // Bamboo
  // ---------------------------------------------------------------------
  server.registerTool(
    "bamboo_get_latest_build",
    {
      description: "Get the latest build result (state, lifecycle, reason) for a Bamboo plan key, e.g. PROJ-PLAN.",
      inputSchema: z.object({
        planKey: z.string().min(1).describe("Bamboo plan key, e.g. PROJ-PLAN")
      })
    },
    safe(async ({ planKey }) => text(await getLatestBuildResult(config.bamboo, planKey)))
  );

  server.registerTool(
    "bamboo_get_deployment_status",
    {
      description:
        "Get the latest deployment status for every environment of a Bamboo deployment project " +
        "(by its display name, e.g. \"Deployment for Makna API UAT\"). Pass planKey too when known " +
        "(e.g. \"MAU-MA\") — it resolves the project via a fast direct lookup instead of scanning " +
        "every deployment project on the instance, which can be slow when there are thousands.",
      inputSchema: z.object({
        deploymentProjectName: z.string().min(1).describe("Bamboo deployment project display name"),
        planKey: z.string().min(1).optional().describe("Build plan key feeding this deployment project, e.g. MAU-MA (speeds up lookup)")
      })
    },
    safe(async ({ deploymentProjectName, planKey }) =>
      text(await getDeploymentStatus(config.bamboo, deploymentProjectName, planKey))
    )
  );

  // ---------------------------------------------------------------------
  // PR Monitoring (Bitbucket + Bamboo combined, per-person)
  // ---------------------------------------------------------------------
  server.registerTool(
    "pr_monitoring_status",
    {
      description:
        "On-demand: list pull requests owned by one person (matched by nickname, e.g. \"Fuad\") " +
        "across all repos configured in pr-monitoring.config.json, each with its combined " +
        "Bitbucket+Bamboo stage: open, declined, merged, building, build_failed, deployed, or " +
        "deploy_failed. Call this fresh every time the user asks to monitor/check pull requests — " +
        "it always queries Bitbucket/Bamboo live, nothing is cached or polled in the background.",
      inputSchema: z.object({
        nickname: z.string().min(1).describe("Nickname from pr-monitoring.config.json, e.g. Fuad, Rahul, Hadi, El, Asraf")
      })
    },
    safe(async ({ nickname }) => {
      const prs = await listTrackedPrsForPerson(config, nickname);
      if (prs.length === 0) {
        return text(`Tidak ada pull request yang tercatat untuk "${nickname}" saat ini.`);
      }
      return text(prs);
    })
  );

  // ---------------------------------------------------------------------
  // Redis Ops (via OpenShift pod exec)
  // ---------------------------------------------------------------------
  server.registerTool(
    "redis_clear_all",
    {
      description:
        "DESTRUCTIVE: wipes the ENTIRE Redis database (FLUSHALL, no undo) for one environment " +
        "(dev, uat, or staging), by generating a fresh OpenShift token and running `redis-cli " +
        "flushall` inside the configured pod via `oc exec`. Requires confirm=true as an explicit " +
        "safeguard — if the caller hasn't clearly confirmed this with the user, call this with " +
        "confirm=false first to get the warning, then ask the user to confirm before retrying " +
        "with confirm=true.",
      inputSchema: z.object({
        environment: z.enum(["dev", "uat", "staging"]).describe("Which environment's Redis to clear"),
        confirm: z
          .boolean()
          .describe("Must be true to actually run FLUSHALL. false returns a warning without touching Redis."),
        username: z.string().min(1).optional().describe("OpenShift username (defaults to configured OPENSHIFT_USERNAME)"),
        password: z.string().min(1).optional().describe("OpenShift password (defaults to configured OPENSHIFT_PASSWORD)")
      })
    },
    safe(async ({ environment, confirm, username, password }) => {
      if (!confirm) {
        return text({
          warning: `This will FLUSHALL (delete every key) in the "${environment}" Redis. This cannot be undone.`,
          action: "Call this tool again with confirm=true only after the user has explicitly confirmed."
        });
      }
      const result = await clearRedisAll(
        config.openshift,
        async () => (await getOpenShiftToken(username, password)).accessToken,
        config.redisOpsConfigPath,
        environment
      );
      return text(result);
    })
  );

  server.registerTool(
    "redis_clear_key",
    {
      description:
        "Deletes one specific Redis key (DEL <key>) for one environment (dev, uat, or staging), " +
        "by generating a fresh OpenShift token and running `redis-cli del <key>` inside the " +
        "configured pod via `oc exec`. Safe to call directly — unlike redis_clear_all, this only " +
        "touches the one named key.",
      inputSchema: z.object({
        environment: z.enum(["dev", "uat", "staging"]).describe("Which environment's Redis to target"),
        key: z.string().min(1).describe("Exact Redis key to delete"),
        username: z.string().min(1).optional().describe("OpenShift username (defaults to configured OPENSHIFT_USERNAME)"),
        password: z.string().min(1).optional().describe("OpenShift password (defaults to configured OPENSHIFT_PASSWORD)")
      })
    },
    safe(async ({ environment, key, username, password }) => {
      const result = await clearRedisKey(
        config.openshift,
        async () => (await getOpenShiftToken(username, password)).accessToken,
        config.redisOpsConfigPath,
        environment,
        key
      );
      return text(result);
    })
  );

  server.registerTool(
    "redis_scan_keys",
    {
      description:
        "Lists Redis keys matching a glob pattern (default \"*\" = all keys) for one environment " +
        "(dev, uat, or staging), using SCAN (cursor-based, non-blocking) rather than KEYS. Returns " +
        "one batch plus a cursor — pass that cursor back in to continue if done=false. For a " +
        "quick look, one call with the default pattern/cursor/count is usually enough.",
      inputSchema: z.object({
        environment: z.enum(["dev", "uat", "staging"]).describe("Which environment's Redis to scan"),
        pattern: z.string().optional().describe("Glob pattern, e.g. \"session:*\" (default: \"*\" = everything)"),
        cursor: z.string().optional().describe("SCAN cursor to continue a previous call (default: \"0\" = start over)"),
        count: z.number().int().positive().max(1000).optional().describe("Approximate batch size hint (default 100)"),
        username: z.string().min(1).optional().describe("OpenShift username (defaults to configured OPENSHIFT_USERNAME)"),
        password: z.string().min(1).optional().describe("OpenShift password (defaults to configured OPENSHIFT_PASSWORD)")
      })
    },
    safe(async ({ environment, pattern, cursor, count, username, password }) => {
      const result = await scanRedisKeys(
        config.openshift,
        async () => (await getOpenShiftToken(username, password)).accessToken,
        config.redisOpsConfigPath,
        environment,
        pattern,
        cursor,
        count
      );
      return text(result);
    })
  );

  server.registerTool(
    "redis_dbsize",
    {
      description: "Returns the total number of keys (DBSIZE) in Redis for one environment (dev, uat, or staging).",
      inputSchema: z.object({
        environment: z.enum(["dev", "uat", "staging"]).describe("Which environment's Redis to check"),
        username: z.string().min(1).optional().describe("OpenShift username (defaults to configured OPENSHIFT_USERNAME)"),
        password: z.string().min(1).optional().describe("OpenShift password (defaults to configured OPENSHIFT_PASSWORD)")
      })
    },
    safe(async ({ environment, username, password }) => {
      const result = await getRedisDbSize(
        config.openshift,
        async () => (await getOpenShiftToken(username, password)).accessToken,
        config.redisOpsConfigPath,
        environment
      );
      return text(result);
    })
  );

  server.registerTool(
    "redis_key_exists",
    {
      description: "Checks whether a Redis key exists (EXISTS key) for one environment (dev, uat, or staging).",
      inputSchema: z.object({
        environment: z.enum(["dev", "uat", "staging"]).describe("Which environment's Redis to check"),
        key: z.string().min(1).describe("Redis key to check"),
        username: z.string().min(1).optional().describe("OpenShift username (defaults to configured OPENSHIFT_USERNAME)"),
        password: z.string().min(1).optional().describe("OpenShift password (defaults to configured OPENSHIFT_PASSWORD)")
      })
    },
    safe(async ({ environment, key, username, password }) => {
      const result = await checkRedisKeyExists(
        config.openshift,
        async () => (await getOpenShiftToken(username, password)).accessToken,
        config.redisOpsConfigPath,
        environment,
        key
      );
      return text(result);
    })
  );

  server.registerTool(
    "redis_get_key",
    {
      description:
        "Reads the value of a Redis string key (GET key) for one environment (dev, uat, or " +
        "staging). Only works for string-type keys — if the key holds a list/set/hash/etc, " +
        "redis-cli's error is returned as-is; call redis_key_info first if the type is unknown.",
      inputSchema: z.object({
        environment: z.enum(["dev", "uat", "staging"]).describe("Which environment's Redis to read"),
        key: z.string().min(1).describe("Redis key to read"),
        username: z.string().min(1).optional().describe("OpenShift username (defaults to configured OPENSHIFT_USERNAME)"),
        password: z.string().min(1).optional().describe("OpenShift password (defaults to configured OPENSHIFT_PASSWORD)")
      })
    },
    safe(async ({ environment, key, username, password }) => {
      const result = await getRedisKey(
        config.openshift,
        async () => (await getOpenShiftToken(username, password)).accessToken,
        config.redisOpsConfigPath,
        environment,
        key
      );
      return text(result);
    })
  );

  server.registerTool(
    "redis_key_info",
    {
      description:
        "Gets a Redis key's type (TYPE) and remaining time-to-live (TTL) together for one " +
        "environment (dev, uat, or staging). ttlSeconds is -1 for \"no expiry\" and -2 for " +
        "\"key does not exist\" — use this before redis_get_key when the key's type is unknown.",
      inputSchema: z.object({
        environment: z.enum(["dev", "uat", "staging"]).describe("Which environment's Redis to check"),
        key: z.string().min(1).describe("Redis key to inspect"),
        username: z.string().min(1).optional().describe("OpenShift username (defaults to configured OPENSHIFT_USERNAME)"),
        password: z.string().min(1).optional().describe("OpenShift password (defaults to configured OPENSHIFT_PASSWORD)")
      })
    },
    safe(async ({ environment, key, username, password }) => {
      const result = await getRedisKeyInfo(
        config.openshift,
        async () => (await getOpenShiftToken(username, password)).accessToken,
        config.redisOpsConfigPath,
        environment,
        key
      );
      return text(result);
    })
  );

  server.registerTool(
    "redis_set_key",
    {
      description:
        "Sets a Redis key to a string value (SET key value), optionally expiring after " +
        "ttlSeconds, for one environment (dev, uat, or staging). Overwrites any existing value " +
        "at that key. Generates a fresh OpenShift token and runs redis-cli inside the configured " +
        "pod via `oc exec`.",
      inputSchema: z.object({
        environment: z.enum(["dev", "uat", "staging"]).describe("Which environment's Redis to target"),
        key: z.string().min(1).describe("Redis key to set"),
        value: z.string().describe("String value to store"),
        ttlSeconds: z.number().int().positive().optional().describe("Optional expiry in seconds (SET ... EX <ttlSeconds>). Omit for no expiry."),
        username: z.string().min(1).optional().describe("OpenShift username (defaults to configured OPENSHIFT_USERNAME)"),
        password: z.string().min(1).optional().describe("OpenShift password (defaults to configured OPENSHIFT_PASSWORD)")
      })
    },
    safe(async ({ environment, key, value, ttlSeconds, username, password }) => {
      const result = await setRedisKey(
        config.openshift,
        async () => (await getOpenShiftToken(username, password)).accessToken,
        config.redisOpsConfigPath,
        environment,
        key,
        value,
        ttlSeconds
      );
      return text(result);
    })
  );

  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("anttech-azzeng-mcp running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting MCP server:", err);
  process.exit(1);
});
