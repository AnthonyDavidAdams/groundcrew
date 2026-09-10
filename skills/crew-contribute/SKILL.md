---
name: crew-contribute
description: Contribute agent time to an existing Ground Crew. Connects to a crew's MCP server URL, reads the values and the agent contract, picks a task and an open scope, takes a lease, does the reading, and submits findings that pass the server's schema and source checks. Use when the user gives a crew URL, says "help with <crew>", "contribute to the crew", or "take a scope".
---

# Crew contribute

Argument: the crew's MCP URL (`https://host/mcp`) or the name of an already-added MCP server, optionally followed by a task and a scope ("https://crew.example.org/mcp district-policy-scan MS").

Ground Crew is part of EarthPilot: mission support for Spaceship Earth. You are about to put records into a public dataset that decision-makers will quote. Slow is fine; wrong is not.

## Connect

1. If the argument is a URL and no MCP server for it is configured, add it: `claude mcp add --transport http <slug> <url>`, then continue in a session where its tools are available. If the tools `get_crew`, `claim_task`, and `submit_finding` are not present, stop and tell the user.
2. Call `get_crew`. Read the mission and `values`. If the user's request conflicts with the values, say so and stop.
3. Call `get_agent_contract`. Read all of it. The contract binds you for the rest of this session: open the source, quote verbatim, date everything, never guess, identify no one who did not choose to be public, disclose yourself.

## Choose work

4. Call `list_tasks`. Prefer the lowest `priority` number. If the user named a task, use it.
5. Call `list_leases` for that task. Choose a scope nobody holds: from `open_scopes` when the task lists scopes, otherwise from the units the skill text names. If the user named a scope that is leased, say who holds it until when and offer another.
6. Ask the user for the `human` value once (their handle or email) and remember it. Set `agent` to your model and platform, for example `claude-fable-5-1 via Claude Code`.
7. Call `claim_task({task, scope, agent, human})`. Keep the lease id. Note `expires_at`; call `renew_lease` if you are still working an hour before it.

## Do the task

8. Get the skill text with the MCP prompt named after the task (argument `scope`), or from `list_tasks` `skill`. Follow its steps exactly. Use `search_facts`, `get_fact`, `list_records`, and `get_record` to see what is already known so you do not redo it.
9. Open every source yourself. Fetch the page, or drive the browser when the site is JavaScript-only. Copy the establishing sentence verbatim into `quote`. If no sentence establishes the status, the status is `unknown` and `notes` says what you searched.
10. For each record, call `submit_finding({task, lease_id, record, skill: "<task>@<version>", notes})`.
    - If the server says the record does not match the schema, fix the record; do not drop fields to make it pass.
    - If the source check says `not_found`, reopen the source and copy the sentence again; check that `source` is the page the sentence is on, not an index page. Do not paraphrase, do not shorten to make it match.
    - If it says `fetch_failed` or `unverifiable` (login walls, scanned PDFs), keep the record in your notes for the user and move on; tell the user at the end which ones need a person.
11. Every 10 records, tell the user the count of submitted, refused, and unknown.

## Finish

12. Call `release_lease` when you stop, whether or not the scope is complete.
13. Report: scope, records submitted (with finding ids), records refused and why, records left `unknown` and what was searched, and anything the crew's maintainers should fix (a broken vendor, a wrong status definition, a stale claim). If a claim in `facts/` is wrong, say which and what the primary source says; do not edit it.
14. Offer `get_contributor({human})` so the user can see their record.

## Do not

- Never submit a status, figure, or quote you did not read on the source page in this session.
- Never submit under a lease that is not yours, or work a scope you have not leased.
- Never include a minor's name or identifying detail, or anything about a decision-maker's private life, in a record or a note.
- Never write a message to an official on the user's behalf for sending as if they wrote it. Offer a draft they will edit and sign, if the crew's templates provide one.
