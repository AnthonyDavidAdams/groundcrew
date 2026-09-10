// Source verification for findings: fetch `source`, reduce it to text, and require the first 120 characters
// of the normalized `quote` to appear in the normalized text. See SPEC.md, "Validation rules".

export const QUOTE_PREFIX_CHARS = 120;
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

export function normalizeText(s) {
  return String(s ?? "")
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Crude HTML to text: drop script/style, turn tags into spaces, decode the common entities.
export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export function quoteAppears(quote, text) {
  const needle = normalizeText(quote).slice(0, QUOTE_PREFIX_CHARS);
  if (!needle) return false;
  return normalizeText(text).includes(needle);
}

export async function fetchSourceText(url, { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, fetchImpl = fetch, userAgent = "groundcrew/0.1 (+https://github.com/earthpilot/groundcrew)" } = {}) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error(`source must be http(s), got ${u.protocol}`);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(u, { signal: ac.signal, redirect: "follow", headers: { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml,text/plain,application/pdf;q=0.5,*/*;q=0.2" } });
    if (!res.ok) throw new Error(`source returned HTTP ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_SOURCE_BYTES) throw new Error(`source larger than ${MAX_SOURCE_BYTES} bytes`);
    if (type.includes("application/pdf") || buf.subarray(0, 5).toString() === "%PDF-") {
      return { text: pdfTextBestEffort(buf), content_type: type || "application/pdf", bytes: buf.length, pdf: true };
    }
    const raw = buf.toString("utf8");
    const text = type.includes("html") || /<\/?[a-z][^>]*>/i.test(raw.slice(0, 2000)) ? htmlToText(raw) : raw;
    return { text, content_type: type, bytes: buf.length, pdf: false };
  } finally {
    clearTimeout(timer);
  }
}

// PDFs are not parsed here; we pull out any uncompressed text operators so plain PDFs still match.
// Compressed streams (most PDFs) will not match and the finding is reported as `source_check: unverifiable`.
function pdfTextBestEffort(buf) {
  const s = buf.toString("latin1");
  const parts = [];
  for (const m of s.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) parts.push(m[1].replace(/\\([()\\])/g, "$1"));
  for (const m of s.matchAll(/\[((?:\((?:\\.|[^\\)])*\)|[^\]])*)\]\s*TJ/g)) {
    parts.push(m[1].replace(/\(((?:\\.|[^\\)])*)\)/g, (_, t) => t.replace(/\\([()\\])/g, "$1")).replace(/-?\d+(\.\d+)?/g, ""));
  }
  return parts.join(" ");
}

// Returns { ok, status, detail }. status: "matched" | "not_found" | "fetch_failed" | "unverifiable" | "skipped".
export async function verifyQuote(record, opts = {}) {
  const source = record?.source, quote = record?.quote;
  if (!source || !quote) return { ok: true, status: "skipped", detail: "record has no source and quote pair" };
  let fetched;
  try {
    fetched = await fetchSourceText(source, opts);
  } catch (err) {
    return { ok: false, status: "fetch_failed", detail: err.message };
  }
  if (quoteAppears(quote, fetched.text)) return { ok: true, status: "matched", detail: `first ${QUOTE_PREFIX_CHARS} characters of the quote found in ${fetched.content_type || "the source"} (${fetched.bytes} bytes)` };
  if (fetched.pdf && normalizeText(fetched.text).length < 200) {
    return { ok: false, status: "unverifiable", detail: "source is a PDF whose text could not be extracted; attach the extracted text or a text-layer URL" };
  }
  return { ok: false, status: "not_found", detail: `the quote does not appear in the fetched source (${fetched.content_type || "unknown type"}, ${fetched.bytes} bytes)` };
}
