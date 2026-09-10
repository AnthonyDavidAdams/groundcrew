# End School Corporal Punishment, as a Ground Crew

This is the first crew. The live data does not live here: the claims registry, the state and district records, the CRDC extracts, the agent contract, the templates, and the skills are all owned by the campaign repository, [AnthonyDavidAdams/end-school-corporal-punishment](https://github.com/AnthonyDavidAdams/end-school-corporal-punishment). This directory adds only what Ground Crew needs on top of it:

| File | What it is |
|---|---|
| `crew.json` | Name, mission, links, the maintainer token variable (`ESCP_MAINTAINER_TOKEN`), and the collection-to-schema map |
| `values.md` | Two paragraphs: how it ends, and how the crew behaves, derived from the campaign README and code of conduct |
| `tasks/tasks.yaml` | The campaign's seven tasks (`district-policy-scan`, `crdc-refresh`, `verify-claim`, `bill-watch`, `decision-maker-dossier`, `share-kit`, `training-review`) with priorities, scopes, and finding schemas |
| `schemas/*.json` | One schema per task for what a single finding looks like. The campaign's own `data/schema/` validates whole data files; these validate one submitted record. |
| `link.sh` | Creates the symlinks below |

## How the campaign's server is configured to use it

`GROUNDCREW_CREW` points at a directory that symlinks the campaign's `facts/`, `data/` subdirectories, `tasks/README.md`, `AGENTS.md`, `CODE_OF_CONDUCT.md`, `templates/`, and `skills/`. With the campaign checked out next to this repository:

```sh
cd examples/escp
sh link.sh ../../../end-school-corporal-punishment      # or any path to the checkout
node ../../bin/groundcrew.mjs validate .                 # 141 files checked, 0 failures at the time of writing
ESCP_MAINTAINER_TOKEN=<secret> GROUNDCREW_STATE=/var/groundcrew/escp.json \
  node ../../bin/groundcrew.mjs serve . --http --port 3000
```

After `link.sh` the directory looks like this (arrows are symlinks):

```
crew.json  values.md  tasks/tasks.yaml  schemas/  link.sh
AGENTS.md            -> campaign/AGENTS.md
CODE_OF_CONDUCT.md   -> campaign/CODE_OF_CONDUCT.md
facts/               -> campaign/facts
templates/           -> campaign/templates
skills/              -> campaign/skills
tasks/README.md      -> campaign/tasks/README.md
data/schema/         -> campaign/data/schema
data/states/         -> campaign/data/states
data/districts/      -> campaign/data/districts
data/crdc/           -> campaign/data/crdc
```

The symlinks are gitignored here; the campaign repository is the source of truth and the crew directory is rebuilt from it on every deploy. In a container, `COPY` the campaign checkout to `/campaign`, this directory to `/crew`, and run `link.sh /campaign` before starting the server; or build the campaign's own image and set `GROUNDCREW_CREW` to the linked directory.

Approved findings are exported with `groundcrew findings . --status approved` and merged into `data/districts/<XX>.yaml`, `data/states/<XX>.yaml`, or `facts/claims/` by a maintainer, who runs the campaign's validator and opens the pull request. When the campaign's own MCP server (`mcp/server.mjs`) is retired, this is what replaces it: the same `search_facts` and `get_fact`, plus leases and reviewed findings instead of GitHub issues.

`training-review` has no skill file in the campaign yet; the task carries a description instead and the prompt says so.

Ground Crew is part of EarthPilot: mission support for Spaceship Earth.
