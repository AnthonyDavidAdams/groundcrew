# Ground Crew protocol, version 0.1

Ground Crew ("Crew" for short) is a protocol for pointing many people's AI agents at one public problem. It defines a directory layout for a crew, an MCP surface a server exposes over that directory, the checks a server runs on incoming findings, and the rules a crew may not break. This document is the normative reference; `server/` is the reference implementation. Ground Crew is part of EarthPilot: mission support for Spaceship Earth.

Words in capitals (MUST, SHOULD, MAY) carry their usual meaning.

## 1. Crew directory layout

A crew is a directory. Everything an agent needs is in it; the server adds nothing but state.

```
crew.json               name, mission, links, configuration
values.md               the values file (section 8)
AGENTS.md               the agent contract
CODE_OF_CONDUCT.md      the conduct rules; includes the fixed rules (section 9)
facts/claims/*.md       the claims registry, one claim per file
tasks/tasks.yaml        the task queue
data/schema/*.json      JSON schemas (draft 2020-12)
data/<collection>/**    records; a collection is a directory under data/, an id is a filename without extension
templates/*.md          optional prose templates (letters, testimony, model policy)
skills/<task>/SKILL.md  the skill each task's `skill` field points at (any path under the crew works)
```

### 1.1 `crew.json`

```json
{
  "name": "End School Corporal Punishment",
  "mission": "End the legal hitting of students in US public schools, district by district and then state by state.",
  "repo": "https://github.com/AnthonyDavidAdams/end-school-corporal-punishment",
  "site": "https://earthpilot.org/kids/",
  "contact": "a@175g.com",
  "maintainer_token_env": "GROUNDCREW_MAINTAINER_TOKEN",
  "lease_ttl_hours": 4,
  "auto_merge": { "enabled": false, "min_approved": 10, "min_approval_rate": 0.9 },
  "collections": { "districts": "data/schema/district.schema.json" }
}
```

`name` and `mission` are required. `maintainer_token_env` names the environment variable holding the maintainer token (default `GROUNDCREW_MAINTAINER_TOKEN`). `collections` maps a collection name to the schema that validates its records; when absent the validator looks for `data/schema/<collection>.schema.json`, then the singular.

### 1.2 `facts/claims/*.md`

One claim per file: YAML frontmatter validated by [`schemas/claim.schema.json`](schemas/claim.schema.json), then a Markdown body explaining what the number counts and how to use it, then a `## History` list.

```markdown
---
id: crdc-national-total-2021-22
claim: "In the 2021-22 school year, 24,534 students received corporal punishment in US public schools."
status: verified
figure: 24534
as_of: "2021-22"
sources:
  - url: https://civilrightsdata.ed.gov/...
    title: "..."
    publisher: US Department of Education, Office for Civil Rights
    date: 2024-01-01
    primary: true
supersedes: null
superseded_by: null
tags: [crdc, national]
last_verified: 2026-09-09
verified_by: "agent:claude run by a@175g.com"
---
```

Required: `id` (equals the filename), `claim`, `status`, `sources` (at least one, each with `url`), `last_verified`. `status` is one of:

| status | meaning | may be published? |
|---|---|---|
| `verified` | someone opened the primary source and the claim matches it, on `last_verified` | yes |
| `reported` | only a secondary source has been checked | only as "according to <source>" |
| `disputed` | sources conflict or the source is gone | no |
| `retired` | superseded by a newer claim; `superseded_by` MUST name it | no |

Rules: the claim sentence names the data year; ratios name both sides; a figure is never edited in place. A newer year is a new claim with `supersedes` set, and the old one is retired with `superseded_by`.

### 1.3 `data/`

`data/schema/*.json` holds the crew's JSON schemas. Every other file under `data/` that ends in `.json`, `.yaml`, or `.yml` is a record; its collection is its directory path under `data/` (for example `districts` or `crdc/2021-22`) and its id is its filename without extension. Records in a collection MUST validate against the collection's schema (section 1.1).

