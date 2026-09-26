// The fleet: every contributor as a ship, and everything that happened as flights.
//
// The activity feed answers "what happened"; this answers "who is flying, from where, over what, and
// what did their instruments do". It is the feed the campaign's flight board reads: ships with stable
// callsigns, the last N days of events with district ids so the board can light the right dot without
// matching names, and, for one lease at a time, the ops log that drives the cockpit instruments.
// Nothing here is new state. Everything is computed from leases, findings, fetches and the ops ledger.
import { createHash } from "node:crypto";
import { handle, safeAgent } from "./activity.mjs";
import { badgeFor } from "./badge.mjs";

// Two-word callsigns from the campaign's own vocabulary: land, weather, tools; then birds. No people.
const FIRST = ["Copper", "Quiet", "Long", "Iron", "Blue", "Cedar", "Prairie", "Delta", "Granite", "Amber", "Silver", "North", "Willow", "Cotton", "Timber", "Slate", "River", "Marsh", "Hollow", "Ridge", "Cypress", "Tallow", "Sable", "Pine", "Salt", "Clay", "Flint", "Chalk", "Bayou", "Meadow", "Ember", "Harbor", "Summit", "Canyon", "Juniper", "Sycamore", "Pecan", "Magnolia", "Cinder", "Fallow", "Harvest", "Lantern", "Compass", "Signal", "Quill", "Anvil", "Beacon", "Mercy"];
const SECOND = ["Heron", "Meridian", "Furrow", "Kestrel", "Osprey", "Plover", "Sparrow", "Wren", "Kite", "Falcon", "Harrier", "Crane", "Egret", "Swift", "Tern", "Lark", "Finch", "Thrush", "Warbler", "Ibis", "Pelican", "Curlew", "Bittern", "Grouse", "Quail", "Merlin", "Condor", "Raven", "Rook", "Jay", "Magpie", "Oriole", "Tanager", "Vireo", "Sandpiper", "Killdeer", "Nighthawk", "Skylark", "Bunting", "Junco", "Siskin", "Towhee", "Cardinal", "Mockingbird", "Kingfisher", "Loon", "Gannet", "Albatross"];

/** A stable two-word callsign for a handle. Same handle, same callsign, forever; nothing reversible. */
export function callsign(id) {
  if (!id) return null;
  const h = createHash("sha256").update(`callsign:${id}`).digest();
  return `${FIRST[h[0] % FIRST.length]} ${SECOND[h[1] % SECOND.length]}`;
}

/** Which kind of agent is flying, from the free-text agent string, for the hull style. */
export function hullOf(agent) {
  const s = String(agent ?? "").toLowerCase();
  if (!s) return "custom";
  if (/scheduled/.test(s)) return "scheduled";
  if (/cursor/.test(s)) return "cursor";
  if (/codex|openai|gpt/.test(s)) return "codex";
  if (/gemini/.test(s)) return "gemini";
  if (/mothership|nightly|pipeline|machine/.test(s)) return "mothership";
  if (/claude/.test(s)) return "claude";
  return "custom";
}

const placeOf = (p) => p && (p.city || p.region || p.country) ? { label: p.label ?? [p.city, p.region, p.country_code || p.country].filter(Boolean).join(", "), lat: Number.isFinite(p.lat) ? p.lat : null, lon: Number.isFinite(p.lon) ? p.lon : null } : null;
const publicUrl = (u) => { try { const x = new URL(u); return `${x.host}${x.pathname}`.slice(0, 120); } catch { return null; } };

