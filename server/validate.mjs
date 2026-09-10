// Validates a crew directory: crew.json, tasks/tasks.yaml against schemas/task.schema.json, every
// facts/claims/*.md frontmatter against schemas/claim.schema.json, and every record under data/ against the
// schema its collection maps to. Used by `groundcrew validate` and by the server at startup.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { splitFrontmatter, loadTasks, loadCollections } from "./crew.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const PROTOCOL_SCHEMAS = join(here, "..", "schemas");

export function newAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(ajv);
  return ajv;
}

export function protocolSchema(name) {
  return JSON.parse(readFileSync(join(PROTOCOL_SCHEMAS, name), "utf8"));
}

export function formatErrors(errors) {
  return (errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(", ")})` : ""}`);
}

// Which schema validates a collection: crew.json `collections` map, else data/schema/<name>.schema.json,
// else data/schema/<singular>.schema.json. Returns a path relative to the crew dir or null.
export function schemaForCollection(root, crew, collection) {
  const map = crew.collections ?? {};
  if (map[collection]) return map[collection];
  const leaf = collection.split("/").pop();
  const candidates = [`data/schema/${leaf}.schema.json`, `data/schema/${leaf.replace(/s$/, "")}.schema.json`, `data/schema/${leaf.replace(/ies$/, "y")}.schema.json`];
  for (const c of candidates) if (existsSync(join(root, c))) return c;
  return null;
}

export function validateCrew(dir) {
  const root = resolve(dir);
  const ajv = newAjv();
  const failures = [];
  const notes = [];
  let checked = 0;
  const report = (file, ok, errors) => { checked++; if (!ok) failures.push({ file, errors }); };

  // crew.json
  const crewPath = join(root, "crew.json");
  let crew = null;
  if (!existsSync(crewPath)) failures.push({ file: "crew.json", errors: ["missing"] });
  else {
    try {
      crew = JSON.parse(readFileSync(crewPath, "utf8"));
      const errs = [];
      for (const k of ["name", "mission"]) if (typeof crew[k] !== "string" || !crew[k].trim()) errs.push(`${k} must be a non-empty string`);
      if (crew.maintainer_token_env != null && typeof crew.maintainer_token_env !== "string") errs.push("maintainer_token_env must be a string");
      if (crew.auto_merge != null && typeof crew.auto_merge !== "object") errs.push("auto_merge must be an object");
      report("crew.json", errs.length === 0, errs);
    } catch (err) { report("crew.json", false, [err.message]); }
  }
  for (const f of ["values.md", "AGENTS.md"]) if (!existsSync(join(root, f))) failures.push({ file: f, errors: ["missing"] });
  if (!existsSync(join(root, "CODE_OF_CONDUCT.md"))) notes.push("CODE_OF_CONDUCT.md is missing; the protocol's non-negotiable rules should be stated in the crew.");

  // tasks
  const vTask = ajv.compile(protocolSchema("task.schema.json"));
  const tasksPath = join(root, "tasks", "tasks.yaml");
  const tasks = existsSync(tasksPath) ? loadTasks(root) : null;
  if (!tasks) failures.push({ file: "tasks/tasks.yaml", errors: ["missing"] });
  else {
    const ids = new Set();
    tasks.forEach((t, i) => {
      const ok = vTask(stripNulls(t));
      const errs = formatErrors(vTask.errors);
      if (t.id && ids.has(t.id)) errs.push(`duplicate task id ${t.id}`);
      ids.add(t.id);
      if (t.schema && !existsSync(join(root, t.schema))) errs.push(`schema file not found: ${t.schema}`);
      if (t.skill && !existsSync(join(root, t.skill))) errs.push(`skill file not found: ${t.skill}`);
      if (t.schema) { try { JSON.parse(readFileSync(join(root, t.schema), "utf8")); } catch (err) { if (existsSync(join(root, t.schema))) errs.push(`schema not valid JSON: ${err.message}`); } }
      report(`tasks/tasks.yaml#${i} (${t.id ?? "?"})`, ok && errs.length === 0, errs);
    });
  }

  // claims
  const claimSchemaPath = existsSync(join(root, "data/schema/claim.schema.json")) ? join(root, "data/schema/claim.schema.json") : join(PROTOCOL_SCHEMAS, "claim.schema.json");
  const vClaim = ajv.compile(JSON.parse(readFileSync(claimSchemaPath, "utf8")));
  const claimsDir = join(root, "facts", "claims");
  const ids = new Set();
  if (existsSync(claimsDir)) {
    for (const f of readdirSync(claimsDir).filter((f) => f.endsWith(".md")).sort()) {
      const parsed = splitFrontmatter(readFileSync(join(claimsDir, f), "utf8"));
      if (!parsed) { report(`facts/claims/${f}`, false, ["missing YAML frontmatter"]); continue; }
      const fm = parsed.frontmatter;
      const ok = vClaim(fm);
      const errs = formatErrors(vClaim.errors);
      if (fm?.id && `${fm.id}.md` !== f) errs.push(`id ${fm.id} does not match filename`);
      if (ids.has(fm?.id)) errs.push(`duplicate id ${fm.id}`);
      if (fm?.status === "retired" && !fm.superseded_by) errs.push("retired claim must name superseded_by");
      ids.add(fm?.id);
      report(`facts/claims/${f}`, ok && errs.length === 0, errs);
    }
  } else notes.push("facts/claims/ is missing; the crew has no claims registry yet.");

  // data collections
  const collections = loadCollections(root);
  for (const [name, records] of Object.entries(collections)) {
    const schemaRel = crew ? schemaForCollection(root, crew, name) : null;
    if (!schemaRel) { notes.push(`data/${name}: no schema mapped (add crew.json collections["${name}"] or data/schema/${name.split("/").pop()}.schema.json); ${Object.keys(records).length} records unchecked`); continue; }
    let v;
    try { v = ajv.compile(JSON.parse(readFileSync(join(root, schemaRel), "utf8"))); } catch (err) { failures.push({ file: schemaRel, errors: [`cannot compile: ${err.message}`] }); continue; }
    for (const [id, rec] of Object.entries(records)) {
      if (rec && rec._error) { report(`data/${name}/${id}`, false, [rec._error]); continue; }
      report(`data/${name}/${id}`, v(rec), formatErrors(v.errors));
    }
  }

  return { root, checked, failures, notes, ok: failures.length === 0 };
}

function stripNulls(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
}

export function printReport(r) {
  for (const f of r.failures) console.error(`FAIL ${f.file}\n  ${f.errors.join("\n  ")}`);
  for (const n of r.notes) console.error(`note: ${n}`);
  console.log(`${r.checked} files checked, ${r.failures.length} failures`);
}