### 1.4 `tasks/tasks.yaml`

```yaml
tasks:
  - id: district-policy-scan        # also the MCP prompt name
    title: District policy scan
    description: Find every district's corporal punishment policy in one state, with source and verbatim quote.
    unit: One state, or a slice of a large state
    output: Entries in data/districts/<XX>.yaml
    priority: 1                      # 1 is highest
    schema: data/schema/district-finding.schema.json   # what one finding must satisfy
    skill: skills/district-policy-scan/SKILL.md
    collection: districts            # where approved findings merge
    scopes: [AL, AR, AZ, FL, GA]     # optional closed list; omit to accept any non-empty scope
    done_means:
      - Every non-unknown status has source, quote, last_verified.
```

Each entry is validated by [`schemas/task.schema.json`](schemas/task.schema.json). `schema` is the schema for one finding, not for a whole data file.

### 1.5 `AGENTS.md` and `CODE_OF_CONDUCT.md`

`AGENTS.md` is the contract every agent reads before working: open the source, primary sources first, quote verbatim, date everything, never guess, identify no one who did not choose to be public, one scope per lease, disclose yourself. It also carries the crew-specific knowledge: where documents live, the status definitions, an example record. `CODE_OF_CONDUCT.md` states the conduct rules and MUST include the fixed rules in section 9. `get_agent_contract` returns both.

## 2. The MCP surface

A Ground Crew server speaks MCP over stdio and Streamable HTTP (`POST /mcp`), and answers `GET /healthz` with `{ok: true, crew, version, claims, tasks, leases_active, pending}`. Every tool returns JSON as a text content block; refusals set `isError: true` and explain why in the text.

### 2.1 Reading the crew

| Tool | Input | Output |
|---|---|---|
| `get_crew` | none | `{name, mission, values, links: {repo, site, docs, contact}, protocol, server_version, lease_ttl_hours, auto_merge, counts}` |
| `get_agent_contract` | none | the text of `AGENTS.md`, then `CODE_OF_CONDUCT.md` |
| `list_tasks` | none | `{count, tasks: [{id, title, description, unit, output, priority, schema, skill, collection, scopes, done_means, leased_scopes, open_scopes}]}` |
| `search_facts` | `{query, status?}` | `{query, status, count, results: [{id, claim, status, figure, as_of, primary_source, last_verified}]}`. Every word in `query` must match the id, sentence, tags, body, or `as_of`, case-insensitively. Retired claims are excluded unless `status` is given. |
| `get_fact` | `{id}` | the claim's frontmatter plus `body`; an error naming similar ids if not found |
| `list_records` | `{collection?, limit?, offset?, include_records?}` | without `collection`: `{collections: [{name, count}]}`; with: `{collection, count, offset, limit, ids, records?}` |
| `get_record` | `{collection, id}` | `{collection, id, record}` |
| `get_template` | `{name?}` | one template's Markdown, or the list; present only if the crew has `templates/` |

### 2.2 Leases

A lease is the unit of coordination. It says one agent, run by one person, holds one scope of one task until a time. Scopes compare case-insensitively with whitespace collapsed.

| Tool | Input | Output |
|---|---|---|
| `claim_task` | `{task, scope, agent, human}` | a lease `{id, task, scope, agent, human, created_at, expires_at, renewed}` ([`schemas/lease.schema.json`](schemas/lease.schema.json)). `expires_at` is now plus the TTL, default 4 hours (`crew.json lease_ttl_hours`, env `GROUNDCREW_LEASE_TTL_HOURS`). MUST refuse when an unexpired, unreleased lease exists for the same task and scope, returning that lease. MUST refuse a scope not in the task's `scopes` list when one is given. |
| `renew_lease` | `{lease_id}` | the lease with `expires_at` moved to now plus TTL. An expired lease MAY be renewed if nobody has taken the scope since. |
| `release_lease` | `{lease_id}` | `{released: true, ...lease}`. Findings already submitted under it are unaffected. |
| `list_leases` | `{task?}` | `{count, leases}` of unexpired, unreleased leases |

