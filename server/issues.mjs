// The feedback queue: bugs, feature requests and questions from contributors and their agents,
// in one place so a maintainer has one thing to read.
//
// Records are written as YAML files (data/issues/<date>-<slug>.yaml) so they can be reviewed in a
// diff and committed, and are also held in server state so the tools can list and dedup them.
// On a container with an ephemeral filesystem the directory should sit on the same volume as the
// state file; `export_issues` writes them wherever a maintainer asks.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";

export const KINDS = ["bug", "feature", "question"];
export const STATUSES = ["open", "triaged", "done", "wontfix"];

export const slugify = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "issue";

// Cheap title similarity: order-independent word overlap, ignoring filler.
const STOP = new Set(["a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "is", "are", "be", "can", "cannot", "not", "with", "when", "it", "this", "that", "should", "would", "no"]);
const words = (s) => new Set(String(s ?? "").toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 2 && !STOP.has(w)) ?? []);

export function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

// Returns the closest open issue above the threshold, or null.
export function findDuplicate(issues, title, kind, threshold = 0.6) {
  let best = null, bestScore = 0;
  for (const i of issues) {
    if (i.status !== "open") continue;
    if (kind && i.kind !== kind) continue;
    const s = similarity(title, i.title);
    if (s > bestScore) { best = i; bestScore = s; }
  }
  return bestScore >= threshold ? { issue: best, score: Number(bestScore.toFixed(2)) } : null;
}

export function issueFilename(issue) {
  return `${issue.created_at.slice(0, 10)}-${slugify(issue.title)}.yaml`;
}

export function writeIssueFile(dir, issue) {
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, issueFilename(issue));
    writeFileSync(path, stringify(issue, { lineWidth: 0 }));
    return path;
  } catch {
    return null; // a read-only filesystem is not a reason to lose the report; state still has it
  }
}

// Opens a GitHub issue when a token is configured. Returns the issue URL, or null.
export async function syncToGitHub(issue, { repo, token, fetchImpl = fetch } = {}) {
  if (!repo || !token) return null;
  const m = String(repo).match(/github\.com\/([^/]+)\/([^/.]+)/i);
  if (!m) return null;
  const body =
    `${issue.body}\n\n---\n` +
    `Filed through the Ground Crew server by ${issue.agent ?? "an agent"}${issue.human ? ` for ${issue.human}` : ""}.\n` +
    (issue.context && Object.keys(issue.context).length ? `\nContext:\n\`\`\`json\n${JSON.stringify(issue.context, null, 2)}\n\`\`\`\n` : "") +
    `\nGround Crew id: ${issue.id}`;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${m[1]}/${m[2]}/issues`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "groundcrew" },
      body: JSON.stringify({ title: issue.title, body, labels: [issue.kind] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j.html_url ?? null;
  } catch {
    return null;
  }
}

// A prefilled "new issue" URL, so a maintainer can open it by hand when no token is set.
export function manualIssueUrl(repo, issue) {
  if (!repo || !/github\.com/i.test(repo)) return null;
  const base = String(repo).replace(/\/$/, "");
  return `${base}/issues/new?labels=${encodeURIComponent(issue.kind)}&title=${encodeURIComponent(issue.title)}&body=${encodeURIComponent(issue.body)}`;
}
