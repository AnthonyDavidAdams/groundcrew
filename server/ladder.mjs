// The activist ladder: what a crew asks of a contributor after the compute.
//
// A person who pointed their agent at the crew once has done the first thing. The crew then asks the
// next thing, and the next, each small and each recorded when the person says it is done: run it on a
// schedule, share the record with the people who can act on it, lend standing to a request, give time
// or money. The rungs and their words come from crew.json `ladder.steps`; the engine only decides
// which rung is next and keeps the ledger of what the contributor has confirmed.
//
//   ladder: { steps: [ { id, title, ask, how, links, done_when: {findings: 1} | {active_days: 3} | {action: "shared"} } ] }
//   share:  { library: "https://…/share/assets.json" }   — posts and images the agent can hand the human
//
// Nothing here sends anything or spends anything. The agent shows the ask; the human decides.

const DEFAULT_STEPS = [
  { id: "contribute", title: "Contribute compute once", ask: "Point your agent at the crew and let it read one slice of the record.", done_when: { findings: 1 } },
  { id: "recurring", title: "Make it recurring", ask: "Set your agent to check in on a schedule so the record keeps moving without you thinking about it.", how: "A scheduled task in your assistant, or a cron entry that runs your agent against this server once a day.", done_when: { active_days: 3 } },
  { id: "share", title: "Share it with the people who can act", ask: "Post the record to the community that can change it. The share kit has posts and images with every figure sourced.", done_when: { action: "shared" } },
  { id: "time", title: "Give an hour", ask: "Show up once: a board meeting, a call, a letter.", done_when: { action: "gave_time" } },
  { id: "donate", title: "Fund the compute", ask: "The record runs on donated compute and a little money; cover a month of it.", done_when: { action: "donated" } },
];
const ACTIONS = ["recurring_set_up", "shared", "made_video", "joined_exchange", "gave_time", "donated", "recruited", "other"];

export function ladderSteps(crew) {
  const steps = crew.crew.ladder?.steps;
  return Array.isArray(steps) && steps.length ? steps : DEFAULT_STEPS;
}

function activeDays(findings) {
  return new Set(findings.map((f) => String(f.timestamp ?? "").slice(0, 10)).filter(Boolean)).size;
}

/** Which rungs this contributor has done, and the first one they have not. */
export function ladderProgress(store, crew, { human, agent }) {
  const who = (f) => (human ? f.human === human : agent ? f.agent === agent : false);
  const findings = store.state.findings.filter(who);
  const actions = (store.state.actions ?? []).filter(who);
  const done = (step) => {
    const w = step.done_when ?? {};
    if (w.findings != null) return findings.length >= w.findings;
    if (w.approved != null) return findings.filter((f) => f.status === "approved").length >= w.approved;
    if (w.active_days != null) return activeDays(findings) >= w.active_days || actions.some((a) => a.action === "recurring_set_up");
    if (w.action) return actions.some((a) => a.action === w.action || (Array.isArray(w.action) && w.action.includes(a.action)));
    if (w.any_action) return actions.some((a) => w.any_action.includes(a.action));
    return false;
  };
  const steps = ladderSteps(crew).map((s) => ({ ...s, done: done(s) }));
  const next = steps.find((s) => !s.done && !(s.only_if && !s.only_if.some((k) => actions.some((a) => a.action === k) || (k === "has_findings" && findings.length)))) ?? null;
  return { steps, next, findings: findings.length, approved: findings.filter((f) => f.status === "approved").length, active_days: activeDays(findings), actions: actions.map((a) => ({ action: a.action, detail: a.detail ?? null, at: a.at })) };
}

export function nextAskLine(store, crew, ids) {
  const p = ladderProgress(store, crew, ids);
  if (!p.next) return null;
  return { step: p.next.id, title: p.next.title, ask: p.next.ask, how: p.next.how ?? null, links: p.next.links ?? null, confirm_with: `report_action(action: "${confirmAction(p.next)}")` };
}
const confirmAction = (step) => (step.done_when?.action && !Array.isArray(step.done_when.action) ? step.done_when.action : step.done_when?.active_days != null ? "recurring_set_up" : "other");