`agent` is the model and platform ("claude-fable-5-1 via Claude.ai"); `human` is the handle or email of the person running it. Both are copied onto every finding submitted under the lease.

### 2.3 Findings

| Tool | Input | Output |
|---|---|---|
| `submit_finding` | `{task, lease_id, record, skill?, notes?}` | on success `{id, status, task, scope, source_check, disclosure: {agent, human, skill, timestamp}}` with `status` `pending` (or `approved` under auto-merge). On failure an error and nothing stored. |
| `list_pending` | `{task?, limit?}` | `{count, findings}` of findings with status `pending`, each the full stored envelope |
| `review_finding` | `{id, decision, reviewer, note?, token?}` | `{id, status, review: {decision, reviewer, note, at}, contributor}`. `decision` is `approved` or `rejected`. Requires the maintainer token as `token` or as an HTTP `Authorization: Bearer` header; refused otherwise. Only `pending` findings can be reviewed. |
| `get_contributor` | `{agent?, human?}` | `{agent, human, pending, approved, rejected, approval_rate, first_seen, auto_merge}` where `approval_rate` is approved over (approved plus rejected), null when nothing is decided |

`submit_finding` MUST, in order:

1. refuse if the task is unknown, the lease does not exist, belongs to another task, was released, or has expired;
2. validate `record` against the task's `schema` and refuse with the validation errors if it fails;
3. when `record.source` and `record.quote` are both present, fetch `source` (section 3) and refuse if the quote is not found;
4. store the finding as `pending` with the disclosure fields filled from the lease (section 7), unless the contributor qualifies for auto-merge (section 6), in which case store it as `approved` with `review.reviewer = "auto-merge"`.

The stored envelope is [`schemas/finding.schema.json`](schemas/finding.schema.json).

### 2.4 Resources and prompts

Resources: `crew://facts` (every claim as JSON, `application/json`), `crew://tasks` (the task list as JSON). The reference server also serves `crew://values` and `crew://contract` as `text/markdown`.

Prompts: one per task, named after the task id, with an optional `scope` argument. It returns the task's skill text, the agent contract, and a one-line reminder of the claim, submit, release sequence, followed by `Scope: <scope>` when one was given.

## 3. Validation rules

**Schema.** A finding's `record` MUST validate against the task's JSON schema (draft 2020-12, formats enforced). A crew's `validate` step MUST also check every claim's frontmatter against the claim schema, every record under `data/` against its collection's schema, and every task entry against the task schema; the id in a claim MUST equal its filename; retired claims MUST name `superseded_by`.

**Source check.** When a record has `source` and `quote`:

- `source` MUST be an `http` or `https` URL. The server fetches it with redirects followed, a timeout (20 seconds in the reference server), and a size cap (8 MB).
- HTML is reduced to text (scripts, styles, comments, and tags removed; common entities decoded). Plain text is used as is. PDFs are handled best-effort; when no text can be extracted the result is `unverifiable`.
- Both the quote and the text are normalized: curly quotes and dashes straightened, whitespace collapsed to one space, lowercased. The first 120 characters of the normalized quote MUST appear in the normalized text.
- Results: `matched`, `not_found`, `fetch_failed` (network error, non-2xx, wrong scheme, too large), `unverifiable`, or `skipped` (no source and quote pair). Only `matched` and `skipped` allow storage.

The check proves the words are on the page. It does not prove the page is the right one or that the status reading is correct; that is what review is for. A server MAY additionally archive the source at fetch time.

**Identity.** The server cannot check that an agent opened the source itself, that `human` is a real person, or that `agent` is truthful. The contract and the review step carry that weight; reputation (section 6) makes lying expensive over time.

## 2.5 Server identity

A crew supplies its own identity, so a connector list shows the crew rather than the engine. In `crew.json`:

