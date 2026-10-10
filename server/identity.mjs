// Which record a finding is about, so a resubmission can replace the pending one it corrects and a
// finding about a different record never does.
//
// A task can name the fields that identify its records (`record_key` in tasks.yaml), and that is
// always preferred: only the crew knows that a bill is a state plus a number, or a dossier a state
// plus a body. Without one, the server falls back on conventions the record schemas already use --
// an authoritative id, or a name inside its region. A record that has neither has no identity, and
// supersedes nothing. Keying it by region alone made one bill erase every other pending bill in the
// state: Mississippi SB 2296 superseded HB 306, which had already superseded HB 1187.

// Case, spacing and punctuation are not identity: "H.B. 306", "HB 306" and "hb306" are one bill.
export const keyPart = (v) =>
  v === null || v === undefined || typeof v === "object" ? "" : String(v).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export function recordIdentity(rec, recordKey = null) {
  if (Array.isArray(recordKey) && recordKey.length) {
    const parts = recordKey.map((f) => keyPart(rec?.[f]));
    if (parts.every(Boolean)) return `key:${parts.join("|")}`;
  }
  const id = rec?.external_id ?? rec?.nces_id ?? rec?.id ?? null;
  if (id !== null && id !== undefined && String(id).trim()) return `id:${String(id).trim()}`;
  const name = String(rec?.name ?? "").trim().toLowerCase();
  if (!name) return null;
  const region = rec?.region ?? rec?.state ?? "";
  return `name:${String(region).trim().toLowerCase()}|${name}`;
}
