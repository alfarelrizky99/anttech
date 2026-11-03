---
name: get-token-oc
description: Re-authenticate and generate a fresh OpenShift bearer token on demand.
version: 0.1.0
author: AntTech
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [openshift, devops, token]
    related_skills: []
---

# Get Token OC Skill

Generates (or re-generates, when the previous one expired) a short-lived OpenShift OAuth
bearer token for the in-house cluster, without the user re-typing a username/password every
time. Backed by the `openshift_generate_token` tool from the `anttech-azzeng` MCP server, which
falls back to the server-configured default credentials when none are given in the call.

## When to Use

- User sends `/get-token-oc` or asks "generate/refresh my OpenShift token"
- A previous OpenShift API call failed because the token expired, and the user wants a new one

Don't use for: anything about Jira, Bitbucket, or Bamboo — those have their own tools
(`jira_*`, `bitbucket_*`, `bamboo_*`).

## Prerequisites

- The `anttech-azzeng` MCP server must be registered and enabled in `mcp_servers` config.
- `OPENSHIFT_OAUTH_URL`, `OPENSHIFT_API_URL`, `OPENSHIFT_USERNAME`, `OPENSHIFT_PASSWORD` must be
  set on that MCP server's `.env` for the no-argument (automatic) flow to work.

## Procedure

1. Call the `openshift_generate_token` tool with no arguments (or with explicit
   `username`/`password` if the user provided different ones for this request).
2. Reply with **only** the `ocLoginCommand` value from the tool result, as a single code block,
   nothing else before or after it — the user pastes this straight into their terminal:
   ```
   oc login --token=<token> --server=<api-url>
   ```
   Do not wrap it in a summary, do not mask the token, do not add "Token berhasil di-generate"
   preambles. The command itself is the entire response.
3. Only on the **first** `/get-token-oc` call in a session, append one short line after the code
   block reminding the user the token is a live credential valid for `expiresInSeconds` (converted
   to a human duration). Skip this reminder on repeat calls in the same session — don't repeat it
   every time.

## Pitfalls

- If the tool errors with "did not return a redirect carrying a token", the cluster's identity
  provider likely requires SSO/OIDC login instead of a password challenge — this skill cannot
  help in that case; tell the user directly rather than retrying.
- If the tool errors with 401/403, the configured default credentials are likely stale (password
  rotated) — tell the user to update `OPENSHIFT_PASSWORD` on the MCP server, don't guess at a fix.

## Verification

- A successful call returns `tokenType: "Bearer"` and a non-empty `maskedToken`. That's enough to
  confirm the flow worked; no further check needed.
