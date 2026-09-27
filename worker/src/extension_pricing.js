// extension_pricing.js — THE canonical price of a pre-trade extension (pure; no I/O).
//
// One function prices an extension, and every surface that shows, stores, checks or imports one uses it:
//   • the builder / preview feeds (`/roster-workbench`, `/trade-workbench` extension_previews)   • stored-offer creation (2-way propose, 3-way create)
//   • acceptance-time validation (2-way accept, 3-way accept + execute gates)                  • the MFL contract import (salaries XML)
//   • the commissioner review output (`GET /admin/trade/extension-review`)
// The browser's own copy (site/shared/pretrade_extension.js) exists only to show a price before a request is sent; it can never decide what is
// stored or imported — the worker re-prices from CURRENT authoritative inputs and refuses any stored offer whose terms differ (`extension_terms_stale`).
//
// CANON (docs/league_context_v1.md §C4 "Extension", worked examples on the same section, and §C5.1 for the AAV token):
//   • Eligible: a FINAL-YEAR contract (years remaining = 1). (Expired rookies are NOT priced here — their base salary is a wiped field that
//     only the draft-slot schedule can supply; that authority is not wired, so they fail closed. The window for them is closed anyway.)
//   • Term: 1 or 2 years (Ext1 / Ext2). A pre-trade extension is never loaded (FL/BL): the extension years are flat.
//   • The current year is NOT repriced — Y1 of the extended contract is the LIVE current-year salary.
//   • The escalator applies to the AAV of the EXTENSION years only:  future AAV = current AAV + raise
//       Schedule 1 (QB / RB / WR / TE):      +$10K (1 year)  /  +$20K (2 years)
//       Schedule 2 (DL / LB / DB / PK / PN): +$3K  (1 year)  /  +$5K  (2 years)
//   • The current AAV is the contract's AAV TOKEN (its current tier — the first value of a dual AAV like "33K, 43K"), preserved verbatim
//     (§C5.1: never recompute it; never average TCV ÷ CL when the token exists). Only when there is no token is it TCV ÷ CL.
//     ROLL-FORWARD REPAIR: MFL clobbers the AAV token when a contract rolls a year (Mason, 2026-07-22). When last season's row for the SAME
//     contract (same TCV and CL, one more year remaining) is available, the current AAV is that contract's LAST AAV tier — exactly the repair
//     the Front Office applies (`normalizeContractInfoForDisplay`), so the builder, the preview and the accept read the same AAV.
//   • New TCV = current salary + future AAV × years  (forward-looking only). New CL = 1 + years. GTD = 75% of the new TCV.
//   • Worked example (canon): 1 year left at $17K AAV, Ext1 → future AAV $27K, current year stays $17K, TCV $17K + $27K = $44K.
//     Two years, $30K AAV, Schedule 1 → $50K AAV for both extension years, TCV $30K + $50K + $50K = $130K.
//   • Amounts are whole $1K (rounded to the nearest $1K, halves up); a price is never below $1K.
//   • MFL's `contractYear` is YEARS REMAINING, so an extended contract is written with contractYear = its new CL (a 3-year contract starts
//     at 3). (A pre-trade extension used to be written with contractYear 1, which had to be hand-corrected — London, 2026-07-22.)
//
// FAIL CLOSED: anything the price needs and cannot get (position, salary, an AAV token or TCV/CL, a readable years-remaining) is a refusal
// with a machine-readable reason — never a guess, never a default.

export const PRICING_VERSION = "2026-09-26.1";

const s = (v) => String(v == null ? "" : v).trim();

/** Schedule 1 / Schedule 2 raises, in dollars, keyed by extension years. (Canon §C4.) */
export const SCHEDULE_RAISES = Object.freeze({
  1: Object.freeze({ 1: 10000, 2: 20000 }),
  2: Object.freeze({ 1: 3000, 2: 5000 }),
});
/** Position group → schedule. Any position not listed here is not priceable (never assumed). */
export const GROUP_SCHEDULE = Object.freeze({ QB: 1, RB: 1, WR: 1, TE: 1, DL: 2, LB: 2, DB: 2, PK: 2, PN: 2 });

const roundK = (n) => Math.round((Number(n) || 0) / 1000) * 1000;
const fk = (d) => {
  d = Math.round(Number(d) || 0);
  if (d <= 0) return "0K";
  const t = Math.round((d / 1000) * 10) / 10;
  return String(t).replace(/\.0$/, "") + "K";
};

