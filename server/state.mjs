// Server state: leases, findings, and the contributor ledger, kept in one JSON file and written atomically
// (write to a sibling temp file, then rename). Path comes from GROUNDCREW_STATE, default ./state.json.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export const DEFAULT_LEASE_TTL_HOURS = 4;

export function newId(prefix) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

export function emptyState() {
  return { version: 1, leases: [], findings: [], issues: [], fetches: [], bugs: [], requests: [], badges: {} };
}

export class StateStore {
  constructor(path) {
    this.path = resolve(path);
    this.state = existsSync(this.path) ? { ...emptyState(), ...JSON.parse(readFileSync(this.path, "utf8")) } : emptyState();
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.path);
  }

  // ---- leases ----
  activeLeases(now = Date.now()) {
    return this.state.leases.filter((l) => !l.released_at && Date.parse(l.expires_at) > now);
  }

  findLease(id) {
    return this.state.leases.find((l) => l.id === id) ?? null;
  }

  // A lease has to conflict with the work it actually overlaps, not only with an identical string.
  // Scopes come in at different grains -- one agent takes "MS", another takes "MS: Rankin County" --
  // and an exact-match check lets both be held at once, which is two agents reading the same district
  // and the protocol failing silently at the one job it has. Seen live: a whole-state Missouri lease
  // and a per-district run of Greenville R-II, held simultaneously, neither aware of the other.
  leaseFor(task, scope, now = Date.now()) {
    return this.activeLeases(now).find((l) => l.task === task && scopesOverlap(l.scope, scope)) ?? null;
  }

  claim({ task, scope, agent, human, ttlHours = DEFAULT_LEASE_TTL_HOURS }) {
    const now = Date.now();
    const existing = this.leaseFor(task, scope, now);
    if (existing) return { ok: false, reason: "scope_leased", lease: publicLease(existing) };
    const lease = {
      id: newId("lease"),
      task,
      scope: String(scope).trim(),
      agent,
      human,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttlHours * 3600_000).toISOString(),
      renewed: 0,
      released_at: null,
    };
    this.state.leases.push(lease);
    this.prune(now);
    this.save();
    return { ok: true, lease: publicLease(lease) };
  }

  renew(id, ttlHours = DEFAULT_LEASE_TTL_HOURS) {
    const lease = this.findLease(id);
    if (!lease) return { ok: false, reason: "no_such_lease" };
    if (lease.released_at) return { ok: false, reason: "released" };
    const now = Date.now();
    if (Date.parse(lease.expires_at) <= now) {
      // Expired: renewal is allowed only if nobody else has since taken the scope.
      const other = this.leaseFor(lease.task, lease.scope, now);
      if (other && other.id !== lease.id) return { ok: false, reason: "scope_leased", lease: publicLease(other) };
    }
    lease.expires_at = new Date(now + ttlHours * 3600_000).toISOString();
    lease.renewed += 1;
    this.save();
    return { ok: true, lease: publicLease(lease) };
  }

  release(id) {
    const lease = this.findLease(id);
    if (!lease) return { ok: false, reason: "no_such_lease" };
    if (!lease.released_at) { lease.released_at = new Date().toISOString(); this.save(); }
    return { ok: true, lease: publicLease(lease) };
  }

  // Drop leases that expired or were released more than 7 days ago so the file stays small.
  prune(now = Date.now()) {
    const cutoff = now - 7 * 86400_000;
    this.state.leases = this.state.leases.filter((l) => {
      const end = l.released_at ? Date.parse(l.released_at) : Date.parse(l.expires_at);
      return end > cutoff;
    });
  }

  // ---- findings ----
  logFetch(entry) {
    const f = (this.state.fetches ||= []);
    f.push(entry);
    if (f.length > 5000) f.splice(0, f.length - 5000);
    this.save();
  }

  addIssue(issue) {
    (this.state.issues ||= []).push(issue);
    this.save();
    return issue;
  }

  updateLease(id, patch) {
    const l = this.findLease(id);
    if (!l) return null;
    Object.assign(l, patch);
    this.save();
    return l;
  }

  updateIssue(id, patch) {
    const i = (this.state.issues ?? []).find((x) => x.id === id);
    if (!i) return null;
    Object.assign(i, patch);
    this.save();
    return i;
  }

  addRequest(req) {
    (this.state.requests ||= []).push(req);
    this.save();
    return req;
  }

  addBug(bug) {
    (this.state.bugs ||= []).push(bug);
    this.save();
    return bug;
  }

  addFinding(finding) {
    this.state.findings.push(finding);
    this.save();
    return finding;
  }

  findFinding(id) {
    return this.state.findings.find((f) => f.id === id) ?? null;
  }

  review(id, { decision, reviewer, note }) {
    const f = this.findFinding(id);
    if (!f) return { ok: false, reason: "no_such_finding" };
    if (f.status !== "pending") return { ok: false, reason: `already_${f.status}`, finding: f };
    f.status = decision;
    f.review = { decision, reviewer, note: note ?? null, at: new Date().toISOString() };
    this.save();
    return { ok: true, finding: f };
  }

  // ---- contributors ----
  contributor({ agent, human }) {
    const match = (f) => (agent ? f.agent === agent : true) && (human ? f.human === human : true);
    const rows = this.state.findings.filter(match);
    const count = (s) => rows.filter((f) => f.status === s).length;
    const approved = count("approved"), rejected = count("rejected"), pending = count("pending");
    const decided = approved + rejected;
    return {
      agent: agent ?? null,
      human: human ?? null,
      pending,
      approved,
      rejected,
      approval_rate: decided ? Number((approved / decided).toFixed(3)) : null,
      first_seen: rows.length ? rows.map((f) => f.timestamp).sort()[0] : null,
    };
  }
}

export function normalizeScope(s) {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// The part of a scope that names the territory, before any narrowing. "MS: Rankin County" and
// "MS, districts A-C" both reduce to "ms"; "MS" already is "ms". Splitting on the first colon, comma
// or dash is crude, and it is crude in the safe direction: it can only ever make two scopes look MORE
// alike, and the cost of a false conflict is one contributor picking a different slice, while the cost
// of a missed one is duplicated work nobody notices.
export function scopeRoot(s) {
  return normalizeScope(String(s ?? "").split(/[:,]|\s+-\s+/)[0]);
}

// Two scopes overlap when they are the same, or when one is a narrowing of the other.
export function scopesOverlap(a, b) {
  const na = normalizeScope(a), nb = normalizeScope(b);
  if (na === nb) return true;
  const ra = scopeRoot(a), rb = scopeRoot(b);
  if (!ra || !rb) return false;
  // "ms" contains "ms: rankin county"; "ms: rankin" and "ms: hinds" do not contain each other.
  return (na === ra && rb === ra) || (nb === rb && ra === rb);
}

export function publicLease(l) {
  return { id: l.id, task: l.task, scope: l.scope, agent: l.agent, human: l.human, expires_at: l.expires_at, created_at: l.created_at, renewed: l.renewed };
}
