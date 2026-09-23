#!/usr/bin/env node
// Ground Crew reference server. Ground Crew is part of EarthPilot: mission support for Spaceship Earth.
//
//   node server/index.mjs                        stdio transport (Claude Desktop, Claude Code, Cursor, ...)
//   node server/index.mjs --http [--port 3000]   Streamable HTTP on POST /mcp, plus GET /healthz
//
// Environment:
//   GROUNDCREW_CREW    crew directory (default ./crew); see SPEC.md for its layout
//   GROUNDCREW_STATE   JSON state file for leases, findings, contributors (default ./state.json)
//   <crew.json maintainer_token_env>   the maintainer token review_finding requires (default GROUNDCREW_MAINTAINER_TOKEN)
//   GROUNDCREW_LEASE_TTL_HOURS         lease length, default 4 (crew.json lease_ttl_hours also works)
//   PORT, HOST                          HTTP bind when --port/--host are not given

import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { badgeFor, badgeSvg, badgePng, TIERS } from "./badge.mjs";
import { egressFetch, proxyCount, egressStats } from "./egress.mjs";
import { handle as handleOf } from "./activity.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { KINDS, STATUSES, findDuplicate, writeIssueFile, syncToGitHub, manualIssueUrl } from "./issues.mjs";
import { buildActivity } from "./activity.mjs";
import { clientIp, lookup as lookupPlace } from "./geo.mjs";
import { TileCache, validTile, ATTRIBUTION, ATTRIBUTION_URL } from "./tiles.mjs";
import { DocumentCache, search as searchDoc, tableOfContents, pageRange, archive } from "./documents.mjs";
import { resolve, basename, dirname, join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadCrew, searchClaims } from "./crew.mjs";
import { normalizeScope, scopesOverlap } from "./state.mjs";
import { StateStore, DEFAULT_LEASE_TTL_HOURS, newId, publicLease } from "./state.mjs";
import { newAjv, formatErrors } from "./validate.mjs";
import { verifyQuote } from "./verify.mjs";
import { ATTRIBUTION as CREW_ATTRIBUTION, BRAND_LINE } from "./brand.mjs";
import { nextFreeUnit } from "./assign.mjs";

// Read from package.json so a deploy cannot report a version it is not running.
const require_ = createRequire(import.meta.url);
export const VERSION = require_("../package.json").version;
export const PROTOCOL = "groundcrew/0.1";

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg, extra) => ({ content: [{ type: "text", text: extra ? `${msg}\n${JSON.stringify(extra, null, 2)}` : msg }], isError: true });

// ---------------------------------------------------------------------------
// Context: one crew, one state store, one ajv, shared by every server instance in the process.
// ---------------------------------------------------------------------------
export function createContext({ crewDir = process.env.GROUNDCREW_CREW ?? "./crew", statePath = process.env.GROUNDCREW_STATE ?? "./state.json", env = process.env, fetchImpl } = {}) {
  const crew = loadCrew(crewDir);
  const store = new StateStore(statePath);
  const ajv = newAjv();
  const validators = {};
  const validatorFor = (task) => {
    if (validators[task.id]) return validators[task.id];
    const schema = crew.readSchema(task.schema);
    if (!schema) return null;
    return (validators[task.id] = ajv.compile(schema));
  };
  const tokenEnv = crew.crew.maintainer_token_env ?? "GROUNDCREW_MAINTAINER_TOKEN";
  const maintainerToken = () => env[tokenEnv] || null;
  const ttlHours = Number(env.GROUNDCREW_LEASE_TTL_HOURS ?? crew.crew.lease_ttl_hours ?? DEFAULT_LEASE_TTL_HOURS) || DEFAULT_LEASE_TTL_HOURS;
  const autoMerge = { enabled: false, min_approved: 10, min_approval_rate: 0.9, ...(crew.crew.auto_merge ?? {}) };
  const issuesDir = env.GROUNDCREW_ISSUES_DIR || join(dirname(resolve(statePath)), "issues");
  const githubToken = () => env.GITHUB_TOKEN || null;
  const docsDir = env.GROUNDCREW_DOCS_DIR || join(dirname(resolve(statePath)), "documents");
  const documents = new DocumentCache({ dir: docsDir, fetchImpl });
  const tilesDir = env.GROUNDCREW_TILES_DIR || join(dirname(resolve(statePath)), "tiles");
  const tiles = new TileCache({ dir: tilesDir, fetchImpl });
  return { crew, store, validatorFor, maintainerToken, githubToken, tokenEnv, ttlHours, autoMerge, fetchImpl, issuesDir, documents, docsDir, tiles, tilesDir, crewDir: resolve(crewDir), statePath: resolve(statePath) };
}

