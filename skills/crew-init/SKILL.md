---
name: crew-init
description: Create a Ground Crew for a new public problem. Interviews the user for the mission, the values, and the first tasks; writes the crew directory with groundcrew init; fills values.md, AGENTS.md, tasks.yaml, and the first schema; runs groundcrew validate. Use when the user says "start a crew", "point agents at this issue", "make a Ground Crew for X", or wants a public-problem project other people's agents can join.
---

# Crew init

Argument: a directory, optionally with the issue in a sentence ("./end-x-crew: end X in Y").

Ground Crew is part of EarthPilot: mission support for Spaceship Earth. Read `SPEC.md` in the `@earthpilot/groundcrew` package (or this repository) before writing anything; sections 1, 8, and 9 are what this skill fills in.

## Interview, in this order

Ask one question at a time. Keep each answer to a sentence or two; the crew will be read by strangers' agents.

1. **Mission.** The outcome in one sentence a stranger understands, and the unit where the decision is actually made (district, county, hospital, employer, legislature). "End X in Y" beats "raise awareness of X".
2. **How it ends.** Who ratifies what, in what order. If the user cannot say, that is the first fact to find, not a task to skip.
3. **Replacement.** What replaces the thing they want gone. A prohibition without a replacement is a demand, not a plan.
4. **The units.** How many are there, where is the authoritative list (a registry with ids), and where does each publish the document that establishes its status.
5. **The status values.** Three to five enum values with a one-line definition each, plus `unknown`. Push back on any value that cannot be established by a verbatim quote from a public document.
6. **The first three claims.** Numbers the user already relies on, with where they came from. Each becomes a claim file with `status: reported` until someone opens the primary source.
7. **Decision-makers.** Which public bodies decide, so the contract can say what is public record about them and what is off limits.
8. **Contact and repo.** Who is accountable, and where the crew will live.

## Write the crew

1. `npx @earthpilot/groundcrew init <dir> --name "<name>" --mission "<mission>"` (or `groundcrew init` if installed).
2. Replace the two paragraphs of `values.md` with the answers to 1 through 3 and the conduct paragraph adapted to this issue. One page at most. Do not remove the second paragraph's commitments; they restate the fixed rules.
3. Rewrite `AGENTS.md`: keep the ten-point contract verbatim, then fill "Tasks you can take", "Status rules" (answer 5), and where the documents live (answer 4), with an example record.
4. Write `data/schema/<unit>.schema.json` for one finding: the unit's name, its registry id, `status` with the enum, `source` (uri), `quote`, `last_verified` (date), `notes`, and an `allOf` making `source` and `quote` required for every non-`unknown` status. Delete `record.schema.json` or point the task at the new file.
5. Rewrite `tasks/tasks.yaml`: the scan task over the units (priority 1), `verify-claim` (priority 2), and anything else the interview produced. Fill `scopes` when the units are grouped by a closed list (states, counties). Point `collection` at where records will live and add the mapping to `crew.json` `collections`.
6. Write one claim file per answer to 6 in `facts/claims/`, delete the example claim.
7. Adapt each `skills/<task>/SKILL.md` so its steps name the real registry, vendors, and search terms.
8. Fill `crew.json`: `repo`, `site`, `contact`. Leave `auto_merge.enabled` false.

## Validate and hand over

1. Run `groundcrew validate <dir>` and fix everything it reports. A note about an unmapped collection means `crew.json collections` is missing an entry.
2. Start the server once to be sure it loads: `GROUNDCREW_MAINTAINER_TOKEN=test groundcrew serve <dir> --http --port 3000`, `curl localhost:3000/healthz`, stop it.
3. Tell the user: what was written, the three things they must still do by hand (verify the first claims, put the crew in a repository, deploy the server with a real token), and the one-link story they can give supporters (README.md, "The one-link story").

## Do not

- Do not invent claims, sources, or numbers. A claim the user cannot source is `reported` with the secondary source named, or it is not written.
- Do not add any status value that needs a judgment call rather than a quote.
- Do not weaken `CODE_OF_CONDUCT.md`. Rules 1 through 5 are the protocol's; a crew may add, never remove.
- No emoji anywhere in the crew.
