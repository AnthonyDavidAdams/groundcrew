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

// City, region and country only — the same three fields the lease stored. Nothing here can be turned
// back into an address, because the address was never kept.
const placeOf = (p) =>
  p && (p.city || p.region || p.country)
    ? {
        city: p.city ?? null, region: p.region ?? null, country: p.country ?? null, country_code: p.country_code ?? null,
        lat: Number.isFinite(p.lat) ? p.lat : null, lon: Number.isFinite(p.lon) ? p.lon : null,
        label: p.label ?? [p.city, p.region, p.country_code || p.country].filter(Boolean).join(", "),
      }
    : null;

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
    const who = { agent: safeAgent(f.agent), contributor: handle(f.human, salt), place: placeOf(f.place) };
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
  // A scope that was claimed and handed back with nothing submitted under it is not a contribution,
  // and a feed that counts it is flattering itself. Only show a claim that was worked or is still open.
  const workedLeases = new Set(findings.map((f) => f.lease_id).filter(Boolean));
  for (const l of leases) {
    if (!l.claimed_at && !l.created_at) continue;
    if (l.released_at && !workedLeases.has(l.id)) continue;
    events.push({
      at: l.claimed_at ?? l.created_at,
      kind: "claimed",
      scope: l.scope ?? null,
      subject: l.scope ?? null,
      headline: `An agent started work on ${l.scope ?? "a new scope"}`,
      agent: safeAgent(l.agent),
      contributor: handle(l.human, salt),
      place: placeOf(l.place),
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

  // Who is working right now, as distinct from what has happened. A lease that is unexpired and
  // unreleased is somebody's agent mid-scope, and that is the thing a room full of people watching a
  // map wants to see: not a history, a present tense.
  const now = Date.now();
  const live = leases
    .filter((l) => !l.released_at && Date.parse(l.expires_at ?? 0) > now)
    .map((l) => ({
      scope: l.scope ?? null,
      task: l.task ?? null,
      agent: safeAgent(l.agent),
      contributor: handle(l.human, salt),
      place: placeOf(l.place),
      since: l.claimed_at ?? l.created_at ?? null,
      expires_at: l.expires_at ?? null,
    }))
    .sort((a, b) => Date.parse(b.since ?? 0) - Date.parse(a.since ?? 0));

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
    live,
    places: [...new Set(events.map((e) => e.place && e.place.label).filter(Boolean))].slice(0, 20),
    map: {
      tiles: "/tiles/{z}/{x}/{y}.png",
      max_zoom: 12,
      attribution: "© OpenStreetMap contributors",
      attribution_url: "https://www.openstreetmap.org/copyright",
      note: "Tiles are proxied and cached by this server so a visitor's browser never contacts a tile provider. Coordinates are rounded to one decimal place, roughly eleven kilometres.",
    },
    note:
      "Contributors are shown as a short one-way hash of the email they gave; the address itself is never published. " +
      "Location is the city the contributor's connection resolved to when they claimed work, looked up once and stored as city, region and country. " +
      "No email address and no IP address is stored anywhere in this project.",
  };
}
