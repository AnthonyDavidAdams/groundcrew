// A document cache so an agent never has to pull a whole PDF into its context to find one sentence.
//
// Fetch once, extract once, keep the text. Agents search it by term and get back the hits with page
// numbers and surrounding context. The quote check at submit time reads the same cached copy, so a
// contributor is verified against the text they actually read rather than a second download that may
// have changed, been rate-limited, or been served differently.

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { normalizeText, htmlToText } from "./verify.mjs";

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 45_000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 groundcrew/0.2";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const urlKey = (u) => createHash("sha1").update(String(u)).digest("hex").slice(0, 20);

// One extraction per URL even when several agents ask at once.
const inflight = new Map();

export class DocumentCache {
  constructor({ dir, fetchImpl = fetch } = {}) {
    this.dir = dir;
    this.fetchImpl = fetchImpl;
    if (dir) { try { mkdirSync(dir, { recursive: true }); } catch { this.dir = null; } }
  }

  paths(url) {
    if (!this.dir) return null;
    const k = urlKey(url);
    return { meta: join(this.dir, `${k}.json`), text: join(this.dir, `${k}.txt`) };
  }

  read(url) {
    const p = this.paths(url);
    if (!p || !existsSync(p.meta) || !existsSync(p.text)) return null;
    try {
      const meta = JSON.parse(readFileSync(p.meta, "utf8"));
      return { ...meta, pages: meta.pages_text ? undefined : undefined, text: readFileSync(p.text, "utf8") };
    } catch { return null; }
  }

  write(url, doc) {
    const p = this.paths(url);
    if (!p) return null;
    try {
      const { text, page_texts, ...meta } = doc;
      writeFileSync(p.text, text);
      writeFileSync(p.meta, JSON.stringify({ ...meta, page_offsets: doc.page_offsets ?? null }, null, 1));
      return p.text;
    } catch { return null; }
  }

  // Store text the server obtained some other way — a vendor API, an OCR pass, a rendered page —
  // under the URL a person would actually cite. A later submit_finding checks the quote against this
  // copy, so a citation can point at a human-readable page that a plain fetch cannot read.
  put(url, text, meta = {}) {
    const body = String(text ?? "");
    const doc = {
      url,
      final_url: meta.final_url ?? url,
      sha256: sha256(Buffer.from(body)),
      bytes: Buffer.byteLength(body),
      content_type: meta.content_type ?? "text/plain",
      fetched_at: new Date().toISOString(),
      page_count: meta.page_count ?? 1,
      extracted_by: meta.extracted_by ?? "api",
      needs_ocr: false,
      page_offsets: meta.page_offsets ?? [0],
      ...meta,
      text: body,
      cached: false,
    };
    this.write(url, doc);
    return doc;
  }

  // Returns { url, final_url, sha256, bytes, content_type, fetched_at, page_count, text, page_offsets, needs_ocr, extracted_by, cached }
  async get(url, { refresh = false } = {}) {
    if (!refresh) {
      const hit = this.read(url);
      if (hit) return { ...hit, cached: true };
    }
    if (inflight.has(url)) return inflight.get(url);
    const job = this.#fetchAndExtract(url).finally(() => inflight.delete(url));
    inflight.set(url, job);
    return job;
  }

