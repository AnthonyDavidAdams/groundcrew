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

import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve, basename, dirname } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadCrew, searchClaims } from "./crew.mjs";
import { StateStore, DEFAULT_LEASE_TTL_HOURS, newId, publicLease } from "./state.mjs";
import { newAjv, formatErrors } from "./validate.mjs";
import { verifyQuote } from "./verify.mjs";

export const VERSION = "0.1.0";
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
  return { crew, store, validatorFor, maintainerToken, tokenEnv, ttlHours, autoMerge, fetchImpl, crewDir: resolve(crewDir), statePath: resolve(statePath) };
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
  const server = new McpServer(
    { name: `groundcrew:${slug(crew.name)}`, version: VERSION },
    {
      instructions:
        "This is a Ground Crew server. It holds one public problem's verified facts, its data, and its task queue, and it accepts findings from any agent. " +
        "Call get_started first: it explains what contributing means here and gives you the exact first calls. " +
        "The contract, in short: open every source yourself in this session, quote the sentence verbatim, date everything, never guess, never name a minor. " +
        "Work is leased so contributors do not duplicate each other (claim_task), and every finding is checked against its source and reviewed by a person before it enters the record (submit_finding). " +
        "If the server refuses a finding you believe is correct, or a tool behaves differently from its description, call report_bug rather than working around it; if the server cannot read a source you could read, resubmit with source_text. " +
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
        },

        // --- for you, the agent ---
        how_contributing_works: [
          "1. get_agent_contract: the rules. Open every source yourself, quote verbatim, date everything, never guess, no minors identified.",
          "2. list_tasks: pick one, and pick a scope inside it (usually a state or a slice of one).",
          "3. claim_task: takes a lease so nobody duplicates your work. Leases expire; renew_lease extends, release_lease hands it back.",
          "4. Do the work: find the primary document, open it, read the sentence that settles the question.",
          "5. submit_finding: one call per record. The server fetches your source and checks your quote against it. A record that fails is refused and not stored.",
          "6. A maintainer reviews. get_contributor shows your record.",
        ],
        if_something_breaks:
          "Call report_bug, and attach the record that would not submit so the work is not lost. If the server cannot read a source you could read yourself, resubmit with `source_text` set to the text you extracted.",
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
        brand: "Ground Crew is part of EarthPilot: mission support for Spaceship Earth.",
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
        `Take a ${ttlHours}-hour lease on one scope of one task so no one else reads the same thing. Returns {id, task, scope, expires_at}. Refused if the scope is already leased and not expired, or (when the task lists scopes) if the scope is not one of them. ` +
        "Give agent as your model and platform, e.g. 'claude-fable-5-1 via Claude.ai', and human as the handle or email of the person running you. Both are stored on every finding you submit. Call renew_lease before expires_at if you are still working; release_lease when you stop.",
      inputSchema: {
        task: z.string().min(1).describe("Task id from list_tasks"),
        scope: z.string().trim().min(1).describe("The unit of work, in the task's own unit, e.g. 'MS' or 'Texas, districts A-C' or 'crdc-national-total-2021-22'"),
        agent: z.string().trim().min(1).describe("Agent name and platform"),
        human: z.string().trim().min(1).describe("The person running the agent: handle or email"),
      },
    },
    async ({ task, scope, agent, human }) => {
      const t = crew.tasksById[task];
      if (!t) return fail(`No task '${task}'. Tasks: ${crew.tasks.map((x) => x.id).join(", ")}`);
      if (t.scopes) {
        const canonical = t.scopes.find((s) => sameScope(s, scope));
        if (!canonical) return fail(`Scope '${scope}' is not one of the task's scopes.`, { scopes: t.scopes });
        scope = canonical;
      }
      const r = store.claim({ task, scope, agent, human, ttlHours });
      if (!r.ok) return fail(`Scope '${scope}' of ${task} is already leased until ${r.lease.expires_at}. Pick another scope or wait.`, { lease: r.lease });
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
        source_text: z.string().trim().min(40).optional().describe("Only when the server cannot read the source itself: the text you extracted from it, containing the quoted sentence. Use this for scanned PDFs with no text layer, and for pages the server cannot reach but you could. The finding is stored, flagged as agent-supplied, and always sent to a human, never auto-merged."),
      },
    },
    async ({ task, lease_id, record, skill, notes, source_text }) => {
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

      const check = await verifyQuote(record, { fetchImpl: ctx.fetchImpl, sourceText: source_text });
      if (!check.ok) return fail(`Source check failed (${check.status}): ${check.detail}. The finding was not stored. Fix the quote or source and resubmit.`, { source: record.source, quote_prefix: String(record.quote).slice(0, 120) });

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
        timestamp: now,
        source_check: { ...check, checked_at: now, ok: undefined },
        notes: notes ?? null,
        review: null,
      };
      delete finding.source_check.ok;

      if (autoMerge.enabled && check.status !== "agent_text") {
        const rep = store.contributor({ human: lease.human });
        if (rep.approved >= autoMerge.min_approved && (rep.approval_rate ?? 0) >= autoMerge.min_approval_rate) {
          finding.status = "approved";
          finding.review = { decision: "approved", reviewer: "auto-merge", note: `contributor has ${rep.approved} approved at rate ${rep.approval_rate}`, at: now };
        }
      }
      store.addFinding(finding);
      return text({ id: finding.id, status: finding.status, task, scope: lease.scope, source_check: finding.source_check, disclosure: { agent: finding.agent, human: finding.human, skill: finding.skill, timestamp: now }, next: finding.status === "pending" ? "A maintainer will review it. Submit the next record under the same lease." : "Merged." });
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

  server.registerTool(
    "report_bug",
    {
      title: "Report a bug or a blocker",
      description:
        "Tell the maintainers that something on the server side is wrong or is blocking you: a check that refuses a correct finding, a tool that behaves differently from its description, a schema that cannot express what the source says, a source the server cannot read. " +
        "Use it instead of working around the problem silently, and instead of asking your human to patch data by hand. Include what you were doing and what you expected.",
      inputSchema: {
        summary: z.string().trim().min(10).max(200).describe("One line: what is broken"),
        detail: z.string().trim().min(20).describe("What you did, what happened, what you expected. Include the exact tool call and the exact error text."),
        tool: z.string().trim().optional().describe("The tool involved, e.g. submit_finding"),
        task: z.string().trim().optional().describe("Task id, if the bug happened inside one"),
        scope: z.string().trim().optional().describe("Scope you were working, e.g. TX"),
        blocking: z.boolean().optional().describe("True if you cannot complete the work at all because of this"),
        agent: z.string().trim().optional().describe("Your name and model"),
        human: z.string().trim().optional().describe("The person running you"),
        record: z.record(z.string(), z.unknown()).optional().describe("The record you were trying to submit, if any, so the work is not lost"),
      },
    },
    async (a) => {
      const bug = {
        id: newId("bug"),
        summary: a.summary,
        detail: a.detail,
        tool: a.tool ?? null,
        task: a.task ?? null,
        scope: a.scope ?? null,
        blocking: a.blocking ?? false,
        agent: a.agent ?? null,
        human: a.human ?? null,
        record: a.record ?? null,
        server_version: VERSION,
        protocol: PROTOCOL,
        status: "open",
        at: new Date().toISOString(),
      };
      store.addBug(bug);
      return text({
        id: bug.id,
        status: "open",
        thanks: "Logged. A maintainer sees this with list_bugs.",
        next: a.record
          ? "Your record was saved with the report, so the work is not lost even though the finding was refused."
          : "If you had a record that would not submit, call report_bug again with it in `record` so the work is not lost.",
        workaround: a.tool === "submit_finding" ? "If the server could not read a source you could read: resubmit with `source_text` set to the text you extracted from it." : null,
      });
    }
  );

  server.registerTool(
    "list_bugs",
    {
      title: "List reported bugs",
      description: "Bug reports from contributors, newest last. Maintainer view: pass the maintainer token to see the attached records.",
      inputSchema: { open_only: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional(), token: z.string().optional() },
    },
    async ({ open_only = true, limit = 50, token }, extra) => {
      const rows = (store.state.bugs ?? []).filter((b) => (open_only ? b.status === "open" : true));
      const expected = ctx.maintainerToken();
      const given = token ?? bearerFrom(extra);
      const authorised = Boolean(expected && given && given === expected);
      return text({
        count: rows.length,
        bugs: rows.slice(-limit).map((b) => (authorised ? b : { ...b, record: b.record ? "(maintainer token required)" : null })),
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
        pending: ctx.store.state.findings.filter((f) => f.status === "pending").length,
      });
    }
    if (url.pathname === "/" && req.method === "GET") {
      return json(res, 200, { name: "groundcrew", crew: ctx.crew.name, mission: ctx.crew.mission, version: VERSION, mcp: "/mcp", health: "/healthz", repo: ctx.crew.crew.repo ?? null, site: ctx.crew.crew.site ?? null, brand: "Ground Crew is part of EarthPilot: mission support for Spaceship Earth." });
    }
    if (url.pathname !== "/mcp") return json(res, 404, { error: "not found" });
    if (req.method !== "POST") return rpcErr(res, 405, "Method not allowed; this server is stateless, POST JSON-RPC to /mcp");
    const server = createServer(ctx);
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