```json
"title": "End School Corporal Punishment",
"description": "One line, shown under the name in a connector list.",
"site": "https://earthpilot.org/kids/",
"icons": [
  { "src": "https://.../icon-512.png", "mimeType": "image/png", "sizes": ["512x512"] },
  { "src": "https://.../icon-48.png",  "mimeType": "image/png", "sizes": ["48x48"] }
]
```

These map to the MCP `serverInfo` fields `title`, `description`, `websiteUrl` and `icons`. Icon `src` must be an absolute http or https URL; anything else is dropped rather than passed through. Supply several sizes, and remember that a wordmark that reads at 512 pixels will be a smudge at 48: use the mark alone for the small sizes.

## 2.6 Documents and crew tools

`fetch_document` downloads a document once, extracts its text on the server, and returns only the passages matching the caller's terms with page numbers and context, plus a detected table of contents, or a named page range. The extraction is cached by URL with its SHA-256, byte size, content type and fetch time, held under one lock per URL so parallel agents share a single download, and it is the copy `submit_finding` checks a quote against, so a contributor is verified against the text they read. A Wayback save is fired without blocking. Documents over 25 MB are refused; a PDF yielding under 200 characters a page comes back with `needs_ocr`, which is the signal to read it by hand and submit with `source_text`. A crew sets its default search terms with `document_terms` in `crew.json`.

Anything specific to one problem domain belongs to the crew, not the engine. A crew may put a `tools.mjs` in its directory exporting `registerTools(server, ctx, helpers)`; the server loads it at startup and the tools appear alongside the built-in ones. The campaign that prompted this uses it for two: finding a school district's handbook across the six vendors that host most of them, and reading Texas board policy, which serves text to a browser and refuses a plain fetch. Neither belongs in an engine that is meant to work for any public problem.

## 3a. Source verification

`submit_finding` fetches `source` and requires the first 120 characters of the normalized `quote` to appear in the extracted text. HTML is reduced to text; PDFs are parsed with a pure-JS extractor, falling back to reading uncompressed text operators.

A source the server cannot read is not a reason to lose the work. When extraction yields nothing usable, or the server cannot reach a page the agent could, the agent resubmits with `source_text`: the text it extracted itself, containing the quoted sentence. The quote is checked against that text and the finding is stored with `source_check.status = "agent_text"` and `needs_human: true`. Agent-supplied text never auto-merges, whatever the contributor's reputation, because the chain of evidence runs through the agent rather than the document.

Statuses: `matched`, `agent_text`, `not_found`, `fetch_failed`, `unverifiable`, `skipped`.

## 3b. The feedback queue

`report_issue` takes a `kind` of `bug`, `feature` or `question`, a title under 120 characters, and a body. `context` carries whatever a maintainer needs, including the record that would not submit; passing a `lease_id` fills in the task, scope, agent and human automatically.

Before filing, the server compares the title against open issues by word overlap and returns a near match rather than creating a duplicate. An agent that genuinely has something new calls again with `confirm_new`. This matters more with agents than with people: an agent that hits the same limitation on forty districts will otherwise file it forty times.

Each issue is written to `<issues dir>/<yyyy-mm-dd>-<slug>.yaml` so it can be reviewed in a diff and committed, and held in state so the tools can list and dedup. The directory defaults to an `issues` folder beside the state file, which on a container should be the mounted volume; `GROUNDCREW_ISSUES_DIR` overrides it. When `GITHUB_TOKEN` is set and the crew has a GitHub repo, the issue is also opened there and labelled by kind, and the URL stored on the record; without a token the response carries a prefilled issue URL instead.

`list_issues` filters by kind and status. `triage_issue` sets a status (`open`, `triaged`, `done`, `wontfix`) and needs the maintainer token. `report_bug` and `request_feature` remain as aliases for one release.

## 3c. Orientation

`get_started` is the first call: what the crew is, what contributing means, the exact sequence, and the highest-priority tasks with their scopes. The same guidance is sent as the server's MCP `instructions` on initialize, so a client that surfaces those shows it without a tool call.

## 4. Leases

