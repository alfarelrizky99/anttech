import { readFileSync } from "node:fs";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import type { HttpTlsConfig, ServiceAuthConfig } from "./config.js";

/**
 * Builds an undici Agent honoring the configured TLS trust settings.
 * Caches one Agent per unique config so we don't allocate a new TLS context per call.
 */
const agentCache = new Map<string, Agent>();

function agentKey(tls: HttpTlsConfig): string {
  return `${tls.rejectUnauthorized}:${tls.caBundlePath ?? ""}`;
}

export function getAgent(tls: HttpTlsConfig): Agent {
  const key = agentKey(tls);
  const cached = agentCache.get(key);
  if (cached) return cached;

  const ca = tls.caBundlePath ? readFileSync(tls.caBundlePath) : undefined;
  const agent = new Agent({
    connect: {
      rejectUnauthorized: tls.rejectUnauthorized,
      ca
    }
  });
  agentCache.set(key, agent);
  return agent;
}

export function buildAuthHeader(auth: ServiceAuthConfig): Record<string, string> {
  if (auth.mode === "bearer") {
    if (!auth.token) {
      throw new Error("Bearer auth selected but no token configured.");
    }
    return { Authorization: `Bearer ${auth.token}` };
  }
  if (!auth.username || !auth.password) {
    throw new Error("Basic auth selected but username/password not configured.");
  }
  const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
  return { Authorization: `Basic ${encoded}` };
}

export interface HttpJsonOptions extends Omit<UndiciRequestInit, "dispatcher"> {
  tls: HttpTlsConfig;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
    url: string
  ) {
    super(`HTTP ${status} ${statusText} for ${url}: ${body.slice(0, 500)}`);
    this.name = "HttpError";
  }
}

/**
 * Performs a fetch against an internal/self-signed-friendly endpoint and returns parsed JSON.
 * Throws HttpError on non-2xx responses.
 */
export async function fetchJson<T = unknown>(url: string, options: HttpJsonOptions): Promise<T> {
  const { tls, ...rest } = options;
  const res = await undiciFetch(url, { ...rest, dispatcher: getAgent(tls) });
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(res.status, res.statusText, text, url);
  }
  if (!text) {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON response from ${url} but got: ${text.slice(0, 200)}`);
  }
}

/**
 * Performs a fetch and returns the raw Response (used when we need headers, e.g. OpenShift's
 * oauth redirect carrying the token in the Location header).
 */
export async function fetchRaw(url: string, options: HttpJsonOptions): Promise<Response> {
  const { tls, ...rest } = options;
  return undiciFetch(url, { ...rest, dispatcher: getAgent(tls) }) as unknown as Promise<Response>;
}
