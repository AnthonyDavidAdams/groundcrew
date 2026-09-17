// Tools that belong to this campaign rather than to Ground Crew.
//
// Finding a school district's handbook and reading Texas board policy are problems specific to US
// school districts. The engine stays general; this file knows about Apptegy, Finalsite and TASB.
//
// Loaded automatically by the server when it finds crew/tools.mjs. Exports registerTools.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// The handful of hosts that serve most district documents. A link to one of these is almost
// certainly a real document rather than a navigation page.
const DOC_HOSTS = [
  { host: "resources.finalsite.net", vendor: "Finalsite" },
  { host: "core-docs.s3", vendor: "Apptegy (core-docs)" },
  { host: "files-backend.assets.thrillshare.com", vendor: "Apptegy (Thrillshare)" },
  { host: "files.smartsites.parentsquare.com", vendor: "ParentSquare SmartSites" },
  { host: "4.files.edl.io", vendor: "Edlio" },
  { host: "content.myconnectsuite.com", vendor: "ConnectSuite" },
  { host: "manuals.boardbook.org", vendor: "BoardBook" },
  { host: "docs.google.com", vendor: "Google Docs" },
  { host: "drive.google.com", vendor: "Google Drive" },
];

const HANDBOOK = /student[\s_%-]*(?:\/?parent[\s_%-]*)?handbook|parent[\s_%-]*student[\s_%-]*handbook|family[\s_%-]*handbook|code[\s_%-]*of[\s_%-]*conduct|student[\s_%-]*code/i;
const YEAR = /(20\d{2})\s*[-–—/]\s*(?:20)?(\d{2})/;

const safe = (u) => { try { return decodeURIComponent(u); } catch { return u; } };

// A Google Docs link that can actually be downloaded as a PDF.
function googlePdf(url) {
  const m = String(url).match(/\/document\/d\/([a-zA-Z0-9_-]+)/) || String(url).match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  return /\/document\//.test(url)
    ? `https://docs.google.com/document/d/${m[1]}/export?format=pdf`
    : `https://drive.google.com/uc?export=download&id=${m[1]}`;
}

function schoolYearFrom(text) {
  const m = String(text).match(YEAR);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2].length === 2 ? `20${m[2]}` : m[2]);
  return b === a + 1 ? `${a}-${String(b).slice(2)}` : null;
}

async function getText(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*" }, redirect: "follow", signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { html: (await res.text()).slice(0, 900000), final: res.url };
}

function links(html, base) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    let abs; try { abs = new URL(m[1].trim(), base).toString(); } catch { continue; }
    out.push({ url: abs, text: m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() });
  }
  return out;
}

