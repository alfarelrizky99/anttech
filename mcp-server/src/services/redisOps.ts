import { readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpenShiftConfig } from "../config.js";

const execFileAsync = promisify(execFile);

export type RedisEnvironmentName = "dev" | "uat" | "staging";

export interface RedisEnvironmentMapping {
  namespace: string;
  execPodPrefix: string;
  redisHost: string;
  redisPort: number;
}

interface RedisOpsConfig {
  environments: Record<RedisEnvironmentName, RedisEnvironmentMapping>;
}

const PLACEHOLDER_PATTERN = /^GANTI_/;
const VALID_ENVIRONMENTS: RedisEnvironmentName[] = ["dev", "uat", "staging"];

function loadConfig(path: string): RedisOpsConfig {
  if (!existsSync(path)) {
    throw new Error(`Redis ops config not found at ${path}. Copy redis-ops.config.json and fill in each environment first.`);
  }
  const raw = JSON.parse(readFileSync(path, "utf-8")) as RedisOpsConfig;
  return raw;
}

function resolveEnvironment(cfg: RedisOpsConfig, env: string): RedisEnvironmentMapping {
  const normalized = env.toLowerCase() as RedisEnvironmentName;
  if (!VALID_ENVIRONMENTS.includes(normalized)) {
    throw new Error(`Unknown environment "${env}". Valid values: ${VALID_ENVIRONMENTS.join(", ")}.`);
  }
  const mapping = cfg.environments[normalized];
  if (!mapping) {
    throw new Error(`No Redis mapping configured for environment "${normalized}" in redis-ops.config.json.`);
  }
  if (PLACEHOLDER_PATTERN.test(mapping.execPodPrefix) || PLACEHOLDER_PATTERN.test(mapping.namespace)) {
    throw new Error(
      `redis-ops.config.json still has placeholder values for environment "${normalized}". ` +
        `Fill in namespace/execPodPrefix for real before using this.`
    );
  }
  return mapping;
}

/**
 * Finds one running pod whose name starts with `prefix` in `namespace`, via the OpenShift API
 * (not a local kubeconfig — token/server/CA are passed explicitly per-call). The exact pod name
 * carries a random suffix that changes on every restart, so this is resolved fresh each call
 * rather than hardcoded in config.
 *
 * Uses `-o custom-columns=NAME:.metadata.name` with a server-side Running filter instead of
 * `-o json` — a namespace with many pods/containers can make `-o json` tens of megabytes (seen:
 * ~39MB for ~130 pods here), which blows past a sane subprocess maxBuffer. We only need names.
 */
async function resolveExecPod(
  cfg: OpenShiftConfig,
  token: string,
  namespace: string,
  prefix: string
): Promise<string> {
  if (!cfg.apiUrl) {
    throw new Error("OpenShift API URL is not configured (OPENSHIFT_API_URL).");
  }
  const args = [
    "get",
    "pods",
    "-n",
    namespace,
    "--token",
    token,
    "--server",
    cfg.apiUrl,
    "--field-selector",
    "status.phase=Running",
    "-o",
    "custom-columns=NAME:.metadata.name",
    "--no-headers"
  ];
  if (cfg.apiCaBundlePath) {
    args.push("--certificate-authority", cfg.apiCaBundlePath);
  } else {
    args.push("--insecure-skip-tls-verify");
  }

  const { stdout } = await execFileAsync(cfg.ocBinary, args, { maxBuffer: 2 * 1024 * 1024 });
  const names = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const match = names.find((name) => name.startsWith(prefix));
  if (!match) {
    throw new Error(
      `No running pod starting with "${prefix}" found in namespace "${namespace}". ` +
        `Check redis-ops.config.json's execPodPrefix for this environment.`
    );
  }
  return match;
}

/**
 * Runs `redis-cli <args...>` inside the resolved pod via `oc exec`, targeting the configured
 * Redis host/port for that environment. Returns trimmed stdout.
 */
