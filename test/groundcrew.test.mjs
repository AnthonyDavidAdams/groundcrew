// End-to-end test: init a crew, add a claim and a record, validate, run the server on stdio and drive the
// whole contribute loop through the SDK client, then check the HTTP transport. Run: npm test
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cli = join(root, "bin", "groundcrew.mjs");
const serverPath = join(root, "server", "index.mjs");
const TOKEN = "test-maintainer-token";

let passed = 0;
const ok = (name) => { passed++; console.log(`ok - ${name}`); };
const parse = (r) => { assert.ok(!r.isError, `tool returned error: ${r.content?.[0]?.text}`); return JSON.parse(r.content[0].text); };
const errText = (r) => { assert.ok(r.isError, `expected an error, got: ${r.content?.[0]?.text}`); return r.content[0].text; };

const tmp = mkdtempSync(join(tmpdir(), "groundcrew-"));
const crewDir = join(tmp, "crew");
const statePath = join(tmp, "state.json");

// ---- a local HTTP fixture standing in for a district policy page ----
const QUOTE = "Corporal punishment may be administered by the principal or the principal's designee in the presence of another certified employee.";
const fixture = createHttpServer((req, res) => {
  if (req.url === "/policy-JDA") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<html><head><title>Policy JDA</title><style>p{}</style></head><body><h1>JDA   Corporal Punishment</h1>
      <p>Corporal   punishment may be administered by the principal or the principal&#39;s designee
      in the presence of another certified employee.</p><script>var x = 1;</script></body></html>`);
  } else { res.writeHead(404); res.end("no"); }
});
await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;

try {
  // ---- init ----
  const init = spawnSync(process.execPath, [cli, "init", crewDir, "--name", "Test Crew", "--mission", "End a test practice in every test district."], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  for (const f of ["crew.json", "values.md", "AGENTS.md", "CODE_OF_CONDUCT.md", "tasks/tasks.yaml", "data/schema/record.schema.json", "facts/claims/example-units-total-2025.md"]) assert.ok(existsSync(join(crewDir, f)), `init wrote ${f}`);
  ok("groundcrew init writes a crew skeleton");

  // ---- add a claim and a record ----
  writeFileSync(join(crewDir, "facts/claims/test-total-2024.md"), `---
id: test-total-2024
claim: "In 2024, 12 test districts still allowed the practice."
status: verified
figure: 12
as_of: "2024"
sources:
  - url: ${fixtureUrl}/policy-JDA
    title: "Policy JDA"
    publisher: "Test District"
    date: "2024-01-01"
    primary: true
tags: [test, districts]
last_verified: 2026-09-10
verified_by: "agent:test run by test"
---

A test claim.
`);
  mkdirSync(join(crewDir, "data/records"), { recursive: true });
  writeFileSync(join(crewDir, "data/records/test-0002.json"), JSON.stringify({ name: "Rankin Test District", region: "MS", external_id: "test-0002", status: "allows", source: `${fixtureUrl}/policy-JDA`, quote: QUOTE, last_verified: "2026-09-10", notes: null }, null, 2));

  // ---- validate: passes, then fails on a bad record ----
  let v = spawnSync(process.execPath, [cli, "validate", crewDir], { encoding: "utf8" });
  assert.equal(v.status, 0, v.stderr + v.stdout);
  assert.ok(/0 failures/.test(v.stdout), v.stdout);
  ok(`groundcrew validate passes: ${v.stdout.trim()}`);

  writeFileSync(join(crewDir, "data/records/bad.json"), JSON.stringify({ name: "Bad", status: "allows", last_verified: "2026-09-10" }));
  v = spawnSync(process.execPath, [cli, "validate", crewDir], { encoding: "utf8" });
  assert.equal(v.status, 1);
  assert.ok(/FAIL data\/records\/bad/.test(v.stderr), v.stderr);
  rmSync(join(crewDir, "data/records/bad.json"));
  ok("groundcrew validate fails on a record missing source and quote");

  // ---- stdio server ----
  const env = { ...process.env, GROUNDCREW_CREW: crewDir, GROUNDCREW_STATE: statePath, GROUNDCREW_MAINTAINER_TOKEN: TOKEN };
  const client = new Client({ name: "groundcrew-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: "pipe" }));

  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ["get_crew", "get_agent_contract", "list_tasks", "claim_task", "renew_lease", "release_lease", "list_leases", "search_facts", "get_fact", "get_record", "list_records", "submit_finding", "list_pending", "review_finding", "get_contributor"]) assert.ok(tools.includes(t), `missing tool ${t}`);
  ok(`list_tools: ${tools.length} tools`);

  const crew = parse(await client.callTool({ name: "get_crew", arguments: {} }));
  assert.equal(crew.name, "Test Crew");
  assert.ok(crew.mission.startsWith("End a test practice") && crew.values.includes("What we are for") && crew.lease_ttl_hours === 4 && crew.auto_merge === false);
  ok("get_crew");

  const contract = await client.callTool({ name: "get_agent_contract", arguments: {} });
  assert.ok(contract.content[0].text.includes("Open the source") && contract.content[0].text.includes("Public record only"));
  ok("get_agent_contract includes AGENTS.md and the code of conduct");

  const tasks = parse(await client.callTool({ name: "list_tasks", arguments: {} }));
  assert.ok(tasks.count >= 2 && tasks.tasks[0].id === "record-scan" && tasks.tasks[0].priority === 1 && tasks.tasks[0].schema);
  ok(`list_tasks: ${tasks.count} tasks`);

  const facts = parse(await client.callTool({ name: "search_facts", arguments: { query: "test districts" } }));
  assert.equal(facts.count, 1); assert.equal(facts.results[0].id, "test-total-2024");
  const fact = parse(await client.callTool({ name: "get_fact", arguments: { id: "test-total-2024" } }));
  assert.equal(fact.figure, 12); assert.ok(fact.body.includes("A test claim"));
  ok("search_facts / get_fact");

  const rec = parse(await client.callTool({ name: "get_record", arguments: { collection: "records", id: "test-0002" } }));
  assert.equal(rec.record.name, "Rankin Test District");
  const recs = parse(await client.callTool({ name: "list_records", arguments: { collection: "records" } }));
  assert.ok(recs.ids.includes("test-0002") && recs.ids.includes("example-0001"));
  ok("get_record / list_records");

  // ---- leases ----
  const lease = parse(await client.callTool({ name: "claim_task", arguments: { task: "record-scan", scope: "MS", agent: "claude-test via test", human: "tester@example.org" } }));
  assert.ok(lease.id.startsWith("lease_") && lease.task === "record-scan" && lease.scope === "MS");
  const ttl = Date.parse(lease.expires_at) - Date.now();
  assert.ok(ttl > 3.9 * 3600_000 && ttl <= 4 * 3600_000 + 5000, `ttl ${ttl}`);
  ok(`claim_task -> ${lease.id}, expires in ~4h`);

  const dup = errText(await client.callTool({ name: "claim_task", arguments: { task: "record-scan", scope: "ms", agent: "other", human: "other@example.org" } }));
  assert.ok(dup.includes("already leased"), dup);
  ok("second claim_task on the same scope is refused");

  const leases = parse(await client.callTool({ name: "list_leases", arguments: {} }));
  assert.equal(leases.count, 1); assert.equal(leases.leases[0].id, lease.id);
  const renewed = parse(await client.callTool({ name: "renew_lease", arguments: { lease_id: lease.id } }));
  assert.ok(Date.parse(renewed.expires_at) >= Date.parse(lease.expires_at) && renewed.renewed === 1);
  ok("list_leases / renew_lease");

  // ---- findings ----
  const good = parse(await client.callTool({
    name: "submit_finding",
    arguments: { task: "record-scan", lease_id: lease.id, skill: "record-scan@test", record: { name: "Test County Schools", region: "MS", external_id: "test-0003", status: "allows", source: `${fixtureUrl}/policy-JDA`, quote: QUOTE, last_verified: "2026-09-10" } },
  }));
  assert.equal(good.status, "pending"); assert.equal(good.source_check.status, "matched");
  assert.equal(good.quote_check, "server_fetch", JSON.stringify(good));
  assert.ok(good.source_chars > 0, "source_chars is reported");
  assert.deepEqual(Object.keys(good.disclosure).sort(), ["agent", "human", "skill", "timestamp"]);
  assert.equal(good.disclosure.human, "tester@example.org");
  ok(`submit_finding with a quote found at the source -> pending (${good.id})`);

  const bad = errText(await client.callTool({
    name: "submit_finding",
    arguments: { task: "record-scan", lease_id: lease.id, record: { name: "Other District", region: "MS", external_id: "test-0004", status: "bans", source: `${fixtureUrl}/policy-JDA`, quote: "Corporal punishment is prohibited in every school of this district.", last_verified: "2026-09-10" } },
  }));
  assert.ok(bad.includes("not_found"), bad);
  // A rejection has to say what the server looked for, not only that it failed.
  const badJson = JSON.parse(bad.slice(bad.indexOf("{")));
  assert.equal(badJson.quote_check, "failed");
  assert.ok(badJson.sought.startsWith("corporal punishment is prohibited"), badJson.sought);
  assert.equal(typeof badJson.matched_chars, "number");
  assert.ok(badJson.source_chars > 0);
  ok("submit_finding with a quote not in the source is rejected, and says what it sought");

  const badSchema = errText(await client.callTool({ name: "submit_finding", arguments: { task: "record-scan", lease_id: lease.id, record: { name: "No status" } } }));
  assert.ok(badSchema.includes("does not match the schema"), badSchema);
  const badFetch = errText(await client.callTool({ name: "submit_finding", arguments: { task: "record-scan", lease_id: lease.id, record: { name: "Gone", status: "allows", source: `${fixtureUrl}/missing`, quote: QUOTE, last_verified: "2026-09-10" } } }));
  assert.ok(badFetch.includes("fetch_failed"), badFetch);
  ok("submit_finding rejects a schema violation and an unfetchable source");

  const pending = parse(await client.callTool({ name: "list_pending", arguments: {} }));
  assert.equal(pending.count, 1); assert.equal(pending.findings[0].id, good.id); assert.equal(pending.findings[0].agent, "claude-test via test");
  ok("list_pending shows the one stored finding with its disclosure");

  const noToken = errText(await client.callTool({ name: "review_finding", arguments: { id: good.id, decision: "approved", reviewer: "maintainer" } }));
  assert.ok(noToken.includes("token"), noToken);
  const wrongToken = errText(await client.callTool({ name: "review_finding", arguments: { id: good.id, decision: "approved", reviewer: "maintainer", token: "nope" } }));
  assert.ok(wrongToken.includes("token"), wrongToken);
  const reviewed = parse(await client.callTool({ name: "review_finding", arguments: { id: good.id, decision: "approved", reviewer: "maintainer", token: TOKEN } }));
  assert.equal(reviewed.status, "approved"); assert.equal(reviewed.review.reviewer, "maintainer");
  ok("review_finding refuses without the maintainer token, approves with it");

  const contributor = parse(await client.callTool({ name: "get_contributor", arguments: { human: "tester@example.org" } }));
  assert.equal(contributor.approved, 1); assert.equal(contributor.pending, 0); assert.equal(contributor.rejected, 0); assert.equal(contributor.approval_rate, 1);
  const byAgent = parse(await client.callTool({ name: "get_contributor", arguments: { agent: "claude-test via test" } }));
  assert.equal(byAgent.approved, 1);
  ok("get_contributor: 1 approved");

  const released = parse(await client.callTool({ name: "release_lease", arguments: { lease_id: lease.id } }));
  assert.equal(released.released, true);
  const afterRelease = errText(await client.callTool({ name: "submit_finding", arguments: { task: "record-scan", lease_id: lease.id, record: { name: "Late", status: "unknown", last_verified: "2026-09-10" } } }));
  assert.ok(afterRelease.includes("released"), afterRelease);
  ok("release_lease; submissions under a released lease are refused");

  const res = await client.listResources();
  assert.ok(res.resources.some((r) => r.uri === "crew://facts") && res.resources.some((r) => r.uri === "crew://tasks"));
  const factsRes = JSON.parse((await client.readResource({ uri: "crew://facts" })).contents[0].text);
  assert.ok(factsRes.some((c) => c.id === "test-total-2024"));
  ok("resources crew://facts, crew://tasks");

  const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
  assert.ok(prompts.includes("record-scan") && prompts.includes("verify-claim"));
  const prompt = await client.getPrompt({ name: "record-scan", arguments: { scope: "MS" } });
  assert.ok(prompt.messages[0].content.text.includes("# Record scan") && prompt.messages[0].content.text.includes("Scope: MS"));
  ok("prompts named after each task return the skill text");

  // ---- every advertised tool has a handler ----
  // A contributor reported a tool that the listing did not have; the reverse (a tool registered but
  // named nowhere) is just as easy to ship. Call each one with no arguments: a schema complaint means
  // the handler is there, "Tool X not found" means it is not.
  const listed = (await client.listTools()).tools.map((t) => t.name).sort();
  const missing = [];
  for (const name of listed) {
    const r = await client.callTool({ name, arguments: {} });
    if (String(r.content?.[0]?.text ?? "").includes(`Tool ${name} not found`)) missing.push(name);
  }
  assert.deepEqual(missing, [], `advertised with no handler: ${missing.join(", ")}`);
  assert.ok(listed.includes("list_bugs") && listed.includes("report_bug"), "report_bug and list_bugs come as a pair");
  ok(`all ${listed.length} advertised tools have a handler`);

  // ---- the docs name only tools that exist ----
  // Anything backticked that starts with one of the tool verbs is a tool name, and has to be real.
  // Field names like `source_text` and `quote` do not start with a verb, so they are not swept up.
  const TOOL_VERB = /^(get|list|claim|renew|release|search|submit|review|report|request|fetch|export|triage|resolve)_[a-z0-9_]+$/;
  const prose = [
    ["crew/AGENTS.md", readFileSync(join(crewDir, "AGENTS.md"), "utf8")],
    ["get_started", (await client.callTool({ name: "get_started", arguments: {} })).content.map((c) => c.text ?? "").join("\n")],
    ["get_agent_contract", (await client.callTool({ name: "get_agent_contract", arguments: {} })).content.map((c) => c.text ?? "").join("\n")],
    ...(existsSync(join(crewDir, "tasks/README.md")) ? [["tasks/README.md", readFileSync(join(crewDir, "tasks/README.md"), "utf8")]] : []),
  ];
  const ghosts = [];
  for (const [where, body] of prose) {
    for (const m of body.matchAll(/`([a-z0-9_]{4,40})`/g)) {
      if (TOOL_VERB.test(m[1]) && !listed.includes(m[1])) ghosts.push(`${where}: ${m[1]}`);
    }
  }
  assert.deepEqual(ghosts, [], `documentation names tools that do not exist: ${ghosts.join(", ")}`);
  ok(`${prose.length} documents name only live tools`);

  await client.close();

  // state survived on disk, written atomically (no temp files left behind)
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.findings.length, 1); assert.equal(state.findings[0].status, "approved");
  assert.ok(!existsSync(`${statePath}.tmp`));
  ok("state.json persisted");

  // ---- http transport ----
  const child = spawn(process.execPath, [cli, "serve", crewDir, "--http", "--port", "0", "--host", "127.0.0.1", "--state", statePath], { env, stdio: ["ignore", "ignore", "pipe"] });
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    child.stderr.on("data", (d) => { buf += d; const m = buf.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/); if (m) resolve(Number(m[1])); });
    child.on("exit", (c) => reject(new Error(`http server exited ${c}: ${buf}`)));
    setTimeout(() => reject(new Error("http server did not start")), 10000);
  });
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.equal(health.ok, true); assert.equal(health.crew, "Test Crew"); assert.equal(health.tasks, 2);
    ok(`GET /healthz on :${port}`);

    const hc = new Client({ name: "groundcrew-test-http", version: "0.0.0" });
    await hc.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const c2 = parse(await hc.callTool({ name: "get_contributor", arguments: { human: "tester@example.org" } }));
    assert.equal(c2.approved, 1);
    ok("HTTP transport get_contributor reads the same state");

    // ---- badges ----
    const none = parse(await hc.callTool({ name: "get_badge", arguments: { human: "nobody@example.org" } }));
    assert.equal(none.approved, 0);
    assert.equal(none.tier, null);
    ok("get_badge on a stranger reports nothing rather than failing");

    // Nothing is listed until somebody claims, which is the opt-in the whole design rests on.
    const before = await (await fetch(`http://127.0.0.1:${port}/crew.json`)).json();
    assert.equal(before.members.length, 0);
    ok("crew roster is empty before anyone claims a badge");

    const claimed = parse(await hc.callTool({ name: "claim_badge", arguments: { human: "tester@example.org", display_name: "A Tester" } }));
    assert.equal(claimed.display_name, "A Tester");
    assert.equal(claimed.districts, 1);
    assert.match(claimed.image, /\/badge\/[0-9a-f]{6}\.svg$/);
    ok("claim_badge mints a badge with the figures from the record");

    const roster = await (await fetch(`http://127.0.0.1:${port}/crew.json`)).json();
    assert.equal(roster.members.length, 1);
    assert.equal(roster.members[0].display_name, "A Tester");
    assert.equal(roster.contributors_total >= 1, true);
    ok("crew roster lists a contributor once they have claimed");

    const svgRes = await fetch(`http://127.0.0.1:${port}${claimed.image}`);
    const svg = await svgRes.text();
    assert.equal(svgRes.headers.get("content-type").startsWith("image/svg+xml"), true);
    assert.match(svg, /<svg[^>]*width="1200"[^>]*height="1200"/);
    assert.match(svg, /A Tester/);
    // The email must never reach the image.
    assert.equal(svg.includes("tester@example.org"), false);
    ok("the badge image is square, carries the name, and never carries the address");

    // The badge has to arrive as an image, not as a link to one: that is the difference between the
    // contributor having something to post and having an errand.
    const raw = await hc.callTool({ name: "claim_badge", arguments: { human: "tester@example.org" } });
    const img = raw.content.find((c) => c.type === "image");
    assert.ok(img, "claim_badge returns an image block");
    assert.equal(img.mimeType, "image/png");
    assert.equal(Buffer.from(img.data, "base64").subarray(1, 4).toString(), "PNG");
    ok("claim_badge sends the badge as a PNG in the tool result");

    const pngRes = await fetch(`http://127.0.0.1:${port}${claimed.image.replace(/\.svg$/, ".png")}`);
    assert.equal(pngRes.headers.get("content-type"), "image/png");
    const head = Buffer.from(await pngRes.arrayBuffer()).subarray(0, 8);
    assert.equal(head.subarray(1, 4).toString(), "PNG");
    ok("the badge is also served as a PNG, which is what social cards need");

    // The failure that looks like success: a container with no fonts renders every shape and no text,
    // and the result is a perfectly valid PNG of an empty circle. Assert that a textless render is
    // refused, at every size, rather than that the bytes are a PNG.
    {
      const { badgePng, looksRendered } = await import("../server/badge.mjs");
      const blank = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200"><rect width="1200" height="1200" fill="#0B1129"/><circle cx="600" cy="470" r="128" fill="#12331F"/></svg>`;
      assert.equal(await badgePng(blank, 300), null, "a render with no text is refused");
      assert.equal(typeof looksRendered, "function");
      ok("a badge whose text did not draw is refused rather than served");
    }

    // A lease has to block the work it overlaps, not only an identical string. Two agents held "MO" and
    // a Missouri district at the same time in production because this check was an equality test.
    {
      const wide = parse(await hc.callTool({ name: "claim_task", arguments: { task: "record-scan", scope: "ZZ", agent: "test", human: "tester@example.org" } }));
      assert.ok(wide.id, "a wide scope can be claimed");
      const narrow = await hc.callTool({ name: "claim_task", arguments: { task: "record-scan", scope: "ZZ: Some District", agent: "test", human: "other@example.org" } });
      assert.equal(narrow.isError, true, "a scope inside a leased one is refused");
      assert.match(narrow.content[0].text, /overlaps/);
      const elsewhere = parse(await hc.callTool({ name: "claim_task", arguments: { task: "record-scan", scope: "YY: Some District", agent: "test", human: "other@example.org" } }));
      assert.ok(elsewhere.id, "a scope outside the leased one is still available");
      ok("a lease blocks a narrower scope inside it, and does not block one outside it");
    }

    // One pending finding per record. A ten-agent fleet submitted Lamar County three times and
    // Enterprise City twice with opposite statuses, all under one lease, and a reviewer had to guess.
    {
      const lease = parse(await hc.callTool({ name: "claim_task", arguments: { task: "record-scan", scope: "WW", agent: "test", human: "dupe@example.org" } }))
      const rec = { region: "WW", name: "Same District", external_id: "9999999", status: "unknown", last_verified: "2026-09-21" }
      const first = parse(await hc.callTool({ name: "submit_finding", arguments: { task: "record-scan", lease_id: lease.id, record: rec } }))
      assert.equal(first.status, "pending")
      const second = parse(await hc.callTool({ name: "submit_finding", arguments: { task: "record-scan", lease_id: lease.id, record: { ...rec, notes: "corrected" } } }))
      assert.equal(second.status, "pending")
      assert.deepEqual(second.supersedes, [first.id], "the second submission supersedes the first")
      const pend = parse(await hc.callTool({ name: "list_pending", arguments: { task: "record-scan" } }))
      const forThis = pend.findings.filter((f) => f.record?.external_id === "9999999")
      assert.equal(forThis.length, 1, "only the newer one is pending")
      assert.equal(forThis[0].record.notes, "corrected", "and it is the newer one")
      ok("a second finding for the same record supersedes the first instead of queueing beside it")
    }

    // The egress pool is optional and must be invisible when unset: a server with no proxies configured
    // behaves exactly as before, which is the only property worth asserting without real proxies.
    {
      const { egressFetch, proxyCount } = await import("../server/egress.mjs")
      assert.equal(proxyCount(), 0, "no proxies configured in the test environment")
      const f = egressFetch()
      const r = await f(`http://127.0.0.1:${port}/healthz`)
      assert.equal(r.status, 200, "egressFetch with an empty pool is a plain fetch")
      const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()
      assert.equal(h.egress_proxies, 0, "healthz reports the pool size so a deploy can be checked")
      ok("the egress pool is a no-op when none is configured, and healthz reports its size")
    }

    // Every crew site carries the same attribution line, and it is served rather than hard-coded in
    // each crew's pages, so a crew that forgets to write it cannot exist and a change to the wording
    // reaches all of them. If this ever comes back null a crew site silently drops the credit.
    {
      const root = await (await fetch(`http://127.0.0.1:${port}/`)).json()
      assert.match(root.brand, /Created with Ground Crew/, "the root endpoint states who built the machinery")
      assert.equal(root.attribution.text, "Created with Ground Crew")
      assert.ok(root.attribution.href, "the attribution carries a link, or a site cannot render it")
      const act = await (await fetch(`http://127.0.0.1:${port}/activity.json`)).json()
      assert.equal(act.attribution.text, "Created with Ground Crew", "the public feed a crew site renders from carries it too")
      ok("every crew inherits the Ground Crew attribution from the server")
    }

    // A lease has to carry where it came from, or the live map has agents on it and nothing to draw.
    // This is asserted through the real HTTP transport, because the bug was that the SDK never gave the
    // tool handler the request headers and no unit test would have noticed.
    {
      const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": "8.8.8.8" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "claim_task", arguments: { task: "record-scan", scope: "GEO", agent: "geo test", human: "geo@example.org" } } }),
      })
      const line = (await r.text()).split("\n").find((l) => l.startsWith("data: "))
      const lease = JSON.parse(JSON.parse(line.slice(6)).result.content[0].text)
      assert.ok(lease.place && lease.place.country_code, `a lease resolves a place from the forwarded address, got ${JSON.stringify(lease.place)}`)
      ok(`a claim records where it came from (${lease.place.label})`)
    }

    const missing = await fetch(`http://127.0.0.1:${port}/badge/deadbe.svg`);
    assert.equal(missing.status, 404);
    ok("a badge for a handle nobody holds is a 404, not a blank certificate");

    await hc.close();
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
  }
} finally {
  fixture.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed`);
