// Loads a Ground Crew directory into memory. See SPEC.md, "Crew directory layout".
//
// A crew directory holds:
//   crew.json              { name, mission, repo, site, maintainer_token_env, ... }
//   values.md              the values file, prose
//   AGENTS.md              the agent contract
//   CODE_OF_CONDUCT.md     optional
//   facts/claims/*.md      one claim per file, YAML frontmatter + body
//   tasks/tasks.yaml       { tasks: [ { id, title, unit, priority, schema, skill, collection?, scopes?, done_means? } ] }
//   data/schema/*.json     JSON schemas (draft 2020-12)
//   data/**/*.json|yaml    record collections; the collection name is the path under data/, the id is the filename
//   templates/*.md         optional prose templates
//   skills/<task>/SKILL.md the skill text a task's `skill` field points at (any path under the crew dir works)

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, basename, extname, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

export const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function splitFrontmatter(text) {
  const m = text.match(FRONTMATTER);
  if (!m) return null;
  return { frontmatter: parseYaml(m[1]) ?? {}, body: m[2].trim() };
}

const readText = (p) => readFileSync(p, "utf8");
const readOptional = (p) => (existsSync(p) ? readText(p) : null);

export function readRecordFile(path) {
  const ext = extname(path).toLowerCase();
  const text = readText(path);
  if (ext === ".json") return JSON.parse(text);
  if (ext === ".yaml" || ext === ".yml") return parseYaml(text);
  throw new Error(`unsupported record file ${path}`);
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory() || (e.isSymbolicLink() && statSync(p).isDirectory())) walk(p, out);
    else out.push(p);
  }
  return out;
}

export function loadClaims(dir) {
  const claims = [];
  const claimsDir = join(dir, "facts", "claims");
  if (!existsSync(claimsDir)) return claims;
  for (const f of readdirSync(claimsDir).filter((f) => f.endsWith(".md")).sort()) {
    const parsed = splitFrontmatter(readText(join(claimsDir, f)));
    if (!parsed) continue;
    claims.push({ ...parsed.frontmatter, body: parsed.body, file: `facts/claims/${f}` });
  }
  return claims;
}

export function loadTasks(dir) {
  const p = join(dir, "tasks", "tasks.yaml");
  if (!existsSync(p)) return [];
  const doc = parseYaml(readText(p)) ?? {};
  const tasks = Array.isArray(doc) ? doc : doc.tasks ?? [];
  return tasks.map((t) => ({
    id: t.id,
    title: t.title ?? t.id,
    unit: t.unit ?? null,
    output: t.output ?? null,
    priority: t.priority ?? null,
    schema: t.schema ?? null,
    skill: t.skill ?? null,
    collection: t.collection ?? null,
    scopes: Array.isArray(t.scopes) ? t.scopes : null,
    done_means: Array.isArray(t.done_means) ? t.done_means : [],
    description: t.description ?? null,
  }));
}

export function loadSchemas(dir) {
  const schemas = {};
  const schemaDir = join(dir, "data", "schema");
  if (existsSync(schemaDir)) {
    for (const f of readdirSync(schemaDir).filter((f) => f.endsWith(".json")).sort()) {
      schemas[`data/schema/${f}`] = JSON.parse(readText(join(schemaDir, f)));
    }
  }
  return schemas;
}

// Every JSON/YAML file under data/ except data/schema/. Collection = directory path under data/, id = basename.
export function loadCollections(dir) {
  const collections = {};
  const dataDir = join(dir, "data");
  const schemaDir = join(dataDir, "schema");
  for (const file of walk(dataDir)) {
    if (resolve(file).startsWith(resolve(schemaDir) + sep)) continue;
    const ext = extname(file).toLowerCase();
    if (![".json", ".yaml", ".yml"].includes(ext)) continue;
    const rel = relative(dataDir, file).split(sep);
    const collection = rel.slice(0, -1).join("/");
    if (!collection) continue;
    const id = basename(file, ext);
    let record;
    try { record = readRecordFile(file); } catch (err) { record = { _error: String(err.message) }; }
    (collections[collection] ??= {})[id] = record;
  }
  return collections;
}

export function loadTemplates(dir) {
  const templates = {};
  const tplDir = join(dir, "templates");
  if (!existsSync(tplDir)) return templates;
  for (const f of readdirSync(tplDir).filter((f) => f.endsWith(".md")).sort()) templates[basename(f, ".md")] = readText(join(tplDir, f));
  return templates;
}

export function loadCrew(dir) {
  const root = resolve(dir);
  const crewJsonPath = join(root, "crew.json");
  if (!existsSync(crewJsonPath)) throw new Error(`No crew.json in ${root}. Run \`groundcrew init ${dir}\` to create a crew.`);
  const crew = JSON.parse(readText(crewJsonPath));
  const tasks = loadTasks(root);
  const skills = {};
  for (const t of tasks) {
    if (!t.skill) continue;
    const p = join(root, t.skill);
    skills[t.id] = readOptional(p);
  }
  const claims = loadClaims(root);
  return {
    root,
    crew,
    name: crew.name,
    mission: crew.mission ?? "",
    values: readOptional(join(root, "values.md")) ?? "",
    agents: readOptional(join(root, "AGENTS.md")) ?? "",
    conduct: readOptional(join(root, "CODE_OF_CONDUCT.md")),
    claims,
    claimsById: Object.fromEntries(claims.map((c) => [c.id, c])),
    tasks,
    tasksById: Object.fromEntries(tasks.map((t) => [t.id, t])),
    skills,
    schemas: loadSchemas(root),
    collections: loadCollections(root),
    templates: loadTemplates(root),
    readSchema(pathFromCrew) {
      if (!pathFromCrew) return null;
      if (this.schemas[pathFromCrew]) return this.schemas[pathFromCrew];
      const p = join(root, pathFromCrew);
      if (!existsSync(p)) return null;
      return (this.schemas[pathFromCrew] = JSON.parse(readText(p)));
    },
  };
}

export function claimSummary(c) {
  const primary = (c.sources ?? []).find((s) => s.primary) ?? (c.sources ?? [])[0];
  return {
    id: c.id,
    claim: c.claim,
    status: c.status,
    figure: c.figure ?? null,
    as_of: c.as_of ?? null,
    primary_source: primary?.url ?? null,
    last_verified: c.last_verified ?? null,
  };
}

// Same semantics as the campaign's search_facts: every word must match id, claim, tags, body, or as_of; retired excluded unless status given.
export function searchClaims(claims, query, status) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return claims
    .filter((c) => (status ? c.status === status : c.status !== "retired"))
    .filter((c) => {
      const hay = [c.id, c.claim, ...(c.tags ?? []), c.body ?? "", c.as_of ?? ""].join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .map(claimSummary);
}
