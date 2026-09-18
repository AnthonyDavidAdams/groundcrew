// The public activity feed: what the crew has done lately, in a shape a web page can render.
//
// This is the one part of the server that anyone can read without a token, so the rule is inverted
// from everywhere else: nothing goes in unless it is safe for a stranger. Contributors are
// identified by a short hash of the email they gave, never the email, and the agent string is
// scrubbed in case someone put an address in it. What is left is the work itself, which is the
// interesting part anyway: a district, a state, a document read, a policy quoted.

import { createHash } from "node:crypto";

export const MAX_EVENTS = 50;

// A stable, non-reversible handle. Same contributor, same handle, across restarts; no way back to
// the address. Salted with the crew name so a handle from one crew cannot be matched to another.
export function handle(human, salt = "") {
  if (!human) return null;
  return createHash("sha256").update(`${salt}:${String(human).trim().toLowerCase()}`).digest("hex").slice(0, 6);
}

// Agent strings are free text a contributor sets. Strip anything that looks like an address or a URL
// and keep it short.
export function safeAgent(agent) {
  const s = String(agent ?? "").replace(/[\w.+-]+@[\w.-]+/g, "someone").replace(/https?:\/\/\S+/g, "").trim();
  return s ? s.slice(0, 60) : null;
}

const ago = (iso) => {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
};

const subjectOf = (rec) => {
  if (!rec || typeof rec !== "object") return null;
  for (const k of ["name", "title", "district", "subject", "id"]) if (typeof rec[k] === "string" && rec[k].trim()) return rec[k].trim().slice(0, 80);
  return null;
};

export function buildActivity(ctx, { limit = MAX_EVENTS } = {}) {
  const store = ctx.store;
  const crew = ctx.crew;
  const salt = crew.name ?? "";
  const findings = store.state.findings ?? [];
  const leases = store.state.leases ?? [];
  const issues = store.state.issues ?? [];
  const verb = crew.crew.activity_verb ?? "recorded";

  const events = [];
  for (const f of findings) {
    const subject = subjectOf(f.record);
    const who = { agent: safeAgent(f.agent), contributor: handle(f.human, salt) };
    // A record with no quote is a district somebody could not get a primary source for. It is still
    // work, and it still belongs in the feed, but it must not be described as sourced.
    const sourced = Boolean(f.record && f.record.quote && f.record.source);
    events.push({
      at: f.timestamp,
      kind: sourced ? "submitted" : "attempted",
      scope: f.scope ?? null,
      subject,
      sourced,
      headline: subject
        ? (sourced ? `${subject} — policy ${verb} from a primary source` : `${subject} — looked at, no readable primary source yet`)
        : `A record was ${verb} in ${f.scope ?? "the dataset"}`,
      quote_check: (f.source_check && f.source_check.status) ?? null,
      ...who,
    });
    if (f.review && f.review.at && f.review.decision === "approved") {
      events.push({
        at: f.review.at,
        kind: "verified",
        scope: f.scope ?? null,
        subject,
        headline: subject ? `${subject} — reviewed and added to the public record` : `A record entered the public dataset`,
        ...who,
      });
    }
  }
  for (const l of leases) {
    if (!l.claimed_at && !l.created_at) continue;
    events.push({
      at: l.claimed_at ?? l.created_at,
      kind: "claimed",
      scope: l.scope ?? null,
      subject: l.scope ?? null,
      headline: `An agent started work on ${l.scope ?? "a new scope"}`,
      agent: safeAgent(l.agent),
      contributor: handle(l.human, salt),
    });
  }
  for (const i of issues) {
    events.push({
      at: i.created_at,
      kind: i.kind === "feature" ? "suggested" : "reported",
      scope: (i.context && i.context.scope) ?? null,
      subject: null,
      headline: i.kind === "feature" ? "A contributor proposed an improvement to the tools" : "A contributor reported a problem with the tools",
      agent: safeAgent(i.agent),
      contributor: handle(i.human, salt),
    });
  }

  events.sort((a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0));
  const recent = events.slice(0, limit).map((e) => ({ ...e, ago: ago(e.at) }));

  const approved = findings.filter((f) => f.status === "approved");
  const contributors = new Set(findings.map((f) => handle(f.human, salt)).filter(Boolean));
  const scopes = new Set(findings.map((f) => f.scope).filter(Boolean));

  return {
    crew: crew.name,
    mission: crew.mission,
    site: crew.crew.site ?? null,
    repo: crew.crew.repo ?? null,
    generated_at: new Date().toISOString(),
    totals: {
      records: approved.length,
      pending_review: findings.filter((f) => f.status === "pending").length,
      contributors: contributors.size,
      scopes_touched: scopes.size,
      documents_read: (store.state.fetches ?? []).length,
      claims_published: (crew.claims ?? []).filter((c) => c.status === "verified").length,
    },
    scopes: [...scopes].sort(),
    events: recent,
    note: "Contributors are shown as a short one-way hash of the address they gave. No email address, IP address or location is collected or published here.",
  };
}