function bearerFrom(extra) {
  const h = extra?.requestInfo?.headers;
  if (!h) return null;
  const v = h.authorization ?? h.Authorization;
  const s = Array.isArray(v) ? v[0] : v;
  const m = s && String(s).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Server factory. One instance for stdio; one per request for stateless HTTP.
// ---------------------------------------------------------------------------
export function createServer(ctx) {
  const { crew, store, ttlHours, autoMerge } = ctx;
  // Identity shown in the client's connector list: name, title, description, site and icons,
  // all supplied by the crew so each one looks like itself rather than like the engine.
  const identity = { name: `groundcrew:${slug(crew.name)}`, version: VERSION };
  if (crew.crew.title || crew.name) identity.title = crew.crew.title ?? crew.name;
  if (crew.crew.description || crew.mission) identity.description = crew.crew.description ?? crew.mission;
  if (crew.crew.site) identity.websiteUrl = crew.crew.site;
  if (Array.isArray(crew.crew.icons) && crew.crew.icons.length) {
    identity.icons = crew.crew.icons
      .filter((i) => i && typeof i.src === "string" && /^https?:\/\//.test(i.src))
      .map((i) => ({ src: i.src, ...(i.mimeType ? { mimeType: i.mimeType } : {}), ...(Array.isArray(i.sizes) && i.sizes.length ? { sizes: i.sizes } : {}), ...(i.theme ? { theme: i.theme } : {}) }));
  }
  const server = new McpServer(
    identity,
    {
      instructions:
        "This is a Ground Crew server. It holds one public problem's verified facts, its data, and its task queue, and it accepts findings from any agent. " +
        "Call get_started first: it explains what contributing means here and gives you the exact first calls. " +
        "The contract, in short: open every source yourself in this session, quote the sentence verbatim, date everything, never guess, never name a minor. " +
        "Work is leased so contributors do not duplicate each other (claim_task), and every finding is checked against its source and reviewed by a person before it enters the record (submit_finding). " +
        "If the server refuses a finding you believe is correct, or a tool behaves differently from its description, call report_issue rather than working around it; if the server cannot read a source you could read, resubmit with source_text. " +
        "report_issue takes bugs, feature requests and questions, and list_issues shows what is already filed. The crew improves from what its contributors hit. " +
        "Facts: quote only status 'verified' claims as fact; 'reported' ones only as 'according to <source>'.",
    }
  );

  // ---- orientation ----
  server.registerTool(
    "get_started",
    {
      title: "Start here",
      description: "Orientation for a person or agent that has just connected: what this crew is, what contributing means, and the exact first calls to make. Call this before anything else.",
      inputSchema: {},
    },
    async () => {
      const top = [...crew.tasks].sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9)).slice(0, 3);
      const brief = crew.crew.brief ?? {};
      // Headline facts come from the crew's own verified claims, so the pitch cannot drift from the record.
      const headline = (brief.headline_claims ?? [])
        .map((id) => crew.claims.find((c) => c.id === id))
        .filter(Boolean)
        .map((c) => ({ claim: c.claim, as_of: c.as_of ?? null, source: (c.sources ?? []).find((x) => x.primary)?.url ?? (c.sources ?? [])[0]?.url ?? null, id: c.id }));
      const verified = crew.claims.filter((c) => c.status === "verified");
      return text({
        crew: crew.name,
        mission: crew.mission,

        // --- for the person who just connected this server ---
        for_your_human: {
          read_this_to_them: brief.summary ??
            `${crew.name}. ${crew.mission} This server holds the project's verified facts and its open work, and accepts contributions from anyone's assistant.`,
          why_it_matters: brief.why ?? null,
          the_facts: headline.length ? headline : verified.slice(0, 4).map((c) => ({ claim: c.claim, as_of: c.as_of ?? null, id: c.id })),
          what_one_contribution_does: brief.what_one_contribution_does ??
            "Each finding you submit is one verified, sourced record added to a public dataset that anyone can cite. Nothing is taken on trust: the server checks your quote against the document, and a person reviews it.",
          what_it_costs_them: brief.cost ??
            "Your own assistant's time and tokens, on their existing subscription. Nothing is billed by this project, and no account is required.",
          what_they_should_decide: [
            "Which task, and which scope inside it. Most tasks are scoped by state.",
            "How much to take on. A scope can be a whole state or a slice of one; a lease can be released at any time.",
            "Whether they want their name on the record. Findings carry the human who ran the agent.",
          ],
          they_can_also: brief.other_ways ?? null,
          what_happens_to_the_work: brief.what_happens_to_the_work ?? null,
        },

        // --- for you, the agent ---
        how_contributing_works: [
          "1. get_agent_contract: the rules. Open every source yourself, quote verbatim, date everything, never guess, no minors identified.",
          "2. claim_task with just `agent` and `human`, and nothing else. The server assigns you the next unit nobody is working on and leases it to you. You do not need to look at the queue, choose, or check what is free -- doing that by hand is how two contributors end up on the same work.",
          "3. Do the work: find the primary document, open it, read the sentence that settles the question.",
          "4. submit_finding: one call per record. The server fetches your source and checks your quote against it. A record that fails is refused and not stored.",
          "5. release_lease when you stop, or renew_lease if you are still going when it is about to expire.",
          "6. A maintainer reviews. get_contributor shows your record.",
          "Only name a task or a scope yourself if you specifically want that one; list_tasks shows what exists.",
        ],
        the_one_call_to_start: {
          tool: "claim_task",
          arguments: { agent: "<your model and platform>", human: "<the handle or email of the person running you>" },
          what_happens: "You get back a lease with the task and scope you have been assigned. Work that, then submit_finding.",
        },
        if_a_call_seems_to_vanish:
          "If a write tool comes back with 'No approval received', the call never reached this server: your client is asking your human to approve it. Ask them to approve write calls for this connector, then retry. Nothing was stored, and nothing is wrong with the server.",
        if_something_breaks:
          "Call report_issue with kind 'bug', and put the record that would not submit in `context` so the work is not lost. If the server cannot read a source you could read yourself, resubmit with `source_text` set to the text you extracted.",
        if_something_is_missing:
          "Call report_issue with kind 'feature': a field the schema cannot express, a task that should exist, a vocabulary that does not fit what the sources say. Say what you were trying to do, not only what to build. Check list_issues first so the same thing is not filed twice.",
        good_first_moves: top.map((t) => ({ task: t.id, title: t.title, unit: t.unit ?? null, priority: t.priority ?? null, scopes: Array.isArray(t.scopes) ? t.scopes.slice(0, 20) : null })),
        read_the_values: "get_crew returns values.md in full. Contributions that conflict with it are declined, however well sourced.",
        links: { repo: crew.crew.repo ?? null, site: crew.crew.site ?? null, contact: crew.crew.contact ?? null },
      });
    }
  );

  // ---- crew ----
  server.registerTool(
    "get_crew",
    {
      title: "About this crew",
      description: "Name, mission, values (values.md in full), and links (repo, site, docs) for the crew this server hosts, plus the protocol version, lease length, and whether auto-merge is on. Read this first.",
      inputSchema: {},
    },
    async () =>
      text({
        name: crew.name,
        mission: crew.mission,
        values: crew.values,
        links: { repo: crew.crew.repo ?? null, site: crew.crew.site ?? null, docs: crew.crew.docs ?? null, contact: crew.crew.contact ?? null },
        protocol: PROTOCOL,
        server_version: VERSION,
        lease_ttl_hours: ttlHours,
        auto_merge: autoMerge.enabled ? { min_approved: autoMerge.min_approved, min_approval_rate: autoMerge.min_approval_rate } : false,
        counts: { claims: crew.claims.length, tasks: crew.tasks.length, collections: Object.keys(crew.collections).length, templates: Object.keys(crew.templates).length },
        brand: BRAND_LINE,
        attribution: CREW_ATTRIBUTION,
      })
  );

  server.registerTool(
    "get_agent_contract",
    {
      title: "Get the agent contract (AGENTS.md)",
      description: "The full text of the crew's AGENTS.md: the rules every agent follows when contributing (open the source, primary sources first, quote verbatim, date everything, never guess, disclose yourself), plus the code of conduct if the crew has one. Read it before claim_task or submit_finding.",
      inputSchema: {},
    },
    async () => text(crew.conduct ? `${crew.agents.trim()}\n\n---\n\n${crew.conduct.trim()}` : crew.agents)
  );

  // ---- tasks and leases ----
  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description: "The crew's task queue (tasks/tasks.yaml): id, title, description, unit of work, priority (1 is highest), the schema every finding must satisfy, the skill that runs it, the data collection results merge into, the closed list of scopes if the task has one, the 'done means' acceptance list, and how many scopes are currently leased. Each task is also an MCP prompt of the same name that returns the skill text.",
      inputSchema: {},
    },
    async () => {
      const active = store.activeLeases();
      return text({
        count: crew.tasks.length,
        tasks: crew.tasks.map((t) => ({
          ...t,
          leased_scopes: active.filter((l) => l.task === t.id).map((l) => l.scope),
          open_scopes: t.scopes ? t.scopes.filter((s) => !active.some((l) => l.task === t.id && sameScope(l.scope, s))) : null,
        })),
      });
    }
  );

  server.registerTool(
    "claim_task",
    {
      title: "Claim a scope (take a lease)",
      description:
        `Take a ${ttlHours}-hour lease so no one else reads the same thing. Returns {id, task, scope, expires_at}. ` +
        "OMIT scope and the server assigns you the next unit nobody is working on, which is the normal way to use this: you do not have to ask what is free, coordinate with anyone, or handle being refused. Omit task as well and it also picks the task, highest priority first. " +
        `Name a scope only when you specifically want that one. Then it is refused if that scope is already leased and not expired, if it OVERLAPS one that is (a lease on "MS" blocks "MS: Rankin County" and the other way round), or, when the task lists scopes, if it is not one of them. ` +
        "Give agent as your model and platform, e.g. 'claude-fable-5-1 via Claude.ai', and human as the handle or email of the person running you. Both are stored on every finding you submit. Call renew_lease before expires_at if you are still working; release_lease when you stop.",
      inputSchema: {
        task: z.string().min(1).optional().describe("Task id from list_tasks. Omit and the server picks the highest-priority task with work free."),
        scope: z.string().trim().min(1).optional().describe("The unit of work, in the task's own unit, e.g. 'MS' or 'Texas, districts A-C'. OMIT THIS to be assigned the next free unit, which is what you usually want."),
        agent: z.string().trim().min(1).describe("Agent name and platform"),
        human: z.string().trim().min(1).describe("The person running the agent: handle or email"),
      },
    },
    async ({ task, scope, agent, human }, extra) => {
      // Being handed the next thing is the default, not a convenience. A contributor who has to ask
      // what is free, pick something, and handle a refusal is a contributor doing the server's job,
      // and a room of twenty people all picking by hand collide on the obvious choice every time.
      const assigned = !scope;
      if (assigned) {
        const picked = nextFreeUnit(crew, store, task);
        if (!picked.ok) return fail(picked.why, picked.detail);
        task = picked.task;
        scope = picked.scope;
      }
      const t = crew.tasksById[task];
      if (!t) return fail(`No task '${task}'. Tasks: ${crew.tasks.map((x) => x.id).join(", ")}`);
      if (!assigned && t.scopes) {
        const canonical = t.scopes.find((s) => sameScope(s, scope));
        if (canonical) scope = canonical;
        // A declared scope list names the units work is handed out in, not the only strings anyone may
        // ever claim. Narrowing one of them -- "TX" into "TX: districts 1-10" -- is how several people
        // work a big unit side by side, and the overlap rule already handles it correctly. Refusing it
        // here contradicted this tool's own description, and made the advice "claim a slice of Texas"
        // impossible to follow on any crew that listed its states.
        else if (!t.scopes.some((s) => scopesOverlap(s, scope))) {
          return fail(`Scope '${scope}' is not one of the task's scopes, and is not inside one of them. Claim one of these, or a slice of one such as '${t.scopes[0]}: part 1'.`, { scopes: t.scopes });
        }
      }
      const r = store.claim({ task, scope, agent, human, ttlHours });
      if (!r.ok) {
        const same = normalizeScope(r.lease.scope) === normalizeScope(scope);
        return fail(
          same
            ? `Scope '${scope}' of ${task} is already leased until ${r.lease.expires_at}. Pick another scope or wait.`
            : `Scope '${scope}' of ${task} overlaps '${r.lease.scope}', which is leased until ${r.lease.expires_at}. A narrower scope inside a leased one is still the same work. Pick a scope outside it, or wait.`,
          { lease: r.lease });
      }

      // Resolve the contributor's rough location once, here, and keep only the city and country. The
      // address itself is never stored. It goes on the lease so every finding under it inherits it
      // without another lookup, and so that a contributor who works for hours is located once.
      try {
        const ip = clientIp(ctx.requestHeaders ?? extra?.requestInfo?.headers ?? {});
        const place = await lookupPlace(ip, { fetchImpl: ctx.fetchImpl });
        if (place) store.updateLease?.(r.lease.id, { place });
        if (place) r.lease.place = place;
      } catch { /* never let geo stand between a contributor and the work */ }

      return text({ ...r.lease, next: `Run the task for scope '${scope}' and call submit_finding with lease_id ${r.lease.id} for each record. Renew before ${r.lease.expires_at}.` });
    }
  );

  server.registerTool(
    "renew_lease",
    { title: "Renew a lease", description: `Extend a lease by another ${ttlHours} hours from now. An expired lease can be renewed only if nobody else has taken the scope since.`, inputSchema: { lease_id: z.string().min(1) } },
    async ({ lease_id }) => {
      const r = store.renew(lease_id, ttlHours);
      if (!r.ok) return fail(`Cannot renew ${lease_id}: ${r.reason}`, r.lease ? { lease: r.lease } : undefined);
      return text(r.lease);
    }
  );

  server.registerTool(
    "release_lease",
    { title: "Release a lease", description: "Give a scope back so someone else can take it. Findings already submitted under the lease are unaffected.", inputSchema: { lease_id: z.string().min(1) } },
    async ({ lease_id }) => {
      const r = store.release(lease_id);
      if (!r.ok) return fail(`Cannot release ${lease_id}: ${r.reason}`);
      return text({ released: true, ...r.lease });
    }
  );

  server.registerTool(
    "list_leases",
    { title: "List active leases", description: "Every unexpired, unreleased lease, optionally for one task: who holds which scope until when. Use it to pick a scope nobody is working on.", inputSchema: { task: z.string().optional() } },
    async ({ task }) => {
      const rows = store.activeLeases().filter((l) => !task || l.task === task).map(publicLease);
      return text({ count: rows.length, leases: rows });
    }
  );

  // ---- facts ----
  server.registerTool(
    "search_facts",
    {
      title: "Search verified facts",
      description:
        "Keyword search over the claims registry (facts/claims). Matches case-insensitively against claim id, claim sentence, tags, and body note; all words in the query must match. Returns id, claim, status, figure, as_of, primary source URL, and last_verified. Retired (superseded) claims are excluded unless you pass status. Use get_fact for full sources and the usage note.",
      inputSchema: {
        query: z.string().min(1).describe("Words to match"),
        status: z.enum(["verified", "reported", "disputed", "retired"]).optional().describe("Restrict to one status. Omit to get every non-retired claim that matches."),
      },
    },
    async ({ query, status }) => {
      const results = searchClaims(crew.claims, query, status);
      return text({ query, status: status ?? "all except retired", count: results.length, results });
    }
  );

  server.registerTool(
    "get_fact",
    {
      title: "Get one claim in full",
      description: "Return one claim from facts/claims by id: the sentence, status, figure, as_of, every source (url, title, publisher, date, primary flag), tags, verification metadata, supersedes/superseded_by, and the markdown body explaining what the number counts and how to use it.",
      inputSchema: { id: z.string().min(1).describe("Claim id (the filename without .md)") },
    },
    async ({ id }) => {
      const c = crew.claimsById[id.trim()];
      if (!c) {
        const near = crew.claims.filter((x) => x.id.includes(id.trim().toLowerCase())).map((x) => x.id).slice(0, 10);
        return fail(`No claim with id '${id}'.${near.length ? ` Similar ids: ${near.join(", ")}` : " Use search_facts to find ids."}`);
      }
      return text(c);
    }
  );

  // ---- records ----
  server.registerTool(
    "list_records",
    {
      title: "List records in a collection",
      description: "Without a collection: every data/ collection with its record count. With one: the record ids (paged with limit and offset), and the records themselves when include_records is true. A collection is a directory under data/; an id is a filename without extension.",
      inputSchema: {
        collection: z.string().optional().describe("Collection name, e.g. 'districts' or 'crdc/2021-22'"),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
        include_records: z.boolean().optional(),
      },
    },
    async ({ collection, limit = 100, offset = 0, include_records = false }) => {
      if (!collection) return text({ collections: Object.entries(crew.collections).map(([name, recs]) => ({ name, count: Object.keys(recs).length })) });
      const recs = crew.collections[collection];
      if (!recs) return fail(`No collection '${collection}'. Available: ${Object.keys(crew.collections).join(", ") || "(none)"}`);
      const ids = Object.keys(recs).sort();
      const page = ids.slice(offset, offset + limit);
      return text({ collection, count: ids.length, offset, limit, ids: page, records: include_records ? Object.fromEntries(page.map((id) => [id, recs[id]])) : undefined });
    }
  );

  server.registerTool(
    "get_record",
    { title: "Get one record", description: "One record from a data/ collection by id, as stored (JSON or YAML parsed).", inputSchema: { collection: z.string().min(1), id: z.string().min(1) } },
    async ({ collection, id }) => {
      const recs = crew.collections[collection];
      if (!recs) return fail(`No collection '${collection}'. Available: ${Object.keys(crew.collections).join(", ") || "(none)"}`);
      const r = recs[id];
      if (r === undefined) return fail(`No record '${id}' in ${collection}. Use list_records.`);
      return text({ collection, id, record: r });
    }
  );

  // ---- findings ----
  server.registerTool(
    "submit_finding",
    {
      title: "Submit a finding",
      description:
        "Submit one record produced under a lease. The record is validated against the task's JSON schema; when it has `source` and `quote`, the server fetches `source` and requires the first 120 characters of the quote (whitespace-normalized, case-insensitive) to appear in the page text. A record that fails either check is refused and not stored. " +
        "A stored finding is `pending` until a maintainer reviews it (or auto-merges if the crew allows it for trusted contributors). Every finding carries your agent, human, skill, and timestamp. " +
        "REQUIREMENT: you must have opened `source` yourself in this session and read the quoted sentence there. Never submit from memory or from a secondary report.",
      inputSchema: {
        task: z.string().min(1).describe("Task id"),
        lease_id: z.string().min(1).describe("The lease from claim_task"),
        record: z.record(z.string(), z.unknown()).describe("The record, in the shape of the task's schema"),
        skill: z.string().trim().min(1).optional().describe("Skill or prompt used, with version, e.g. 'district-policy-scan@0.1'. Defaults to the task's skill file name."),
        notes: z.string().trim().optional().describe("Anything the reviewer needs: what was searched, conflicting documents, why a field is null"),
        source_text: z.string().trim().min(40).optional().describe("The text you read, containing the quoted sentence. Supply it whenever the server might not be able to read the source itself: scanned PDFs with no text layer, pages behind a bot challenge, and hosts that block or rate-limit the server. The server still tries the source first; if it cannot read it, or the quote is not in what it got, your text is used instead and the finding is stored, flagged as agent-supplied, and always sent to a human, never auto-merged. Aliases: document_text, extracted_text."),
        document_text: z.string().trim().min(40).optional().describe("Alias for source_text."),
        extracted_text: z.string().trim().min(40).optional().describe("Alias for source_text."),
      },
    },
    async ({ task, lease_id, record, skill, notes, source_text, document_text, extracted_text }) => {
      const suppliedText = source_text ?? document_text ?? extracted_text;
      const t = crew.tasksById[task];
      if (!t) return fail(`No task '${task}'.`);
      const lease = store.findLease(lease_id);
      if (!lease) return fail(`No lease '${lease_id}'. Call claim_task first.`);
      if (lease.task !== task) return fail(`Lease ${lease_id} is for task '${lease.task}', not '${task}'.`);
      if (lease.released_at) return fail(`Lease ${lease_id} was released at ${lease.released_at}. Claim the scope again.`);
      if (Date.parse(lease.expires_at) <= Date.now()) return fail(`Lease ${lease_id} expired at ${lease.expires_at}. Call renew_lease or claim_task again.`);

      const validate = ctx.validatorFor(t);
      if (!validate) return fail(`Task '${task}' has no readable schema (${t.schema}); the crew maintainer must fix tasks/tasks.yaml.`);
      if (!validate(record)) return fail(`Record does not match the schema for '${task}' (${t.schema}).`, { errors: formatErrors(validate.errors) });

      // If this document has already been through fetch_document, check the quote against that copy
      // first: it is the text the agent actually read, and it costs no second download.
      let cachedText = null;
      if (record?.source) { try { cachedText = ctx.documents?.read(record.source)?.text ?? null; } catch { cachedText = null; } }

      const check = await verifyQuote(record, { fetchImpl: ctx.fetchImpl, sourceText: suppliedText, cachedText });
      if (!check.ok) {
        const { ok: _ok, status, detail, ...diag } = check;
        return fail(`Source check failed (${status}): ${detail}. The finding was not stored. Fix the quote or source and resubmit.`, {
          source: record.source,
          quote_check: "failed",
          ...diag,
          next: status === "not_found" && (diag.matched_chars ?? 0) > 0
            ? "`sought` is exactly what the server looked for and `source_says` is what the document has at that point. Usually the quote was retyped rather than copied, or it spans a line break the extractor joined differently."
            : "Open the source again and copy the sentence verbatim, or pass `source_text` with the text you extracted if the server cannot read what you read.",
        });
      }

      // One pending finding per record. A lease stops two contributors reading the same district; it
      // does nothing about one contributor's own agents, and a ten-agent fleet duplicated itself badly:
      // Lamar County submitted three times, Enterprise City twice with OPPOSITE statuses, all under one
      // lease. A reviewer then opens a queue where one district asserts two different things.
      //
      // A resubmission is usually a correction, so the newer one wins and the older is superseded
      // rather than refused -- refusing would make a contributor who found a mistake unable to fix it.
      // What is refused is nothing; what is prevented is two of the same thing sitting pending.
      // This is a generic server, so identity cannot assume one crew's field names. An authoritative id
      // is best; failing that, the unit's name inside its region. Both are conventions the record
      // schemas here already use -- external_id/region in the template, nces_id/state in the campaign.
      const identity = (rec) => {
        const id = rec?.external_id ?? rec?.nces_id ?? rec?.id ?? null;
        if (id !== null && id !== undefined && String(id).trim()) return `id:${String(id).trim()}`;
        const region = rec?.region ?? rec?.state ?? "";
        return `name:${String(region).trim().toLowerCase()}|${String(rec?.name ?? "").trim().toLowerCase()}`;
      };
      const mine = identity(record);
      const superseded = store.state.findings.filter(
        (f) => f.status === "pending" && f.task === task && identity(f.record) === mine
      );
      for (const old of superseded) {
        old.status = "superseded";
        old.review = { decision: "superseded", reviewer: "server", note: `replaced by a later submission for the same record`, at: new Date().toISOString() };
      }

      const now = new Date().toISOString();
      const finding = {
        id: newId("finding"),
        task,
        lease_id,
        scope: lease.scope,
        collection: t.collection ?? null,
        record,
        status: "pending",
        agent: lease.agent,
        human: lease.human,
        skill: skill ?? skillLabel(t),
        place: lease.place ?? null,
        timestamp: now,
        source_check: { ...check, checked_at: now, ok: undefined },
        notes: notes ?? null,
        review: null,
      };
      delete finding.source_check.ok;
      if (superseded.length) finding.supersedes = superseded.map((f) => f.id);

      if (autoMerge.enabled && check.status !== "agent_text") {
        const rep = store.contributor({ human: lease.human });
        if (rep.approved >= autoMerge.min_approved && (rep.approval_rate ?? 0) >= autoMerge.min_approval_rate) {
          finding.status = "approved";
          finding.review = { decision: "approved", reviewer: "auto-merge", note: `contributor has ${rep.approved} approved at rate ${rep.approval_rate}`, at: now };
        }
      }
      store.addFinding(finding);
      const QUOTE_CHECK = { matched: "server_fetch", cached: "cached_text", agent_text: "agent_supplied", skipped: "none" };
      return text({ id: finding.id, status: finding.status, task, scope: lease.scope, quote_check: QUOTE_CHECK[check.status] ?? check.status, source_chars: check.source_chars ?? null, source_check: finding.source_check, disclosure: { agent: finding.agent, human: finding.human, skill: finding.skill, timestamp: now }, supersedes: finding.supersedes ?? null, next: finding.status === "pending" ? (finding.supersedes ? `A maintainer will review it. It replaces ${finding.supersedes.length} earlier pending finding${finding.supersedes.length === 1 ? "" : "s"} for the same record, which are now marked superseded. Submit the next record under the same lease.` : "A maintainer will review it. Submit the next record under the same lease.") : "Merged." });
    }
  );

  server.registerTool(
    "list_pending",
    { title: "List pending findings", description: "Findings awaiting review, newest last, optionally for one task. Each includes the record, its source check, and its disclosure line.", inputSchema: { task: z.string().optional(), limit: z.number().int().min(1).max(500).optional() } },
    async ({ task, limit = 100 }) => {
      const rows = store.state.findings.filter((f) => f.status === "pending" && (!task || f.task === task));
      return text({ count: rows.length, findings: rows.slice(-limit) });
    }
  );

  server.registerTool(
    "review_finding",
    {
      title: "Review a finding (maintainers)",
      description: `Approve or reject a pending finding. Requires the crew's maintainer token: pass it as \`token\` or send it as an HTTP Authorization: Bearer header. The token is the value of the ${ctx.tokenEnv} environment variable on the server.`,
      inputSchema: {
        id: z.string().min(1).describe("Finding id"),
        decision: z.enum(["approved", "rejected"]),
        reviewer: z.string().trim().min(1).describe("Who is deciding: handle or email"),
        note: z.string().trim().optional(),
        token: z.string().optional().describe("Maintainer token (or use an Authorization: Bearer header over HTTP)"),
      },
    },
    async ({ id, decision, reviewer, note, token }, extra) => {
      const expected = ctx.maintainerToken();
      if (!expected) return fail(`This server has no maintainer token configured (set ${ctx.tokenEnv}); review_finding is disabled.`);
      const given = token ?? bearerFrom(extra);
      if (!given || !safeEqual(given, expected)) return fail("Maintainer token missing or wrong.");
      const r = store.review(id, { decision, reviewer, note });
      if (!r.ok) return fail(`Cannot review ${id}: ${r.reason}`);
      return text({ id, status: r.finding.status, review: r.finding.review, contributor: store.contributor({ human: r.finding.human }) });
    }
  );

  // ---- documents ----
  server.registerTool(
    "fetch_document",
    {
      title: "Read a document without loading it",
      description:
        "Download a document once, extract its text on the server, and return only what you asked for: the passages matching your terms, with page numbers and surrounding context, plus the table of contents. " +
        "Use this instead of pulling a whole handbook into your context. The extracted copy is cached and is the same copy submit_finding checks your quote against, so you are verified against the text you actually read. " +
        "PDFs, HTML and plain text; up to 25 MB. A scanned PDF comes back with needs_ocr true and no text, which is when you read it yourself and submit with source_text.",
      inputSchema: {
        url: z.string().url().describe("The document. Must be the file or page itself, not a landing page."),
        terms: z.array(z.string().min(2)).optional().describe("What to look for. Defaults to the crew's document_terms."),
        pages: z.string().regex(/^\d+(-\d+)?$/).optional().describe("Return this page or range in full, e.g. '12' or '12-18', instead of term hits"),
        context_words: z.number().int().min(20).max(1200).optional().describe("Roughly how many words around each hit (default 300)"),
        toc: z.boolean().optional().describe("Include the detected table of contents (default true)"),
        archive: z.boolean().optional().describe("Fire a Wayback save; does not block (default true)"),
        refresh: z.boolean().optional().describe("Re-download even if cached"),
        lease_id: z.string().optional().describe("Your lease, so the fetch is logged against the work"),
      },
    },
    async ({ url, terms, pages, context_words = 300, toc = true, archive: doArchive = true, refresh = false, lease_id }) => {
      let doc;
      try {
        doc = await ctx.documents.get(url, { refresh });
      } catch (err) {
        return fail(`Could not read the document: ${err.message}`, { url, next: "If you can read it yourself, submit with source_text and it will be flagged for a human." });
      }
      const lease = lease_id ? store.findLease(lease_id) : null;
      store.logFetch?.({ url, sha256: doc.sha256, bytes: doc.bytes, pages: doc.page_count, at: new Date().toISOString(), agent: lease?.agent ?? null, human: lease?.human ?? null, lease_id: lease?.id ?? null });

      let archived = null;
      if (doArchive && !doc.cached) archive(url, ctx.fetchImpl).then((u) => { if (u) { doc.archived_url = u; ctx.documents.write(url, doc); } });

      const out = {
        url: doc.url,
        final_url: doc.final_url,
        sha256: doc.sha256,
        bytes: doc.bytes,
        content_type: doc.content_type,
        page_count: doc.page_count,
        fetched_at: doc.fetched_at,
        cached: doc.cached,
        extracted_by: doc.extracted_by,
        needs_ocr: doc.needs_ocr,
        archived_url: doc.archived_url ?? null,
        text_chars: (doc.text ?? "").length,
      };
      if (doc.needs_ocr) {
        out.warning = "No usable text layer; this is probably a scan. Read it yourself and submit with source_text.";
        return text(out);
      }
      if (pages) {
        const [a, b] = pages.split("-").map(Number);
        out.pages = pages;
        out.text = pageRange(doc, a, b ?? a);
      } else {
        const useTerms = terms?.length ? terms : (crew.crew.document_terms ?? ["policy"]);
        out.terms = useTerms;
        out.hits = searchDoc(doc, useTerms, { words: context_words });
        if (!out.hits.length) out.next = "Nothing matched. Try other wording, read the table of contents, or ask for a page range.";
      }
      if (toc) out.table_of_contents = tableOfContents(doc);
      return text(out);
    }
  );

  // ---- feedback: bugs, feature requests and questions in one queue ----
  const issuesDir = ctx.issuesDir;
  const ghToken = () => ctx.githubToken?.() ?? null;

  const fileIssue = async (a, kindDefault) => {
    const kind = a.kind ?? kindDefault;
    const title = String(a.title ?? a.summary ?? "").trim();
    const body = String(a.body ?? a.detail ?? a.problem ?? "").trim();
    if (!title) return fail("An issue needs a title.");
    if (body.length < 20) return fail("Say what happened and what you expected; twenty characters is not enough for anyone to act on.");

    const existing = store.state.issues ?? [];
    if (!a.confirm_new) {
      const dup = findDuplicate(existing, title, kind);
      if (dup) {
        return text({
          duplicate_of: { id: dup.issue.id, kind: dup.issue.kind, title: dup.issue.title, status: dup.issue.status, created_at: dup.issue.created_at, url: dup.issue.url ?? null },
          similarity: dup.score,
          nothing_was_filed: true,
          next: "If this is the same thing, reference that id in your finding's notes and carry on. If it is genuinely different, call again with confirm_new: true and a title that says how it differs.",
        });
      }
    }

    const now = new Date().toISOString();
    const issue = {
      id: newId("issue"),
      kind,
      title: title.slice(0, 120),
      body,
      status: "open",
      agent: a.agent ?? null,
      human: a.human ?? null,
      context: a.context ?? null,
      server_version: VERSION,
      protocol: PROTOCOL,
      created_at: now,
      url: null,
    };
    // context is auto-filled from the lease when the agent gives one
    if (a.lease_id) {
      const l = store.findLease(a.lease_id);
      if (l) issue.context = { lease_id: l.id, task: l.task, scope: l.scope, ...(issue.context ?? {}) , agent: issue.agent ?? l.agent, human: issue.human ?? l.human };
      issue.agent ??= l?.agent ?? null;
      issue.human ??= l?.human ?? null;
    }
    issue.url = await syncToGitHub(issue, { repo: crew.crew.repo, token: ghToken(), fetchImpl: ctx.fetchImpl });
    const file = writeIssueFile(issuesDir, issue);
    store.addIssue(issue);
    return text({
      id: issue.id,
      kind: issue.kind,
      status: issue.status,
      url: issue.url,
      open_it_yourself: issue.url ? null : manualIssueUrl(crew.crew.repo, issue),
      written_to: file,
      thanks: "Filed. A maintainer sees it with list_issues.",
      next: "Reference this id in the notes of any finding it affected, then carry on with the work.",
    });
  };

  server.registerTool(
    "report_issue",
    {
      title: "File a bug, a feature request or a question",
      description:
        "The one place to tell the maintainers something. kind 'bug' when something is broken: a check that refuses a correct finding, a tool that behaves differently from its description, a source the server cannot read. " +
        "kind 'feature' when the design is in your way: a field the schema cannot express, a task that should exist, a vocabulary that does not fit what the sources say. One capability per report, with a concrete example from the run that prompted it. " +
        "kind 'question' when the contract or a vocabulary is ambiguous and guessing would put something wrong in the record. " +
        "Near-duplicate titles are returned rather than filed again, so check the answer before assuming you filed something new.",
      inputSchema: {
        kind: z.enum(KINDS).describe("bug, feature or question"),
        title: z.string().trim().min(8).max(120).describe("One line"),
        body: z.string().trim().min(20).describe("What you did, what happened, what you expected. For a feature: what you were trying to do and what stopped you, before what to build."),
        lease_id: z.string().trim().optional().describe("Your lease, if you have one; task, scope, agent and human are filled in from it"),
        context: z.record(z.string(), z.unknown()).optional().describe("Anything else a maintainer needs: the failing tool call, the exact error, the record that would not submit"),
        agent: z.string().trim().optional(),
        human: z.string().trim().optional(),
        confirm_new: z.boolean().optional().describe("Set true to file anyway after a duplicate was returned"),
      },
    },
    async (a) => fileIssue(a, "bug")
  );

  // Kept so skills written against the earlier names keep working.
  server.registerTool(
    "report_bug",
    { title: "File a bug (alias of report_issue)", description: "Alias of report_issue with kind 'bug'. Prefer report_issue.", inputSchema: { summary: z.string().trim().min(8).max(120), detail: z.string().trim().min(20), tool: z.string().trim().optional(), task: z.string().trim().optional(), scope: z.string().trim().optional(), blocking: z.boolean().optional(), agent: z.string().trim().optional(), human: z.string().trim().optional(), record: z.record(z.string(), z.unknown()).optional(), lease_id: z.string().trim().optional(), confirm_new: z.boolean().optional() } },
    async (a) => fileIssue({ ...a, title: a.summary, body: a.detail, context: { tool: a.tool ?? null, task: a.task ?? null, scope: a.scope ?? null, blocking: a.blocking ?? false, record: a.record ?? null } }, "bug")
  );

  server.registerTool(
    "request_feature",
    { title: "Request a feature (alias of report_issue)", description: "Alias of report_issue with kind 'feature'. Prefer report_issue.", inputSchema: { summary: z.string().trim().min(8).max(120), problem: z.string().trim().min(20), proposal: z.string().trim().optional(), tool: z.string().trim().optional(), task: z.string().trim().optional(), scope: z.string().trim().optional(), frequency: z.enum(["once", "occasionally", "most records", "every record"]).optional(), agent: z.string().trim().optional(), human: z.string().trim().optional(), lease_id: z.string().trim().optional(), confirm_new: z.boolean().optional() } },
    async (a) => fileIssue({ ...a, title: a.summary, body: a.proposal ? `${a.problem}\n\nProposed: ${a.proposal}` : a.problem, context: { tool: a.tool ?? null, task: a.task ?? null, scope: a.scope ?? null, frequency: a.frequency ?? null } }, "feature")
  );

  server.registerTool(
    "list_issues",
    {
      title: "List issues",
      description: "The feedback queue: bugs, feature requests and questions, newest last. Check it before filing, so the same thing is not reported twice.",
      inputSchema: { kind: z.enum(KINDS).optional(), status: z.enum(STATUSES).optional(), limit: z.number().int().min(1).max(200).optional(), full: z.boolean().optional().describe("Include the body and context") },
    },
    async ({ kind, status = "open", limit = 50, full = false }) => {
      const rows = (store.state.issues ?? []).filter((i) => (!kind || i.kind === kind) && (!status || i.status === status));
      return text({
        count: rows.length,
        issues: rows.slice(-limit).map((i) => (full ? i : { id: i.id, kind: i.kind, title: i.title, status: i.status, created_at: i.created_at, url: i.url ?? null })),
      });
    }
  );

  // `report_bug` exists, so `list_bugs` has to. An agent that filed with one and could not list with
  // the other reported it as a missing tool, which it was.
  server.registerTool(
    "list_bugs",
    {
      title: "List bugs (alias of list_issues)",
      description: "Alias of list_issues filtered to kind 'bug'. Prefer list_issues, which also shows feature requests and questions.",
      inputSchema: { status: z.enum(STATUSES).optional(), limit: z.number().int().min(1).max(200).optional(), full: z.boolean().optional() },
    },
    async ({ status = "open", limit = 50, full = false }) => {
      const rows = (store.state.issues ?? []).filter((i) => i.kind === "bug" && (!status || i.status === status));
      return text({
        count: rows.length,
        issues: rows.slice(-limit).map((i) => (full ? i : { id: i.id, kind: i.kind, title: i.title, status: i.status, created_at: i.created_at, url: i.url ?? null })),
      });
    }
  );

  server.registerTool(
    "triage_issue",
    {
      title: "Triage an issue",
      description: `Set an issue's status. Requires the crew's maintainer token (${ctx.tokenEnv}), as \`token\` or an Authorization: Bearer header.`,
      inputSchema: { id: z.string(), status: z.enum(STATUSES), note: z.string().trim().optional(), token: z.string().optional() },
    },
    async ({ id, status, note, token }, extra) => {
      const expected = ctx.maintainerToken();
      if (!expected) return fail(`This server has no maintainer token configured (set ${ctx.tokenEnv}); triage_issue is disabled.`);
      const given = token ?? bearerFrom(extra);
      if (!given || given !== expected) return fail("Wrong or missing maintainer token.");
      const updated = store.updateIssue(id, { status, triage_note: note ?? null, triaged_at: new Date().toISOString() });
      if (!updated) return fail(`No issue '${id}'.`);
      writeIssueFile(issuesDir, updated);
      return text({ id, status, note: note ?? null });
    }
  );

  server.registerTool(
    "export_findings",
    {
      title: "Export findings for merging",
      description:
        "Approved findings as records, ready to merge into the crew's data files. This is the last mile: a finding is not part of the record until it lands in the repository. " +
        `Requires the maintainer token (${ctx.tokenEnv}), as \`token\` or an Authorization: Bearer header. ` +
        "Pass `since` to take only what has arrived since the last export, and `mark_exported` to stamp them so the next export skips them.",
      inputSchema: {
        status: z.enum(["approved", "pending", "rejected", "all"]).optional().describe("Default approved"),
        task: z.string().optional(),
        since: z.string().optional().describe("ISO timestamp; only findings reviewed after it"),
        include_exported: z.boolean().optional().describe("Include ones already stamped as exported (default false)"),
        mark_exported: z.boolean().optional().describe("Stamp the returned findings so the next export skips them"),
        limit: z.number().int().min(1).max(1000).optional(),
        token: z.string().optional(),
      },
    },
    async ({ status = "approved", task, since, include_exported = false, mark_exported = false, limit = 500, token }, extra) => {
      const expected = ctx.maintainerToken();
      if (!expected) return fail(`This server has no maintainer token configured (set ${ctx.tokenEnv}); export_findings is disabled.`);
      const given = token ?? bearerFrom(extra);
      if (!given || given !== expected) return fail("Wrong or missing maintainer token.");

      let rows = store.state.findings.filter((f) => (status === "all" || f.status === status) && (!task || f.task === task));
      if (!include_exported) rows = rows.filter((f) => !f.exported_at);
      if (since) { const t = Date.parse(since); if (!Number.isNaN(t)) rows = rows.filter((f) => Date.parse(f.review?.at ?? f.timestamp) > t); }
      rows = rows.slice(0, limit);

      if (mark_exported && rows.length) {
        const at = new Date().toISOString();
        for (const r of rows) { const f = store.state.findings.find((x) => x.id === r.id); if (f) f.exported_at = at; }
        store.save();
      }

      return text({
        count: rows.length,
        collection_hint: rows[0]?.collection ?? null,
        findings: rows.map((f) => ({
          id: f.id, task: f.task, scope: f.scope, collection: f.collection,
          record: f.record,
          source_check: f.source_check?.status ?? null,
          agent: f.agent, human: f.human, skill: f.skill,
          submitted_at: f.timestamp, reviewed_at: f.review?.at ?? null, reviewer: f.review?.reviewer ?? null,
          notes: f.notes ?? null,
        })),
        next: mark_exported
          ? "Stamped. Merge them into the crew's data files and commit; the next export will skip these."
          : "Merge these, then call again with mark_exported to stamp them.",
      });
    }
  );

  server.registerTool(
    "get_contributor",
    {
      title: "Contributor record",
      description: "Counts of pending, approved, and rejected findings and the approval rate for an agent, a human, or both together. This is the reputation the crew uses to decide whether a contributor's findings can auto-merge.",
      inputSchema: { agent: z.string().trim().min(1).optional(), human: z.string().trim().min(1).optional() },
    },
    async ({ agent, human }) => {
      if (!agent && !human) return fail("Give agent, human, or both.");
      const rep = store.contributor({ agent, human });
      const trusted = autoMerge.enabled && rep.approved >= autoMerge.min_approved && (rep.approval_rate ?? 0) >= autoMerge.min_approval_rate;
      return text({ ...rep, auto_merge: autoMerge.enabled ? (trusted ? "eligible" : `needs ${autoMerge.min_approved} approved at rate ${autoMerge.min_approval_rate}`) : "off" });
    }
  );

  // ---- search / fetch, for clients that expect those exact names ----
  //
  // ChatGPT's research connectors look for tools called `search` and `fetch` with a particular result
  // shape. The capability already exists here under better names; these are thin aliases over it, not a
  // second implementation, so there is nothing to keep in step. Any client benefits: "search then fetch"
  // is a reasonable thing to expect of a server whatever is asking.
  const claimUrl = (c) => (c.sources ?? []).find((x) => x.primary)?.url ?? (c.sources ?? [])[0]?.url ?? null;
  server.registerTool(
    "search",
    {
      title: "Search this crew",
      description:
        "Keyword search across the crew's verified claims and its data records, returning ids you can pass to fetch. " +
        "All words must match. Use it to find what this crew already knows before submitting anything, and to answer a question from the record rather than from memory.",
      inputSchema: { query: z.string().min(1).describe("Words to match") },
    },
    async ({ query }) => {
      const results = [];
      for (const c of searchClaims(crew.claims, query)) {
        results.push({ id: `claim:${c.id}`, title: String(c.claim ?? c.id).slice(0, 200), url: claimUrl(c) });
      }
      const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
      for (const [collection, recs] of Object.entries(crew.collections)) {
        for (const [id, rec] of Object.entries(recs)) {
          // A state's district file is one record holding hundreds of districts. Returning the file
          // when someone asks about Pike County is technically a hit and useless; the answer they want
          // is one district, so the rows inside are searched and returned individually.
          const rows = Array.isArray(rec?.districts) ? rec.districts : null;
          if (rows) {
            for (const d of rows) {
              const hay = JSON.stringify(d).toLowerCase();
              if (!words.every((w) => hay.includes(w))) continue;
              results.push({ id: `${collection}:${id}:${d.name}`, title: `${d.name}, ${id}: ${d.status === "bans" ? "prohibits" : d.status === "allows" ? "permits" : d.status} corporal punishment`.slice(0, 200), url: d.source ?? null });
              if (results.length > 200) break;
            }
            if (results.length > 200) break;
            continue;
          }
          const hay = JSON.stringify(rec).toLowerCase();
          if (!words.every((w) => hay.includes(w))) continue;
          results.push({ id: `${collection}:${id}`, title: `${rec?.name ?? id} (${collection})`.slice(0, 200), url: rec?.source ?? null });
          if (results.length > 200) break;
        }
        if (results.length > 200) break;
      }
      return text({ results: results.slice(0, 100) });
    }
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch one result",
      description: "The full text of one result from search, by the id search returned. Ids look like 'claim:<id>' or '<collection>:<id>'.",
      inputSchema: { id: z.string().min(1).describe("An id from search, e.g. claim:law-ingraham-v-wright-1977") },
    },
    async ({ id }) => {
      const i = String(id).indexOf(":");
      if (i < 1) return fail(`'${id}' is not a search id. They look like 'claim:<id>' or '<collection>:<id>'.`);
      const kind = id.slice(0, i), key = id.slice(i + 1);
      if (kind === "claim") {
        const c = crew.claims.find((x) => x.id === key);
        if (!c) return fail(`No claim '${key}'.`);
        return text({ id, title: String(c.claim ?? key).slice(0, 200), text: `${c.claim}\n\n${c.body ?? ""}`.trim(),
          url: claimUrl(c), metadata: { status: c.status, as_of: c.as_of ?? null, last_verified: c.last_verified ?? null, sources: c.sources ?? [] } });
      }
      const recs = crew.collections[kind];
      if (!recs) return fail(`No collection '${kind}'. Available: ${Object.keys(crew.collections).join(", ") || "(none)"}`);
      // search returns "<collection>:<state>:<district name>" for a row inside a state file.
      const deep = key.indexOf(":");
      if (deep > 0) {
        const parent = recs[key.slice(0, deep)], want = key.slice(deep + 1);
        const row = Array.isArray(parent?.districts) ? parent.districts.find((d) => d.name === want) : null;
        if (!row) return fail(`No district '${want}' in ${kind}:${key.slice(0, deep)}.`);
        return text({ id, title: `${row.name}, ${key.slice(0, deep)}`, text: JSON.stringify(row, null, 1), url: row.source ?? null,
          metadata: { collection: kind, state: key.slice(0, deep), status: row.status, quote: row.quote ?? null, last_verified: row.last_verified ?? null } });
      }
      const r = recs[key];
      if (r === undefined) return fail(`No record '${key}' in ${kind}.`);
      return text({ id, title: `${r?.name ?? key} (${kind})`, text: JSON.stringify(r, null, 1), url: r?.source ?? null, metadata: { collection: kind } });
    }
  );

  // ---- badges ----
  server.registerTool(
    "claim_badge",
    {
      title: "Claim your badge",
      description:
        "Mint a square, shareable badge for the work you have had approved here, and get the links to share it. " +
        "Nothing is minted until you ask: publishing someone's work under their name is theirs to decide. " +
        "Pass display_name only if the person you are working for wants a name on it -- ask them first, and leave it out if they would rather be the handle. " +
        "The badge carries the number of districts whose policy is on the public record because of them, and it links to the page where anyone else can start. Call it again any time; the numbers are recomputed from the record, never stored.",
      inputSchema: {
        human: z.string().trim().min(1).describe("The person whose work this is: the same handle or email their findings carry"),
        display_name: z.string().trim().min(1).max(40).optional().describe("A name to print on the badge, only if they asked for one. Otherwise the badge shows their anonymous handle."),
      },
    },
    async ({ human, display_name }) => {
      const b = badgeFor(ctx, { human });
      if (!b.approved) return fail(`Nothing approved yet for '${human}', so there is nothing to put on a badge. Submit a finding, and once a maintainer approves it this will work. get_contributor shows where you stand.`);
      store.state.badges ??= {};
      store.state.badges[b.id] = {
        ...(store.state.badges[b.id] ?? {}),
        display_name: display_name ?? store.state.badges[b.id]?.display_name ?? null,
        claimed_at: store.state.badges[b.id]?.claimed_at ?? new Date().toISOString(),
      };
      store.save();
      const base = (crew.crew.badge_base ?? "").replace(/\/$/, "");
      const fresh = badgeFor(ctx, { human });
      // Send the badge, do not merely link it. An image in the conversation is something the person can
      // save or post straight away; a URL is a chore. 600px keeps the payload around 38 KB of base64,
      // which is small enough to hand back on every call, and the full-size image stays at its URL.
      const svg = badgeSvg({ name: fresh.display_name ?? `contributor ${fresh.id}`, tier: fresh.tier,
        approved: fresh.districts, districts: fresh.districts, children: fresh.children,
        site: crew.crew.site ?? "", id: fresh.id });
      const png = await badgePng(svg, 600);
      const payload = {
        ...fresh,
        image: base ? `${base}/badge/${fresh.id}.svg` : `/badge/${fresh.id}.svg`,
        page: crew.crew.site ? `${String(crew.crew.site).replace(/\/$/, "")}/crew/${fresh.id}/` : null,
        share_text: `${fresh.display_name ?? "My agent"} put ${fresh.districts} school district${fresh.districts === 1 ? "'s" : "s'"} corporal punishment policy on the public record. Point yours at it: ${crew.crew.site ?? ""}/contribute`,
        privacy: "The badge shows your handle unless you gave a display name. Your email is never on it and never public.",
        next: "Share the image, or send someone the contribute page. The badge updates itself as more of your findings are approved.",
      };
      const content = [{ type: "text", text: JSON.stringify(payload, null, 2) }];
      if (png) content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
      else content.push({ type: "text", text: "This server has no rasterizer, so the badge is at the SVG url above rather than attached here." });
      return { content };
    }
  );

  server.registerTool(
    "get_badge",
    {
      title: "See a badge",
      description: "The badge figures for a contributor, whether or not they have claimed one: districts recorded, children covered by those districts in the federal count, and the tier those add up to.",
      inputSchema: { human: z.string().trim().min(1).optional(), id: z.string().trim().min(4).max(12).optional().describe("A public handle, if you have that rather than the person's address") },
    },
    async ({ human, id }) => {
      if (!human && !id) return fail("Give human or id.");
      if (human) return text(badgeFor(ctx, { human }));
      const rows = store.state.findings.filter((f) => f.status === "approved");
      const match = rows.find((f) => handleOf(f.human, crew.name) === id);
      if (!match) return fail(`No contributor with handle '${id}'.`);
      return text(badgeFor(ctx, { human: match.human }));
    }
  );

  // ---- templates (optional, kept from the campaign server) ----
  if (Object.keys(crew.templates).length) {
    server.registerTool(
      "get_template",
      { title: "Get a template", description: `One of the crew's templates (templates/*.md) by name. Available: ${Object.keys(crew.templates).join(", ")}. Omit name to list them.`, inputSchema: { name: z.string().optional() } },
      async ({ name }) => {
        if (!name) return text({ templates: Object.entries(crew.templates).map(([n, body]) => ({ name: n, title: (body.match(/^#\s+(.+)$/m) ?? [])[1] ?? n, chars: body.length })) });
        const body = crew.templates[name.trim().replace(/\.md$/, "")];
        if (!body) return fail(`No template '${name}'. Available: ${Object.keys(crew.templates).join(", ")}`);
        return text(body);
      }
    );
  }

  // ---- resources ----
  server.registerResource("facts", "crew://facts", { title: "Claims registry", description: "Every claim in facts/claims as JSON", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(crew.claims, null, 1) }],
  }));
  server.registerResource("tasks", "crew://tasks", { title: "Task queue", description: "tasks/tasks.yaml as JSON", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(crew.tasks, null, 1) }],
  }));
  server.registerResource("values", "crew://values", { title: "Values", description: "values.md", mimeType: "text/markdown" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: crew.values }],
  }));
  server.registerResource("contract", "crew://contract", { title: "Agent contract", description: "AGENTS.md", mimeType: "text/markdown" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: crew.agents }],
  }));

  // ---- prompts: one per task, returning the skill text plus the contract ----
  for (const t of crew.tasks) {
    server.registerPrompt(
      t.id,
      {
        title: t.title,
        description: `${t.description ?? t.title}. Unit of work: ${t.unit ?? "see skill"}. Returns the task's skill text and the agent contract; pass a scope to start.`,
        argsSchema: { scope: z.string().optional().describe(`The scope to work on, in the task's unit (${t.unit ?? "see skill"})`) },
      },
      ({ scope }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `${(crew.skills[t.id] ?? `# ${t.title}\n\nNo skill file is recorded for this task (${t.skill ?? "none"}); follow the task description: ${t.description ?? t.unit ?? ""}`).trim()}\n\n---\n\nThe agent contract that binds this task:\n\n${crew.agents.trim()}` +
                `\n\n---\n\nProtocol: claim the scope with claim_task({task: "${t.id}", scope, agent, human}), do the work, then submit_finding for each record with the lease id; release_lease when done.` +
                (scope ? `\n\nScope: ${scope}` : "\n\nNo scope was given; call list_tasks and list_leases, then ask which scope to take."),
            },
          },
        ],
      })
    );
  }

  return server;
}

