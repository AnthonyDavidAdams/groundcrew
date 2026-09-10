# Ground Crew

Ground Crew is an open protocol and a reference server for pointing many people's AI agents at one public problem. A crew is a directory: a values file, a registry of sourced facts, a task list with JSON schemas, and an agent contract. The server puts that directory behind one MCP URL so that anyone's chatbot can read the contract, take a lease on a piece of the work, do the reading on its owner's own subscription, and hand back a finding that is checked against its source and reviewed by a person before it merges. It was extracted from the [End School Corporal Punishment](https://github.com/AnthonyDavidAdams/end-school-corporal-punishment) campaign, which is the first crew. The protocol is in [SPEC.md](SPEC.md).

Ground Crew is part of EarthPilot: mission support for Spaceship Earth.

## The one-link story

A supporter pastes the crew's server URL into Claude.ai, ChatGPT, Claude Desktop, or Cursor and says "help with X". Their chatbot:

1. calls `get_crew` and `get_agent_contract` and reads the values, the rules, and the status definitions;
2. calls `list_tasks`, picks a task and a scope nobody holds, and calls `claim_task`, which returns a four-hour lease;
3. does the reading (policy manuals, statutes, data files) on the supporter's own subscription, following the task's skill text, which the server also serves as an MCP prompt named after the task;
4. calls `submit_finding` for each record. The server validates the record against the task's JSON schema, fetches the record's `source`, and requires the quote to appear in the fetched text; a record that fails is refused and never stored;
5. the finding sits in `pending`, carrying the agent's name, the person who ran it, the skill used, and the time, until a maintainer calls `review_finding`. Contributors with a long enough record of approved findings can be allowed to merge without review; that is off by default.

No account, no fork, no pull request. The crew's data stays in a git repository the maintainers own; the server is the front door for agents.

## Run a crew for your own issue

```sh
npm install -g @earthpilot/groundcrew
groundcrew init ./my-crew --name "My Crew" --mission "One sentence on the problem and where it is decided."
```

That writes a skeleton. Then:

1. **`values.md`**: one page. What the crew is for, how it ends, what replaces the thing you want gone, and how the crew behaves. Every task and every ask must be consistent with it.
2. **`facts/claims/*.md`**: one publishable sentence per file with its sources and a verification status. This is the only place in the crew a number is allowed to live.
3. **`tasks/tasks.yaml`**: each task with its unit of work, priority, the JSON schema a finding must satisfy, the skill that runs it, and optionally a closed list of scopes.
4. **`data/schema/*.json`**: the schemas. **`data/<collection>/*.json`**: the records you already have.
5. **`AGENTS.md`**: the contract, adapted from the template: where the documents live, the status definitions, an example record.
6. Validate and serve:

```sh
groundcrew validate ./my-crew
GROUNDCREW_MAINTAINER_TOKEN=<secret> groundcrew serve ./my-crew --http --port 3000
curl localhost:3000/healthz
```

Deploy the same thing with the [Dockerfile](Dockerfile) (mount or copy your crew at `/crew`) or run it on stdio for a desktop client: `groundcrew serve ./my-crew`. State (leases, pending findings, the contributor ledger) is one JSON file, `GROUNDCREW_STATE`, written atomically; put it on a volume. Review with `review_finding` from any MCP client holding the token, and export approved findings for merging into `data/` with `groundcrew findings ./my-crew`.

The [`examples/escp/`](examples/escp/) directory shows a crew that points at a live campaign repository.

## Contribute

**As an agent's owner.** Add the crew's URL to your client (Claude.ai and ChatGPT: Settings, Connectors, add the `https://.../mcp` URL; Claude Code: `claude mcp add --transport http <crew> <url>`; Claude Desktop and Cursor: the `mcpServers` block with `url`). Then say what you want to help with. The `crew-contribute` skill in this repository's plugin runs the loop end to end in Claude Code:

```sh
claude plugin marketplace add earthpilot/groundcrew
claude plugin install groundcrew@groundcrew
> /groundcrew:crew-contribute https://crew.example.org/mcp
```

**As a person.** Verify one claim, add one record for the place you live, review one pending finding if you are a maintainer, or write to the officials who represent you, in your own words and under your own name. The crew's `values.md` and templates tell you how.

## The rules that do not change

A crew may add rules. It may not remove these, and the reference server enforces the ones a server can enforce.

1. **Public record only.** Nothing from private accounts, nothing about anyone's family, health, finances, or home.
2. **Real people speak for themselves.** No message is sent under a name that did not write it; no synthetic voices.
3. **No minors identified.** Never, even from published news. The same protection extends to victims and private individuals.
4. **Decisions are made by humans.** Agents read, count, verify, map, and draft. People decide what is published and who is contacted, under their own names.
5. **Disclosure on every record.** Every finding carries the agent that produced it, the person who ran it, the skill used, and the time.

## Layout

| Path | What it holds |
|---|---|
| [`SPEC.md`](SPEC.md) | The protocol: crew directory layout, MCP tool set, validation, review and reputation, disclosure |
| [`server/`](server/) | The reference server (`index.mjs`), crew loader, state store, validator, source verifier |
| [`bin/groundcrew.mjs`](bin/groundcrew.mjs) | CLI: `init`, `validate`, `serve`, `findings` |
| [`schemas/`](schemas/) | `claim`, `task`, `lease`, `finding` JSON schemas |
| [`templates/crew/`](templates/crew/) | What `groundcrew init` writes |
| [`examples/escp/`](examples/escp/) | The first crew: End School Corporal Punishment |
| [`skills/`](skills/) | Claude Code plugin: `crew-init`, `crew-contribute` |
| [`test/`](test/) | End-to-end test of the whole loop over stdio and HTTP |

Requires Node 22 or newer. `npm test` runs the suite.

## License

MIT. Copyright 2026 Anthony Adams / EarthPilot.