export async function registerTools(server, ctx, { z, text, fail, documents }) {
  const fetchImpl = ctx.fetchImpl ?? fetch;

  server.registerTool(
    "resolve_handbook",
    {
      title: "Find a district's current handbook",
      description:
        "Given a district website, return candidate handbook and code-of-conduct documents, newest school year first, with the page each link was found on and the vendor hosting it. " +
        "Discovery is the expensive half of a district scan and it is the same handful of hosts every time: Finalsite, Apptegy, ParentSquare, Edlio, BoardBook, Google Docs. " +
        "Feed the winner to fetch_document rather than opening it yourself. If nothing comes back, the district's site is probably JavaScript-only or behind a bot challenge; say so in a report_issue and fall back to reading it yourself.",
      inputSchema: {
        website: z.string().url().describe("The district's website, from the NCES record"),
        district: z.string().optional().describe("District name, used only to label the result"),
        state: z.string().length(2).optional(),
        max_pages: z.number().int().min(1).max(8).optional().describe("How many pages to look at (default 4)"),
      },
    },
    async ({ website, district, state, max_pages = 4 }) => {
      const origin = (() => { try { return new URL(website).origin; } catch { return null; } })();
      if (!origin) return fail(`'${website}' is not a usable URL.`);
      const HUB = /parent|student|famil|handbook|conduct|polic|document|resource|about|district/i;
      const seen = new Set(), queue = [website];
      const candidates = [];
      let pages = 0;
      while (queue.length && pages < max_pages) {
        const page = queue.shift();
        if (seen.has(page)) continue;
        seen.add(page);
        let got; try { got = await getText(page, fetchImpl); } catch { continue; }
        pages++;
        for (const l of links(got.html, got.final)) {
          const hay = `${l.text} ${safe(l.url)}`;
          const isDoc = /\.(pdf|docx?)(\?|#|$)/i.test(l.url) || DOC_HOSTS.some((d) => l.url.includes(d.host));
          if (HANDBOOK.test(hay) && isDoc) {
            const vendor = DOC_HOSTS.find((d) => l.url.includes(d.host))?.vendor ?? "district site";
            const download = googlePdf(l.url) ?? l.url;
            if (!candidates.some((c) => c.url === download)) {
              candidates.push({ title: l.text.slice(0, 120) || null, url: download, original_link: download === l.url ? undefined : l.url, vendor, school_year: schoolYearFrom(hay), found_on: got.final });
            }
          }
        }
        if (pages < max_pages) {
          for (const l of links(got.html, got.final)) {
            try { if (new URL(l.url).origin !== origin) continue; } catch { continue; }
            if (HUB.test(`${l.text} ${l.url}`) && !/\.(pdf|docx?|jpe?g|png)(\?|#|$)/i.test(l.url) && !seen.has(l.url) && queue.length < 12) queue.push(l.url);
          }
        }
      }
      const rank = (c) => (c.school_year ? Number(c.school_year.slice(0, 4)) : 0);
      candidates.sort((a, b) => rank(b) - rank(a));
      return text({
        district: district ?? null, state: state ?? null, website, pages_examined: pages,
        candidates,
        next: candidates.length
          ? "Pass the newest candidate to fetch_document. Check its school_year against the current one before quoting it."
          : "Nothing found. The site is probably JavaScript-rendered or behind a bot challenge; read it yourself and submit with source_text, and file a report_issue so the pattern gets added.",
      });
    }
  );

  server.registerTool(
    "fetch_tasb_policy",
    {
      title: "Read a Texas district's board policy",
      description:
        "Texas districts publish board policy through TASB Policy Online, which serves text to a browser but refuses a plain server fetch. This reads it for you. " +
        "FO(LOCAL) is the corporal punishment policy; FO(LEGAL) is the statute it rests on. Returns each separately with the update number and issue date from the footer, which is how you date the policy. " +
        "The district key is the number in a pol.tasb.org URL, for example 1133 for Mount Pleasant ISD.",
      inputSchema: {
        district_key: z.string().regex(/^\d{1,6}$/).describe("The district's TASB key, the number in pol.tasb.org/Policy/Code/<key>"),
        code: z.string().trim().default("FO").describe("Policy code, e.g. FO for student discipline and corporal punishment"),
      },
    },
    async ({ district_key, code = "FO" }) => {
      // Policy/Code redirects here; go straight to it.
      const url = `https://pol.tasb.org/PolicyOnline/PolicyDetails?key=${district_key}&code=${encodeURIComponent(code)}`;
      let got;
      try { got = await getText(url, fetchImpl); } catch (err) { return fail(`TASB returned ${err.message} for key ${district_key}. Check the key, or read it yourself and submit with source_text.`); }
      const plain = got.html
        .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
        .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

      // On TASB the FO(LOCAL) / FO(LEGAL) marker sits at the END of its section, followed by the
      // district name and the update footer. So a section runs backwards from its marker to the
      // previous marker (or the start of the policy body).
      const markerRe = new RegExp(`${code}\\((LOCAL|LEGAL|REGULATION|EXHIBIT)\\)`, "gi");
      const markers = [...plain.matchAll(markerRe)].map((m) => ({ label: m[1].toUpperCase(), start: m.index, end: m.index + m[0].length }));
      const bodies = {};
      let prevEnd = 0;
      for (const mk of markers) {
        const body = plain
          .slice(prevEnd, mk.start)
          // drop the district-name line that trails each section
          .replace(/\s*[A-Z][A-Z .'-]{3,60}\s*$/, "")
          .replace(/\s+/g, " ")
          .trim();
        if (body.length > 200 && !bodies[mk.label]) bodies[mk.label] = body.slice(0, 40000);
        prevEnd = mk.end;
      }
      // Each section is preceded by the page's table of contents; drop it.
      const trimNav = (t) => {
        if (!t) return t;
        const head = t.slice(0, 2500);
        const m = [...head.matchAll(/Adopted:\s*[0-9/]{6,10}/g)].pop();
        return m ? t.slice(m.index + m[0].length).trim() : t;
      };
      const cut = (label) => (bodies[label] ? trimNav(bodies[label]) : null);
      const footer = plain.match(/UPDATE\s+(\d+)\s*DATE ISSUED:?\s*([0-9/\-]+)/i);
      const local = cut("LOCAL"), legal = cut("LEGAL");
      if (!local && !legal) {
        return fail("TASB answered but no LOCAL or LEGAL section was found; the page may be JavaScript-only for this district.", { url, chars: plain.length, next: "Read it yourself and submit with source_text." });
      }
      // Hand back the sentences that matter rather than making the agent scan 7,000 characters.
      const terms = ctx.crew.crew.document_terms ?? ["corporal punishment"];
      const hits = [];
      for (const [label, body] of [["LOCAL", local], ["LEGAL", legal]]) {
        if (!body) continue;
        const low = body.toLowerCase();
        for (const term of terms) {
          const t = String(term).toLowerCase();
          let i = 0, n = 0;
          while (n < 3) {
            const at = low.indexOf(t, i);
            if (at < 0) break;
            const s0 = Math.max(0, at - 220), e0 = Math.min(body.length, at + t.length + 320);
            hits.push({ section: label, term, context: (s0 ? "… " : "") + body.slice(s0, e0).trim() + (e0 < body.length ? " …" : "") });
            i = at + t.length; n++;
          }
        }
      }

      return text({
        district_key, code, source: url,
        hits,
        local, legal,
        update: footer ? `UPDATE ${footer[1]}` : null,
        date_issued: footer ? footer[2] : null,
        note: "Quote LOCAL for what this district does; LEGAL is the statute and is identical across districts, so it does not establish a district's own policy.",
      });
    }
  );

  return ["resolve_handbook", "fetch_tasb_policy"];
}
