// Badges: a square, shareable image for someone who has contributed to a crew.
//
// The point is recruitment, not vanity. Somebody's agent reads a school district's policy, the record
// gets better, and they get something they can post that says what they did and links to where anyone
// else can do the same. So the badge carries a real number, not a participation ribbon.
//
// Two rules the rest of this server already follows and this must not break:
//   - a contributor's email never becomes public. The public identity is handle(), a salted six-character
//     hash, and a badge only carries a name if the person asked for one to be on it.
//   - nothing is minted without being asked for. A badge exists when someone calls claim_badge, not
//     automatically when they submit, because publishing a person's work under their name is theirs to
//     decide, not ours.
import { handle } from "./activity.mjs";

// Rasterising the badge is what lets it be sent rather than linked: MCP tool results can carry an
// image, and a picture that appears in the conversation is worth more than a URL somebody has to
// open. SVG is kept as the source of truth and PNG is produced from it, so there is one design.
let Resvg = null;
async function rasterizer() {
  if (Resvg === null) {
    try { ({ Resvg } = await import("@resvg/resvg-js")); }
    catch { Resvg = false; }   // no rasterizer here: callers fall back to the SVG and say so
  }
  return Resvg;
}

export async function badgePng(svg, width = 1200) {
  const R = await rasterizer();
  if (!R) return null;
  return new R(svg, { fitTo: { mode: "width", value: width }, background: "#0B1129" }).render().asPng();
}

export const TIERS = [
  { at: 1, name: "Recorded", blurb: "put a district's policy on the public record" },
  { at: 5, name: "Scout", blurb: "recorded five districts" },
  { at: 20, name: "Surveyor", blurb: "recorded twenty districts" },
  { at: 50, name: "Cartographer", blurb: "recorded fifty districts" },
  { at: 150, name: "Chief Surveyor", blurb: "recorded a hundred and fifty districts" },
];

export const tierFor = (approved) => [...TIERS].reverse().find((t) => approved >= t.at) ?? null;

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Fitting a long district name or display name into a fixed box, without a text measurement API.
// Rough but stable: the badge is generated the same way every time, so what you see is what shares.
const fit = (s, max) => (String(s).length > max ? `${String(s).slice(0, max - 1)}…` : String(s));

export function badgeSvg({ name, tier, approved, districts, children, site, id }) {
  const line = tier ? tier.name : "Contributor";
  const sub = approved === 1 ? "1 district recorded" : `${approved.toLocaleString()} districts recorded`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200" role="img" aria-label="${esc(name)}: ${esc(line)}, ${esc(sub)}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#101A3D"/><stop offset="1" stop-color="#0B1129"/>
  </linearGradient>
</defs>
<rect width="1200" height="1200" fill="url(#bg)"/>
<rect x="46" y="46" width="1108" height="1108" fill="none" stroke="#C9A227" stroke-width="3"/>
<rect x="62" y="62" width="1076" height="1076" fill="none" stroke="#C9A227" stroke-width="1" opacity="0.45"/>
<text x="600" y="168" text-anchor="middle" fill="#7CE0A8" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="30" letter-spacing="10" font-weight="700">EARTHPILOT</text>
<text x="600" y="214" text-anchor="middle" fill="#9AA6C4" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="23" letter-spacing="4">END SCHOOL CORPORAL PUNISHMENT</text>
<circle cx="600" cy="470" r="150" fill="none" stroke="#2D6A4F" stroke-width="10"/>
<circle cx="600" cy="470" r="128" fill="#12331F"/>
<text x="600" y="512" text-anchor="middle" fill="#B7F7CE" font-family="Iowan Old Style,Palatino,Georgia,serif" font-size="120" font-weight="700">${esc(String(approved))}</text>
<text x="600" y="700" text-anchor="middle" fill="#F4F1E8" font-family="Iowan Old Style,Palatino,Georgia,serif" font-size="76" font-weight="600">${esc(fit(line, 22))}</text>
<text x="600" y="762" text-anchor="middle" fill="#C9A227" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="32" letter-spacing="2">${esc(fit(sub, 42))}</text>
<text x="600" y="866" text-anchor="middle" fill="#F4F1E8" font-family="Iowan Old Style,Palatino,Georgia,serif" font-size="44">${esc(fit(name, 30))}</text>
${children ? `<text x="600" y="936" text-anchor="middle" fill="#9AA6C4" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="27">covering ${esc(children.toLocaleString())} children in the federal count</text>` : ""}
<text x="600" y="1066" text-anchor="middle" fill="#7CE0A8" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="30" letter-spacing="1">${esc(String(site ?? "").replace(/^https?:\/\//, ""))}/contribute</text>
${name && !String(name).includes(id) ? `<text x="600" y="1112" text-anchor="middle" fill="#5E6A8A" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="20" letter-spacing="1">${esc(id)}</text>` : ""}
</svg>`;
}

// What a badge says about someone, computed from findings rather than stored, so it cannot drift from
// the record it is claiming to represent.
export function badgeFor(ctx, { human, agent } = {}) {
  const rep = ctx.store.contributor({ human, agent });
  // Same salt the activity feed uses, so one person has one handle everywhere on this crew.
  const id = handle(human ?? agent ?? "", ctx.crew.name ?? "");
  const rows = ctx.store.state.findings.filter((f) => f.status === "approved" && (human ? f.human === human : true) && (agent ? f.agent === agent : true));
  // A district counts once however many times it was submitted, and children are only counted where
  // the record carries a federal figure for that district.
  const seen = new Set();
  let children = 0;
  for (const f of rows) {
    const r = f.record ?? {};
    const key = r.nces_id || `${r.state}|${String(r.name ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (Number.isFinite(r.crdc_students_latest)) children += r.crdc_students_latest;
  }
  const claimed = ctx.store.state.badges?.[id] ?? null;
  return {
    id,
    display_name: claimed?.display_name ?? null,
    claimed_at: claimed?.claimed_at ?? null,
    approved: rep.approved,
    pending: rep.pending,
    districts: seen.size,
    children,
    tier: tierFor(seen.size),
    first_seen: rep.first_seen,
  };
}
