// An OpenStreetMap tile cache, so a crew's website can show where a contribution came from without
// telling a tile server who is reading the page.
//
// The page asks this server for a tile; this server asks OpenStreetMap once, keeps the PNG, and
// serves every later request from disk. Two reasons, in order of importance: a browser fetching
// tiles directly would disclose every visitor's address to a third party on every page view, and
// OpenStreetMap's tile policy asks that you cache rather than re-fetch and that you identify
// yourself. Distinct tiles are few — contributors cluster in towns, and a town is one tile — so in
// practice this is a handful of images that are fetched once and never again.
//
// Attribution is not optional: anything rendering these must credit OpenStreetMap contributors.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const ATTRIBUTION = "© OpenStreetMap contributors";
export const ATTRIBUTION_URL = "https://www.openstreetmap.org/copyright";
export const MIN_ZOOM = 1, MAX_ZOOM = 12;      // a town, never a street
export const MAX_TILE_BYTES = 512 * 1024;
const UPSTREAM = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const UA = "groundcrew/0.7 (+https://github.com/AnthonyDavidAdams/groundcrew; contact a@175g.com)";

const memory = new Map();       // "z/x/y" -> Buffer, a small hot set in front of the disk
const MEMORY_MAX = 64;
const inflight = new Map();

// Web Mercator, the standard slippy-map scheme.
export function tileFor(lat, lon, z) {
  const n = 2 ** z;
  const latR = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  return { z, x: Math.floor(x), y: Math.floor(y), fx: x - Math.floor(x), fy: y - Math.floor(y) };
}

export const validTile = (z, x, y) =>
  Number.isInteger(z) && Number.isInteger(x) && Number.isInteger(y) &&
  z >= MIN_ZOOM && z <= MAX_ZOOM && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z;

export class TileCache {
  constructor({ dir, fetchImpl = fetch } = {}) {
    this.dir = dir;
    this.fetchImpl = fetchImpl;
    if (dir) { try { mkdirSync(dir, { recursive: true }); } catch { this.dir = null; } }
  }

  path(z, x, y) {
    return this.dir ? join(this.dir, `${z}_${x}_${y}.png`) : null;
  }

  async get(z, x, y) {
    if (!validTile(z, x, y)) throw new Error(`tile ${z}/${x}/${y} is out of range (zoom ${MIN_ZOOM}-${MAX_ZOOM})`);
    const key = `${z}/${x}/${y}`;
    if (memory.has(key)) return memory.get(key);
    const file = this.path(z, x, y);
    if (file && existsSync(file)) {
      const buf = readFileSync(file);
      this.#remember(key, buf);
      return buf;
    }
    if (inflight.has(key)) return inflight.get(key);
    const job = this.#fetchTile(z, x, y, key, file).finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  async #fetchTile(z, x, y, key, file) {
    const res = await this.fetchImpl(UPSTREAM(z, x, y), {
      headers: { "User-Agent": UA, Accept: "image/png,image/*" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`tile server returned HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_TILE_BYTES) throw new Error("tile is implausibly large");
    if (buf.subarray(0, 8).toString("latin1") !== "\x89PNG\r\n\x1a\n") throw new Error("tile server did not return a PNG");
    if (file) { try { writeFileSync(file, buf); } catch { /* memory only, then */ } }
    this.#remember(key, buf);
    return buf;
  }

  #remember(key, buf) {
    if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value);
    memory.set(key, buf);
  }
}
