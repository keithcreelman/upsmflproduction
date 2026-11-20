// Commissioner Desk: the shared contract. Pure data and pure functions: no I/O, no env, no D1.
// Everything else in worker/src/desk/ (and the desk page) imports its constants from here so the tool layer,
// the validator and the renderer can never disagree about a state name, a data class or how a fact is shown.
//
// See docs/ai_desk/DESK_CONTRACT.md for the design.

// ── Data classes ────────────────────────────────────────────────────────────────────────────────
// P0 public league data · P1 owner-private · P2 commissioner · P3 secrets (never reachable by any tool).
export const DATA_CLASSES = ["P0", "P1", "P2", "P3"];
export const DATA_CLASS_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
// The desk is commissioner-only: its ceiling is P2. P3 is not a ceiling anyone can hold.
export const COMMISH_CEILING = "P2";

// ── Evidence grades ─────────────────────────────────────────────────────────────────────────────
// A an MFL record · B a league document · C derived by code from A/B · D inferred · NO_RECORD looked and found nothing.
export const GRADES = ["A", "B", "C", "D", "NO_RECORD"];

// ── Tool result statuses ────────────────────────────────────────────────────────────────────────
export const TOOL_STATUSES = ["ok", "refused", "unsupported_as_of", "no_record", "error", "forbidden"];

// Why a tool declined to produce a number (status "refused"); the composer must turn these into a decline, never a guess.
export const REFUSAL_CODES = [
  "incomplete_contract_data",   // drop penalty: contractInfo has no year-by-year salaries, so earned salary would be an AAV x years guess
  "tag_cutoff_unreliable",      // drop penalty: a tag cut near the FA Auction; the calculator hard-codes Aug 1, canon says the auction start
  "data_class_exceeded",
  "stale_data",
  "unverified_calculation",
];

// Why coverage has a gap.
export const GAP_REASONS = ["NO_RECORD", "unsupported_as_of", "partial_coverage", "stale", "unverified_calculation", "conflict_in_canon"];

// ── Answer card states (the composer's output vocabulary; the UX spec §5) ───────────────────────
export const CARD_STATES = [
  "answer", "answer_with_caveat", "answer_with_gap", "partial", "answer_with_conflict",
  "cite_and_abstain", "needs_ruling", "abstain",
  "refuse_privacy", "refuse_fairness", "ignore_injection",
  "tool_failure", "stale_data", "budget_exceeded", "out_of_scope",
];
// States the MODEL may choose. The rest are chosen by code (budget gate, freshness policy, validator failure, injection detector).
export const MODEL_CARD_STATES = [
  "answer", "answer_with_caveat", "answer_with_gap", "partial", "answer_with_conflict",
  "cite_and_abstain", "needs_ruling", "abstain", "refuse_privacy", "refuse_fairness", "out_of_scope",
];
// States that carry no numbers at all.
export const NO_FACT_STATES = ["abstain", "refuse_privacy", "refuse_fairness", "tool_failure", "budget_exceeded", "out_of_scope", "cite_and_abstain"];

// ── Caller ──────────────────────────────────────────────────────────────────────────────────────
// The caller object is built ONLY by the route handler, after the existing commissioner proof (commishSessionProven) has passed.
// It is never read from a request body, a header, a model message or a tool result.
export class DeskAuthError extends Error {
  constructor(reason) { super(`desk authorization failed: ${reason}`); this.name = "DeskAuthError"; this.reason = reason; }
}

// `who` is a franchise id ("0008") when known, or a proof label ("session" | "apikey"): the existing commissioner proof
// (commishSessionProven) answers only "yes, by which route", not which franchise, so the desk records how the caller was proven.
// A caller is real only if THIS module made it. Object.freeze() on a look-alike literal is not proof; membership in this private set is.
const BRANDED_CALLERS = new WeakSet();
export function makeCommishCaller(who) {
  const raw = String(who == null ? "" : who).trim();
  const id = /^\d{1,4}$/.test(raw) ? raw.padStart(4, "0") : (raw.replace(/[^a-z_]/gi, "").toLowerCase().slice(0, 12) || "commish");
  const caller = Object.freeze({ class: "commish", proven: true, scope: "desk", franchiseId: id, ceiling: COMMISH_CEILING });
  BRANDED_CALLERS.add(caller);
  return caller;
}

// Throws unless the caller is the proven commissioner. Every tool run, every store write and every model call starts here.
export function assertCommishCaller(caller) {
  if (!caller || typeof caller !== "object") throw new DeskAuthError("no caller");
  if (caller.class !== "commish") throw new DeskAuthError("caller is not the commissioner");
  if (caller.proven !== true) throw new DeskAuthError("commissioner proof missing");
  if (caller.scope !== "desk") throw new DeskAuthError("wrong scope");
  if (!BRANDED_CALLERS.has(caller)) throw new DeskAuthError("caller was not built by makeCommishCaller");
  if (caller.ceiling !== COMMISH_CEILING) throw new DeskAuthError("bad ceiling");
  return caller;
}

