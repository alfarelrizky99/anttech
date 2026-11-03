import type { OpenShiftConfig } from "../config.js";
import { fetchRaw } from "../httpClient.js";

export interface OpenShiftTokenResult {
  accessToken: string;
  tokenType: string;
  expiresInSeconds: number;
}

/**
 * Requests a short-lived OpenShift OAuth token using the built-in internal OAuth server's
 * "challenging client" implicit flow, equivalent to what `oc login -u <user> -p <password>` does
 * under the hood. This only works against clusters whose identity provider supports a password
 * challenge (HTPasswd, LDAP, Keystone, etc.) — pure SSO/OIDC-only providers will reject it.
 *
 * Flow:
 *   GET {oauthUrl}/oauth/authorize?response_type=token&client_id=openshift-challenging-client
 *   Authorization: Basic <user:pass>
 *   X-CSRF-Token: <any-nonempty-value>
 *
 * On success the server responds with a redirect (302) whose Location header contains
 * `#access_token=...&expires_in=...&token_type=...` in the URL fragment.
 */
export async function requestOpenShiftToken(
  cfg: OpenShiftConfig,
  username: string,
  password: string
): Promise<OpenShiftTokenResult> {
  if (!cfg.oauthUrl) {
    throw new Error("OpenShift OAuth URL is not configured (OPENSHIFT_OAUTH_URL).");
  }

  const basic = Buffer.from(`${username}:${password}`).toString("base64");
  const url = new URL("/oauth/authorize", cfg.oauthUrl);
  url.searchParams.set("response_type", "token");
  url.searchParams.set("client_id", "openshift-challenging-client");

  const res = await fetchRaw(url.toString(), {
    method: "GET",
    redirect: "manual",
    headers: {
      Authorization: `Basic ${basic}`,
      "X-CSRF-Token": "1"
    },
    tls: cfg.tls
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error("OpenShift rejected the credentials (401/403). Check username/password.");
  }

  const location = res.headers.get("location");
  if (!location || (res.status !== 302 && res.status !== 303)) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `OpenShift did not return a redirect carrying a token (status ${res.status}). ` +
        `This cluster's identity provider may not support password challenges (e.g. SSO/OIDC-only). ` +
        `Body: ${body.slice(0, 300)}`
    );
  }

  const fragment = location.split("#")[1];
  if (!fragment) {
    throw new Error(`OpenShift redirect had no token fragment. Location: ${location}`);
  }
  const params = new URLSearchParams(fragment);
  const error = params.get("error");
  if (error) {
    throw new Error(`OpenShift OAuth error: ${error} ${params.get("error_description") ?? ""}`.trim());
  }
  const accessToken = params.get("access_token");
  if (!accessToken) {
    throw new Error(`OpenShift redirect fragment had no access_token. Fragment: ${fragment}`);
  }

  return {
    accessToken,
    tokenType: params.get("token_type") ?? "Bearer",
    expiresInSeconds: Number(params.get("expires_in") ?? cfg.tokenTtlSeconds)
  };
}

/**
 * Masks a token for safe display, e.g. in chat confirmations: keeps the first/last 4 chars.
 */
export function maskToken(token: string): string {
  if (token.length <= 10) return "****";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}