export function buildFleet(ctx, { since = null, lease = null, limit = 3000 } = {}) {
  const store = ctx.store, salt = ctx.crew.name ?? "";
  const findings = store.state.findings ?? [], leases = store.state.leases ?? [], fetches = store.state.fetches ?? [], ops = store.state.ops ?? [];
  const now = Date.now(), sinceMs = since ? Date.parse(since) : now - 30 * 86400e3;
  const badges = store.state.badges ?? {};

  // ---- ships: one per human, with the latest agent string as the hull ----
  const humans = new Map();
  const touch = (human, agent, at, place) => {
    if (!human) return;
    const s = humans.get(human) ?? { human, agent: null, last: 0, place: null };
    const t = Date.parse(at ?? 0) || 0;
    if (t >= s.last) { s.last = t; if (agent) s.agent = agent; if (place) s.place = place; }
    humans.set(human, s);
  };
  for (const f of findings) touch(f.human, f.agent, f.timestamp, f.place);
  for (const l of leases) touch(l.human, l.agent, l.claimed_at ?? l.created_at, l.place);
  for (const a of store.state.actions ?? []) touch(a.human, a.agent, a.at, null);
  const ships = [...humans.values()].map((s) => {
    const id = handle(s.human, salt);
    const b = badgeFor(ctx, { human: s.human });
    const flying = leases.find((l) => l.human === s.human && !l.released_at && Date.parse(l.expires_at ?? 0) > now) ?? null;
    return {
      id, callsign: callsign(id), display_name: badges[id]?.display_name ?? null,
      hull: hullOf(s.agent), agent: safeAgent(s.agent),
      home: placeOf(badges[id]?.home ?? s.place),
      districts: b.districts, children: b.children, tier: b.tier?.name ?? null,
      flying: flying ? { lease_id: flying.id, scope: flying.scope, since: flying.claimed_at ?? flying.created_at, expires_at: flying.expires_at, place: placeOf(flying.place) } : null,
      last_seen: s.last ? new Date(s.last).toISOString() : null,
      hosted: false,
    };
  }).sort((a, b) => (b.flying ? 1 : 0) - (a.flying ? 1 : 0) || b.districts - a.districts);

  // ---- events since: what the board replays and then follows live ----
  const ev = [];
  const who = (human, agent, place) => { const id = handle(human, salt); return { contributor: id, callsign: callsign(id), agent: safeAgent(agent), place: placeOf(place) }; };
  for (const f of findings) {
    const r = f.record ?? {}; const sourced = Boolean(r.quote && r.source);
    const base = { scope: f.scope ?? null, subject: r.name ?? null, nces_id: r.nces_id ?? null, state: r.state ?? null, status: r.status ?? null, sourced, ...who(f.human, f.agent, f.place) };
    if (Date.parse(f.timestamp) >= sinceMs) ev.push({ at: f.timestamp, kind: sourced ? "submitted" : "attempted", quote_check: f.source_check?.status ?? null, ...base });
    if (f.review?.at && Date.parse(f.review.at) >= sinceMs) ev.push({ at: f.review.at, kind: f.review.decision === "approved" ? "verified" : "returned", ...base });
  }
  const worked = new Set(findings.map((f) => f.lease_id).filter(Boolean));
  for (const l of leases) {
    const at = l.claimed_at ?? l.created_at; if (!at || Date.parse(at) < sinceMs) continue;
    if (l.released_at && !worked.has(l.id)) continue;
    ev.push({ at, kind: "claimed", lease_id: l.id, scope: l.scope ?? null, subject: l.scope ?? null, ...who(l.human, l.agent, l.place) });
  }
  const leaseById = new Map(leases.map((l) => [l.id, l]));
  for (const x of fetches) {
    if (!x.lease_id || Date.parse(x.at ?? 0) < sinceMs) continue;
    const l = leaseById.get(x.lease_id);
    ev.push({ at: x.at, kind: "fetched", lease_id: x.lease_id, scope: l?.scope ?? null, subject: l?.scope ?? null, url: publicUrl(x.url), pages: x.pages ?? null, ...who(x.human, x.agent, l?.place) });
  }
  for (const o of ops) if (Date.parse(o.at ?? 0) >= sinceMs) ev.push({ at: o.at, kind: "machine", scope: o.scope ?? null, subject: o.scope ?? null, headline: o.summary, units: o.units ?? null, produced: o.produced ?? null, contributor: null, callsign: "Mothership", agent: "Mothership", place: null });
  ev.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const events = ev.slice(-limit);

  // ---- the cockpit: one lease's instruments, in order ----
  let cockpit = null;
  if (lease) {
    const l = leaseById.get(lease);
    if (l) {
      const rows = [];
      rows.push({ at: l.claimed_at ?? l.created_at, instrument: "LOCK", summary: `Locked on ${l.scope}` });
      for (const x of fetches.filter((x) => x.lease_id === l.id)) rows.push({ at: x.at, instrument: "TRACTOR", summary: `Document aboard: ${publicUrl(x.url)}${x.pages ? ` (${x.pages} pages)` : ""}`, url: publicUrl(x.url), pages: x.pages ?? null });
      for (const f of findings.filter((f) => f.lease_id === l.id)) {
        const r = f.record ?? {};
        rows.push({ at: f.timestamp, instrument: "VERIFIER", summary: f.source_check?.status ? `Quote check: ${f.source_check.status}` : "Quote check: not run", status: f.source_check?.status ?? null });
        rows.push({ at: f.timestamp, instrument: "UPLINK", summary: `${r.name ?? "record"}: ${r.status ?? "?"} submitted for review`, status: r.status ?? null, nces_id: r.nces_id ?? null });
        if (f.review?.at) rows.push({ at: f.review.at, instrument: "REVIEW", summary: `${f.review.decision === "approved" ? "Approved" : "Returned"}${f.review.reason ? `: ${f.review.reason}` : ""}`, decision: f.review.decision });
      }
      if (l.released_at) rows.push({ at: l.released_at, instrument: "RELEASE", summary: "Lease released" });
      rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      cockpit = { lease_id: l.id, scope: l.scope, ...who(l.human, l.agent, l.place), active: !l.released_at && Date.parse(l.expires_at) > now, rows: rows.slice(-50) };
    }
  }

  return { crew: ctx.crew.name, generated_at: new Date(now).toISOString(), since: new Date(sinceMs).toISOString(), ships, flying: ships.filter((s) => s.flying).length, events, cockpit,
    note: "Ships are contributors under anonymous handles with generated callsigns. Places are city-level and rounded. Document addresses are public documents only." };
}