export function classAllowed(ceiling, dataClass) {
  const c = DATA_CLASS_RANK[ceiling], d = DATA_CLASS_RANK[dataClass];
  return c != null && d != null && d <= c && dataClass !== "P3";
}

// ── As-of ───────────────────────────────────────────────────────────────────────────────────────
// Every tool takes as_of: "current" or an ISO date (YYYY-MM-DD). A tool that cannot honor a past date says so; it never answers for today.
export const AS_OF_RE = /^(current|\d{4}-\d{2}-\d{2})$/;
export function isAsOf(v) {
  if (typeof v !== "string" || !AS_OF_RE.test(v)) return false;
  if (v === "current") return true;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
export function asOfSeason(asOf, currentSeason) {
  return asOf === "current" ? Number(currentSeason) : Number(String(asOf).slice(0, 4));
}

// ── Facts ───────────────────────────────────────────────────────────────────────────────────────
// A fact is a number, name, date or short string produced by CODE. The model writes {{f.<id>}} tokens; the renderer fills in display text.
export const FACT_UNITS = ["usd", "count", "pct", "rank", "season", "date", "week", "years", "text", "id"];
const FACT_ID_RE = /^c\d{1,3}\.[a-z][a-z0-9_]{0,63}$/;

export function isFactId(id) { return typeof id === "string" && FACT_ID_RE.test(id); }

// UPS salaries are quoted in $K: "$33K"; odd amounts show dollars: "$1,103".
export function formatFact(fact) {
  if (!fact || typeof fact !== "object") return "";
  const v = fact.value;
  switch (fact.unit) {
    case "usd": {
      const n = Number(v);
      if (!Number.isFinite(n)) return String(v);
      const sign = n < 0 ? "-" : "";
      const a = Math.abs(n);
      return a >= 1000 && a % 1000 === 0 ? `${sign}$${a / 1000}K` : `${sign}$${a.toLocaleString("en-US")}`;
    }
    case "pct": return `${Number(v)}%`;
    case "rank": { const n = Number(v); return Number.isFinite(n) ? `${n}${ordinalSuffix(n)}` : String(v); }
    case "years": return Number(v) === 1 ? "1 year" : `${v} years`;
    case "week": return `Week ${v}`;
    default: return String(v);
  }
}
function ordinalSuffix(n) {
  const m100 = n % 100;
  if (m100 >= 11 && m100 <= 13) return "th";
  return ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] || "th";
}

// ── Output hygiene ──────────────────────────────────────────────────────────────────────────────
// Keys that must never leave a tool, whatever the route returned (defense in depth under each tool's own output allowlist).
// Matched on the key with every non-letter removed and lowercased, so userEmail, user_email, "api-key", accessToken, mflUserId, Cookies all hit.
// Substring match on purpose: over-stripping a harmless field is safe; leaking one is not.
export const SECRET_KEY_RE = /(email|cookie|apikey|token|password|passwd|secret|authorization|mfluserid|phone|credential|session|bearer)/;
export function isSecretKey(key) { return SECRET_KEY_RE.test(String(key).toLowerCase().replace(/[^a-z]/g, "")); }
export function isUnsafeKey(key) { return key === "__proto__" || key === "constructor" || key === "prototype"; }

// ── Forbidden routes ────────────────────────────────────────────────────────────────────────────
// The registry refuses these for every tool, even if a tool definition lists them by mistake.
export const FORBIDDEN_ROUTE_PATTERNS = [
  /^\/admin(\/|$)/i,
  /^\/refresh\//i,
  /^\/reconcile\//i,
  /^\/trade-offers/i,
  /^\/api\/draft-state/i,
  /^\/api\/mfl-export/i,
  /^\/discord\//i,
  /^\/commish/i,
  /\/(write|post|import|backfill|sync|commit|execute|apply|cancel|accept|decline|revoke)(\/|$|-)/i,
];

// A route path must be plain: letters, digits, "-", "_", "." and "/" only; no "..", no "//", no "%" (encoded separators), no query or fragment.
export function isPlainRoutePath(p) {
  return typeof p === "string" && p.length <= 120 && /^\/[A-Za-z0-9_\-./]*$/.test(p) && !p.includes("..") && !p.includes("//") && !p.split("/").some((seg) => seg === "." || seg === "..");
}

// ── Small helpers ───────────────────────────────────────────────────────────────────────────────
export function freezeDeep(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) freezeDeep(o[k]); }
  return o;
}

export function emptyCoverage() { return { supported: true, gaps: [] }; }