A lease exists so two agents do not read the same thousand pages. It is not a lock on the truth: findings from an expired lease are refused, and a scope can be re-claimed when its lease expires or is released. Servers SHOULD prune leases that ended more than seven days ago. Servers SHOULD keep the TTL short (four hours by default) because most agent sessions are shorter than that, and SHOULD let an agent renew as often as it likes.

## 5. Review

Every stored finding is `pending` until a maintainer decides. A maintainer is whoever holds the crew's maintainer token. Reviewers look at the record, the source check result, the notes, and the disclosure, and open the source when the reading of it is what matters. Approved findings are merged into the crew's `data/` (and `facts/`) by the maintainers; the reference CLI prints them with `groundcrew findings <dir>`. A rejected finding stays in the state file with the reviewer's note so the contributor's record reflects it.

## 6. Reputation and auto-merge

A contributor is identified by `human` (the accountable party) and, secondarily, by `agent`. The contributor record is counts of `pending`, `approved`, and `rejected` findings and the `approval_rate`.

A crew MAY allow findings from trusted contributors to merge without review by setting in `crew.json`:

```json
"auto_merge": { "enabled": true, "min_approved": 10, "min_approval_rate": 0.9 }
```

When enabled, a submission whose `human` has at least `min_approved` approved findings and an approval rate of at least `min_approval_rate` is stored as `approved` with `review.reviewer = "auto-merge"`. The default is off. Auto-merge never bypasses the schema or source checks.

## 7. Disclosure

Every stored finding MUST carry:

| field | source |
|---|---|
| `agent` | from the lease: model and platform |
| `human` | from the lease: the person who ran the agent |
| `skill` | from the submission, defaulting to the task's skill name |
| `timestamp` | server time at submission, ISO 8601 |

These fields are returned by `list_pending`, kept when the finding is merged into the crew's data or its history, and never stripped. Agents are held to the same rules as the people who run them.

## 7a. Telling contributors what happens to their work

A crew that feeds anything other than its own public mission must say so where a contributor will see it, in `AGENTS.md` and in the `brief` block that `get_started` returns to the human. Name what stays open, name what may become commercial, and say plainly that the contributor's own subscription is paying for the reading either way. Offer the contributions that feed only the public mission as an alternative.

This is not a legal formality. People lend an agent to a cause; if the work also feeds a business, they are entitled to know before they start rather than after.

## 8. The values file

`values.md` is one page. It says what the crew is for, where the decision is actually made, how it ends, what replaces the thing the crew wants gone, and how the crew behaves. Every task, every ask, and every published record must be consistent with it. It is served in full by `get_crew` and as `crew://values` because it is the first thing an agent should read and the thing a contributor can hold the maintainers to.

## 9. What a crew must never do

These rules are part of the protocol. A crew may add rules; it may not remove these. A server implementing the protocol SHOULD refuse to serve a crew whose `CODE_OF_CONDUCT.md` contradicts them.

1. **Public record only.** Nothing from private or friends-only accounts; nothing about anyone's family, health, finances, or home. If a person would be surprised the public can read it, it does not go in.
2. **Real people speak for themselves.** No message to a decision-maker is sent under a name that did not write it. Tools may help a person draft; they never invent one. No synthetic voices, no coordinated pile-ons.
3. **No minors identified.** Never a child's name, image, or identifying detail, even from published news. The same protection extends to victims and private individuals.
4. **Decisions are made by humans.** Agents read, count, verify, map, and draft. People decide what is published, what is asked for, and who is contacted, under their own names. No contact at home; no contacting employers.
5. **Disclosure on every record.** Agent, human, skill, timestamp, always.

## 10. Conformance

A server is a Ground Crew server if it exposes the tools in section 2 with the stated names and shapes, enforces section 2.3's four steps in `submit_finding`, requires a maintainer token for `review_finding`, keeps section 7's fields on every finding, and serves a crew that satisfies section 1 and section 9. The reference server and its test (`npm test`) are the executable form of this list.
