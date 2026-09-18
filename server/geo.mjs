// Coarse location for the public activity feed: "Eureka, California, US".
//
// The rule here is that we never keep the address. An IP arrives on a request, is exchanged for a
// city once, and is gone: the lookup cache is keyed by a hash of it, the lease stores only the place,
// and nothing writes an IP to disk or to a log. A third-party lookup service does see the address at
// the moment of the exchange, which is a real disclosure and is stated on the contribute page and in
// the feed itself rather than buried here.
//
// Geo never blocks or fails a contribution. No answer means no place, and the work proceeds.

import { createHash } from "node:crypto";

const CACHE_MAX = 500;
const cache = new Map(); // hash(ip) -> place | null
export const TIMEOUT_MS = 4000;

const key = (ip) => createHash("sha256").update(String(ip)).digest("hex").slice(0, 16);

// Railway and most proxies put the real address in x-real-ip. Raw x-forwarded-for is caller-supplied
// and can be a list or a lie, so it is only a fallback and only its first entry.
export function clientIp(headers = {}) {
  const get = (n) => {
    const v = headers[n] ?? headers[n.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const real = get("x-real-ip");
  if (real) return String(real).trim();
  const fwd = get("x-forwarded-for");
  if (fwd) return String(fwd).split(",")[0].trim();
  return null;
}

const PRIVATE = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd)/i;
export const isRoutable = (ip) => Boolean(ip) && !PRIVATE.test(String(ip));

function shape(j) {
  if (!j) return null;
  const city = j.city ?? j.cityName ?? null;
  const region = j.region ?? j.regionName ?? null;
  const country = j.country ?? j.countryName ?? null;
  const code = j.country_code ?? j.countryCode ?? null;
  if (!city && !region && !country) return null;
  const label = [city, region, code || country].filter(Boolean).join(", ");
  return { city: city || null, region: region || null, country: country || null, country_code: code || null, label };
}

const SERVICES = [
  (ip) => `https://ipwho.is/${encodeURIComponent(ip)}`,
  (ip) => `https://freeipapi.com/api/json/${encodeURIComponent(ip)}`,
];

// Returns { city, region, country, country_code, label } or null. Never throws.
export async function lookup(ip, { fetchImpl = fetch } = {}) {
  if (!isRoutable(ip)) return null;
  const k = key(ip);
  if (cache.has(k)) return cache.get(k);
  let place = null;
  for (const url of SERVICES) {
    try {
      const res = await fetchImpl(url(ip), { headers: { "User-Agent": "groundcrew (+https://github.com/AnthonyDavidAdams/groundcrew)" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) continue;
      const j = await res.json();
      if (j && j.success === false) continue;
      place = shape(j);
      if (place) break;
    } catch { /* try the next one, then give up */ }
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, place);
  return place;
}

export const _cache = cache;
