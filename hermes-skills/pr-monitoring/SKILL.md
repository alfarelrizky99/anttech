---
name: pr-monitoring
description: Check pull request progress (Bitbucket + Bamboo) for a team member.
version: 0.1.0
author: AntTech
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [bitbucket, bamboo, pull-request, monitoring]
    related_skills: []
---

# PR Monitoring Skill

Pure on-demand lookup of pull request progress across every repo configured in
`pr-monitoring.config.json`, combining Bitbucket PR state with the Bamboo build/deployment that
follows it. Backed by the `pr_monitoring_status` tool from the `anttech-azzeng` MCP server, which
queries Bitbucket/Bamboo live on every call — there is no background polling, cron job, or cached
state. Nothing happens until a user asks.

## When to Use

- User asks "monitoring pull request", "cek PR [nama]", "PR [nama] gimana", or similar
- User asks about their own or someone else's open/merged PRs and build/deploy status

Don't use for: a single specific PR by number/URL — that's `bitbucket_get_pull_request` instead.

## Prerequisites

- The `anttech-azzeng` MCP server must be registered and enabled.
- `pr-monitoring.config.json` must have real people/repos filled in (no `GANTI_` placeholders
  left) — if the tool errors about placeholders, tell the user the config isn't finished yet,
  don't try to work around it.

## Procedure

1. Figure out whose PRs to check:
   - If the user named someone ("cek PR Fuad"), use that nickname.
   - If the user said "PR saya" / didn't name anyone and you know who they are (their WhatsApp
     number matches a `whatsapp` entry in the config), use their own nickname.
   - If ambiguous, ask which person/nickname to check rather than guessing.
2. Call `pr_monitoring_status` with that `nickname`.
3. Present the result as a short list, one line per PR: title (trimmed), stage in plain Indonesian
   (lihat tabel di bawah), and the Bitbucket URL. Group by repo if the person has PRs in more than
   one repo.
4. If the tool returns an empty result, say plainly that this person has no tracked PRs right now
   — don't invent one.

## Stage → wording

| `stage` value | Tampilkan sebagai |
|---|---|
| `open` | masih open, nunggu review |
| `declined` | declined |
| `merged` | sudah di-merge |
| `building` | lagi di-build di Bamboo |
| `build_failed` | build gagal |
| `deployed` | sudah deploy (pakai `stageDetail` buat sebutin environment-nya) |
| `deploy_failed` | deployment gagal |

## Pitfalls

- A PR's Bamboo stage only resolves when that repo has `bambooPlanKey` configured — otherwise it
  stops at `merged` with no build/deploy detail. That's expected, not a bug; don't apologize for it.
- `nickname` matching is case-insensitive but must otherwise match an entry in
  `pr-monitoring.config.json` exactly — "Fuad" works, "fuad adhim" (full name) will not match
  unless that's literally the configured nickname.

## Verification

- A non-empty result lists at least one PR with a `stage` field recognized above. That's enough
  to confirm the call worked.