// A crew may add its own tools by putting a tools.mjs in its directory that exports
// `registerTools(server, ctx, helpers)`. Anything specific to one problem domain belongs there,
// not in the engine.
export async function loadCrewTools(server, ctx) {
  const file = join(ctx.crewDir, "tools.mjs");
  if (!existsSync(file)) return [];
  try {
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.registerTools !== "function") return [];
    const names = await mod.registerTools(server, ctx, { z, text, fail, documents: ctx.documents, searchDoc, tableOfContents, pageRange, egressFetch, proxyCount });
    return Array.isArray(names) ? names : [];
  } catch (err) {
    console.error(`crew tools.mjs failed to load: ${err.message}`);
    return [];
  }
}

function skillLabel(t) {
  if (!t.skill) return "unspecified";
  const b = basename(t.skill, ".md");
  return b === "SKILL" ? basename(dirname(t.skill)) : b;
}
function slug(s) {
  return String(s ?? "crew").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "crew";
}
function sameScope(a, b) {
  return String(a).trim().toLowerCase().replace(/\s+/g, " ") === String(b).trim().toLowerCase().replace(/\s+/g, " ");
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------
function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

export async function runStdio(ctx) {
  const server = createServer(ctx);
  await loadCrewTools(server, ctx);
  await server.connect(new StdioServerTransport());
  console.error(`groundcrew ${VERSION} on stdio: ${ctx.crew.name} (${ctx.crewDir}; ${ctx.crew.claims.length} claims, ${ctx.crew.tasks.length} tasks; state ${ctx.statePath})`);
  return server;
}

export async function runHttp(ctx, { argv = process.argv, env = process.env } = {}) {
  const port = Number(arg(argv, "--port", env.PORT ?? 3000));
  const host = arg(argv, "--host", env.HOST ?? "0.0.0.0");
  const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  const rpcErr = (res, code, message) => json(res, code, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/healthz") {
      return json(res, 200, {
        ok: true,
        name: "groundcrew",
        crew: ctx.crew.name,
        version: VERSION,
        protocol: PROTOCOL,
        claims: ctx.crew.claims.length,
        tasks: ctx.crew.tasks.length,
        leases_active: ctx.store.activeLeases().length,
        egress_proxies: proxyCount(),
        egress: egressStats(),
        pending: ctx.store.state.findings.filter((f) => f.status === "pending").length,
      });
    }
    // Map tiles, proxied and cached so a visitor's browser never contacts a tile server directly.
    // Attribution to OpenStreetMap contributors is a condition of using these and is carried in the
    // activity feed alongside the coordinates that reference them.
    const tileMatch = url.pathname.match(/^\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/);
    if (tileMatch) {
      const [z, x, y] = tileMatch.slice(1).map(Number);
      const headers = { "Access-Control-Allow-Origin": "*" };
      if (!validTile(z, x, y)) { res.writeHead(400, { ...headers, "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "tile out of range" })); }
      try {
        const png = await ctx.tiles.get(z, x, y);
        res.writeHead(200, {
          ...headers,
          "Content-Type": "image/png",
          "Content-Length": png.length,
          "Cache-Control": "public, max-age=2592000, immutable",
          "X-Map-Attribution": ATTRIBUTION,
        });
        return res.end(png);
      } catch (err) {
        res.writeHead(502, { ...headers, "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // The crew roster: everyone who has claimed a badge, and what they have had approved. Only claimed
    // badges appear, because claiming one is the moment somebody chose to be listed. Everyone else's
    // work is in the record and in the activity feed, under a handle, exactly as before.
    if (url.pathname === "/crew.json") {
      const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60" };
      if (req.method === "OPTIONS") { res.writeHead(204, { ...headers, "Access-Control-Allow-Methods": "GET, OPTIONS" }); return res.end(); }
      if (req.method !== "GET") { res.writeHead(405, headers); return res.end(JSON.stringify({ error: "GET only" })); }
      const claimed = Object.keys(ctx.store.state.badges ?? {});
      const humans = new Map();
      for (const f of ctx.store.state.findings) {
        if (f.status !== "approved" || !f.human) continue;
        const id = handleOf(f.human, ctx.crew.name);
        if (claimed.includes(id) && !humans.has(id)) humans.set(id, f.human);
      }
      const members = [...humans].map(([id, human]) => {
        const b = badgeFor(ctx, { human });
        return { id: b.id, display_name: b.display_name, districts: b.districts, children: b.children,
                 tier: b.tier?.name ?? null, claimed_at: b.claimed_at, badge: `/badge/${b.id}.svg` };
      }).sort((a, b) => b.districts - a.districts || String(a.id).localeCompare(String(b.id)));
      // The totals cover everyone, claimed or not, so the roster never reads as if it were the whole crew.
      const everyone = new Set(ctx.store.state.findings.filter((f) => f.status === "approved" && f.human).map((f) => f.human));
      res.writeHead(200, headers);
      return res.end(JSON.stringify({
        crew: ctx.crew.name,
        members,
        contributors_total: everyone.size,
        listed: members.length,
        tiers: TIERS,
        note: "Only contributors who claimed a badge are listed. Everyone else's work is in the record and the activity feed under an anonymous handle.",
      }));
    }

    // A contributor's badge, as an image anyone can hotlink. It is generated from the record on every
    // request rather than stored, so it is never out of date with what the person has actually had
    // approved -- and so a badge cannot be forged by writing a file.
    //
    // SVG, not PNG: this server has no rasterizer and adding one for this is not worth the weight. SVG
    // renders in Slack, Discord, iMessage, GitHub and any browser, and downloads cleanly. The PNG that
    // Twitter and LinkedIn cards need is generated with the site, from this same markup.
    const badgeMatch = url.pathname.match(/^\/badge\/([0-9a-f]{4,12})\.(svg|png)$/);
    if (badgeMatch) {
      const id = badgeMatch[1];
      const wantPng = badgeMatch[2] === "png";
      const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": wantPng ? "image/png" : "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=300" };
      const row = ctx.store.state.findings.find((f) => f.status === "approved" && handleOf(f.human, ctx.crew.name) === id);
      if (!row) { res.writeHead(404, { ...headers, "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "no such contributor" })); }
      const b = badgeFor(ctx, { human: row.human });
      const svg = badgeSvg({
        name: b.display_name ?? `contributor ${b.id}`,
        tier: b.tier, approved: b.districts, districts: b.districts, children: b.children,
        site: ctx.crew.crew.site ?? "", id: b.id,
      });
      if (wantPng) {
        // Twitter and LinkedIn cards will not render SVG, so the social image has to be a raster.
        const png = await badgePng(svg, 1200);
        if (!png) { res.writeHead(501, { ...headers, "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "no rasterizer on this server; use the .svg" })); }
        res.writeHead(200, { ...headers, "Content-Length": png.length });
        return res.end(png);
      }
      res.writeHead(200, headers);
      return res.end(svg);
    }

    // The public feed. Readable by anyone, including a browser on the crew's own website, which is
    // why it is the only route that sets CORS and the only one that never sees a token.
    if (url.pathname === "/activity.json") {
      const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=20" };
      if (req.method === "OPTIONS") { res.writeHead(204, { ...headers, "Access-Control-Allow-Methods": "GET, OPTIONS" }); return res.end(); }
      if (req.method !== "GET") { res.writeHead(405, headers); return res.end(JSON.stringify({ error: "GET only" })); }
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
      let body;
      try { body = buildActivity(ctx, { limit }); }
      catch (err) { res.writeHead(500, headers); return res.end(JSON.stringify({ error: err.message })); }
      res.writeHead(200, headers);
      return res.end(JSON.stringify(body));
    }
    if (url.pathname === "/" && req.method === "GET") {
      return json(res, 200, { name: "groundcrew", crew: ctx.crew.name, mission: ctx.crew.mission, version: VERSION, mcp: "/mcp", health: "/healthz", activity: "/activity.json", crew_roster: "/crew.json", badge: "/badge/{handle}.svg or .png", tiles: "/tiles/{z}/{x}/{y}.png", repo: ctx.crew.crew.repo ?? null, site: ctx.crew.crew.site ?? null, brand: BRAND_LINE, attribution: CREW_ATTRIBUTION });
    }
    if (url.pathname !== "/mcp") return json(res, 404, { error: "not found" });
    if (req.method !== "POST") return rpcErr(res, 405, "Method not allowed; this server is stateless, POST JSON-RPC to /mcp");
    // The SDK version here never populates extra.requestInfo, so a tool handler cannot see the request
    // headers and every lease was being stored without a location -- the live map had agents on it and
    // nothing to draw. A fresh server is built per request anyway, so hand it the headers directly.
    const reqCtx = { ...ctx, requestHeaders: req.headers };
    const server = createServer(reqCtx);
    await loadCrewTools(server, reqCtx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("mcp request failed:", err);
      if (!res.headersSent) json(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  await new Promise((resolve) => httpServer.listen(port, host, resolve));
  const actual = httpServer.address().port;
  console.error(`groundcrew ${VERSION} http listening on http://${host}:${actual}/mcp (health: /healthz; crew ${ctx.crew.name} at ${ctx.crewDir}; state ${ctx.statePath})`);
  const stop = () => httpServer.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return httpServer;
}

export async function main(argv = process.argv) {
  const ctx = createContext({ crewDir: arg(argv, "--crew", process.env.GROUNDCREW_CREW ?? "./crew"), statePath: arg(argv, "--state", process.env.GROUNDCREW_STATE ?? "./state.json") });
  return argv.includes("--http") ? runHttp(ctx, { argv }) : runStdio(ctx);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) main().catch((err) => { console.error(err); process.exit(1); });
