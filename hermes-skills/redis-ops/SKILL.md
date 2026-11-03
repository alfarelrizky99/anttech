---
name: redis-ops
description: Full Redis toolkit — scan, read, write, and clear keys for dev/uat/staging.
version: 0.3.0
author: AntTech
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [redis, openshift, devops]
    related_skills: [get-token-oc]
---

# Redis Ops Skill

Reads/writes Redis data on the in-house OpenShift cluster for one of three environments (dev,
uat, staging), by generating a fresh OpenShift token and running `redis-cli` inside the right pod
via `oc exec`. Backed by eight tools from the `anttech-azzeng` MCP server:

| Tool | What it does |
|---|---|
| `redis_scan_keys` | List keys matching a glob pattern (SCAN, cursor-based — not blocking KEYS *) |
| `redis_dbsize` | Total key count for the whole environment |
| `redis_key_exists` | Does one key exist? (EXISTS) |
| `redis_get_key` | Read a string key's value (GET) |
| `redis_key_info` | A key's type + remaining TTL together (TYPE + TTL) |
| `redis_set_key` | Write/overwrite a key, optional TTL (SET ... [EX seconds]) |
| `redis_clear_key` | Delete one key (DEL) |
| `redis_clear_all` | **Destructive**: wipe the whole database (FLUSHALL) |

## When to Use

- User asks to list/browse/search Redis keys (all keys or by pattern), for a named environment
- User asks how many keys exist, or whether a specific key exists
- User asks to read/check the value or TTL of a specific key
- User asks to set/write a Redis key to some value, for a named environment
- User asks to delete/clear one specific Redis key, for a named environment
- User asks to "clear redis", "flush redis", "hapus semua redis", for a named environment

Don't use for: anything about OpenShift tokens on their own (that's `/get-token-oc`), or
Jira/Bitbucket/Bamboo (separate tools).

## Prerequisites

- The `anttech-azzeng` MCP server must be registered and enabled.
- `redis-ops.config.json` must have the target environment filled in (no `GANTI_` placeholder for
  its `execPodPrefix`/`namespace`) — if a tool errors about placeholders, say the environment
  isn't configured yet, don't try to work around it.
- OpenShift credentials must be available (same `OPENSHIFT_USERNAME`/`OPENSHIFT_PASSWORD` the
  `/get-token-oc` flow uses) — every tool here generates its own token internally, no separate
  step needed.

## Procedure

1. Figure out which environment: user must say (or you must confirm) one of `dev`, `uat`,
   `staging`. If not stated and not obvious from context, ask — don't guess an environment,
   especially for a write or destructive operation.
2. **Browsing/listing keys** (`redis_scan_keys`): default pattern `"*"` lists everything in
   batches; narrow with a pattern when the user mentions a prefix/topic (e.g. "key yang ada
   'session'" → `pattern: "*session*"`). One call is usually enough for a quick look — only chain
   cursors if the user explicitly wants an exhaustive list.
3. **Counting keys** (`redis_dbsize`): straightforward, no extra care needed.
4. **Checking one key** (`redis_key_exists`, `redis_key_info`): safe, read-only. Use
   `redis_key_info` when the user asks about TTL/expiry or the key's type; use `redis_key_exists`
   for a plain yes/no.
5. **Reading a value** (`redis_get_key`): only works on string keys. If it errors because the key
   is a different type (list/hash/set), call `redis_key_info` to tell the user what type it
   actually is instead of retrying blindly.
6. **Setting a key** (`redis_set_key`): call it with `environment`, `key`, `value`, and optional
   `ttlSeconds` if the user mentioned an expiry ("berlaku 1 jam" → `ttlSeconds: 3600`). This
   overwrites any existing value at that key — mention that if the user didn't seem aware.
7. **Clearing one key** (`redis_clear_key`): call it directly with `environment` and `key`. Safe
   to run without extra confirmation — it only touches the one named key.
8. **Clearing everything** (`redis_clear_all`): destructive and irreversible (FLUSHALL on the
   whole database for that environment).
   - First call it with `confirm=false` to surface the warning (or just state the warning
     yourself if you're confident the user already understands the scope).
   - Only call it again with `confirm=true` after the user has explicitly said to proceed in this
     conversation turn — a prior unrelated "yes" earlier in the chat doesn't count.
   - Never default to clearing `dev`/`uat`/`staging` "just in case" — always use the environment
     the user actually named.
9. Report back the result plainly: environment, the exact redis-cli command that ran, and its
   output. For `redis_scan_keys`, mention if `done` is false (more keys exist beyond this batch)
   rather than implying the list is complete.

## Pitfalls

- `staging` has no dedicated Redis pod — exec happens from an application pod that happens to
  have `redis-cli` installed. If that pod prefix isn't configured yet, the tool errors clearly;
  pass that error along, don't invent a different pod.
- A pod name has a random suffix that changes on restart — every tool resolves it fresh each
  call, so don't assume a pod name from an earlier turn is still valid.
- `redis_scan_keys` uses SCAN, not KEYS — on a large database one call returns a partial batch
  (`done: false`) by design, not an error. Don't treat a short `keys` list as "that's everything"
  without checking `done`.
- `redis_key_info`'s `ttlSeconds` is `-1` for "no expiry" and `-2` for "key does not exist" — these
  are normal values, not error codes.
- `redis_clear_all` has NO undo. Treat a user's "ya udah clear aja" casually said mid-conversation
  about something else as NOT sufficient confirmation for a specific environment.

## Verification

- `redis_scan_keys` success: result has a `keys` array (possibly empty if the pattern matched
  nothing) and a `cursor`/`done` pair.
- `redis_dbsize` / `redis_key_exists` success: `output` is a number.
- `redis_get_key` success: `output` is the stored string (or empty if the key doesn't exist —
  redis-cli prints nothing for a GET on a missing key, which is different from an error).
- `redis_key_info` success: `type` and `ttlSeconds` are both present.
- `redis_set_key` / `redis_clear_all` success: `output` is `"OK"`.
- `redis_clear_key` success: `output` is `"1"` (deleted) or `"0"` (didn't exist) — both are
  successful calls.
