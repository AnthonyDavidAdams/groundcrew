// Where the server's outbound requests come from.
//
// Some vendors rate-limit by source address. Simbli is the one that matters here: it serves the board
// policy manuals for much of Alabama, Georgia, Kentucky and Mississippi, it answers a challenge page
// after a burst from one address, and a fleet reading several hundred districts spends most of its
// time waiting for that to clear. Where a proxy pool is configured, requests are spread across it.
//
// What this does NOT do is hide who is asking. The User-Agent still names the project and links to the
// repository, every request is still identifiable, and a vendor who would rather we stopped can still
// find us and say so. Spreading load across addresses is a different thing from pretending to be
// somebody else, and only the first one is happening here.
//
// Configure with EGRESS_PROXIES: a comma-separated list of proxy URLs, e.g.
//   EGRESS_PROXIES=http://user:pass@host1:8080,http://user:pass@host2:8080
// With none set, everything goes out directly and nothing about the server changes.
// undici's own fetch, not the global one. Node's built-in fetch carries its own bundled copy of undici
// and rejects a ProxyAgent built from the npm package with UND_ERR_INVALID_ARG -- two undici instances,
// one dispatcher. The server reported a working pool and every proxied request failed.
import { ProxyAgent, fetch as undiciFetch } from "undici";

const parseList = (s) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

let pool = null;
function proxies() {
  if (pool) return pool;
  const urls = parseList(process.env.EGRESS_PROXIES);
  pool = urls.map((url) => {
    try { return { url, agent: new ProxyAgent(url) }; }
    catch (err) { console.error(`egress: ignoring proxy '${url.replace(/\/\/[^@]*@/, "//")}': ${err.message}`); return null; }
  }).filter(Boolean);
  if (pool.length) console.error(`egress: ${pool.length} proxies configured`);
  return pool;
}

export const proxyCount = () => proxies().length;

// Round robin. A least-recently-used scheme would be better if the proxies differed in speed, but they
// are interchangeable by assumption and a counter cannot get out of step with itself.
let next = 0;
export function nextDispatcher() {
  const p = proxies();
  if (!p.length) return null;
  const chosen = p[next % p.length];
  next = (next + 1) % Math.max(p.length, 1);
  return chosen.agent;
}

// A fetch that spreads itself across the pool. Identical to fetch when no pool is configured, so this
// can be used everywhere without a branch at each call site.
// Residential bandwidth is billed by the gigabyte and most requests do not need it, so the pool is a
// fallback and not a default. Go direct; if the answer looks like a block, try again through a proxy.
// A TASB policy page is about 880 KB, so routing a few hundred districts through the pool by habit
// would spend real money for an answer the open internet was already giving.
const BLOCKED = /Pardon Our Interruption|_Incapsula_Resource|Client Challenge|Just a moment\.\.\./i;
const blockedStatus = (s) => s === 403 || s === 429 || s === 503;

let direct = 0, viaProxy = 0, proxyBytes = 0;
export const egressStats = () => ({ direct, via_proxy: viaProxy, proxy_kb: Math.round(proxyBytes / 1024) });

export function egressFetch(fetchImpl = fetch) {
  // `init.expect` is an optional predicate over the response body: "is this the thing I asked for?".
  // Without it the only test is whether the response looks like a challenge page, and the failure that
  // matters most does not look like one. TASB answers Railway's address with HTTP 200 and 70,000 bytes
  // of navigation -- 8% of the 875,000 the same URL returns elsewhere, no error, no challenge text,
  // and none of the policy. That sailed through every check and made two hundred Texas districts look
  // unreadable. A caller that knows what the page must contain can say so, and be routed around it.
  return async (url, init = {}) => {
    const { expect, ...opts } = init;
    if (!proxies().length) return fetchImpl(url, opts);
    try {
      const res = await fetchImpl(url, opts);
      if (!blockedStatus(res.status)) {
        const body = await res.text();
        const looksRight = !BLOCKED.test(body.slice(0, 4000)) && (!expect || expect(body));
        if (looksRight) { direct++; return new Response(body, { status: res.status, headers: res.headers }); }
      }
    } catch { /* fall through to the pool */ }
    const dispatcher = nextDispatcher();
    const res = await undiciFetch(url, { ...opts, dispatcher });
    const body = await res.text();
    viaProxy++; proxyBytes += body.length;
    return new Response(body, { status: res.status, headers: res.headers });
  };
}

// One address is enough to be blocked; the pool is only useful if a blocked member is skipped rather
// than retried into. Callers that can tell a block from a failure report it here.
const cooling = new Map();
export function markBlocked(ms = 10 * 60 * 1000) {
  const p = proxies();
  if (!p.length) return;
  const i = (next - 1 + p.length) % p.length;
  cooling.set(i, Date.now() + ms);
}
export function healthy() {
  const p = proxies();
  const now = Date.now();
  return p.filter((_, i) => !(cooling.get(i) > now)).length;
}
