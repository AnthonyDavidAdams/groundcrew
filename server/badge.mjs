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

// Fonts have to be named explicitly. A container has no fonts unless someone installed them, and resvg
// does not fail when it cannot find one -- it draws everything except the text. The first PNG this
// served from Alpine was a gold frame and an empty green circle, a perfectly valid image of nothing,
// which is why the deploy check below looks at pixels and not at the content type.
const SERIF = ["DejaVu Serif", "Liberation Serif", "Noto Serif", "Georgia", "Times New Roman", "serif"];
const SANS = ["DejaVu Sans", "Liberation Sans", "Noto Sans", "Helvetica", "Arial", "sans-serif"];

export async function badgePng(svg, width = 1200) {
  const R = await rasterizer();
  if (!R) return null;
  const rendered = new R(svg, {
    fitTo: { mode: "width", value: width },
    background: "#0B1129",
    font: {
      loadSystemFonts: true,
      defaultFontFamily: SERIF[0],
      serifFamily: SERIF.find(Boolean),
      sansSerifFamily: SANS.find(Boolean),
    },
  }).render();
  // A badge with no text on it is not worth sending. Better to fall back to the SVG, which a browser
  // will render with its own fonts, than to hand someone a picture of an empty circle.
  if (!looksRendered(rendered)) return null;
  return rendered.asPng();
}

// Did the text actually draw? Count near-white pixels. The badge's palette is dark blue, green and
// gold; the only thing on it that is close to white is the type, so a render with no glyphs has
// essentially none. Measured: 1,498 of 360,000 at 600px with the text, single digits without it.
//
// The first version of this compared file size, which was wrong in a way worth recording: a 1200px
// badge with text and a 600px badge with text are both about 29 KB, so a threshold tuned at one width
// called the other one blank. Size conflates how big the image is with how much is in it.
export function looksRendered(rendered) {
  const px = rendered?.pixels;
  if (!px) return false;
  let bright = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 200) bright++;
  return bright > (px.length / 4) * 0.0005;   // 0.05% of the canvas, against a measured 0.4%
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
<text x="600" y="1066" text-anchor="middle" fill="#7CE0A8" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="30" letter-spacing="1">${esc(String(site ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, ""))}/contribute</text>
${name && !String(name).includes(id) ? `<text x="600" y="1112" text-anchor="middle" fill="#5E6A8A" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" font-size="20" letter-spacing="1">${esc(id)}</text>` : ""}
</svg>`;
}

// What a badge says about someone, computed from findings rather than stored, so it cannot drift from
// the record it is claiming to represent.
export function badgeFor(ctx, { human, agent } = {}) {
  const rep = ctx.store.contributor({ human, agent });
  // Same salt the activity feed uses, so one person has one handle everywhere on this crew.
  const id = handle(human ?? agent ?? "", ctx.crew.name ?? "");
  // Approved findings only, and superseded ones never count: a contributor who corrected a record twice
  // recorded one district, not three.
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
    // The figure the record carries, under whichever name the crew's schema gives it. Findings
    // submitted before a crew started joining federal counts simply have none, which is why a badge can
    // legitimately read zero children beside a real district count.
    const n = r.crdc_students_latest ?? r.students ?? r.students_2023_24 ?? null;
    if (Number.isFinite(n)) children += n;
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