/** MFL / MFL-ish position → pricing group (null when unknown). Same mapping the builders use. */
export function positionGroup(pos) {
  const p = s(pos).toUpperCase();
  if (!p) return null;
  if (["DE", "DT", "DL", "NT", "EDGE", "ED"].includes(p)) return "DL";
  if (["CB", "S", "FS", "SS", "DB"].includes(p)) return "DB";
  if (p === "K" || p === "PK") return "PK";
  if (p === "P" || p === "PN") return "PN";
  if (["QB", "RB", "WR", "TE", "LB"].includes(p)) return p;
  return null;
}
export function scheduleFor(pos) {
  const group = positionGroup(pos);
  if (!group) return null;
  const schedule = GROUP_SCHEDULE[group];
  return { group, schedule, raises: SCHEDULE_RAISES[schedule] };
}

/** "9K" → 9000 · "1.5K" → 1500 · "86" → 86000 (a bare number under 1000 is $K, MFL's convention) · "9000" → 9000 · junk → null. */
export function moneyToDollars(token) {
  const raw = s(token);
  if (!raw) return null;
  const hasK = /k/i.test(raw);
  const cleaned = raw.replace(/[^0-9.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return hasK || Math.abs(n) < 1000 ? Math.round(n * 1000) : Math.round(n);
}

/** Parse a contractInfo string: CL / TCV / AAV tiers / Y-by-year / GTD / Ext lineage. Tolerates both "|" and "| " separators. */
export function parseContractInfo(info) {
  const text = s(info);
  const out = { cl: null, tcv: null, aav_tiers: [], years: {}, gtd: null, ext: "" };
  if (!text) return out;
  const cl = text.match(/(?:^|\|)\s*CL\s*:?\s*(\d+)/i);
  if (cl) out.cl = parseInt(cl[1], 10);
  const tcv = text.match(/(?:^|\|)\s*TCV\s*:?\s*([^|]+)/i);
  if (tcv) out.tcv = moneyToDollars(tcv[1]);
  const aav = text.match(/(?:^|\|)\s*AAV\s*:?\s*([^|]+)/i);
  if (aav) out.aav_tiers = (aav[1].match(/-?\d+(?:\.\d+)?\s*K?/gi) || []).map(moneyToDollars).filter((n) => n != null && n > 0);
  const re = /\bY\s*(\d+)\s*[-:]\s*\$?\s*([0-9]+(?:\.[0-9]+)?\s*K?)/gi;
  let m;
  while ((m = re.exec(text))) {
    const y = parseInt(m[1], 10), d = moneyToDollars(m[2]);
    if (y > 0 && d != null && d >= 0) out.years[String(y)] = d;
  }
  const gtd = text.match(/(?:^|\|)\s*GTD\s*:?\s*([^|]+)/i);
  if (gtd) out.gtd = moneyToDollars(gtd[1]);
  const ext = text.match(/(?:^|\|)\s*Ext\s*:\s*([^|]*)/i);
  if (ext) out.ext = s(ext[1]).replace(/[^\x20-\x7E]/g, "").replace(/\s{2,}/g, " ").replace(/^[,\s]+|[,\s]+$/g, "");
  return out;
}

// ── Ext: lineage ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const norm = (x) => s(x).toLowerCase().replace(/[^a-z0-9]/g, "");
/** ASCII-only label (MFL renders contractInfo as Latin-1). Empty when nothing printable is left. */
export function asciiLabel(x) { return s(x).replace(/[^\x20-\x7E]/g, "").replace(/\s{2,}/g, " ").trim(); }
/** The lineage of extending franchises, with the franchise extending NOW appended (unless it is already the latest entry). */
export function lineageWithExtender(existing, extenderLabel) {
  const cur = s(existing);
  const label = asciiLabel(extenderLabel);
  if (!label) return cur;
  const parts = cur ? cur.split(",").map((x) => x.trim()).filter(Boolean) : [];
  if (parts.length && norm(parts[parts.length - 1]) === norm(label)) return parts.join(", ");
  return [...parts, label].join(", ");
}

const termYearsOf = (t) => {
  const x = s(t).toUpperCase().replace(/^VET-?/, "");
  if (/^(1|1YR|1-YR|EXT1)/.test(x)) return 1;
  if (/^(2|2YR|2-YR|EXT2)/.test(x)) return 2;
  return 0;
};
const loadedOf = (v) => {
  const x = s(v).toUpperCase();
  if (!x || x === "NONE" || x === "NO" || x === "0") return "NONE";
  if (x === "FL" || x === "BL") return x;
  return x;
};

/**
 * The player's CURRENT AAV — the base the escalator is added to. Returns { aav, source } or null.
 *   prior_last_tier   last season's row is the same contract one year earlier (same TCV/CL when both are known) → its last AAV tier
 *   token             the contract's AAV token, current (first) tier
 *   tcv_over_cl       no token: TCV ÷ CL
 * `prior` = { years, info } for last season's row, `null` = none exists, `undefined` = not consulted.
 */
export function resolveCurrentAav({ contractInfo, yearsRemaining, prior }) {
  const cur = parseContractInfo(contractInfo);
  const cy = parseInt(s(yearsRemaining), 10);
  if (prior && Number.isFinite(cy) && cy > 0 && parseInt(s(prior.years), 10) === cy + 1) {
    const p = parseContractInfo(prior.info);
    const sameTcv = !(p.tcv > 0 && cur.tcv > 0 && p.tcv !== cur.tcv);
    const sameCl = !(p.cl > 0 && cur.cl > 0 && p.cl !== cur.cl);
    if (sameTcv && sameCl && p.aav_tiers.length) return { aav: p.aav_tiers[p.aav_tiers.length - 1], source: "prior_last_tier" };
  }
  if (cur.aav_tiers.length) return { aav: cur.aav_tiers[0], source: "token" };
  if (cur.tcv > 0 && cur.cl > 0) return { aav: Math.round(cur.tcv / cur.cl), source: "tcv_over_cl" };
  return null;
}

/**
 * Price ONE extension from the player's CURRENT contract.
 * @param input { position, yearsRemaining, salary, contractInfo, prior?, term ("1YR"|"2YR"|…), loaded ("NONE"), extLineage? }
 * @returns { ok:true, terms } | { ok:false, reason, detail }
 */
export function priceExtension(input) {
  const i = input || {};
  const no = (reason, detail) => ({ ok: false, reason, detail: detail || "" });
  const years = termYearsOf(i.term);
  if (!years) return no("bad_term", "The extension must be 1 or 2 years.");
  if (loadedOf(i.loaded) !== "NONE") return no("loaded_extension_unsupported", "A pre-trade extension is flat; a loaded (FL/BL) extension has no canonical price.");
  const sched = scheduleFor(i.position);
  if (!sched) return no("pricing_position_unavailable", "The player's position could not be established, so his schedule is unknown.");
  const cy = parseInt(s(i.yearsRemaining), 10);
  if (!Number.isFinite(cy)) return no("pricing_contract_unreadable", "The player's years remaining could not be read.");
  if (cy < 1) return no("expired_contract_not_priced", "An expired contract has no current-year salary to carry; its price needs the draft-slot salary schedule.");
  if (cy > 1) return no("not_final_year", "The player has more than one year left.");
  const salaryRaw = Number(String(i.salary == null ? "" : i.salary).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(salaryRaw) || salaryRaw <= 0) return no("pricing_salary_unreadable", "The player's current salary is blank or unreadable (blank is not $0).");
  const resolved = resolveCurrentAav({ contractInfo: i.contractInfo, yearsRemaining: cy, prior: i.prior });
  if (!resolved || !(resolved.aav > 0)) return no("pricing_aav_unavailable", "The contract has neither an AAV token nor a TCV and length to derive one from.");
  const aav = roundK(resolved.aav);
  const salary = Math.max(1000, roundK(salaryRaw));
  const raise = sched.raises[years];
  const future = Math.max(1000, roundK(aav + raise));
  const cl = 1 + years;
  const byYear = { 1: salary };
  for (let k = 0; k < years; k++) byYear[String(k + 2)] = future;
  const tcv = salary + future * years;
  const gtd = tcv > 4000 ? Math.round(tcv * 0.75) : Math.max(0, tcv - salary);
  const parts = [`CL ${cl}`, `TCV ${fk(tcv)}`, `AAV ${fk(aav)}, ${fk(future)}`, Object.keys(byYear).map((k) => `Y${k}-${fk(byYear[k])}`).join(", ")];
  const lineage = s(i.extLineage);
  if (lineage) parts.push(`Ext: ${lineage}`);
  parts.push(`GTD: ${fk(gtd)}`);
  return {
    ok: true,
    terms: {
      version: PRICING_VERSION,
      term: `${years}YR`, loaded: "NONE", extension_years: years,
      position_group: sched.group, schedule: sched.schedule, escalator: raise,
      salary_year1: salary, aav_current: aav, aav_source: resolved.source, aav_future: future,
      contract_length: cl, contract_year: cl, salary_by_year: byYear, tcv, gtd,
      status: `Vet-Ext${years}`,
      contract_info: parts.join("|"),
    },
  };
}

// ── the STORED terms of a request, and the comparison ─────────────────────────────────────────────────────────────────────────────────────
const num = (v) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[^\d.-]/g, "")); return Number.isFinite(n) ? n : null; };

