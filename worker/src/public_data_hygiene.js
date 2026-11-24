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
  if (!row || typeof row !== "object") return row;
  const out = blankDeep(row);
  if (isObj(row.payload)) out.payload = offerPayloadForFile(row.payload);
  return out;
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

// `payload_json` is rebuilt from an ALLOWLIST, not scrubbed: only the keys the outbox readers use survive, only as plain
// values (never nested objects under a key that should be a scalar), and strings are capped. Any other key, at any level
// (a UI search box, a note under a name nobody listed, a new field added later), is absent from the public file.
const PAYLOAD_TOP = ["schema_version", "league_id", "season"];
const TEAM_KEYS = ["franchise_id", "role", "traded_salary_adjustment_k"];
const ASSET_KEYS = ["asset_id", "type", "player_id", "player_name", "taxi", "salary", "contract_type", "contract_info", "contract_length", "years",
  "position", "nfl_team", "pick_key", "pick_season", "pick_round", "pick_slot", "pick_origin_franchise_id", "description", "token", "pick",
  "label", "already_extended_by_this_franchise"];
const EXT_KEYS = ["player_id", "player_name", "from_franchise_id", "fromFranchiseId", "to_franchise_id", "extension_term", "option_key", "optionKey",
  "loaded_indicator", "new_contract_status", "new_TCV", "new_tcv", "newTcv", "new_aav_future", "newAavFuture", "new_contract_length", "newContractLength",
  "preview_contract_info_string", "preview_id", "applies_to_acquirer"];
const MAX_TEXT = 240;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
function pickScalars(src, keys) {
  const out = {};
  if (!isObj(src)) return out;
  for (const k of keys) {
    const v = src[k];
    if (typeof v === "string") out[k] = v.slice(0, MAX_TEXT);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}
/** The part of an outbox payload the readers need: teams (+ their selected assets), extension requests, the two team ids,
 *  the validation status. Returns null for a non-object. */
export function outboxPayloadForFile(pj) {
  if (!isObj(pj)) return null;
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    ...pickScalars(pj, PAYLOAD_TOP),
    teams: arr(pj.teams).filter(isObj).map((tm) => ({ ...pickScalars(tm, TEAM_KEYS), selected_assets: arr(tm.selected_assets).filter(isObj).map((a) => pickScalars(a, ASSET_KEYS)) })),
    extension_requests: arr(pj.extension_requests).filter(isObj).map((r) => pickScalars(r, EXT_KEYS)),
    ui: pickScalars(pj.ui, ["left_team_id", "right_team_id"]),
    validation: pickScalars(pj.validation, ["status"]),
  };
}

// ── trade offers (the offers file) ───────────────────────────────────────────────────────────────────────────────────
// The stored offer's `payload` is what the inbox card and the workbench hydrate from. Same method as the outbox: rebuilt from
// an allowlist, scalars only. It adds the display fields the cards show (team names, the salary tables); it leaves out the
// builder's own UI state (`filters`, which holds the search box), `validation.issues`, the raw `assets` lists (the client rebuilds
// those from the offer's token lists), and every key not named here, at any level.
const OFFER_PAYLOAD_TOP = [...PAYLOAD_TOP, "generated_at", "source"];
const OFFER_TEAM_KEYS = [...TEAM_KEYS, "franchise_name", "traded_salary_adjustment_dollars", "traded_salary_adjustment_max_k", "selected_non_taxi_salary_dollars"];
const SALARY_SIDE_KEYS = ["franchise_id", "franchise_name", "salary_cap_dollars", "starting_salary_dollars", "salary_adjustment_total_dollars", "outgoing_dollars",
  "incoming_dollars", "salary_trade_adjustment_dollars", "net_salary_adjustment_dollars", "new_salary_dollars", "trade_salary_adjustment_k",
  "trade_salary_adjustment_max_k", "net_trade_salary_k", "net_cap_change_dollars", "available_salary_before_dollars", "available_salary_after_dollars", "over_cap_dollars"];
const IMPACT_ROW_KEYS = ["season", "left_before_dollars", "left_after_dollars", "left_change_dollars", "right_before_dollars", "right_after_dollars", "right_change_dollars"];

/** The stored-offer version of the payload allowlist. Returns null for a non-object. */
export function offerPayloadForFile(pj) {
  if (!isObj(pj)) return null;
  const arr = (v) => (Array.isArray(v) ? v : []);
  const out = {
    ...pickScalars(pj, OFFER_PAYLOAD_TOP),
    teams: arr(pj.teams).filter(isObj).map((tm) => ({ ...pickScalars(tm, OFFER_TEAM_KEYS), selected_assets: arr(tm.selected_assets).filter(isObj).map((a) => pickScalars(a, ASSET_KEYS)) })),
    extension_requests: arr(pj.extension_requests).filter(isObj).map((r) => pickScalars(r, EXT_KEYS)),
    ui: pickScalars(pj.ui, ["left_team_id", "right_team_id"]),
    validation: pickScalars(pj.validation, ["status"]),
  };
  if (isObj(pj.salary_reconciliation)) {
    const sr = pj.salary_reconciliation;
    out.salary_reconciliation = { ...pickScalars(sr, ["has_over_cap"]), left: pickScalars(sr.left, SALARY_SIDE_KEYS), right: pickScalars(sr.right, SALARY_SIDE_KEYS) };
  }
  if (isObj(pj.multi_year_salary_impact)) {
    const my = pj.multi_year_salary_impact;
    out.multi_year_salary_impact = { ...pickScalars(my, ["current_season", "left_franchise_name", "right_franchise_name"]), rows: arr(my.rows).filter(isObj).map((r) => pickScalars(r, IMPACT_ROW_KEYS)) };
  }
  return out;
}

/** A copy of an outbox row that is safe to commit to the public repository: allowlisted fields only, `payload_json` rebuilt from an allowlist, and the MFL response excerpts (which can echo the note) emptied. Never mutates its input. */
export function outboxFileRow(row) {
  const src = row && typeof row === "object" ? row : {};
  const out = {};
  for (const k of OUTBOX_FILE_FIELDS) if (k in src) out[k] = src[k];
  out.payload_json = outboxPayloadForFile(src.payload_json);
  out.mfl_post_response_snip = "";
  out.mfl_verify_response_snip = "";
  return out;
}
