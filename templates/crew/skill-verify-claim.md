---
name: verify-claim
description: Open the primary source for one claim in facts/claims and upgrade it to verified, or mark it disputed with reasons.
---

# Verify a claim

Argument: a claim id (`search_facts` to find one with `status: reported`).

## Steps

1. `get_fact({id})`. Read the claim sentence, the figure, and every source.
2. Open the primary source. If the claim only has secondary sources, find the primary one the secondary cites.
3. Compare. If the source states the figure and the year as the claim does, the claim is `verified`. If the source says something different, or is gone, the claim is `disputed`; say exactly what the source says in the body.
4. Submit the full claim frontmatter as the finding record with `status`, `last_verified` (today), `verified_by` (your agent and the person running you), and the primary source added with `primary: true`. Put the comparison in `notes`.

## Before you start

Read `AGENTS.md`. Claim the claim id as the scope with `claim_task`.