/** Normalize the terms a stored extension request CLAIMS (from its fields and its preview string). Never trusts one to fill in the other silently. */
export function storedTerms(req) {
  const r = req || {};
  const info = parseContractInfo(r.preview_contract_info_string || r.contract_info || "");
  const optionKey = s(r.option_key || r.optionKey).toUpperCase();
  // the term is stated up to three ways (extension_term, option_key, status); they must agree — a request that says two different things is unreadable
  const termCandidates = [...new Set([termYearsOf(r.extension_term || r.extensionTerm || r.term), termYearsOf(optionKey), termYearsOf(r.new_contract_status || r.contract_status)].filter(Boolean))];
  const term = termCandidates.length === 1 ? termCandidates[0] : 0;
  const termConflict = termCandidates.length > 1;
  const loaded = loadedOf(r.loaded_indicator || (optionKey.includes("|") ? optionKey.split("|")[1] : "") || "NONE");
  const tiers = info.aav_tiers;
  const infoYears = Object.keys(info.years).length ? info.years : null;
  const fieldLen = num(r.new_contract_length ?? r.newContractLength);
  const fieldTcv = num(r.new_TCV ?? r.new_tcv ?? r.newTcv);
  const fieldFut = num(r.new_aav_future ?? r.newAavFuture);
  const fieldCur = num(r.new_aav_current ?? r.newAavCurrent);
  const fieldY1 = num(r.new_current_salary ?? r.newCurrentSalary);
  return {
    term: termConflict ? "CONFLICT" : term ? `${term}YR` : null, loaded,
    status_years: termYearsOf(r.new_contract_status || r.contract_status) || null,
    contract_length: fieldLen != null ? fieldLen : info.cl,
    salary_year1: fieldY1 != null ? fieldY1 : (infoYears ? infoYears["1"] ?? null : null),
    salary_by_year: infoYears,
    aav_current: fieldCur != null ? fieldCur : (tiers.length ? tiers[0] : null),
    aav_future: fieldFut != null ? fieldFut : (tiers.length > 1 ? tiers[tiers.length - 1] : null),
    tcv: fieldTcv != null ? fieldTcv : info.tcv,
    _info: { cl: info.cl, tcv: info.tcv, tiers, has_string: !!s(r.preview_contract_info_string || r.contract_info) },
    _fields: { length: fieldLen, tcv: fieldTcv, future: fieldFut, current: fieldCur, year1: fieldY1 },
  };
}

