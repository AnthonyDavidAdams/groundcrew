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
export function egressFetch(fetchImpl = fetch) {
  return (url, init = {}) => {
    const dispatcher = nextDispatcher();
    // Only undici's own fetch accepts this dispatcher; with no pool, use whatever the caller passed.
    return dispatcher ? undiciFetch(url, { ...init, dispatcher }) : fetchImpl(url, init);
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
