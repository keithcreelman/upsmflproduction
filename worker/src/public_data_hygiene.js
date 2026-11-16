// public_data_hygiene.js: keeps account identifiers and free-text fields out of the data files the worker commits to the
// repository (site/trades/trade_offers_*.json and site/reports/bug_reports_*.json). Everything here is pure: no I/O, no
// logging, and nothing returned ever contains a value that was removed.
//
// WHAT THIS DOES NOT GUARANTEE. It removes RECOGNIZED things: the named identifier fields, "MFL <token>" label segments, URL
// parameters whose NAME is on the list below, and the exact values the request itself carried. It cannot recognize an unknown
// value typed or pasted into free text (details, steps, expected-vs-actual), into a franchise name, into a screenshot's file
// name, into a URL parameter with an unlisted name, or into any other context field. Those pass through unchanged. The control
// for report text is the BUG_REPORT_PUBLIC_WRITES_ENABLED pause; this scrubber is a second layer, not a reason to re-enable it.

const s = (v) => String(v == null ? "" : v);

// Free-text fields of a trade offer. Emptied in the committed row; the live inbox reads its notes from MFL.
export const OFFER_TEXT_KEYS = ["message", "comment", "comments", "raw_comment", "action_message"];
const OFFER_TEXT = new Set(OFFER_TEXT_KEYS);

function blankDeep(v, keys = OFFER_TEXT) {
  if (Array.isArray(v)) return v.map((x) => blankDeep(x, keys));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = keys.has(k) && typeof x === "string" ? "" : blankDeep(x, keys);
    return out;
  }
  return v;
}

/** A copy of a stored trade-offer row with its free-text fields emptied, at the top level and inside `payload`.
 *  The input is never mutated (the caller still needs the text in memory, e.g. for the day-one trade DM). */
export function blankOfferText(row) {
  return row && typeof row === "object" ? blankDeep(row) : row;
}

// ── account identifiers ───────────────────────────────────────────────────────────────────────────────────────────

const ID_KEY = /^(mfl_?user_?id|submitted_?by_?mfl_?user_?id)$/i;
// "MFL <token>" as one segment of a label. A token is a long run with no spaces; a team name is not.
const LABEL_TOKEN_SEGMENT = /^\s*MFL[\s:_=-]+[A-Za-z0-9+/=_%.-]{12,}\s*$/i;

function usable(secrets) {
  return (Array.isArray(secrets) ? secrets : []).map((x) => s(x).trim()).filter((x) => x.length >= 6);
}
function dropSecrets(text, secrets) {
  let out = s(text);
  for (const sec of usable(secrets)) out = out.split(sec).join("");
  return out;
}
// URL parameter NAMES that carry an identifier or a key; they are not copied into a report.
const SENSITIVE_PARAM = /^(mfl_?user_?id|mflusrid|apikey|api_?key|key|token|access_?token|auth|authorization|password|secret|session|sid)$/i;
const SENSITIVE_PARAM_TEXT = /([?&#;]|^)(mfl_?user_?id|mflusrid|apikey|api_?key|access_?token|token|authorization|password|secret)\s*=\s*[^&#\s;"']*/gi;
function dropSensitiveParams(text) {
  const raw = s(text);
  if (!/(=)/.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      for (const k of [...u.searchParams.keys()]) if (SENSITIVE_PARAM.test(k)) u.searchParams.delete(k);
      if (u.hash && /=/.test(u.hash)) {
        const h = new URLSearchParams(u.hash.replace(/^#/, ""));
        for (const k of [...h.keys()]) if (SENSITIVE_PARAM.test(k)) h.delete(k);
        const rest = h.toString();
        u.hash = rest ? `#${rest}` : "";
      }
      return u.toString();
    } catch (_) { /* fall through to the text rule */ }
  }
  return raw.replace(SENSITIVE_PARAM_TEXT, (m, lead) => (lead === "?" || lead === "&" || lead === "#" || lead === ";" ? lead : ""));
}

/** A submitter label with any account identifier removed: every `|` segment that is "MFL <token>" or contains a known value goes. */
export function scrubBugLabel(label, secrets) {
  return dropSensitiveParams(s(label))
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p && !LABEL_TOKEN_SEGMENT.test(p) && !usable(secrets).some((sec) => p.includes(sec)))
    .join(" | ");
}

function scrubDeep(v, secrets) {
  if (typeof v === "string") return dropSecrets(dropSensitiveParams(v), secrets);
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, secrets));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (!ID_KEY.test(k)) out[k] = scrubDeep(x, secrets);
    return out;
  }
  return v;
}

/** A bug-report row with no account identifier anywhere: the id fields emptied, the label and the captured page context scrubbed,
 *  and any known value removed from the typed text. `secrets` are the values this request carried (never logged or returned). */
export function withoutAccountIds(row, secrets) {
  const r = row && typeof row === "object" ? row : {};
  return {
    ...r,
    mfl_user_id: "",
    submitted_by_mfl_user_id: "",
    submitted_by_label: scrubBugLabel(r.submitted_by_label, secrets),
    details: dropSecrets(r.details, secrets),
    steps_to_reproduce: dropSecrets(r.steps_to_reproduce, secrets),
    expected_vs_actual: dropSecrets(r.expected_vs_actual, secrets),
    context: scrubDeep(r.context && typeof r.context === "object" ? r.context : {}, secrets),
  };
}

/** The row as committed to the reports file: screenshots reduced to their metadata. The full row (with the images)
 *  is still what the Discord thread is built from. */
export function storableBugRow(row) {
  const r = row && typeof row === "object" ? row : {};
  const att = Array.isArray(r.attachments) ? r.attachments : [];
  return {
    ...r,
    attachments: att.map((a) => ({
      name: s(a && a.name).slice(0, 120),
      type: s(a && a.type).slice(0, 60),
      original_type: s(a && a.original_type).slice(0, 60),
      size_bytes: Math.max(0, Number(a && a.size_bytes) || 0),
      image_stored: false,
    })),
  };
}

// ── trade outbox rows (the dormant file fallback) ───────────────────────────────────────────────────────────────────

// The only top-level fields a file-stored outbox row keeps. Everything the fallback's readers use is here: lookup keys, status,
// the machine-built XML and trailer (ids, hash, base64 XML: no owner text), and `payload_json` with its notes emptied.
export const OUTBOX_FILE_FIELDS = [
  "id", "created_ts", "updated_ts", "league_id", "season", "trade_id", "action_type", "from_franchise_id", "to_franchise_id",
  "payload_xml_extensions", "payload_xml_salary_adj", "payload_xml_salary_trade", "payload_hash", "status", "comment_trailer",
];
const OUTBOX_TEXT = new Set([...OFFER_TEXT_KEYS, "notes"]);

/** A copy of an outbox row that is safe to commit to the public repository: allowlisted fields only, owner notes emptied
 *  inside `payload_json`, and the MFL response excerpts (which can echo the note) emptied. Never mutates its input. */
export function outboxFileRow(row) {
  const src = row && typeof row === "object" ? row : {};
  const out = {};
  for (const k of OUTBOX_FILE_FIELDS) if (k in src) out[k] = src[k];
  const pj = src.payload_json;
  out.payload_json = pj && typeof pj === "object" ? blankDeep(pj, OUTBOX_TEXT) : null;
  out.mfl_post_response_snip = "";
  out.mfl_verify_response_snip = "";
  return out;
}