/**
 * Compare a request's stored terms with the canonical terms. Every difference is listed; ANY difference is a mismatch.
 * Compared: term, loaded treatment, status↔term, contract length, year-one salary, every year's salary, current AAV, extension-year AAV (escalator applied), TCV.
 */
export function compareTerms(stored, canonical) {
  const diffs = [];
  const eq = (field, a, b) => { if (a == null || a !== b) diffs.push({ field, stored: a == null ? null : a, canonical: b }); };
  eq("term", stored.term, canonical.term);
  eq("loaded", stored.loaded, canonical.loaded);
  if (stored.status_years != null) eq("status", stored.status_years, canonical.extension_years);
  eq("contract_length", stored.contract_length, canonical.contract_length);
  eq("salary_year1", stored.salary_year1, canonical.salary_year1);
  const cy = canonical.salary_by_year, sy = stored.salary_by_year;
  if (!sy) diffs.push({ field: "salary_by_year", stored: null, canonical: cy });
  else {
    const keys = new Set([...Object.keys(cy), ...Object.keys(sy)]);
    for (const k of [...keys].sort()) if (cy[k] !== sy[k]) diffs.push({ field: `salary_year_${k}`, stored: sy[k] ?? null, canonical: cy[k] ?? null });
  }
  eq("aav_current", stored.aav_current, canonical.aav_current);
  eq("aav_future", stored.aav_future, canonical.aav_future);
  eq("tcv", stored.tcv, canonical.tcv);
  // a request must also agree WITH ITSELF (its fields vs its preview string) — two different prices for one extension is never accepted
  const st = stored._info, f = stored._fields;
  if (f.tcv != null && st.tcv != null && f.tcv !== st.tcv) diffs.push({ field: "stored_inconsistent_tcv", stored: f.tcv, canonical: st.tcv });
  if (f.length != null && st.cl != null && f.length !== st.cl) diffs.push({ field: "stored_inconsistent_length", stored: f.length, canonical: st.cl });
  if (f.future != null && st.tiers.length > 1 && f.future !== st.tiers[st.tiers.length - 1]) diffs.push({ field: "stored_inconsistent_aav_future", stored: f.future, canonical: st.tiers[st.tiers.length - 1] });
  return { match: diffs.length === 0, diffs };
}

