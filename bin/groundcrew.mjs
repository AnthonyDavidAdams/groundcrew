#!/usr/bin/env node
// Ground Crew CLI. Ground Crew is part of EarthPilot: mission support for Spaceship Earth.
//
//   groundcrew init <dir> [--name "..."] [--mission "..."]   write a crew skeleton
//   groundcrew validate <dir>                                 check claims, records, tasks against their schemas
//   groundcrew serve <dir> [--http] [--port N] [--host H] [--state path]
//   groundcrew findings <dir> [--status pending|approved|rejected] [--state path]

import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const tpl = (name) => join(pkgRoot, "templates", "crew", name);

const argv = process.argv.slice(2);
const cmd = argv[0];
const dirArg = argv[1] && !argv[1].startsWith("--") ? argv[1] : null;
const flag = (name, fallback) => { const i = argv.indexOf(name); return i !== -1 && argv[i + 1] != null ? argv[i + 1] : fallback; };
const has = (name) => argv.includes(name);

function usage(code = 0) {
  console.log(`groundcrew <command> <crew-dir> [options]

  init <dir> [--name N] [--mission M]     write a crew skeleton (values.md, AGENTS.md, CODE_OF_CONDUCT.md, tasks, a claim, a schema)
  validate <dir>                          validate claims, records, and tasks against their schemas; exit 1 on failure
  serve <dir> [--http] [--port N] [--host H] [--state path]
                                          run the MCP server on stdio, or Streamable HTTP with --http
  findings <dir> [--status S] [--state path]
                                          print stored findings (default: approved) as JSON, for merging into data/

Environment: GROUNDCREW_STATE (default <dir>/state.json when serving via this CLI), the maintainer token named in crew.json.
Ground Crew is part of EarthPilot: mission support for Spaceship Earth.`);
  process.exit(code);
}

function fill(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

function init(dir) {
  const root = resolve(dir);
  if (existsSync(join(root, "crew.json"))) { console.error(`${root} already has a crew.json; refusing to overwrite.`); process.exit(1); }
  const name = flag("--name", "My Crew");
  const mission = flag("--mission", "One sentence on the public problem this crew exists to move, and where the decision is made.");
  const vars = { name, mission: mission.replace(/"/g, '\\"') };
  const write = (rel, content) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); console.log(`  wrote ${rel}`); };
  console.log(`Creating crew '${name}' in ${root}`);
  write("crew.json", fill(readFileSync(tpl("crew.json"), "utf8"), vars));
  write("values.md", fill(readFileSync(tpl("values.md"), "utf8"), vars));
  write("AGENTS.md", fill(readFileSync(tpl("AGENTS.md"), "utf8"), vars));
  write("CODE_OF_CONDUCT.md", fill(readFileSync(tpl("CODE_OF_CONDUCT.md"), "utf8"), vars));
  write("tasks/tasks.yaml", readFileSync(tpl("tasks.yaml"), "utf8"));
  write("data/schema/record.schema.json", readFileSync(tpl("record.schema.json"), "utf8"));
  write("data/schema/claim.schema.json", readFileSync(join(pkgRoot, "schemas", "claim.schema.json"), "utf8"));
  write("facts/claims/example-units-total-2025.md", readFileSync(tpl("example-claim.md"), "utf8"));
  write("data/records/example-0001.json", JSON.stringify({ name: "Example Unit", region: "XX", external_id: "example-0001", status: "unknown", source: null, quote: null, last_verified: "2026-01-01", notes: "Placeholder written by groundcrew init; replace or delete." }, null, 2) + "\n");
  write("skills/record-scan/SKILL.md", readFileSync(tpl("skill-record-scan.md"), "utf8"));
  write("skills/verify-claim/SKILL.md", readFileSync(tpl("skill-verify-claim.md"), "utf8"));
  write("templates/README.md", "# Templates\n\nOptional prose templates (letters, testimony, model policy) served by `get_template`. One Markdown file per template.\n");
  write(".gitignore", "state.json\nstate.json.*.tmp\nnode_modules/\n");
  write("README.md", `# ${name}\n\n${mission}\n\nThis directory is a [Ground Crew](https://github.com/earthpilot/groundcrew) crew. Edit \`values.md\` first, then \`AGENTS.md\`, \`tasks/tasks.yaml\`, and the schemas under \`data/schema/\`. Run \`groundcrew validate .\` and \`groundcrew serve . --http\`.\n\nGround Crew is part of EarthPilot: mission support for Spaceship Earth.\n`);
  console.log(`\nNext: edit values.md, then AGENTS.md and tasks/tasks.yaml. Then:\n  groundcrew validate ${dir}\n  ${vars.name ? "" : ""}GROUNDCREW_MAINTAINER_TOKEN=<secret> groundcrew serve ${dir} --http --port 3000`);
}

async function validate(dir) {
  const { validateCrew, printReport } = await import(join(pkgRoot, "server", "validate.mjs"));
  const r = validateCrew(dir);
  printReport(r);
  process.exit(r.ok ? 0 : 1);
}

async function serve(dir) {
  const { createContext, runHttp, runStdio } = await import(join(pkgRoot, "server", "index.mjs"));
  const statePath = flag("--state", process.env.GROUNDCREW_STATE ?? join(resolve(dir), "state.json"));
  const ctx = createContext({ crewDir: dir, statePath });
  if (has("--http")) await runHttp(ctx, { argv: process.argv });
  else await runStdio(ctx);
}

async function findings(dir) {
  const { StateStore } = await import(join(pkgRoot, "server", "state.mjs"));
  const statePath = flag("--state", process.env.GROUNDCREW_STATE ?? join(resolve(dir), "state.json"));
  const store = new StateStore(statePath);
  const status = flag("--status", "approved");
  const rows = store.state.findings.filter((f) => status === "all" || f.status === status);
  console.log(JSON.stringify(rows, null, 2));
}

if (!cmd || has("--help") || has("-h")) usage(0);
if (!dirArg) { console.error(`${cmd}: crew directory required\n`); usage(1); }
const run = { init, validate, serve, findings }[cmd];
if (!run) { console.error(`unknown command ${cmd}\n`); usage(1); }
Promise.resolve(run(dirArg)).catch((err) => { console.error(err.message ?? err); process.exit(1); });
