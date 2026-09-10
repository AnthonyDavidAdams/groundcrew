#!/bin/sh
# Point this crew directory at a checkout of the End School Corporal Punishment campaign repository.
# The campaign owns the data; this directory adds crew.json, values.md, tasks/tasks.yaml, and the finding schemas.
#
#   sh link.sh [path-to-campaign-checkout]      default: ../../../end-school-corporal-punishment
set -e
here=$(cd "$(dirname "$0")" && pwd)
campaign=${1:-"$here/../../../end-school-corporal-punishment"}
campaign=$(cd "$campaign" && pwd)
[ -f "$campaign/AGENTS.md" ] || { echo "no campaign checkout at $campaign" >&2; exit 1; }
mkdir -p "$here/data" "$here/tasks"
link() { rm -rf "$here/$2"; ln -s "$1" "$here/$2"; echo "  $2 -> $1"; }
link "$campaign/facts"               facts
link "$campaign/AGENTS.md"           AGENTS.md
link "$campaign/CODE_OF_CONDUCT.md"  CODE_OF_CONDUCT.md
link "$campaign/templates"           templates
link "$campaign/skills"              skills
link "$campaign/tasks/README.md"     tasks/README.md
link "$campaign/data/schema"         data/schema
link "$campaign/data/states"         data/states
link "$campaign/data/districts"      data/districts
link "$campaign/data/crdc"           data/crdc
echo "linked. Next: node ../../bin/groundcrew.mjs validate $here"