/** One-shot: price the request's player from `live` and compare — the single call every surface makes. */
export function checkExtensionRequest(req, live) {
  if (storedTerms(req).term === "CONFLICT") {
    return { ok: false, reason: "extension_terms_stale", detail: "The request states two different extension lengths.", diffs: [{ field: "term", stored: "conflict", canonical: null }], canonical: null, stored: storedTerms(req) };
  }
  const priced = priceExtension({
    position: live && live.position, yearsRemaining: live && live.yearsRemaining, salary: live && live.salary, contractInfo: live && live.contractInfo, prior: live && live.prior,
    term: storedTerms(req).term, loaded: storedTerms(req).loaded, extLineage: live && live.extLineage,
  });
  if (!priced.ok) return { ok: false, reason: priced.reason, detail: priced.detail, canonical: null };
  const stored = storedTerms(req);
  const cmp = compareTerms(stored, priced.terms);
  return cmp.match
    ? { ok: true, terms: priced.terms, stored }
    : { ok: false, reason: "extension_terms_stale", detail: "The extension's stored terms differ from the canonical price computed from the player's current contract.", diffs: cmp.diffs, canonical: priced.terms, stored };
}

/**
 * The BUILDER / PREVIEW feed: price every offered extension row from the holder's CURRENT contract with the same function everything else uses.
 * A row the worker cannot price (no roster asset, blank salary, prior-season contracts unreadable, unknown position, loaded request, …) is NOT offered.
 * @param rows  preview rows ({ player_id, franchise_id, extension_term, loaded_indicator, … })
 * @param assetsByFranchise  { fid: [ { type:"PLAYER", player_id, position, salary, years, contract_info, salary_blank } ] }
 * @param abbrevByFid  { fid: "PG" } (the league's franchise abbreviations; the `Ext:` lineage label)
 * @param prior  { playerId: { years, info } } last season's contracts, or null when unreadable (⇒ nothing is offered)
 */
export function canonicalizePreviewRows({ rows, assetsByFranchise, abbrevByFid, prior }) {
  const out = [];
  let dropped = 0;
  const digits = (v) => s(v).replace(/\D/g, "");
  const pad = (v) => { const d = digits(v); return d ? d.padStart(4, "0").slice(-4) : ""; };
  for (const row of Array.isArray(rows) ? rows : []) {
    const pid = digits(row && row.player_id), fid = pad(row && row.franchise_id);
    const list = (assetsByFranchise && assetsByFranchise[fid]) || [];
    const asset = list.find((a) => a && s(a.type).toUpperCase() === "PLAYER" && digits(a.player_id) === pid);
    if (!asset || !prior || asset.salary_blank) { dropped += 1; continue; }
    const abbrev = s(abbrevByFid && abbrevByFid[fid]);
    const priced = priceExtension({
      position: asset.position, yearsRemaining: asset.years, salary: asset.salary, contractInfo: asset.contract_info, prior: prior[pid] || null,
      term: row && row.extension_term, loaded: row && row.loaded_indicator,
      extLineage: lineageWithExtender(parseContractInfo(asset.contract_info).ext, abbrev === fid ? "" : abbrev),
    });
    if (!priced.ok) { dropped += 1; continue; }
    const c = priced.terms;
    out.push({
      ...row, new_contract_status: c.status, new_contract_length: c.contract_length, new_TCV: c.tcv, new_aav_current: c.aav_current, new_aav_future: c.aav_future,
      new_current_salary: c.salary_year1, new_contract_guarantee: c.gtd, preview_contract_info_string: c.contract_info, pricing_version: c.version, pricing_source: "canonical",
    });
  }
  return { rows: out, dropped };
}
