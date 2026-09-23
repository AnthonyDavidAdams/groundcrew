---
name: record-scan
description: Find and record the official status of every unit in one scope, with source URL and verbatim quote, and submit each as a finding.
---

# Record scan

Argument: a scope, in the task's unit (see `list_tasks`).

## Steps

1. Call `list_records({collection: "records"})` and `get_record` for the scope. Entries with `source` set and `last_verified` within 12 months are done; skip them.
2. Get the full list of units in the scope from the authoritative registry named in `AGENTS.md`. Record each unit's `external_id`.
3. For each unit, find the official document that establishes its status. Search in the order `AGENTS.md` gives, stopping at the first authoritative hit.
4. Classify per the status rules in `AGENTS.md`. Copy the sentence that establishes the status verbatim into `quote`.
5. Call `submit_finding` with the record. If the server says the quote is not at the source, open the source again and fix the quote; do not paraphrase.
6. For `unknown`, put what you searched in `notes`.

## Quality bar

- A status without a quote is `unknown`.
- A document that is silent is `unknown`, not `bans`, unless a higher rule prohibits the practice.

## Before you start

Read `AGENTS.md` (`get_agent_contract`). Claim the scope with `claim_task`. Renew the lease before it expires; release it when you stop.
