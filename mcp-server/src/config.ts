import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";

// Resolve .env relative to this file's own location (project root), not the current working
// directory. The MCP server is spawned by Hermes with an arbitrary cwd (e.g. the user's home
// directory), so a bare `import "dotenv/config"` would silently fail to find the .env file.
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
loadDotenv({ path: resolve(projectRoot, ".env") });

/**
 * Resolves a possibly-relative filesystem path against the project root (not the process's
 * current working directory, which Hermes sets arbitrarily when spawning this server).
 * Absolute paths are returned unchanged.
 */
function resolveFromProjectRoot(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return resolve(projectRoot, path);
}

/**
 * Parses a boolean-ish environment variable. Defaults to `fallback` when unset.
 */
function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

const AuthModeSchema = z.enum(["bearer", "basic"]);

// Treats an empty string the same as "unset" — .env files commonly leave a key present but
// blank (e.g. `JIRA_BASE_URL=`), which should fall back to the field's optionality rather than
// fail URL validation.
const optionalUrl = z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional());
const optionalString = z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());

const envSchema = z.object({
  // --- OpenShift ---
  OPENSHIFT_OAUTH_URL: optionalUrl,
  OPENSHIFT_API_URL: optionalUrl,
  OPENSHIFT_TLS_VERIFY: optionalString,
  OPENSHIFT_CA_BUNDLE_PATH: optionalString,
  OPENSHIFT_TOKEN_TTL_SECONDS: optionalString,
  // Default credentials used for the automated re-authentication flow (e.g. the "/get-token-oc"
  // skill), so the user doesn't have to type their password into WhatsApp every time. Explicit
  // username/password passed to the tool call still take precedence over these.
  OPENSHIFT_USERNAME: optionalString,
  OPENSHIFT_PASSWORD: optionalString,
  // The Kubernetes API server (api.<cluster>:6443) is signed by a DIFFERENT CA than the OAuth
  // ingress route (kube-apiserver-lb-signer vs the ingress operator's cert) — a separate bundle
  // is required for `oc exec`/pod operations even though both point at the same cluster.
  OPENSHIFT_API_CA_BUNDLE_PATH: optionalString,
  // Path to the `oc` CLI binary used for pod exec operations (redis-ops). Defaults to "oc"
  // resolved from PATH.
  OC_BINARY_PATH: optionalString,

  // --- Jira ---
  JIRA_BASE_URL: optionalUrl,
  JIRA_AUTH_MODE: AuthModeSchema.optional(),
  JIRA_TOKEN: optionalString,
  JIRA_USERNAME: optionalString,
  JIRA_PASSWORD: optionalString,
  JIRA_TLS_VERIFY: optionalString,

  // --- Bitbucket ---
  BITBUCKET_BASE_URL: optionalUrl,
  BITBUCKET_AUTH_MODE: AuthModeSchema.optional(),
  BITBUCKET_TOKEN: optionalString,
  BITBUCKET_USERNAME: optionalString,
  BITBUCKET_PASSWORD: optionalString,
  BITBUCKET_TLS_VERIFY: optionalString,

  // --- Bamboo ---
  BAMBOO_BASE_URL: optionalUrl,
  BAMBOO_AUTH_MODE: AuthModeSchema.optional(),
  BAMBOO_TOKEN: optionalString,
  BAMBOO_USERNAME: optionalString,
  BAMBOO_PASSWORD: optionalString,
  BAMBOO_TLS_VERIFY: optionalString
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration. See stderr for details.");
}

const env = parsed.data;

export interface ServiceAuthConfig {
  mode: "bearer" | "basic";
  token?: string;
  username?: string;
  password?: string;
}

export interface HttpTlsConfig {
  rejectUnauthorized: boolean;
  caBundlePath?: string;
}

export interface OpenShiftConfig {
  enabled: boolean;
  oauthUrl?: string;
  apiUrl?: string;
  tls: HttpTlsConfig;
  tokenTtlSeconds: number;
  defaultUsername?: string;
  defaultPassword?: string;
  /** CA bundle for the Kubernetes API server (separate issuer from the OAuth ingress route). */
  apiCaBundlePath?: string;
  /** Path/name of the `oc` CLI binary, resolved via PATH if not absolute. */
  ocBinary: string;
}

export interface RestServiceConfig {
  enabled: boolean;
  baseUrl?: string;
  auth: ServiceAuthConfig;
  tls: HttpTlsConfig;
}

export interface AppConfig {
  openshift: OpenShiftConfig;
  jira: RestServiceConfig;
  bitbucket: RestServiceConfig;
  bamboo: RestServiceConfig;
  prMonitoringConfigPath: string;
  redisOpsConfigPath: string;
}

function buildRestConfig(
  baseUrl: string | undefined,
  authMode: "bearer" | "basic" | undefined,
  token: string | undefined,
  username: string | undefined,
  password: string | undefined,
  tlsVerify: string | undefined
): RestServiceConfig {
  const mode: "bearer" | "basic" = authMode ?? (token ? "bearer" : "basic");
  return {
    enabled: Boolean(baseUrl),
    baseUrl,
    auth: { mode, token, username, password },
    tls: { rejectUnauthorized: envBool(tlsVerify, true) }
  };
}

export const config: AppConfig = {
  openshift: {
    enabled: Boolean(env.OPENSHIFT_OAUTH_URL && env.OPENSHIFT_API_URL),
    oauthUrl: env.OPENSHIFT_OAUTH_URL,
    apiUrl: env.OPENSHIFT_API_URL,
    tls: {
      rejectUnauthorized: envBool(env.OPENSHIFT_TLS_VERIFY, true),
      caBundlePath: resolveFromProjectRoot(env.OPENSHIFT_CA_BUNDLE_PATH)
    },
    tokenTtlSeconds: Number(env.OPENSHIFT_TOKEN_TTL_SECONDS ?? 1800),
    defaultUsername: env.OPENSHIFT_USERNAME,
    defaultPassword: env.OPENSHIFT_PASSWORD,
    apiCaBundlePath: resolveFromProjectRoot(env.OPENSHIFT_API_CA_BUNDLE_PATH),
    ocBinary: env.OC_BINARY_PATH ?? "oc"
  },
  jira: buildRestConfig(
    env.JIRA_BASE_URL,
    env.JIRA_AUTH_MODE,
    env.JIRA_TOKEN,
    env.JIRA_USERNAME,
    env.JIRA_PASSWORD,
    env.JIRA_TLS_VERIFY
  ),
  bitbucket: buildRestConfig(
    env.BITBUCKET_BASE_URL,
    env.BITBUCKET_AUTH_MODE,
    env.BITBUCKET_TOKEN,
    env.BITBUCKET_USERNAME,
    env.BITBUCKET_PASSWORD,
    env.BITBUCKET_TLS_VERIFY
  ),
  bamboo: buildRestConfig(
    env.BAMBOO_BASE_URL,
    env.BAMBOO_AUTH_MODE,
    env.BAMBOO_TOKEN,
    env.BAMBOO_USERNAME,
    env.BAMBOO_PASSWORD,
    env.BAMBOO_TLS_VERIFY
  ),
  prMonitoringConfigPath: resolve(projectRoot, "pr-monitoring.config.json"),
  redisOpsConfigPath: resolve(projectRoot, "redis-ops.config.json")
};