let shareCache = { at: 0, data: null, url: null };
export async function shareKit(crew, { audience, fetchImpl = fetch } = {}) {
  const url = crew.crew.share?.library;
  if (!url) return { error: "This crew has no share library configured.", posts: [], images: [] };
  if (!shareCache.data || shareCache.url !== url || Date.now() - shareCache.at > 10 * 60 * 1000) {
    try { const r = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) }); shareCache = { at: Date.now(), url, data: await r.json() }; }
    catch (e) { return { error: `Could not load the share library: ${e.message}`, library: url, posts: [], images: [] }; }
  }
  const lib = shareCache.data ?? {};
  const posts = (lib.posts ?? []).filter((p) => !audience || (p.audiences ?? []).includes(audience) || p.audience === audience);
  const images = (lib.images ?? []).filter((i) => !audience || (i.audiences ?? []).includes(audience) || i.audience === audience);
  return { library: url, rules: lib.rules ?? null, audiences: lib.audiences ?? null, posts, images };
}

export function registerLadderTools(server, ctx, { z, text, fail }) {
  const { store, crew } = ctx;
  const ids = z.object({ human: z.string().trim().min(1).optional().describe("The person running the agent: handle or email, as used on claim_task"), agent: z.string().trim().min(1).optional() }).shape;

  server.registerTool("next_ask", {
    title: "What to ask your human next",
    description: "The crew's next ask of this contributor, after the compute: run it on a schedule, share the record with the people who can act on it, lend standing, give time, fund the compute. Returns the rung they are on, the ask in plain words, how to do it, and the report_action call that records it when they say it is done. Show the ask to your human; do not act on it yourself.",
    inputSchema: ids,
  }, async ({ human, agent }) => {
    if (!human && !agent) return fail("Give human, agent, or both — the same values used on claim_task.");
    const p = ladderProgress(store, crew, { human, agent });
    return text({ contributor: { human: human ?? null, agent: agent ?? null, findings: p.findings, approved: p.approved, active_days: p.active_days }, done: p.steps.filter((s) => s.done).map((s) => s.id), next: p.next ? { id: p.next.id, title: p.next.title, ask: p.next.ask, how: p.next.how ?? null, links: p.next.links ?? null, confirm_with: `report_action(action: "${confirmAction(p.next)}")` } : { id: null, title: "Every rung done", ask: "Thank you. Recruit one more person and start them at the first rung.", confirm_with: 'report_action(action: "recruited")' }, all_steps: p.steps.map((s) => ({ id: s.id, title: s.title, done: s.done })), actions: p.actions });
  });

  server.registerTool("report_action", {
    title: "Record something your human did",
    description: `Record that the person running you did one of the crew's asks, so the ladder moves and the next ask is the right one. Only report what they actually told you they did. Actions: ${ACTIONS.join(", ")}.`,
    inputSchema: { ...ids, action: z.enum(ACTIONS), detail: z.string().trim().max(500).optional().describe("Where or what: the post URL, the platform, the state they joined the exchange in, the amount, the meeting") },
  }, async ({ human, agent, action, detail }) => {
    if (!human && !agent) return fail("Give human, agent, or both.");
    store.state.actions ??= [];
    const row = { id: `act_${Math.random().toString(36).slice(2, 10)}`, human: human ?? null, agent: agent ?? null, action, detail: detail ?? null, at: new Date().toISOString() };
    store.state.actions.push(row); store.save();
    const next = nextAskLine(store, crew, { human, agent });
    return text({ recorded: row, thanks: crew.crew.ladder?.thanks?.[action] ?? "Recorded. Thank you.", next });
  });

  server.registerTool("share_kit", {
    title: "Posts and images to share",
    description: "The crew's share library: ready-to-post text for each platform and images, every figure sourced to a verified claim. Hand your human the post that fits where they are (a parents' Facebook group, a teachers' group, LinkedIn, Instagram, a church bulletin) and the image URL. When they have posted, call report_action(action: \"shared\", detail: <where>).",
    inputSchema: { audience: z.string().trim().optional().describe("rural-parents, teachers, former-students, board-members, legislators, congregations, general") },
  }, async ({ audience }) => text(await shareKit(crew, { audience })));

  return ["next_ask", "report_action", "share_kit"];
}