  async #fetchAndExtract(url) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error(`document must be http(s), got ${u.protocol}`);
    const res = await this.fetchImpl(u, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/pdf,text/plain,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`document returned HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOCUMENT_BYTES) throw new Error(`document is ${(buf.length / 1048576).toFixed(1)} MB, over the ${MAX_DOCUMENT_BYTES / 1048576} MB cap`);
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const isPdf = type.includes("application/pdf") || buf.subarray(0, 5).toString() === "%PDF-";

    let pages = [], extracted_by = "text";
    if (isPdf) {
      ({ pages, extracted_by } = await pdfPages(buf));
    } else if (type.includes("html") || /<\/?[a-z][^>]*>/i.test(buf.toString("utf8").slice(0, 2000))) {
      pages = [htmlToText(buf.toString("utf8"))]; extracted_by = "html";
    } else {
      pages = [buf.toString("utf8")];
    }

    // One flat string plus where each page starts, so a character offset maps back to a page.
    const page_offsets = []; let text = "";
    for (const p of pages) { page_offsets.push(text.length); text += (text ? "\n\n" : "") + p; }

    const perPage = pages.length ? normalizeText(text).length / pages.length : 0;
    const doc = {
      url,
      final_url: res.url ?? url,
      sha256: sha256(buf),
      bytes: buf.length,
      content_type: type || (isPdf ? "application/pdf" : "text/plain"),
      fetched_at: new Date().toISOString(),
      page_count: pages.length,
      extracted_by,
      needs_ocr: perPage < 200,
      text,
      page_offsets,
      cached: false,
    };
    this.write(url, doc);
    return doc;
  }
}

async function pdfPages(buf) {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: false });
    if (Array.isArray(text) && text.join("").trim().length) return { pages: text, extracted_by: "unpdf" };
  } catch { /* fall through */ }
  return { pages: [""], extracted_by: "none" };
}

export const pageOf = (doc, offset) => {
  const o = doc.page_offsets ?? [];
  if (!o.length) return null;
  let lo = 0, hi = o.length - 1, page = 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (o[mid] <= offset) { page = mid + 1; lo = mid + 1; } else hi = mid - 1; }
  return page;
};

// Term hits with surrounding context. `words` is roughly how many words of context to return.
export function search(doc, terms, { words = 300, maxPerTerm = 6 } = {}) {
  const hay = doc.text ?? "";
  const low = hay.toLowerCase();
  const out = [];
  for (const term of terms) {
    const t = String(term).toLowerCase();
    if (!t) continue;
    let i = 0, n = 0;
    while (n < maxPerTerm) {
      const at = low.indexOf(t, i);
      if (at < 0) break;
      const half = Math.max(200, Math.round((words / 2) * 6));
      let s = Math.max(0, at - half), e = Math.min(hay.length, at + t.length + half);
      s = hay.lastIndexOf(" ", s) + 1 || s;
      const cut = hay.indexOf(" ", e); if (cut > 0) e = cut;
      out.push({ term, page: pageOf(doc, at), offset: at, context: (s ? "… " : "") + hay.slice(s, e).replace(/\s+/g, " ").trim() + (e < hay.length ? " …" : "") });
      i = at + t.length; n++;
    }
  }
  return out;
}

// Lines that look like a contents entry: a title, then leaders or spaces, then a page number.
export function tableOfContents(doc, { maxEntries = 80 } = {}) {
  const head = (doc.text ?? "").slice(0, 60000);
  const entries = [];
  for (const line of head.split(/\r?\n/)) {
    const m = line.match(/^\s*(.{3,90}?)[\s.·•_-]{2,}(\d{1,4})\s*$/);
    if (m && !/^\d+$/.test(m[1].trim())) entries.push({ title: m[1].trim().replace(/\s+/g, " "), page: Number(m[2]) });
    if (entries.length >= maxEntries) break;
  }
  return entries;
}

export function pageRange(doc, from, to) {
  const o = doc.page_offsets ?? [];
  if (!o.length) return doc.text ?? "";
  const a = Math.max(1, from), b = Math.min(doc.page_count, to ?? from);
  const start = o[a - 1] ?? 0;
  const end = b < o.length ? o[b] : (doc.text ?? "").length;
  return (doc.text ?? "").slice(start, end);
}

// Wayback save, deliberately not awaited by the caller.
export function archive(url, fetchImpl = fetch) {
  return fetchImpl(`https://web.archive.org/save/${url}`, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(60_000) })
    .then((r) => {
      const loc = r.headers.get("content-location");
      return loc ? "https://web.archive.org" + loc : (r.url && r.url.includes("/web/") ? r.url : null);
    })
    .catch(() => null);
}