async function execRedisCli(
  cfg: OpenShiftConfig,
  token: string,
  namespace: string,
  podName: string,
  redisHost: string,
  redisPort: number,
  redisArgs: string[]
): Promise<string> {
  if (!cfg.apiUrl) {
    throw new Error("OpenShift API URL is not configured (OPENSHIFT_API_URL).");
  }
  const args = [
    "exec",
    "-n",
    namespace,
    podName,
    "--token",
    token,
    "--server",
    cfg.apiUrl
  ];
  if (cfg.apiCaBundlePath) {
    args.push("--certificate-authority", cfg.apiCaBundlePath);
  } else {
    args.push("--insecure-skip-tls-verify");
  }
  args.push("--", "redis-cli", "-h", redisHost, "-p", String(redisPort), ...redisArgs);

  const { stdout } = await execFileAsync(cfg.ocBinary, args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export interface RedisOpResult {
  environment: RedisEnvironmentName;
  namespace: string;
  podUsed: string;
  redisHost: string;
  redisPort: number;
  command: string;
  output: string;
}

/**
 * Gets a fresh OpenShift token (reusing the same flow as openshift_generate_token), resolves the
 * exec pod, and returns everything needed to run redis-cli commands against one environment.
 */
async function prepareExec(
  openshift: OpenShiftConfig,
  requestToken: () => Promise<string>,
  redisOpsConfigPath: string,
  environment: string
): Promise<{ mapping: RedisEnvironmentMapping; envName: RedisEnvironmentName; token: string; podName: string }> {
  const config = loadConfig(redisOpsConfigPath);
  const mapping = resolveEnvironment(config, environment);
  const envName = environment.toLowerCase() as RedisEnvironmentName;
  const token = await requestToken();
  const podName = await resolveExecPod(openshift, token, mapping.namespace, mapping.execPodPrefix);
  return { mapping, envName, token, podName };
}

/**
 * Flushes the ENTIRE Redis database for one environment (FLUSHALL) — destructive, no undo.
 */
export async function clearRedisAll(
  openshift: OpenShiftConfig,
  requestToken: () => Promise<string>,
  redisOpsConfigPath: string,
  environment: string
): Promise<RedisOpResult> {
  const { mapping, envName, token, podName } = await prepareExec(openshift, requestToken, redisOpsConfigPath, environment);
  const output = await execRedisCli(
    openshift, token, mapping.namespace, podName, mapping.redisHost, mapping.redisPort, ["flushall"]
  );
  return {
    environment: envName,
    namespace: mapping.namespace,
    podUsed: podName,
    redisHost: mapping.redisHost,
    redisPort: mapping.redisPort,
    command: "FLUSHALL",
    output
  };
}

/**
 * Deletes one specific key from Redis for one environment (DEL <key>).
 */
export async function clearRedisKey(
  openshift: OpenShiftConfig,
  requestToken: () => Promise<string>,
  redisOpsConfigPath: string,
  environment: string,
  key: string
): Promise<RedisOpResult> {
  const { mapping, envName, token, podName } = await prepareExec(openshift, requestToken, redisOpsConfigPath, environment);
  const output = await execRedisCli(
    openshift, token, mapping.namespace, podName, mapping.redisHost, mapping.redisPort, ["del", key]
  );
  return {
    environment: envName,
    namespace: mapping.namespace,
    podUsed: podName,
    redisHost: mapping.redisHost,
    redisPort: mapping.redisPort,
    command: `DEL ${key}`,
    output
  };
}

/**
 * Total number of keys in the database for one environment (DBSIZE).
 */
export async function getRedisDbSize(
  openshift: OpenShiftConfig,
  requestToken: () => Promise<string>,
  redisOpsConfigPath: string,
  environment: string
): Promise<RedisOpResult> {
  const { mapping, envName, token, podName } = await prepareExec(openshift, requestToken, redisOpsConfigPath, environment);
  const output = await execRedisCli(
    openshift, token, mapping.namespace, podName, mapping.redisHost, mapping.redisPort, ["dbsize"]
  );
  return {
    environment: envName,
    namespace: mapping.namespace,
    podUsed: podName,
    redisHost: mapping.redisHost,
    redisPort: mapping.redisPort,
    command: "DBSIZE",
    output
  };
}

/**
 * Checks whether a key exists (EXISTS key) — "1" if present, "0" if not.
 */
export async function checkRedisKeyExists(
  openshift: OpenShiftConfig,
  requestToken: () => Promise<string>,
  redisOpsConfigPath: string,
  environment: string,
  key: string
): Promise<RedisOpResult> {
  const { mapping, envName, token, podName } = await prepareExec(openshift, requestToken, redisOpsConfigPath, environment);
  const output = await execRedisCli(
    openshift, token, mapping.namespace, podName, mapping.redisHost, mapping.redisPort, ["exists", key]
  );
  return {
    environment: envName,
    namespace: mapping.namespace,
    podUsed: podName,
    redisHost: mapping.redisHost,
    redisPort: mapping.redisPort,
    command: `EXISTS ${key}`,
    output
  };
}

/**
 * Reads one key's value (GET key). Only works for string-type keys — redis-cli returns an error
 * for other types (list/set/hash/etc), which is surfaced as-is rather than guessed around.
 */
export async function getRedisKey(
  openshift: OpenShiftConfig,
  requestToken: () => Promise<string>,
  redisOpsConfigPath: string,
  environment: string,
  key: string
): Promise<RedisOpResult> {
  const { mapping, envName, token, podName } = await prepareExec(openshift, requestToken, redisOpsConfigPath, environment);
  const output = await execRedisCli(
    openshift, token, mapping.namespace, podName, mapping.redisHost, mapping.redisPort, ["get", key]
  );
  return {
    environment: envName,
    namespace: mapping.namespace,
    podUsed: podName,
    redisHost: mapping.redisHost,
    redisPort: mapping.redisPort,
    command: `GET ${key}`,
    output
  };
}

export interface RedisKeyInfo extends RedisOpResult {
  key: string;
  type: string;
  ttlSeconds: number; // -1 = no expiry, -2 = key does not exist
}

/**
 * Combines TYPE and TTL for one key into a single result — the two things you almost always
 * want together when inspecting a key (what kind of value is this, and does it expire).
 */
export async function getRedisKeyInfo(
  openshift: OpenShiftConfig,
  requestToken: () => Promise<string>,
  redisOpsConfigPath: string,
  environment: string,
  key: string
): Promise<RedisKeyInfo> {
  const { mapping, envName, token, podName } = await prepareExec(openshift, requestToken, redisOpsConfigPath, environment);
  const type = await execRedisCli(
    openshift, token, mapping.namespace, podName, mapping.redisHost, mapping.redisPort, ["type", key]
  );
  const ttlRaw = await execRedisCli(
    openshift, token, mapping.namespace, podName, mapping.redisHost, mapping.redisPort, ["ttl", key]
  );
  return {
    environment: envName,
    namespace: mapping.namespace,
    podUsed: podName,
    redisHost: mapping.redisHost,
    redisPort: mapping.redisPort,
    command: `TYPE ${key} / TTL ${key}`,
    output: `type=${type} ttl=${ttlRaw}`,
    key,
    type,
    ttlSeconds: Number(ttlRaw)
  };
}

export interface RedisScanResult {
  environment: RedisEnvironmentName;
  namespace: string;
  podUsed: string;
  redisHost: string;
  redisPort: number;
  cursor: string;
  done: boolean;
  keys: string[];
}

/**
 * Lists keys matching a glob pattern (default "*" = everything) using SCAN rather than KEYS —
 * SCAN is cursor-based and doesn't block the whole Redis instance like KEYS does on a large
 * database. One call returns one batch; pass the returned `cursor` back in to continue, or
 * ignore pagination entirely for a quick look (done=false just means there's more beyond this
 * batch, not that anything is wrong).
 */
export async function scanRedisKeys(
  openshift: OpenShiftConfig,
  requestToken: () => Promise<string>,
  redisOpsConfigPath: string,
  environment: string,
  pattern = "*",
  cursor = "0",
  count = 100
): Promise<RedisScanResult> {
  const { mapping, envName, token, podName } = await prepareExec(openshift, requestToken, redisOpsConfigPath, environment);
  const output = await execRedisCli(
    openshift, token, mapping.namespace, podName, mapping.redisHost, mapping.redisPort,
    ["scan", cursor, "match", pattern, "count", String(count)]
  );
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const nextCursor = lines[0] ?? "0";
  const keys = lines.slice(1);
  return {
    environment: envName,
    namespace: mapping.namespace,
    podUsed: podName,
    redisHost: mapping.redisHost,
    redisPort: mapping.redisPort,
    cursor: nextCursor,
    done: nextCursor === "0",
    keys
  };
}

/**
 * Sets one Redis key to a string value (SET key value), optionally with a TTL in seconds
 * (SET key value EX <ttlSeconds>). Overwrites any existing value at that key.
 */
export async function setRedisKey(
  openshift: OpenShiftConfig,
  requestToken: () => Promise<string>,
  redisOpsConfigPath: string,
  environment: string,
  key: string,
  value: string,
  ttlSeconds?: number
): Promise<RedisOpResult> {
  const { mapping, envName, token, podName } = await prepareExec(openshift, requestToken, redisOpsConfigPath, environment);
  const redisArgs = ttlSeconds ? ["set", key, value, "EX", String(ttlSeconds)] : ["set", key, value];
  const output = await execRedisCli(
    openshift, token, mapping.namespace, podName, mapping.redisHost, mapping.redisPort, redisArgs
  );
  return {
    environment: envName,
    namespace: mapping.namespace,
    podUsed: podName,
    redisHost: mapping.redisHost,
    redisPort: mapping.redisPort,
    command: ttlSeconds ? `SET ${key} <value> EX ${ttlSeconds}` : `SET ${key} <value>`,
    output
  };
}
