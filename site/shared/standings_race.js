/* standings_race.js — UPS "standings race" derived-value module.
   Phase II-A1 (see docs/league_context_v1.md §F.1/§F.2 for the seeding
   canon; the worker applies it — worker/src/seeding.js).

   Pure, browser-compatible, side-effect-free: payload in, derived values
   out. No DOM access, no fetch calls, no global application-state
   mutation — mirrors the site/shared/cap_math.js convention so desktop
   (site/standings/mfl_hpm_standings_v2.html) and mobile
   (site/m/views/league.js) can both load this one file instead of each
   growing their own copy of the same math.

   INPUT SHAPE — race(payload) expects an /api/standings response (or an
   equivalent object) with:
     rows          — resp.rows: each row carries playoff_seed,
                     playoff_status, is_division_leader, division,
                     franchise_id, franchise_name, h2h_w/l/t, h2h_pct,
                     allplay_pct and seed_reason (the worker's own
                     explanation of the seed — see whySeedForRow).
     weekly        — resp.weekly: per-matchup rows { w, fid, ts, opp, os,
                     div, po } (one row per franchise per PLAYED matchup).
                     null when the worker's query FAILED (it then also
                     sends weekly_errors) — never coerced to [] here.
     weeklyScores  — resp.weeklyScores: per-franchise-per-week rows
                     { w, fid, ts, opt, po } (includes playoff byes).
                     Same null-on-failure contract as weekly.
     preseason     — resp.preseason (boolean), passed through untouched.
     season_complete — resp.season_complete: until it is true the
                     bracket and draft picks are a PROJECTION (bracketFinal).
     standings_basis, regular_season — the current season's seeding basis
                     and regular-season status (through_week, complete,
                     problems, seed_by_week). Seeds and BYE/DIV/WC read "if
                     the season ended today" until regular_season.complete
                     (seedsFinal); "unavailable" means the worker seeded
                     nobody, and whySeed says why.

   F3 (binding everywhere weekly rows are read): "preseason" means the
   expected franchises' relevant input is genuinely empty; regular-season
   flags are exactly 0 / "0" / false and playoff flags exactly 1 / "1" /
   true; anything else on a relevant row — or a row that isn't an object or
   has no franchise id (it can't be shown to be another league's) — makes
   the result incomplete/unavailable, never preseason and never a guess.
   Rows of franchises not on rows[] are ignored. A null weekly/weeklyScores
   is a failed query ("unavailable"), never [].

   None of these fields are invented here — they are the exact field
   names the worker returns. This module does not fetch them and does not
   care how a caller obtained the object; it only reads what's already
   on it.

   SEEDING: this module never ranks, re-ranks or explains a seed by its
   own comparator. The worker seeds (worker/src/seeding.js — canon §F.1:
   All-Play % → Overall → season Points For → head-to-head, Keith
   2026-10-08) and says which step decided each team (row.seed_reason,
   Keith 2026-10-09: "the client never recreates the ladder"). Seasons
   with recorded final standings (2010–2025) are labeled as recorded
   and make no ladder claim.

   Loaded via window.UPS_STANDINGS_RACE — see site/m/index.html and
   site/standings/mfl_hpm_standings_v2.html for the <script> tags.
*/
(function (global) {
  'use strict';

  // ── small helpers ────────────────────────────────────────────────────
  function pad4(v) {
    var s = String(v == null ? '' : v);
    while (s.length < 4) s = '0' + s;
    return s;
  }
  function round1(n) { return Math.round(n * 10) / 10; }
  function isFiniteNum(n) { return typeof n === 'number' && isFinite(n); }
  // Explicit is_playoff normalization — never generic truthiness (which
  // would treat "0" as playoff, a real risk since JSON round-trips and
  // some callers pass string flags). Recognizes 0/"0"/false as regular
  // season and 1/"1"/true as playoff; anything else is ambiguous and
  // must NOT be guessed either way — the caller excludes it (fails
  // closed) rather than silently assuming regular season.
  function normalizePo(v) {
    if (v === 0 || v === '0' || v === false) return false;
    if (v === 1 || v === '1' || v === true) return true;
    return null;
  }
  // F3 rule vii: a weekly row we can read at all is a plain object with a franchise id. Anything else (null, a
  // string, an array, a row with no fid) can't be shown to belong to some OTHER franchise, so it is malformed —
  // never skipped as "foreign", and never allowed to leave the input looking empty (preseason).
  function isRowObject(r) { return r !== null && typeof r === 'object' && !Array.isArray(r); }
  function hasId(v) { return v != null && typeof v !== 'object' && typeof v !== 'boolean' && String(v).trim() !== ''; }
  // Strict number: null / '' / booleans / objects are NOT numbers here (Number(null) === 0 would be a false zero).
  function strictNum(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') return Number(v);
    return NaN;
  }
  function isWeekNum(w) { return Number.isInteger(w) && w >= 1; }
  function round2(n) { return Math.round(n * 100) / 100; }
  // Points as exact integer hundredths (MFL scores carry at most two decimals), so a sum or an average never depends
  // on floating-point summation order; ratio2(num, den) = num / den to two decimals from integers in ONE division,
  // halves rounded up (Math.round), the way the rest of the site rounds.
  function hundredths(x) { return Math.round(x * 100); }
  function ratio2(num, den) { return den ? Math.round((num * 100) / den) / 100 : null; }
  function hasOwn(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

  // ── 1. Status ────────────────────────────────────────────────────────
  // bye -> BYE, division_winner -> DIV, wild_card -> WC, everything else
  // (non_playoff / missing / unknown) -> null. Never OUT — elimination
  // can't be computed without remaining-schedule data. Reads
  // playoff_status directly; never infers status from seed number alone.
  var STATUS_MAP = { bye: 'BYE', division_winner: 'DIV', wild_card: 'WC' };
  // A RECORDED (finished) season's playoff_status/playoff_seed on /api/standings are a recompute under today's
  // rule, not the recorded seeds (wrong in 14 of 16 seasons, #1329), so no status is claimed for them.
  function isRecordedRow(row) { return !!(row && row.seed_reason && row.seed_reason.basis === 'recorded_final_standings'); }
  function statusForRow(row) {
    if (isRecordedRow(row)) return null;
    var st = row && row.playoff_status;
    return STATUS_MAP.hasOwnProperty(st) ? STATUS_MAP[st] : null;
  }

  // ── shared AP-record helpers ─────────────────────────────────────────
  // Derives the WHOLE league's regular-season AP table in one pass, and
  // reports a status any caller can act on truthfully instead of a bare
  // record. This exists because per-franchise derivation (the previous
  // design) could accept a franchise that was present in some regular-
  // season weeks but silently missing from another — a confident partial
  // record built from an incomplete dataset. That is no longer possible:
  // completeness is checked WEEK BY WEEK against the full expected
  // franchise population (every franchise on the payload's own rows[],
  // NOT just the union of whatever happens to appear in weeklyScores —
  // a franchise missing from every week must still count as "expected
  // but absent", not silently drop out of the population).
  //
  // expectedFids: array of franchise_id values (any padding) — always
  // pass `rows.map(r => r.franchise_id)`, i.e. the FULL league's rows,
  // even when the caller only cares about a subset (one division, one
  // team) — using a narrower "expected" set would make weeks look
  // "incomplete" just because other franchises' scores are present.
  //
  // Returns { status, byFid }:
  //   'ok'         — every regular-season week has exactly one valid
  //                  score for every expected franchise. byFid is a
  //                  complete { fid: {w,l,t} } map.
  //   'preseason'  — GENUINELY zero relevant rows anywhere in the payload
  //                  (relevant = franchise_id is one of the expected
  //                  population). A true zero record for every team
  //                  (byFid: {}, the caller applies {w:0,l:0,t:0} — see
  //                  resolveApRecordWithTable). This is NOT the same as
  //                  "zero regular-season weeks survived filtering" — a
  //                  payload that has relevant rows but they were all
  //                  playoff-only, or had an unrecognized `po` value, is
  //                  NOT preseason (see 'incomplete' below); nobody has
  //                  played yet is the ONLY thing 'preseason' means.
  //   'incomplete' — fail-closed catch-all for anything short of a fully
  //                  trustworthy regular-season table: (a) at least one
  //                  relevant row has an unrecognized `po` value (not
  //                  cleanly 0/"0"/false/1/"1"/true) — checked BEFORE and
  //                  INDEPENDENTLY of the completeness scan below, so a
  //                  malformed row can never be "rescued" by every other
  //                  franchise still technically participating that week;
  //                  (b) relevant rows existed but zero of them survived
  //                  as valid regular-season weeks (e.g. every relevant
  //                  row was legitimately playoff-only — a real, non-
  //                  malformed state, but still not "nobody has played");
  //                  (c) at least one populated regular-season week is
  //                  missing a valid score for at least one expected
  //                  franchise. In every case byFid is null for EVERY
  //                  franchise — a partial/untrustworthy dataset can't be
  //                  trusted for anyone, not just the franchise it's
  //                  short on.
  //   'conflict'   — the same (week, franchise_id) key appears twice
  //                  with two DIFFERENT scores anywhere in the payload.
  //                  Identical duplicates are safe and deduped; this is
  //                  an unresolvable disagreement, so — like 'incomplete'
  //                  — nobody gets a derived record from this dataset.
  //                  Order-independent: which duplicate row arrived
  //                  first never affects the outcome.
  // A relevant regular-season row with an unreadable week or score (null,
  // '', NaN — never Number(null) === 0) makes the table 'incomplete': it
  // can't silently become a false zero, nor be dropped while the other
  // rows still look complete. So does a row that isn't an object or has no
  // fid (F3 rule vii — it can't be shown to be foreign, so an input of only
  // such rows is never 'preseason'). A row for a franchise NOT in the expected population
  // (a "foreign" row) is simply ignored — including a malformed `po` on
  // a foreign row, which must never poison this league's own table.
  function deriveRegSeasonApTable(weeklyScores, expectedFids) {
    // A FAILED query reaches here as null (the worker never sends it as []) — that is "we couldn't read it", not
    // "nobody has played": incomplete, never preseason.
    if (!Array.isArray(weeklyScores)) return { status: 'incomplete', byFid: null, unreadable: true };
    var expected = {};
    (Array.isArray(expectedFids) ? expectedFids : []).forEach(function (fid) {
      if (fid != null) expected[pad4(fid)] = true;
    });
    var expectedList = Object.keys(expected);
    var byWeek = {};        // week -> { fid: score }
    var conflictWeeks = {}; // week -> true
    var sawAnyRelevantRow = false;
    var sawUnrecognizedPo = false;
    var sawMalformedRow = false;
    weeklyScores.forEach(function (r) {
      if (!isRowObject(r) || !hasId(r.fid)) { sawMalformedRow = true; return; } // F3 rule vii — can't be shown to be foreign
      var fid = pad4(r.fid);
      if (!expected.hasOwnProperty(fid)) return; // foreign franchise — irrelevant, never poisons this table
      sawAnyRelevantRow = true;
      var isPo = normalizePo(r.po);
      if (isPo === null) { sawUnrecognizedPo = true; return; } // fail closed — never guessed as regular season
      if (isPo === true) return; // valid, explicit playoff — excluded, not an error
      var w = strictNum(r.w);
      var ts = strictNum(r.ts);
      if (!isWeekNum(w) || !isFiniteNum(ts)) { sawMalformedRow = true; return; } // unreadable week/score: never absent-and-forgotten, never a 0
      var bucket = byWeek[w] || (byWeek[w] = {});
      if (bucket.hasOwnProperty(fid) && bucket[fid] !== ts) conflictWeeks[w] = true;
      bucket[fid] = ts; // identical duplicates are idempotent; a real conflict is flagged above and invalidates the whole table below
    });
    if (sawMalformedRow) return { status: 'incomplete', byFid: null };
    if (!sawAnyRelevantRow) return { status: 'preseason', byFid: {} };
    if (sawUnrecognizedPo) return { status: 'incomplete', byFid: null };
    var weeks = Object.keys(byWeek);
    if (Object.keys(conflictWeeks).length) return { status: 'conflict', byFid: null };
    if (!weeks.length) return { status: 'incomplete', byFid: null }; // relevant rows existed (e.g. playoff-only) but zero usable regular-season weeks — not the same as nobody having played
    var incomplete = weeks.some(function (w) {
      var bucket = byWeek[w];
      var fids = Object.keys(bucket);
      if (fids.length !== expectedList.length) return true;
      return fids.some(function (fid) { return !expected.hasOwnProperty(fid); });
    });
    if (incomplete) return { status: 'incomplete', byFid: null };
    var byFid = {};
    expectedList.forEach(function (fid) { byFid[fid] = { w: 0, l: 0, t: 0 }; });
    weeks.forEach(function (w) {
      var bucket = byWeek[w];
      var fids = Object.keys(bucket);
      fids.forEach(function (fid) {
        var myScore = bucket[fid];
        fids.forEach(function (other) {
          if (other === fid) return;
          var otherScore = bucket[other];
          if (myScore > otherScore) byFid[fid].w++;
          else if (myScore < otherScore) byFid[fid].l++;
          else byFid[fid].t++;
        });
      });
    });
    return { status: 'ok', byFid: byFid };
  }
  // Resolves ONE row's AP record against an already-derived table,
  // applying tiers 1-2 first (seed_ap, then allplay_regseason_*) before
  // ever consulting the table (tier 3). This is the shared resolver
  // apGamesBack/divisionRace/luckForRow/expectedWinsForRow all call so a
  // 'conflict' or 'incomplete' table status is applied identically to
  // every franchise in one race() pass — never computed (and never
  // capable of disagreeing) per franchise.
  function resolveApRecordWithTable(row, apTable) {
    if (!row) return null;
    // Tier 0 — the worker's own regular-season All-Play record (current season, /api/standings rows[].regular_season).
    var rsAp = row.regular_season && row.regular_season.all_play;
    if (rsAp && typeof rsAp === 'object' && apFraction(rsAp)) return { w: Number(rsAp.w), l: Number(rsAp.l), t: Number(rsAp.t) };
    if (row.seed_ap && typeof row.seed_ap === 'object' && apFraction(row.seed_ap)) return row.seed_ap;
    if (row.allplay_regseason_w != null || row.allplay_regseason_l != null || row.allplay_regseason_t != null) {
      var rsRec = { w: row.allplay_regseason_w, l: row.allplay_regseason_l, t: row.allplay_regseason_t };
      if (apFraction(rsRec)) return rsRec;
    }
    if (!apTable) return null;
    if (apTable.status === 'preseason') return { w: 0, l: 0, t: 0 };
    if (apTable.status !== 'ok') return null; // 'incomplete' / 'conflict' -> fail closed, never a false zero
    var fid = pad4(row.franchise_id);
    return apTable.byFid.hasOwnProperty(fid) ? apTable.byFid[fid] : null;
  }
  // Public convenience wrapper — derives the table itself from raw
  // weeklyScores + expectedFids, then resolves one row. Callers that
  // need MANY rows against the same weeklyScores (apGamesBack,
  // divisionRace) derive the table once themselves instead of calling
  // this per row, for both efficiency and to guarantee every row in one
  // call sees the identical table/status.
  //
  // See the module header for the required hierarchy: NEVER falls back
  // to allplay_w/l/t, allplay_full_*, allplay_historical_*, or any
  // rounded allplay_pct — those are full-season-inclusive-of-playoffs
  // once a season reaches its playoff weeks (the 2022 Good in Da
  // Hood/Pure Greatness contamination: an exact full-season AP tie at
  // 127-60 that was NOT a tie through the real regular-season cutoff,
  // 114-40 vs 109-45).
  function apRecordForRow(row, weeklyScores, expectedFids) {
    var apTable = deriveRegSeasonApTable(weeklyScores, expectedFids);
    return resolveApRecordWithTable(row, apTable);
  }
  // AP wins-equivalent = w + 0.5t. Returns null for a missing/invalid record
  // (never throws — negative/non-numeric fields just fail the finite check).
  function apWinsEquiv(rec) {
    if (!rec) return null;
    var w = Number(rec.w), l = Number(rec.l), t = Number(rec.t);
    if (!isFiniteNum(w) || !isFiniteNum(l) || !isFiniteNum(t)) return null;
    return w + 0.5 * t;
  }
  // Exact AP fraction {num, den} for cross-multiplication comparison —
  // never float division. Rejects fractional/negative/non-integer w/l/t
  // as invalid (returns null), matching upsSeedTiebreak's apRecord guard.
  function apFraction(rec) {
    if (!rec || typeof rec !== 'object') return null;
    var w = Number(rec.w), l = Number(rec.l), t = Number(rec.t);
    if (!Number.isInteger(w) || !Number.isInteger(l) || !Number.isInteger(t) || w < 0 || l < 0 || t < 0) return null;
    var n = w + l + t;
    return { num: 2 * w + t, den: Math.max(2 * n, 1) };
  }
  function apPctFromRecord(rec) {
    var wins = apWinsEquiv(rec);
    if (wins == null) return null;
    var n = Number(rec.w || 0) + Number(rec.l || 0) + Number(rec.t || 0);
    return n > 0 ? wins / n : 0;
  }

  // ── 2. AP games back ("WC Back") ─────────────────────────────────────
  // apGB per franchise_id relative to the LAST WILD CARD's REGULAR-SEASON-
  // ONLY AP wins-equivalent (apRecordForRow's 3-tier hierarchy — never a
  // full-season field). A team outside the field is chasing the last wild
  // card, never a division winner: the four division winners are protected,
  // so the 6th seed is the wrong yardstick whenever it is a division winner
  // (#1329, 2026 Week 6: Hawks showed -1 against Real Deal Creel). Seeds 1-6
  // -> 0 unconditionally (a structural fact of their seed, not an AP
  // computation). Everyone else -> max(0, lastWildCardWins - myWins), or
  // null if either side's regular-season AP can't be resolved (no wild-card
  // row / incomplete weekly data) — never a value computed from
  // contaminated full-season data.
  // The WORKER's figure wins whenever the row carries one: rows[].ap_back
  // (All-Play wins behind the last wild card, ties count half — current
  // season only; null for seeds 1-6). A negative value can't come from the
  // ladder; if one ever arrives (a worker older than this rule) it reads as
  // unavailable (null), never as a number. The module's own arithmetic below
  // runs only for a response without ap_back (recorded seasons, older
  // workers), and nothing is ever re-ordered by either.
  function apGamesBack(rows, weeklyScores) {
    var list = Array.isArray(rows) ? rows : [];
    var out = {};
    // Recorded seasons: "behind the 6th seed" would use the recompute's 6th seed (see isRecordedRow) -- unavailable.
    if (list.some(isRecordedRow)) {
      list.forEach(function (r) { if (isRowObject(r)) out[pad4(r.franchise_id)] = null; });
      return out;
    }
    var allWorker = list.length > 0 && list.every(function (r) { return !isRowObject(r) || hasOwn(r, 'ap_back'); });
    if (allWorker) {
      list.forEach(function (r) {
        if (!isRowObject(r)) return;
        var seed = Number(r.playoff_seed);
        var fid = pad4(r.franchise_id);
        if (seed >= 1 && seed <= 6) { out[fid] = 0; return; }
        var v = (r.ap_back === null) ? NaN : strictNum(r.ap_back);
        out[fid] = isFiniteNum(v) && v >= 0 ? v : null;
      });
      return out;
    }
    // The last wild card: the wild-card row with the lowest seed (seeds 3-6). No identifiable wild card -> unavailable.
    var cutRow = null;
    for (var i = 0; i < list.length; i++) {
      var cand = list[i];
      if (!cand || statusForRow(cand) !== 'WC') continue;
      var cs = Number(cand.playoff_seed);
      if (cs >= 3 && cs <= 6 && (!cutRow || cs > Number(cutRow.playoff_seed))) cutRow = cand;
    }
    if (!cutRow) {
      list.forEach(function (r) { if (r) out[pad4(r.franchise_id)] = null; });
      return out;
    }
    // One shared table for every row in this call — a 'conflict' or
    // 'incomplete' status is never computed (and can never disagree)
    // per franchise; it applies identically to the whole league.
    var apTable = deriveRegSeasonApTable(weeklyScores, list.map(function (r) { return r && r.franchise_id; }));
    var cutWins = apWinsEquiv(resolveApRecordWithTable(cutRow, apTable));
    list.forEach(function (r) {
      if (!r) return;
      var fid = pad4(r.franchise_id);
      var seed = Number(r.playoff_seed);
      if (seed >= 1 && seed <= 6) { out[fid] = 0; return; }
      var wins = apWinsEquiv(resolveApRecordWithTable(r, apTable));
      if (cutWins == null || wins == null) { out[fid] = null; return; }
      out[fid] = Math.max(0, round1(cutWins - wins));
    });
    return out;
  }

  // ── 3. Luck ──────────────────────────────────────────────────────────
  // Exact REGULAR-SEASON-ONLY Overall table for the WHOLE league, derived
  // once from weekly[] and reused by every franchise (mirrors
  // deriveRegSeasonApTable's shared-table design — a data problem in one
  // week can never be computed, or disagreed about, per franchise).
  //
  // weekly[] rows are { w, fid, ts, opp, os, div, po } — one row PER SIDE
  // of a scheduled matchup (src_schedule), so a single game between A and
  // B in week W produces TWO rows: (w, A, ts:X, opp:B, os:Y) and
  // (w, B, ts:Y, opp:A, os:X). This league has genuine multi-opponent
  // weeks (verified against live 2020 data — a franchise can have 2+ rows
  // in the same week, each against a DIFFERENT opponent), so the natural
  // unique identity for one matchup entry is (week, franchise_id,
  // opponent_id) — NOT (week, franchise_id) — matching Fable's identified
  // key. Two rows sharing (week, fid, opp) are the same matchup slot
  // reported twice: identical scores dedupe safely; different scores are
  // a conflict.
  //
  // Two independent completeness checks run per regular-season week:
  //   1. RECIPROCITY — for every entry (w, fid, opp, ts, os) there must be
  //      a matching reciprocal entry (w, opp, fid, os, ts) with score and
  //      opponent-score swapped. A present-but-disagreeing reciprocal is a
  //      CONFLICT (contradictory data); an entirely missing reciprocal is
  //      INCOMPLETE (one side of a real matchup silently absent — this is
  //      exactly "one matchup missing during a multi-opponent week": if
  //      team A's row for its game against B exists but B's own row for
  //      that same game is missing, A's entry has no reciprocal).
  //   2. PARTICIPATION — every expected franchise (from the full payload
  //      rows[], not just whoever appears in weekly[]) must appear as
  //      `fid` in at least one entry that week. Catches a franchise
  //      missing from an ENTIRE week outright.
  //   KNOWN LIMITATION (no fix invents an expected matchup count without
  //   payload evidence): if a franchise's ENTIRE second matchup of a
  //   multi-opponent week is dropped from BOTH sides at once (its own row
  //   AND its opponent's row for that one pairing), and the franchise
  //   still participates via its other matchup that week, neither check
  //   can detect the hole — there is no orphaned row and no schedule
  //   metadata in this payload stating how many opponents a franchise
  //   should have in a given week. Reciprocity + participation are the
  //   strongest schedule-aware checks this payload supports.
  // Returns { status, byFid } with the SAME status vocabulary and the
  // SAME fail-closed rules as deriveRegSeasonApTable (see its header
  // comment for the full rationale): 'ok' (complete map); 'preseason'
  // ONLY when there are zero rows for the expected population at all —
  // {0,0,0} is the true state for everyone; 'incomplete' for anything
  // short of trustworthy — an unrecognized `po` value on a relevant row
  // (checked first, independent of and never rescued by the
  // participation check below), relevant rows that were all legitimately
  // playoff-only (not "nobody has played"), or missing/short weekly data;
  // 'conflict' for contradictory data. 'incomplete' and 'conflict' both
  // resolve to byFid: null for EVERY franchise, never a partial map.
  // RELEVANT here means the row involves the expected population on
  // either side — its franchise OR its opponent — because a row whose
  // opponent is expected describes that expected franchise's game: it
  // counts against 'preseason' and its `po` is checked like any other
  // (only expected franchises' own rows ever enter the table). A row
  // with NEITHER side expected is unrelated and ignored entirely,
  // including any malformed `po` it carries.
  function deriveRegSeasonOverallTable(weekly, expectedFids) {
    // A FAILED query (null) is incomplete, never preseason — see deriveRegSeasonApTable.
    if (!Array.isArray(weekly)) return { status: 'incomplete', byFid: null, unreadable: true };
    var expected = {};
    (Array.isArray(expectedFids) ? expectedFids : []).forEach(function (fid) {
      if (fid != null) expected[pad4(fid)] = true;
    });
    var expectedList = Object.keys(expected);
    var byWeek = {};        // week -> { "fid|opp": {fid, opp, ts, os} }
    var conflictWeeks = {}; // week -> true (disagreeing duplicate OR disagreeing reciprocal)
    var sawAnyRelevantRow = false;
    var sawUnrecognizedPo = false;
    var sawMalformedRow = false;
    weekly.forEach(function (m) {
      if (!isRowObject(m) || !hasId(m.fid) || !hasId(m.opp)) { sawMalformedRow = true; return; } // F3 rule vii — can't be shown to be unrelated
      var fid = pad4(m.fid);
      var opp = pad4(m.opp);
      if (!expected.hasOwnProperty(fid) && !expected.hasOwnProperty(opp)) return; // neither side expected — unrelated, never poisons this table
      sawAnyRelevantRow = true; // involves an expected franchise (as fid OR opp) — this payload is not "nobody has played"
      var isPo = normalizePo(m.po);
      if (isPo === null) { sawUnrecognizedPo = true; return; } // fail closed — never guessed as regular season
      if (isPo === true) return; // valid, explicit playoff — excluded, not an error
      if (!expected.hasOwnProperty(fid)) return; // the foreign side of an expected franchise's game — only expected franchises' own rows enter the table
      var w = strictNum(m.w);
      var ts = strictNum(m.ts), os = strictNum(m.os);
      if (!isWeekNum(w) || !isFiniteNum(ts) || !isFiniteNum(os)) { sawMalformedRow = true; return; } // unreadable week/score: never dropped, never zero
      var key = fid + '|' + opp;
      var bucket = byWeek[w] || (byWeek[w] = {});
      if (bucket.hasOwnProperty(key)) {
        if (bucket[key].ts !== ts || bucket[key].os !== os) conflictWeeks[w] = true;
        // identical duplicate -> idempotent, no-op
      } else {
        bucket[key] = { fid: fid, opp: opp, ts: ts, os: os };
      }
    });
    if (sawMalformedRow) return { status: 'incomplete', byFid: null };
    if (!sawAnyRelevantRow) return { status: 'preseason', byFid: {} };
    if (sawUnrecognizedPo) return { status: 'incomplete', byFid: null };
    var weeks = Object.keys(byWeek);
    if (!weeks.length) return { status: 'incomplete', byFid: null }; // relevant rows existed (e.g. playoff-only) but zero usable regular-season weeks
    var incompleteWeeks = {};
    weeks.forEach(function (w) {
      var bucket = byWeek[w];
      var participants = {};
      Object.keys(bucket).forEach(function (key) {
        var entry = bucket[key];
        participants[entry.fid] = true;
        var recip = bucket[entry.opp + '|' + entry.fid];
        if (!recip) { incompleteWeeks[w] = true; return; }
        if (recip.ts !== entry.os || recip.os !== entry.ts) conflictWeeks[w] = true;
      });
      if (expectedList.some(function (fid) { return !participants.hasOwnProperty(fid); })) incompleteWeeks[w] = true;
    });
    if (Object.keys(conflictWeeks).length) return { status: 'conflict', byFid: null };
    if (Object.keys(incompleteWeeks).length) return { status: 'incomplete', byFid: null };
    var byFid = {};
    expectedList.forEach(function (fid) { byFid[fid] = { w: 0, l: 0, t: 0 }; });
    weeks.forEach(function (w) {
      var bucket = byWeek[w];
      Object.keys(bucket).forEach(function (key) {
        var entry = bucket[key];
        if (!byFid.hasOwnProperty(entry.fid)) return;
        if (entry.ts > entry.os) byFid[entry.fid].w++;
        else if (entry.ts < entry.os) byFid[entry.fid].l++;
        else byFid[entry.fid].t++;
      });
    });
    return { status: 'ok', byFid: byFid };
  }
  // Resolves ONE row's exact regular-season Overall record against an
  // already-derived table — the Overall-side counterpart to
  // resolveApRecordWithTable. There is no seed_ap-equivalent authoritative
  // Phase I W/L/T field to check first (only seed_ov_pct, a PERCENTAGE —
  // see luckForRow, which uses it as a percentage-only fallback, never
  // here as a record).
  function resolveOverallRecordWithTable(row, overallTable) {
    if (!row || !overallTable) return null;
    if (overallTable.status === 'preseason') return { w: 0, l: 0, t: 0 };
    if (overallTable.status !== 'ok') return null; // 'incomplete' / 'conflict' -> fail closed
    var fid = pad4(row.franchise_id);
    return overallTable.byFid.hasOwnProperty(fid) ? overallTable.byFid[fid] : null;
  }
  // luck = regular-season Overall win% - regular-season All-Play%. Both
  // sides resolve through their own shared, once-per-race() table (apTable
  // / overallTable — computed once in race() and reused for every
  // franchise, never re-derived or independently recomputed per row) —
  // never the display h2h_pct/allplay_pct fields, which are NOT
  // playoff-filtered once a season reaches its playoff weeks (see
  // apRecordForRow's header comment on the 2022 contamination lesson —
  // the identical mixed-scope bug applied to Luck before this fix).
  //   AP%:      resolveApRecordWithTable(row, apTable)
  //             (seed_ap -> allplay_regseason_* -> derived from weeklyScores).
  //   Overall%: resolveOverallRecordWithTable(row, overallTable) — falls
  //             back to the authoritative Phase I seed_ov_pct ONLY when
  //             the exact record can't be derived, and ONLY as a
  //             percentage (never to manufacture a W/L/T record or a game
  //             count — see expectedWinsForRow).
  // Returns null (never a fabricated 0) whenever either side can't be
  // resolved truthfully — the UI shows an em dash, never tints it, and it
  // sorts last in both directions (mfl_hpm_standings_v2.html's generic
  // null-always-last sortRows()).
  var LUCK_TOOLTIP = 'Regular-season Overall win percentage minus regular-season All-Play percentage. Positive means the schedule has helped; negative means it has hurt.';
  function luckForRow(row, overallTable, apTable) {
    if (!row) return null;
    var apPct = apPctFromRecord(resolveApRecordWithTable(row, apTable));
    var overallRec = resolveOverallRecordWithTable(row, overallTable);
    var overallPct = overallRec ? apPctFromRecord(overallRec) : null;
    if (overallPct == null) {
      var seedOv = Number(row.seed_ov_pct);
      if (isFiniteNum(seedOv)) overallPct = seedOv;
    }
    if (apPct == null || overallPct == null) return null;
    return overallPct - apPct;
  }
  // expectedWins = regular-season AP% * total regular-season Overall
  // games, rounded to 1 decimal. Requires the EXACT derived Overall
  // record (for the game count) — the seed_ov_pct fallback that can
  // rescue luckForRow's percentage can never supply a game count, so
  // expectedWins is null in that case rather than inventing one.
  function expectedWinsForRow(row, overallTable, apTable) {
    if (!row) return null;
    var apPct = apPctFromRecord(resolveApRecordWithTable(row, apTable));
    var overallRec = resolveOverallRecordWithTable(row, overallTable);
    if (apPct == null || !overallRec) return null;
    var games = overallRec.w + overallRec.l + overallRec.t;
    return round1(apPct * games);
  }

  // ── 4/5. Recent form + weekly AP rank ───────────────────────────────
  function resultForMatchup(m) {
    if (m.ts > m.os) return 'W';
    if (m.ts < m.os) return 'L';
    return 'T';
  }
  // Last-5 (and last-3) regular-season W/L/T for one franchise, in
  // chronological order. Reads the `po` (is_playoff) flag on each weekly[]
  // row rather than guessing from week number. Multi-opponent weeks each
  // contribute their own result (no de-dup by week). Sort is by week,
  // then original array position (stable) as a tiebreak.
  // null weekly (a failed query) → { last5: null, last3: null }: unknown, never "no games yet". F3: a row whose
  // playoff flag isn't a clean 0/1 on this franchise's game (either side), or a row that can't be read at all
  // (not an object / no fid / no opp — it can't be shown to be someone else's game), makes the form unavailable
  // (null) — never guessed as regular season, never silently left out.
  var FORM_UNAVAILABLE = function () { return { last5: null, last3: null }; };
  function formForFranchise(weekly, fid) {
    if (!Array.isArray(weekly)) return FORM_UNAVAILABLE();
    var padded = pad4(fid);
    var list = [];
    for (var i = 0; i < weekly.length; i++) {
      var m = weekly[i];
      if (!isRowObject(m) || !hasId(m.fid) || !hasId(m.opp)) return FORM_UNAVAILABLE();
      var mine = pad4(m.fid) === padded;
      if (!mine && pad4(m.opp) !== padded) continue; // another franchise's game
      var formPo = normalizePo(m.po);
      if (formPo === null) return FORM_UNAVAILABLE();
      if (!mine || formPo) continue; // the opponent's side of the game, or a playoff game
      var w = strictNum(m.w), ts = strictNum(m.ts), os = strictNum(m.os);
      if (!isWeekNum(w) || !isFiniteNum(ts) || !isFiniteNum(os)) return FORM_UNAVAILABLE();
      list.push({ m: { w: w, ts: ts, os: os }, i: list.length });
    }
    list.sort(function (a, b) { return (a.m.w - b.m.w) || (a.i - b.i); });
    var results = list.map(function (x) { return resultForMatchup(x.m); });
    return { last5: results.slice(-5), last3: results.slice(-3) };
  }

  // Per-week AP rank (1 = highest score, ties share the better/lower
  // rank number — "1224" competition ranking) computed from
  // weeklyScores[] (already one row per franchise/week; de-duplicated
  // defensively below by (week, fid) in case a payload ever isn't).
  // Returns { maxWeek, byFranchise: { fid: { <week>: {rank, playoff} } } }.
  // A week absent from a franchise's map is simply unplayed/missing.
  // expectedFids (optional, race() passes the payload's rows): rows of any
  // other franchise are ignored. Returns null — the strip is unavailable,
  // never guessed — for a failed query (null), a row that can't be read
  // (not an object / no fid), or a relevant row whose playoff flag is not a
  // clean 0/"0"/false or 1/"1"/true (normalizePo; "0" is NOT a playoff week).
  function weeklyApRank(weeklyScores, expectedFids) {
    if (!Array.isArray(weeklyScores)) return null;
    var expected = null;
    if (Array.isArray(expectedFids)) {
      expected = {};
      expectedFids.forEach(function (f) { if (hasId(f)) expected[pad4(f)] = true; });
    }
    var byWeek = {};
    var maxWeek = 0;
    for (var i = 0; i < weeklyScores.length; i++) {
      var r = weeklyScores[i];
      if (!isRowObject(r) || !hasId(r.fid)) return null;
      var fid = pad4(r.fid);
      if (expected && !expected.hasOwnProperty(fid)) continue; // another league's row
      var rankPo = normalizePo(r.po);
      if (rankPo === null) return null;
      var w = strictNum(r.w), ts = strictNum(r.ts);
      if (!isWeekNum(w) || !isFiniteNum(ts)) return null;
      if (w > maxWeek) maxWeek = w;
      (byWeek[w] = byWeek[w] || {})[fid] = { ts: ts, po: rankPo }; // last occurrence wins (de-dupe)
    }
    var byFranchise = {};
    Object.keys(byWeek).forEach(function (wKey) {
      var w = Number(wKey);
      var bucket = byWeek[wKey];
      var entries = Object.keys(bucket).map(function (fid) {
        return { fid: fid, ts: bucket[fid].ts, po: bucket[fid].po };
      });
      entries.sort(function (a, b) { return b.ts - a.ts; });
      var rank = 1;
      entries.forEach(function (e, i) {
        if (i > 0 && e.ts < entries[i - 1].ts) rank = i + 1; // ties share the better rank
        var slot = byFranchise[e.fid] || (byFranchise[e.fid] = {});
        slot[w] = { rank: rank, playoff: e.po };
      });
    });
    return { maxWeek: maxWeek, byFranchise: byFranchise };
  }

  // ── 6. Game log ──────────────────────────────────────────────────────
  // Full season (regular + playoff, each row flagged) for one franchise,
  // chronological. Opponent name resolved from rows[] using the
  // season-correct identity already on the payload.
  // null (unavailable, never an empty or guessed log) for a failed query, a
  // row that can't be read (not an object / no fid / no opp), or a row of
  // this franchise's games (either side) whose playoff flag isn't clean.
  function gameLogForFranchise(weekly, rows, fid) {
    if (!Array.isArray(weekly)) return null; // unreadable, never an empty log
    var padded = pad4(fid);
    var nameByFid = {};
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      if (r) nameByFid[pad4(r.franchise_id)] = r.franchise_name || ('Franchise ' + pad4(r.franchise_id));
    });
    var list = [];
    for (var i = 0; i < weekly.length; i++) {
      var m = weekly[i];
      if (!isRowObject(m) || !hasId(m.fid) || !hasId(m.opp)) return null;
      var mine = pad4(m.fid) === padded;
      if (!mine && pad4(m.opp) !== padded) continue;
      var logPo = normalizePo(m.po);
      if (logPo === null) return null;
      if (!mine) continue;
      var w = strictNum(m.w), ts = strictNum(m.ts), os = strictNum(m.os);
      if (!isWeekNum(w) || !isFiniteNum(ts) || !isFiniteNum(os)) return null;
      list.push({ m: { w: w, opp: m.opp, ts: ts, os: os, po: logPo }, i: list.length });
    }
    list.sort(function (a, b) { return (a.m.w - b.m.w) || (a.i - b.i); });
    return list.map(function (x) {
      var m = x.m;
      var oppFid = pad4(m.opp);
      return {
        week: m.w,
        opponent_franchise_id: oppFid,
        opponent_name: nameByFid[oppFid] || ('Franchise ' + oppFid),
        team_score: m.ts,
        opponent_score: m.os,
        result: resultForMatchup(m),
        is_playoff: m.po
      };
    });
  }

  // ── division race (backs A4's "Division race" disclosure block) ─────
  // Every team in `division`, with Overall record, REGULAR-SEASON-ONLY AP
  // record/% (apRecordForRow's 3-tier hierarchy), and AP GB to the
  // division leader (row.is_division_leader — the worker's own
  // MFL-standingsSort-based flag, same one used for the 👑/leader-pill
  // badges elsewhere). Never hardcodes a team count.
  // ORDER is the worker's: its division order (rows[].division_rank, MFL
  // standingsSort) when every team in the division carries one, otherwise
  // the order of rows[] as sent. Never re-sorted by games back — a page
  // must not re-sort this list either.
  //   games_back — the worker's division_games_back (Overall-record games
  //                behind the division leader) when the row carries it, else
  //                null. This is the division race's own measure.
  //   ap_gb      — All-Play wins behind the division leader (descriptive;
  //                max 0). Uses the worker's regular-season All-Play record
  //                when the row carries one (resolveApRecordWithTable tier 0).
  //   overall    — the worker's regular-season record when the row carries
  //                regular_season.record (src_standings totals include playoff
  //                weeks once they are played), else the h2h_* totals.
  function divisionRace(rows, division, weeklyScores) {
    var allRows = Array.isArray(rows) ? rows : [];
    var list = allRows.filter(function (r) {
      return isRowObject(r) && division != null && String(r.division) === String(division);
    });
    var ranked = list.length > 0 && list.every(function (r) { return r.division_rank != null && Number.isInteger(strictNum(r.division_rank)); });
    if (ranked) {
      list = list.map(function (r, i) { return { r: r, i: i }; })
        .sort(function (a, b) { return (strictNum(a.r.division_rank) - strictNum(b.r.division_rank)) || (a.i - b.i); })
        .map(function (x) { return x.r; });
    }
    // The expected population for completeness-checking is the FULL
    // league (every franchise on `rows`), never just this division —
    // otherwise every week would look "incomplete" merely because the
    // other 9+ franchises' scores are present in the same weekly bucket.
    var apTable = deriveRegSeasonApTable(weeklyScores, allRows.map(function (r) { return r && r.franchise_id; }));
    var leader = null;
    for (var i = 0; i < list.length; i++) { if (list[i].is_division_leader) { leader = list[i]; break; } }
    var leaderWins = leader ? apWinsEquiv(resolveApRecordWithTable(leader, apTable)) : null;
    var entries = list.map(function (r) {
      var rec = resolveApRecordWithTable(r, apTable);
      var wins = apWinsEquiv(rec);
      var gb = (leaderWins != null && wins != null) ? Math.max(0, round1(leaderWins - wins)) : null;
      var rsRec = r.regular_season && r.regular_season.record;
      var overall = (rsRec && typeof rsRec === 'object' && apFraction(rsRec))
        ? { w: Number(rsRec.w), l: Number(rsRec.l), t: Number(rsRec.t), pct: apPctFromRecord(rsRec) }
        : { w: r.h2h_w || 0, l: r.h2h_l || 0, t: r.h2h_t || 0, pct: (r.h2h_pct == null ? null : Number(r.h2h_pct)) };
      var dgb = (r.division_games_back === null) ? NaN : strictNum(r.division_games_back);
      return {
        franchise_id: pad4(r.franchise_id),
        franchise_name: r.franchise_name || ('Franchise ' + pad4(r.franchise_id)),
        is_division_leader: !!r.is_division_leader,
        division_rank: ranked ? strictNum(r.division_rank) : null,
        overall: overall,
        ap: rec,
        ap_pct: apPctFromRecord(rec),
        ap_gb: gb,
        games_back: isFiniteNum(dgb) ? dgb : null
      };
    });
    return entries; // the worker's order — no sort here
  }

  // ── 7. Seed explanation ─────────────────────────────────────────────
  // Words only: the WORKER decided the seed and says which step of its
  // ladder separated this team from its neighbor (row.seed_reason —
  // worker/src/seeding.js seedLadderSteps). Nothing here compares two teams.
  var STEP_LABEL = {
    all_play: 'All-Play %',
    // Owner-facing words (#1329): canon §F.1 calls the second step "Overall"; the screens call that record "H2H".
    overall: 'H2H record',
    points_for: 'season Points For',
    head_to_head: 'the H2H games between them',
    name: 'the name-order fallback after every league step tied — not a league rule',
    franchise_id: 'the franchise-id fallback after every league step tied — not a league rule',
    head_to_head_unavailable: 'a tie that reached head-to-head, which can’t be shown because the regular-season games couldn’t be read'
  };
  var POOL_LABEL = {
    bye: 'the bye pool (the two best division winners)',
    seeds3to6: 'the seeds 3–6 pool',
    outside: 'the race for the last wild card'
  };
  // The ladder steps that came BEFORE a deciding step were level — said in brackets so "behind on Overall record"
  // isn't read as "worse on All-Play %" (canon §F.1 order: All-Play % → Overall → Points For → head-to-head).
  var SAME_BEFORE = {
    overall: 'same All-Play %',
    points_for: 'same All-Play % and H2H record',
    head_to_head: 'same All-Play %, H2H record and season Points For'
  };
  function stepPhrase(step) {
    var label = STEP_LABEL[step] || step;
    return label + (SAME_BEFORE[step] ? ' (' + SAME_BEFORE[step] + ')' : '');
  }
  // Plain words for the worker's regular_season.problems codes (worker/src/standings_truth.js), for
  // "Seeds unavailable: <reason>".
  function problemWords(p) {
    var code = p && p.code;
    var wk = (p && p.week != null && String(p.week) !== '') ? 'Week ' + p.week : null;
    switch (code) {
      case 'malformed_playoff_flag': return (wk ? 'a ' + wk + ' result' : 'a result') + ' has a playoff flag that is neither regular season nor playoff';
      case 'weekly_unreadable': return 'the weekly results couldn’t be read';
      case 'standings_without_weekly_rows': return 'the season has standings but no weekly results';
      case 'missing_week_score': case 'missing_score': return (wk ? 'a ' + wk + ' score' : 'a weekly score') + ' is missing';
      case 'conflicting_score': return 'two different ' + (wk ? wk + ' ' : '') + 'scores were recorded for one team';
      case 'week_gap': return (wk || 'a week') + ' is missing';
      case 'game_without_week_scores': return (wk || 'a week') + ' has games but no weekly scores';
      case 'regular_flag_after_last_regular_week': return (wk || 'a week') + ' is marked regular season after the regular season ends';
      case 'playoff_flag_in_regular_week': return (wk || 'a week') + ' is marked playoff during the regular season';
      case 'unknown_last_regular_week': return 'the season’s last regular-season week isn’t known';
      case 'no_regular_season_rows': return 'no regular-season weeks were found';
      default: return 'the regular-season results couldn’t be checked';
    }
  }
  // { blocked, basis, pool, decidingCriterion, text, vsAbove } — words only, from the worker.
  //   recorded season  → "Seed 3 — from the recorded final standings." (no ladder step is ever claimed)
  //   basis unavailable → blocked, "Seeds unavailable: <the worker's first problem, in words>."
  //   ladder + seed_reason.vs_above (the team directly above in the worker's order, and the step that kept this
  //     team BELOW it) → "Seed 5: behind Real Deal Creel on H2H record (same All-Play %)."; the structural steps
  //     read "A first-round bye needs a division title." / "<name> is in the field as a division winner."
  //   ladder without vs_above (seed 1, or an older worker) → the seed_reason rival wording.
  //   no seed reason at all (a worker that predates it) → blocked, never a guessed one.
  // context (optional): { standings_basis, regular_season } from the same /api/standings response.
  function whySeedForRow(row, rows, weeklyScores, context) {
    if (!row) return null;
    var reason = row.seed_reason;
    var seed = Number(row.playoff_seed);
    var seeded = seed >= 1 && seed <= 6;
    if (reason && reason.basis === 'recorded_final_standings') {
      // No seed number: this row's playoff_seed is the recompute, not the recorded seed (see isRecordedRow).
      return {
        blocked: false, basis: 'recorded_final_standings', pool: null, decidingCriterion: null, vsAbove: null,
        text: 'From the recorded final standings (see the finish and the recorded seed).'
      };
    }
    var ctxBasis = context && context.standings_basis;
    if ((reason && reason.basis === 'unavailable') || ctxBasis === 'unavailable') {
      var probs = context && context.regular_season && Array.isArray(context.regular_season.problems) ? context.regular_season.problems : [];
      var msg = 'Seeds unavailable: ' + (probs.length ? problemWords(probs[0]) : 'the regular-season results couldn’t be checked') + '.';
      return { blocked: true, basis: 'unavailable', pool: null, decidingCriterion: null, vsAbove: null, text: msg, reason: msg };
    }
    if ((reason && reason.basis === 'preseason') || ctxBasis === 'preseason') {
      var pre = 'No seeds yet — no games have been played.';
      return { blocked: true, basis: 'preseason', pool: null, decidingCriterion: null, vsAbove: null, text: pre, reason: pre };
    }
    if (!reason || reason.basis !== 'ladder') {
      return { blocked: true, basis: null, pool: null, decidingCriterion: null, text: null, vsAbove: null,
        reason: 'The standings response carries no seed reason for this team.' };
    }
    var rival = reason.rival_name || (reason.rival_franchise_id ? 'Franchise ' + pad4(reason.rival_franchise_id) : null);
    var stepText = reason.step ? STEP_LABEL[reason.step] || reason.step : null;
    var above = (reason.vs_above && typeof reason.vs_above === 'object' && hasId(reason.vs_above.franchise_id)) ? reason.vs_above : null;
    var aboveFid = above ? pad4(above.franchise_id) : null;
    var aboveName = above ? (above.name || 'Franchise ' + aboveFid) : null;
    var vsAbove = above ? { franchise_id: aboveFid, name: aboveName, step: above.step || null } : null;
    // why this team is BELOW the team directly above it, in the worker's own step
    function belowSentence(lead) {
      if (above.step === 'bye_requires_division_title') return lead + aboveName + '. A first-round bye needs a division title.';
      if (above.step === 'division_winner_in_field') return lead + aboveName + '. ' + aboveName + ' is in the field as a division winner.';
      if (!above.step) return lead + aboveName + '.';
      return lead + aboveName + ' on ' + stepPhrase(above.step) + '.';
    }
    if (!seeded) {
      var list = (Array.isArray(rows) ? rows : []).filter(Boolean);
      var gb = apGamesBack(list, weeklyScores)[pad4(row.franchise_id)];
      // gb is All-Play wins behind the last wild card (named next); never negative, never against a division winner.
      var lead = (gb == null || gb < 0) ? 'Outside the top six — AP games back unavailable'
        : 'Outside the top six — ' + gb + ' AP win' + (gb === 1 ? '' : 's') + ' back';
      var text = lead + (rival && stepText ? '; behind ' + rival + ' (the last wild card) on ' + stepText : '') + '.';
      // The team directly above, when it isn't the last wild card already named: a division winner in the field
      // ahead of a better team is structural; another team outside the field is the next one to pass.
      if (above && aboveFid !== pad4(reason.rival_franchise_id)) {
        var aboveRow = null;
        for (var i = 0; i < list.length; i++) { if (pad4(list[i].franchise_id) === aboveFid) { aboveRow = list[i]; break; } }
        if (above.step === 'division_winner_in_field') text += ' ' + aboveName + ' is in the field as a division winner.';
        else if (aboveRow && aboveRow.playoff_seed == null && above.step) text += ' ' + belowSentence('Directly behind ');
      }
      return {
        blocked: false, basis: 'ladder', pool: 'outside', decidingCriterion: reason.step || null, vsAbove: vsAbove,
        text: text
      };
    }
    if (above) {
      // ...and, when a TIEBREAK (not plain All-Play) put it ahead of the team below, say that too: it answers
      // "why is he ahead of a team with the same All-Play %?"
      var aheadTie = reason.position === 'ahead' && rival && reason.step && reason.step !== 'all_play' &&
        reason.step !== 'name' && reason.step !== 'franchise_id' && STEP_LABEL[reason.step];
      return {
        blocked: false, basis: 'ladder', pool: reason.pool || null, decidingCriterion: above.step || null, vsAbove: vsAbove,
        aheadOf: aheadTie ? { franchise_id: pad4(reason.rival_franchise_id), name: rival, step: reason.step } : null,
        text: belowSentence('Seed ' + seed + ': behind ') + (aheadTie ? ' Ahead of ' + rival + ' on ' + stepPhrase(reason.step) + '.' : '')
      };
    }
    var poolLabel = POOL_LABEL[reason.pool] || 'its pool';
    if (!rival || !stepText) {
      return { blocked: false, basis: 'ladder', pool: reason.pool || null, decidingCriterion: null, vsAbove: null,
        text: 'Seed ' + seed + ': eligibility placed the team in ' + poolLabel + '.' };
    }
    return {
      blocked: false, basis: 'ladder', pool: reason.pool || null, decidingCriterion: reason.step, vsAbove: null,
      text: 'Seed ' + seed + ': in ' + poolLabel + '; ' + (reason.position === 'ahead' ? 'ranked ahead of ' : 'behind ') + rival + ' on ' + stepText + '.'
    };
  }

  // ── 8. Projected bracket / draft order (Phase II-A2) ────────────────
  // Pure bracket-topology + chalk-projection helpers for A5 (desktop
  // projected bracket + draft order) and A6 (mobile Playoffs mode).
  // NEVER recomputes playoff SEEDS — every function here takes an
  // already-ordered seeds[] array (from /api/playoff-bracket, or the
  // canonical playoff_seed already on /api/standings rows) and only ever
  // asks "who wins a projected/actual GAME between two already-seeded
  // teams" — seed 1..12 is trusted input, not derived here.
  //
  // BRACKET TOPOLOGY (verified against real, live /api/playoff-bracket
  // data for a completed season — 2025 — not assumed): each 6-team side
  // (seeds 1-6 for the UPS championship side, 7-12 for the Hawk Tuah Bowl
  // side, using within-side relative positions 1-6) is a standard
  // single-elimination bracket with the top 2 byed to the semifinal
  // round:
  //   Round 1 (week 1 of 3 playoff weeks):  3 vs 6,  4 vs 5
  //   Semis   (week 2): 1 vs winner(4v5),  2 vs winner(3v6)
  //   Placement (week 2, the other game — the two R1 LOSERS play each
  //     other for the lower two of the six positions)
  //   Final   (week 3): winner(semi1) vs winner(semi2)
  //   Third-place (week 3): loser(semi1) vs loser(semi2)
  // This exact topology (and the finish/pick assignment below) was
  // verified by replaying it against real 2025 matchup data and
  // confirming it reproduces the real bracket's actual picks, including
  // 1.01 = Cleon Ca$h (finish 7, the real 2025 Hawk Tuah Bowl champion).
  //
  // FINISH / PICK ASSIGNMENT — as of the Phase II-A2 correction pass, this
  // table is the ONE authoritative pick mapper for BOTH the real desktop
  // Draft Order view (site/standings/mfl_hpm_standings_v2.html
  // renderDraftOrder now calls buildActualBracketResult()/this table
  // directly — it no longer has its own inline pick-assignment
  // arithmetic) and the projected chalk bracket. It is intentionally NOT
  // a lookup keyed by the DB's stored final_finish column — that's a
  // separate concept (final_finish is a historical record written at
  // season-end; this module computes bracket placement fresh from named
  // game-slot outcomes). For the 2025 season (the only completed season
  // this module has been verified against), the stored final_finish
  // values agree with the bracket-computed placements for all 12
  // franchises — no divergence has been observed or demonstrated; this
  // comment previously claimed otherwise without a verified example, and
  // that claim has been retracted (Phase II-A2 correction pass, F8):
  var BRACKET_FINISH_SLOTS = [
    { side: 'champ', game: 'final',     role: 'winner', finish: 1,  pick: '1.12' },
    { side: 'champ', game: 'final',     role: 'loser',  finish: 2,  pick: '1.11' },
    { side: 'champ', game: 'third',     role: 'winner', finish: 3,  pick: '1.10' },
    { side: 'champ', game: 'third',     role: 'loser',  finish: 4,  pick: '1.09' },
    { side: 'champ', game: 'placement', role: 'winner', finish: 5,  pick: '1.07' },
    { side: 'champ', game: 'placement', role: 'loser',  finish: 6,  pick: '1.08' },
    { side: 'hawk',  game: 'final',     role: 'winner', finish: 7,  pick: '1.01' },
    { side: 'hawk',  game: 'final',     role: 'loser',  finish: 8,  pick: '1.02' },
    { side: 'hawk',  game: 'third',     role: 'winner', finish: 9,  pick: '1.03' },
    { side: 'hawk',  game: 'third',     role: 'loser',  finish: 10, pick: '1.04' },
    { side: 'hawk',  game: 'placement', role: 'winner', finish: 11, pick: '1.05' },
    { side: 'hawk',  game: 'placement', role: 'loser',  finish: 12, pick: '1.06' }
  ];
  // Validates and normalizes a seeds[] array (from /api/playoff-bracket,
  // or any equivalent list of {seed, franchise_id, franchise_name}).
  // Fails closed — returns { ok:false, reason } rather than fabricating
  // a bracket — when there aren't exactly 12 entries, a seed number is
  // missing/non-integer/out of 1-12/duplicated, or a franchise_id is
  // missing/duplicated. Never keyed on franchise name.
  function validateBracketSeeds(seedsRaw) {
    if (!Array.isArray(seedsRaw)) return { ok: false, reason: 'seeds must be an array' };
    if (seedsRaw.length !== 12) return { ok: false, reason: 'expected exactly 12 seeds, got ' + seedsRaw.length };
    var bySeedNum = {}, byFid = {}, normalized = [];
    for (var i = 0; i < seedsRaw.length; i++) {
      var s = seedsRaw[i];
      if (!s || typeof s !== 'object') return { ok: false, reason: 'seed entry ' + i + ' is missing or malformed' };
      var n = Number(s.seed);
      if (!Number.isInteger(n) || n < 1 || n > 12) return { ok: false, reason: 'seed entry ' + i + ' has an invalid seed number' };
      if (bySeedNum.hasOwnProperty(n)) return { ok: false, reason: 'duplicate seed number ' + n };
      var rawFid = s.franchise_id;
      if (rawFid == null || String(rawFid).trim() === '') return { ok: false, reason: 'seed ' + n + ' is missing a franchise_id' };
      var fid = pad4(rawFid);
      if (byFid.hasOwnProperty(fid)) return { ok: false, reason: 'duplicate franchise_id ' + fid };
      bySeedNum[n] = true; byFid[fid] = true;
      normalized.push({ seed: n, franchise_id: fid, franchise_name: (s.franchise_name == null ? '' : String(s.franchise_name)) || ('Franchise ' + fid) });
    }
    return { ok: true, seeds: normalized };
  }
  // Chalk rule (Keith's Phase II-A2 decision): the higher seed (lower
  // seed NUMBER) wins every projected game. Never a tie under chalk
  // (seed numbers are always distinct once validated).
  function chalkWinner(a, b) {
    if (!a) return b;
    if (!b) return a;
    return Number(a.seed) < Number(b.seed) ? a : b;
  }
  function chalkLoser(a, b) {
    if (!a || !b) return null;
    return chalkWinner(a, b) === a ? b : a;
  }
  function chalkGame(a, b) {
    return { a: a, b: b, winner: chalkWinner(a, b), loser: chalkLoser(a, b), scoreA: null, scoreB: null, pending: false, projected: true };
  }
  // Builds one 6-team side's full bracket topology (see the module
  // comment above) entirely by chalk. `base` = 0 for the UPS
  // championship side (seeds 1-6), 6 for the Hawk Tuah Bowl side (7-12).
  function chalkBracketSide(bySeedNum, base) {
    function s(n) { return bySeedNum[base + n]; }
    var r1a = chalkGame(s(3), s(6));
    var r1b = chalkGame(s(4), s(5));
    var semi1 = chalkGame(s(1), r1b.winner);
    var semi2 = chalkGame(s(2), r1a.winner);
    var placement = chalkGame(r1a.loser, r1b.loser);
    var finalGame = chalkGame(semi1.winner, semi2.winner);
    var thirdGame = chalkGame(semi1.loser, semi2.loser);
    return { r1: [r1a, r1b], semis: [semi1, semi2], placement: placement, final: finalGame, third: thirdGame };
  }
  // ── F5 (Phase II-A2 correction pass) — one GAME's natural identity is
  // (week, sorted franchise-id pair), regardless of how many perspective
  // rows the API sends for it. normalizeActualGame() groups those rows
  // and returns an explicit STATUS, never guessing:
  //   'ok'         — both sides' rows present, mutually consistent, a
  //                  real (non-tied) score difference decides a winner.
  //   'pending'    — valid/consistent data, but a score is null/missing
  //                  or the two scores are tied (no explicit winner is
  //                  ever supplied by this module's inputs, so a tie
  //                  always stays pending, never a coin-flip).
  //   'incomplete' — only ONE side's perspective row was ever seen for
  //                  this game (no reciprocal row) — never enough to
  //                  assign a winner, regardless of what that one row's
  //                  score says.
  //   'conflict'   — two rows disagree (duplicate rows for the same
  //                  perspective report different scores, OR the two
  //                  sides' rows cross-check to different score pairs).
  //                  scoreA/scoreB are cleared to null — a conflict is
  //                  never resolved by trusting "whichever row came
  //                  first"; the result is input-order independent.
  // Only 'ok' games ever produce a non-null winner/loser — pending/
  // incomplete/conflict all leave winner=null, loser=null, pending=true,
  // so assignFinishesAndPicks() (below) never assigns a placement/pick
  // from anything but a decided game.
  function normalizeActualGame(week, loFid, hiFid, rawRows, byFid) {
    var loRows = [], hiRows = [];
    (rawRows || []).forEach(function (m) {
      var fid = pad4(m.franchise_id), oppFid = pad4(m.opponent_franchise_id);
      // m.team_score == null must stay null, never Number(null) === 0.
      var score = (m.team_score == null) ? null : (isFiniteNum(Number(m.team_score)) ? Number(m.team_score) : null);
      var oppScore = (m.opponent_score == null) ? null : (isFiniteNum(Number(m.opponent_score)) ? Number(m.opponent_score) : null);
      if (fid === loFid && oppFid === hiFid) loRows.push({ score: score, oppScore: oppScore });
      else if (fid === hiFid && oppFid === loFid) hiRows.push({ score: score, oppScore: oppScore });
      // a row that doesn't match this exact pair is not this game's data
    });
    function allSame(rows) {
      if (rows.length <= 1) return true;
      var first = rows[0];
      return rows.every(function (r) { return r.score === first.score && r.oppScore === first.oppScore; });
    }
    var loConsistent = allSame(loRows), hiConsistent = allSame(hiRows);
    var loRow = loRows[0] || null, hiRow = hiRows[0] || null;
    var crossConsistent = true;
    if (loRow && hiRow) {
      crossConsistent =
        (loRow.score == null || hiRow.oppScore == null || loRow.score === hiRow.oppScore) &&
        (loRow.oppScore == null || hiRow.score == null || loRow.oppScore === hiRow.score);
    }
    var status;
    if (!loConsistent || !hiConsistent || !crossConsistent) status = 'conflict';
    else if (!loRow || !hiRow) status = 'incomplete';
    else status = (loRow.score == null || hiRow.score == null || loRow.score === hiRow.score) ? 'pending' : 'ok';
    // Each side's score is taken ONLY from that side's own reported row —
    // never inferred from the other side's oppScore mirror field, even
    // when that side's own row is missing. A missing/unreported side
    // stays null (honest, never fabricated) whether the game is
    // 'incomplete' (only one perspective ever seen) or 'conflict'
    // (perspectives disagree — neither is trusted).
    var scoreLo = (status !== 'conflict' && loRow) ? loRow.score : null;
    var scoreHi = (status !== 'conflict' && hiRow) ? hiRow.score : null;
    var teamLo = byFid[loFid], teamHi = byFid[hiFid];
    var winner = null, loser = null;
    if (status === 'ok') {
      winner = scoreLo > scoreHi ? teamLo : teamHi;
      loser = scoreLo > scoreHi ? teamHi : teamLo;
    }
    return {
      week: week, a: teamLo, b: teamHi, scoreA: scoreLo, scoreB: scoreHi,
      winner: winner, loser: loser, pending: status !== 'ok', projected: false, status: status
    };
  }
  // Classifies a flat list of ACTUAL game entries for ONE side (already
  // deduped to one entry per (week, franchise pair)) into the same
  // {r1, semis, placement, final, third} shape chalkBracketSide()
  // produces — by CROSS-REFERENCING who won/lost the round-1 games and
  // the semis, exactly mirroring the desktop Bracket view's own
  // classification (both R1 losers meeting again = placement/consolation;
  // both semi winners meeting = the real final; both semi losers = 3rd
  // place) — never by assuming a fixed week-to-round label, so a
  // partially-played bracket degrades to missing slots instead of a
  // wrong label. `playoffWeeks` = [r1Week, semisWeek, finalWeek].
  function classifySideGamesFromMatchups(games, playoffWeeks) {
    var wk1 = playoffWeeks[0], wk2 = playoffWeeks[1], wk3 = playoffWeeks[2];
    var r1 = games.filter(function (g) { return g.week === wk1; });
    var r1LoserFids = {};
    r1.forEach(function (g) { if (g.loser) r1LoserFids[g.loser.franchise_id] = true; });
    var wk2Games = games.filter(function (g) { return g.week === wk2; });
    var semis = [], placement = null;
    wk2Games.forEach(function (g) {
      if (r1LoserFids[g.a.franchise_id] && r1LoserFids[g.b.franchise_id]) placement = g;
      else semis.push(g);
    });
    var semiLoserFids = {}, semiWinnerFids = {};
    semis.forEach(function (g) {
      if (g.loser) semiLoserFids[g.loser.franchise_id] = true;
      if (g.winner) semiWinnerFids[g.winner.franchise_id] = true;
    });
    var wk3Games = games.filter(function (g) { return g.week === wk3; });
    var finalGame = null, thirdGame = null;
    wk3Games.forEach(function (g) {
      if (semiWinnerFids[g.a.franchise_id] && semiWinnerFids[g.b.franchise_id]) finalGame = g;
      else if (semiLoserFids[g.a.franchise_id] && semiLoserFids[g.b.franchise_id]) thirdGame = g;
    });
    return { r1: r1, semis: semis, placement: placement, final: finalGame, third: thirdGame };
  }
  // THE shared finish/pick assignment — used identically for a chalk
  // projection (champSide/hawkSide from chalkBracketSide) and for real
  // results (from classifySideGamesFromMatchups). A slot whose game
  // hasn't been decided yet (null, or pending with no winner/loser) is
  // simply left unassigned — never fabricated.
  function assignFinishesAndPicks(champSide, hawkSide) {
    var sides = { champ: champSide, hawk: hawkSide };
    var picks = {}, finishes = {};
    BRACKET_FINISH_SLOTS.forEach(function (slot) {
      var side = sides[slot.side];
      var g = side ? side[slot.game] : null;
      var entry = g ? g[slot.role] : null;
      if (!entry) return;
      picks[slot.pick] = entry.franchise_id;
      finishes[entry.franchise_id] = slot.finish;
    });
    return { picks: picks, finishes: finishes, slots: BRACKET_FINISH_SLOTS };
  }
  // Top-level: PROJECTED bracket + draft order using chalk (A5's core
  // entry point). seedsRaw = /api/playoff-bracket's seeds[] (or any
  // equivalent already-ordered 12-team list). Returns
  // { status: 'ok', champ, hawk, picks, finishes } or
  // { status: 'unavailable', reason, champ:null, hawk:null, picks:null, finishes:null }.
  function projectChalkBracket(seedsRaw) {
    var v = validateBracketSeeds(seedsRaw);
    if (!v.ok) return { status: 'unavailable', reason: v.reason, champ: null, hawk: null, picks: null, finishes: null };
    var bySeedNum = {};
    v.seeds.forEach(function (s) { bySeedNum[s.seed] = s; });
    var champSide = chalkBracketSide(bySeedNum, 0);
    var hawkSide = chalkBracketSide(bySeedNum, 6);
    var assigned = assignFinishesAndPicks(champSide, hawkSide);
    return { status: 'ok', champ: champSide, hawk: hawkSide, picks: assigned.picks, finishes: assigned.finishes };
  }
  // Top-level: ACTUAL bracket + draft order from real /api/playoff-bracket
  // matchups[] (verified against real 2025 data — reproduces every real
  // pick, including the semifinal upsets that season had). seedsRaw =
  // seeds[]; matchupsRaw = matchups[] (one row per side per game, as the
  // worker returns it — deduped here); playoffWeeksRaw = the response's
  // playoff_weeks (defaults to [15,16,17] if not a 3-element array). A
  // matchup row for a franchise not on seedsRaw, or a game whose two
  // participants are seeded on DIFFERENT sides (a data anomaly), is
  // ignored rather than fabricated into a result. Used both to validate
  // A2's chalk logic against real history and to power A6's mobile
  // "what does this game determine" labeling.
  function buildActualBracketResult(seedsRaw, matchupsRaw, playoffWeeksRaw) {
    var v = validateBracketSeeds(seedsRaw);
    if (!v.ok) return { status: 'unavailable', reason: v.reason, champ: null, hawk: null, picks: null, finishes: null, games: [] };
    var byFid = {};
    v.seeds.forEach(function (s) { byFid[s.franchise_id] = s; });
    var playoffWeeks = (Array.isArray(playoffWeeksRaw) && playoffWeeksRaw.length === 3)
      ? playoffWeeksRaw.map(Number).sort(function (a, b) { return a - b; })
      : [15, 16, 17];
    // Group raw rows by (week, canonical sorted fid pair) — a GAME's
    // natural identity — before deciding anything about who won. This is
    // input-order independent: it doesn't matter which row arrived first,
    // or how many duplicate/reciprocal rows exist for the pair.
    var groups = {};
    (Array.isArray(matchupsRaw) ? matchupsRaw : []).forEach(function (m) {
      if (!m) return;
      var fidA = pad4(m.franchise_id), fidB = pad4(m.opponent_franchise_id);
      if (!byFid.hasOwnProperty(fidA) || !byFid.hasOwnProperty(fidB)) return;
      var week = Number(m.week);
      if (!isFiniteNum(week)) return;
      var seedA = byFid[fidA], seedB = byFid[fidB];
      // a cross-side pairing would be a data anomaly — never fabricated
      // into either side's bracket.
      var bothChamp = seedA.seed <= 6 && seedB.seed <= 6;
      var bothHawk = seedA.seed >= 7 && seedB.seed >= 7;
      if (!bothChamp && !bothHawk) return;
      var pair = [fidA, fidB].sort();
      var key = week + '|' + pair.join('-');
      if (!groups.hasOwnProperty(key)) groups[key] = { week: week, loFid: pair[0], hiFid: pair[1], side: bothChamp ? 'champ' : 'hawk', rows: [] };
      groups[key].rows.push(m);
    });
    var champGames = [], hawkGames = [];
    Object.keys(groups).forEach(function (key) {
      var g = groups[key];
      var entry = normalizeActualGame(g.week, g.loFid, g.hiFid, g.rows, byFid);
      (g.side === 'champ' ? champGames : hawkGames).push(entry);
    });
    function byWeekThenFid(x, y) { return x.week - y.week || x.a.franchise_id.localeCompare(y.a.franchise_id); }
    champGames.sort(byWeekThenFid);
    hawkGames.sort(byWeekThenFid);
    var champSide = classifySideGamesFromMatchups(champGames, playoffWeeks);
    var hawkSide = classifySideGamesFromMatchups(hawkGames, playoffWeeks);
    var assigned = assignFinishesAndPicks(champSide, hawkSide);
    return { status: 'ok', champ: champSide, hawk: hawkSide, picks: assigned.picks, finishes: assigned.finishes, games: champGames.concat(hawkGames) };
  }
  // verifyActualSide(result, sideKey, seedsRaw, opts) — a FINISHED season's side, drawn by
  // buildActualBracketResult into today's rounds, is shown as a bracket only when it is that season's bracket
  // (#1329 decision 2, item 2: older formats don't fit today's rounds). opts: { season, hasConferences }.
  // The recorded champion comes from the seeds' final_finish (the worker's recorded final standings): 1 = UPS
  // champion; 7 = Hawk Tuah Bowl champion from 2011 (2010's toilet bracket had the loser advance: no title).
  //   → { draw, reason, recordedChampion (fid | null), noTitle, games (the side's games, week order) }
  //   draw false + reason: 'no_title' (2010 toilet side) · 'conference_format' (every Round 1 game is inside one
  //   conference, the 2011-2013 conference brackets) · 'incomplete' (no decided final) · 'champion_mismatch' (the
  //   drawn champion isn't the recorded one) · 'seeds_unreadable' (the season's seeds don't validate — 2013 has two
  //   teams at seed 7 — so the games are split by recorded finish, 1-6 and 7-12, from opts.matchups, with no seed
  //   numbers). With no recorded finish to check against, the side draws as before (reason 'unverified').
  //   A Round 1 of exactly today's pairs (3 v 6 and 4 v 5; H3 v H6 and H4 v H5) is never treated as a conference
  //   bracket, even in a season that had conferences.
  function verifyActualSide(result, sideKey, seedsRaw, opts) {
    var hawk = sideKey === 'hawk';
    var season = opts && opts.season != null ? strictNum(opts.season) : NaN;
    var out = { draw: false, reason: 'unavailable', recordedChampion: null, noTitle: false, games: [] };
    var seeds = Array.isArray(seedsRaw) ? seedsRaw.filter(isRowObject) : [];
    var info = {};
    seeds.forEach(function (s) { if (hasId(s.franchise_id)) info[pad4(s.franchise_id)] = s; });
    var want = hawk ? 7 : 1;
    var rec = seeds.filter(function (s) { return strictNum(s.final_finish) === want; });
    var recordedChampion = rec.length === 1 && hasId(rec[0].franchise_id) ? pad4(rec[0].franchise_id) : null;
    var noTitle = hawk && season === 2010;
    if (!result || result.status !== 'ok') {
      // Seeds that don't validate: list the side's games by recorded finish (both teams 1-6, or both 7-12).
      var fin = function (f) { var x = info[f]; var n = x ? strictNum(x.final_finish) : NaN; return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null; };
      var finished = Object.keys(info).filter(function (f) { return fin(f) != null; });
      if (finished.length < 12 || !Array.isArray(opts && opts.matchups)) return out;
      var seen = {};
      opts.matchups.forEach(function (m) {
        if (!isRowObject(m) || !hasId(m.franchise_id) || !hasId(m.opponent_franchise_id)) return;
        var a = pad4(m.franchise_id), b = pad4(m.opponent_franchise_id), w = strictNum(m.week);
        var fa = fin(a), fb = fin(b);
        if (fa == null || fb == null || !isWeekNum(w) || (hawk ? !(fa >= 7 && fb >= 7) : !(fa <= 6 && fb <= 6))) return;
        var key = w + '|' + [a, b].sort().join('-');
        var ts = strictNum(m.team_score), os = strictNum(m.opponent_score);
        if (seen[key] || !isFiniteNum(ts) || !isFiniteNum(os)) return;
        var ea = { franchise_id: a, franchise_name: info[a].franchise_name || ('Franchise ' + a), seed: null };
        var eb = { franchise_id: b, franchise_name: info[b].franchise_name || ('Franchise ' + b), seed: null };
        seen[key] = { week: w, a: ea, b: eb, scoreA: ts, scoreB: os, winner: ts > os ? ea : os > ts ? eb : null, loser: ts > os ? eb : os > ts ? ea : null, pending: false, status: 'final', _fa: fa, _fb: fb };
      });
      out.games = Object.keys(seen).map(function (k) { return seen[k]; }).sort(function (x, y) { return (x.week - y.week) || (Math.min(x._fa, x._fb) - Math.min(y._fa, y._fb)); });
      out.games.forEach(function (g) { delete g._fa; delete g._fb; });
      out.recordedChampion = noTitle ? null : recordedChampion; out.noTitle = noTitle; out.reason = 'seeds_unreadable';
      return out;
    }
    var side = hawk ? result.hawk : result.champ;
    out.games = (result.games || []).filter(function (g) {
      var sa = g && g.a && Number(g.a.seed); return hawk ? sa >= 7 : sa <= 6;
    }).sort(function (x, y) {
      return (x.week - y.week) || (Math.min(x.a.seed, x.b.seed) - Math.min(y.a.seed, y.b.seed));
    });
    if (noTitle) { out.noTitle = true; out.reason = 'no_title'; return out; }
    out.recordedChampion = recordedChampion;
    var modern = hawk ? { '9-12': 1, '10-11': 1 } : { '3-6': 1, '4-5': 1 };
    var todaysRound1 = !!(side && side.r1 && side.r1.length === 2 && side.r1.every(function (g) {
      return g && g.a && g.b && modern.hasOwnProperty([Number(g.a.seed), Number(g.b.seed)].sort(function (x, y) { return x - y; }).join('-'));
    }));
    if (opts && opts.hasConferences && !todaysRound1 && side && side.r1 && side.r1.length) {
      var intra = side.r1.every(function (g) {
        var a = g && g.a && info[pad4(g.a.franchise_id)], b = g && g.b && info[pad4(g.b.franchise_id)];
        return a && b && a.conference_id != null && a.conference_id !== '' && a.conference_id === b.conference_id;
      });
      if (intra) { out.reason = 'conference_format'; return out; }
    }
    var drawn = side && side.final && side.final.winner ? pad4(side.final.winner.franchise_id) : null;
    if (!out.recordedChampion) { out.draw = !!drawn; out.reason = drawn ? 'unverified' : 'incomplete'; return out; }
    if (!drawn) { out.reason = 'incomplete'; return out; }
    if (drawn !== out.recordedChampion) { out.reason = 'champion_mismatch'; return out; }
    out.draw = true; out.reason = null;
    return out;
  }

  // ── F9 (Phase II-A2 correction pass) — the ONE shared gating decision
  // both the desktop and mobile Playoffs surfaces consume, replacing each
  // page's own ad hoc "!matchups.length && !season_complete" conditionals.
  // Returns exactly one of:
  //   'actual'      — matchups is a non-empty array. Real results exist
  //                    (even mid-playoffs, partially played) — render
  //                    them via buildActualBracketResult(); NEVER project
  //                    over real data, regardless of season_complete.
  //   'projected'   — matchups is an empty array AND season_complete is
  //                    the literal boolean `false` (a string, null,
  //                    undefined, or any other truthy/falsy-but-not-
  //                    boolean value fails closed to 'unavailable' —
  //                    malformed season_complete never silently enables
  //                    a projection) AND the 12-seed set validates.
  //   'unavailable' — anything else: matchups is not an array (a
  //                    malformed non-array matchups object is NEVER
  //                    treated as an empty array), or matchups is empty
  //                    but season_complete isn't strictly false, or the
  //                    seeds don't validate.
  function projectionMode(input) {
    var seasonComplete = input && input.seasonComplete;
    var matchupsRaw = input && input.matchups;
    var seedsRaw = input && input.seeds;
    if (!Array.isArray(matchupsRaw)) return 'unavailable';
    if (matchupsRaw.length > 0) return 'actual';
    if (seasonComplete !== false) return 'unavailable';
    var v = validateBracketSeeds(seedsRaw);
    return v.ok ? 'projected' : 'unavailable';
  }
  // ── F2 (Phase II-A2 correction pass) — one shared, human-readable
  // "why this pick" label generator driven by BRACKET_FINISH_SLOTS, used
  // by BOTH the actual and projected desktop Draft Order rendering (no
  // separate hand-written why-text table per rendering path). `pick` is
  // a "1.0N"/"1.1N" string; `projected` prefixes the text when the pick
  // came from projectChalkBracket() rather than real results.
  var GAME_DISPLAY_NAME = {
    champ: { final: 'the UPS Championship', third: 'the championship 3rd-place game', placement: 'the 5th-place game' },
    hawk:  { final: 'the Hawk Tuah Bowl', third: 'the Hawk Tuah Bowl 3rd-place game', placement: 'the Hawk Tuah Bowl 5th-place game' }
  };
  function pickWhyText(pick, projected) {
    var slot = null;
    for (var i = 0; i < BRACKET_FINISH_SLOTS.length; i++) {
      if (BRACKET_FINISH_SLOTS[i].pick === pick) { slot = BRACKET_FINISH_SLOTS[i]; break; }
    }
    if (!slot) return null;
    var verb = slot.role === 'winner' ? 'Won' : 'Lost';
    var name = GAME_DISPLAY_NAME[slot.side][slot.game];
    return (projected ? 'Projected — ' : '') + verb + ' ' + name;
  }
  // The draft year a season's playoff results determine — e.g. the 2026
  // season's playoffs set the 2027 rookie draft order. Never hardcoded.
  function nextDraftYear(season) {
    var n = Number(season);
    return isFiniteNum(n) ? n + 1 : null;
  }
  // A6's four pre-playoff mobile groups (BYES / DIVISION WINNERS / WILD
  // CARDS / IN THE HUNT), derived from the SAME playoff_status field
  // (via statusForRow) and the SAME regular-season-only AP GB
  // (via apGamesBack) that the A1 desktop/mobile standings tables
  // already use — never a separate/duplicated computation. `rows` =
  // /api/standings rows; `weeklyScores` threads through to apGamesBack
  // exactly as A1 already does. Every group keeps the WORKER's order (its
  // seeds, then its ladder for the teams outside the field). IN THE HUNT is
  // NOT re-sorted by games back: apGB is shown beside each team (the
  // worker's ap_back when the rows carry it), never used to re-rank them.
  function projectedPlayoffGroups(rows, weeklyScores) {
    var list = (Array.isArray(rows) ? rows : []).filter(Boolean);
    var gbMap = apGamesBack(list, weeklyScores);
    var byes = [], divisionWinners = [], wildCards = [], inTheHunt = [];
    list.forEach(function (r, i) {
      var fid = pad4(r.franchise_id);
      var status = statusForRow(r);
      var entry = {
        order: i,   // the worker's order — playoff seed, then the league ladder (never re-derived here)
        franchise_id: fid,
        franchise_name: r.franchise_name || ('Franchise ' + fid),
        seed: (r.playoff_seed == null ? null : Number(r.playoff_seed)),
        status: status,
        overall: { w: r.h2h_w || 0, l: r.h2h_l || 0, t: r.h2h_t || 0, pct: (r.h2h_pct == null ? null : Number(r.h2h_pct)) },
        allplay_pct: (r.allplay_pct == null ? null : Number(r.allplay_pct)),
        apGB: gbMap.hasOwnProperty(fid) ? gbMap[fid] : null
      };
      if (status === 'BYE') byes.push(entry);
      else if (status === 'DIV') divisionWinners.push(entry);
      else if (status === 'WC') wildCards.push(entry);
      else inTheHunt.push(entry);
    });
    function bySeedAsc(a, b) { return (a.seed == null ? 99 : a.seed) - (b.seed == null ? 99 : b.seed); }
    byes.sort(bySeedAsc);
    divisionWinners.sort(bySeedAsc);
    wildCards.sort(bySeedAsc);
    // Teams outside the field stay in the WORKER's order (its ladder) — no re-sort by games back or anything else.
    return { byes: byes, divisionWinners: divisionWinners, wildCards: wildCards, inTheHunt: inTheHunt };
  }

  // ── 9. Weekly views ─────────────────────────────────────────────────
  // completedWeeks / weekTable / seasonWeeklyLeaders / teamWeeklyHistory /
  // scoredFaced: DESCRIPTIVE numbers from the response's own weekly rows.
  // Nothing here seeds, ranks for seeding, or explains a seed. A week's
  // "rank" is the order of that week's scores (1 = highest, ties share the
  // better rank). "Season All-Play rank" (seasonApRank) is the order of
  // cumulative REGULAR-SEASON All-Play % (ties share the rank) — a
  // description of the All-Play table, NOT the seed: the worker seeds
  // (canon §F.1, rows[].playoff_seed / regular_season.seed_by_week).
  //
  // Each takes the whole /api/standings response and returns
  // { status, problems, problem_count, ... }, and never throws:
  //   'ok'          every row it reads is clean and every week it covers is
  //                 complete (every expected franchise scored; in a
  //                 regular-season week every franchise has a game, and every
  //                 game agrees with its reciprocal and with the weekly scores).
  //   'preseason'   the expected franchises' relevant input is genuinely
  //                 EMPTY (nobody has played). Lists are [] / {}.
  //   'incomplete'  F3: a row that can't be read (not an object, no fid or
  //                 opp — it can't be shown to be another league's — or a bad
  //                 week or score), a playoff flag on a relevant row that isn't
  //                 exactly 0 / "0" / false or 1 / "1" / true, two different
  //                 scores for one team-week, a game that disagrees with its
  //                 reciprocal or the weekly scores, a week missing an expected
  //                 franchise, weeks out of sequence, or relevant rows that are
  //                 all playoff rows (that is not preseason). Values are null.
  //   'unavailable' the input couldn't be read: weekly / weeklyScores null (a
  //                 failed query — never treated as []), no rows[], an unknown
  //                 franchise, or a week that hasn't been scored. Values null.
  // Expected franchises = payload.rows. Rows of any other franchise (both
  // sides, for a game) are ignored and never poison the league's own data.
  var MAX_PROBLEMS = 25;
  function capProblems(list) { return list.length > MAX_PROBLEMS ? list.slice(0, MAX_PROBLEMS) : list; }
  function lastRegularWeekOf(payload) {
    var a = payload && payload.regular_season && strictNum(payload.regular_season.last_regular_season_week);
    if (isWeekNum(a)) return a;
    var b = payload && payload.meta && strictNum(payload.meta.last_regular_season_week);
    return isWeekNum(b) ? b : null;
  }
  // One validating pass over the response's weekly rows. Row-level problems
  // (F3) go in `problems` and poison every view; a week that is merely short
  // (a franchise missing, a regular-season team with no game) or whose game
  // scores disagree with its team scores is recorded on that week and poisons
  // only the views that cover it.
  function readSeasonWeeks(payload, needGames) {
    var problems = [];
    var expected = {}, order = [], names = {};
    var rowsIn = (payload && Array.isArray(payload.rows)) ? payload.rows : [];
    rowsIn.forEach(function (r, i) {
      if (!isRowObject(r) || !hasId(r.franchise_id)) { problems.push({ code: 'malformed_standings_row', index: i }); return; }
      var fid = pad4(r.franchise_id);
      if (expected.hasOwnProperty(fid)) return;
      expected[fid] = true;
      order.push(fid);
      names[fid] = r.franchise_name ? String(r.franchise_name) : 'Franchise ' + fid;
    });
    var read = { unavailable: false, problems: problems, expected: expected, order: order, names: names,
      weeks: {}, regularWeeks: [], playoffWeeks: [], allWeeks: [], relevant: false };
    if (!order.length) { read.unavailable = true; read.problems = [{ code: 'no_franchise_rows' }]; return read; }
    var ws = payload.weeklyScores, wk = payload.weekly;
    var unreadable = [];
    if (!Array.isArray(ws)) unreadable.push({ code: 'weekly_scores_unreadable' });
    if (needGames && !Array.isArray(wk)) unreadable.push({ code: 'weekly_unreadable' });
    if (unreadable.length) { read.unavailable = true; read.problems = unreadable; return read; }
    var weeks = read.weeks;
    function weekOf(w, po) {
      return weeks[w] || (weeks[w] = { week: w, po: po, problems: [], scores: {}, games: {}, gameList: {} });
    }
    ws.forEach(function (r, i) {
      if (!isRowObject(r) || !hasId(r.fid)) { problems.push({ code: 'malformed_row', table: 'weeklyScores', index: i }); return; }
      var fid = pad4(r.fid);
      if (!expected.hasOwnProperty(fid)) return; // another league's franchise
      read.relevant = true;
      var po = normalizePo(r.po);
      if (po === null) { problems.push({ code: 'malformed_playoff_flag', table: 'weeklyScores', week: r.w, franchise_id: fid }); return; }
      var w = strictNum(r.w), ts = strictNum(r.ts);
      if (!isWeekNum(w)) { problems.push({ code: 'bad_week', table: 'weeklyScores', franchise_id: fid }); return; }
      if (!isFiniteNum(ts)) { problems.push({ code: 'bad_score', table: 'weeklyScores', week: w, franchise_id: fid }); return; }
      var W = weekOf(w, po);
      if (W.po !== po && !W.mixed) { W.mixed = true; problems.push({ code: 'mixed_playoff_flags', week: w }); }
      if (W.scores.hasOwnProperty(fid) && W.scores[fid] !== ts) problems.push({ code: 'conflicting_score', week: w, franchise_id: fid });
      W.scores[fid] = ts;
    });
    if (needGames) {
      wk.forEach(function (m, i) {
        if (!isRowObject(m) || !hasId(m.fid) || !hasId(m.opp)) { problems.push({ code: 'malformed_row', table: 'weekly', index: i }); return; }
        var fid = pad4(m.fid), opp = pad4(m.opp);
        if (!expected.hasOwnProperty(fid) && !expected.hasOwnProperty(opp)) return; // neither side is this league's
        read.relevant = true;
        var po = normalizePo(m.po);
        if (po === null) { problems.push({ code: 'malformed_playoff_flag', table: 'weekly', week: m.w, franchise_id: fid, opponent_franchise_id: opp }); return; }
        if (!expected.hasOwnProperty(fid)) return; // the other league's side of a game — only our own rows enter
        var w = strictNum(m.w), ts = strictNum(m.ts), os = strictNum(m.os);
        if (!isWeekNum(w)) { problems.push({ code: 'bad_week', table: 'weekly', franchise_id: fid }); return; }
        if (!isFiniteNum(ts) || !isFiniteNum(os)) { problems.push({ code: 'bad_score', table: 'weekly', week: w, franchise_id: fid }); return; }
        var W = weeks[w];
        if (!W || !W.scores.hasOwnProperty(fid)) { problems.push({ code: 'game_without_week_score', week: w, franchise_id: fid }); return; }
        if (W.po !== po) problems.push({ code: 'playoff_flag_mismatch', week: w, franchise_id: fid });
        // A game whose score disagrees with that week's team scores (e.g. a stat correction that reached one table and
        // not the other — 2025 Week 17) is a fault of THAT week: it fails every view covering the week and no other
        // (Keith, #1329 decision 2: "fail only the affected Week 17 data"). Every other week still passes each check.
        if (W.scores[fid] !== ts || (W.scores.hasOwnProperty(opp) && W.scores[opp] !== os)) W.problems.push({ code: 'game_score_mismatch', week: w, franchise_id: fid, opponent_franchise_id: opp });
        var g = W.games[fid] || (W.games[fid] = {});
        if (g.hasOwnProperty(opp)) {
          if (g[opp].ts !== ts || g[opp].os !== os) problems.push({ code: 'conflicting_game', week: w, franchise_id: fid, opponent_franchise_id: opp });
          return; // an identical duplicate is the same game
        }
        g[opp] = { opp: opp, ts: ts, os: os };
        (W.gameList[fid] || (W.gameList[fid] = [])).push(g[opp]);
      });
    }
    var all = Object.keys(weeks).map(Number).sort(function (a, b) { return a - b; });
    all.forEach(function (w) {
      var W = weeks[w];
      var missing = order.filter(function (fid) { return !W.scores.hasOwnProperty(fid); });
      if (missing.length) W.problems.push({ code: 'partial_week', week: w, missing: missing });
      if (!needGames) return;
      Object.keys(W.games).forEach(function (fid) {
        Object.keys(W.games[fid]).forEach(function (opp) {
          var e = W.games[fid][opp];
          if (!expected.hasOwnProperty(opp)) { problems.push({ code: 'foreign_opponent', week: w, franchise_id: fid, opponent_franchise_id: opp }); return; }
          var recip = W.games[opp] && W.games[opp][fid];
          if (!recip) problems.push({ code: 'missing_reciprocal', week: w, franchise_id: fid, opponent_franchise_id: opp });
          else if (recip.ts !== e.os || recip.os !== e.ts) problems.push({ code: 'conflicting_game', week: w, franchise_id: fid, opponent_franchise_id: opp });
        });
      });
      if (W.po === false) {
        var noGame = order.filter(function (fid) { return W.scores.hasOwnProperty(fid) && !(W.gameList[fid] && W.gameList[fid].length); });
        if (noGame.length) W.problems.push({ code: 'missing_games', week: w, franchise_ids: noGame });
      }
    });
    read.allWeeks = all;
    read.regularWeeks = all.filter(function (w) { return weeks[w].po === false; });
    read.playoffWeeks = all.filter(function (w) { return weeks[w].po === true; });
    // Weeks in sequence: regular weeks run 1..k, playoff weeks come after them, and (when the response says where the
    // regular season ends) neither kind crosses that line. A gap means a week failed to load.
    read.regularWeeks.forEach(function (w, i) { if (w !== i + 1) problems.push({ code: 'week_gap', week: i + 1 }); });
    var maxReg = read.regularWeeks.length ? read.regularWeeks[read.regularWeeks.length - 1] : 0;
    if (read.playoffWeeks.length && !read.regularWeeks.length) problems.push({ code: 'playoff_without_regular_season' });
    read.playoffWeeks.forEach(function (w) { if (w <= maxReg) problems.push({ code: 'playoff_week_before_regular_week', week: w }); });
    var lastReg = lastRegularWeekOf(payload);
    if (lastReg != null) {
      read.regularWeeks.forEach(function (w) { if (w > lastReg) problems.push({ code: 'regular_flag_after_last_regular_week', week: w }); });
      read.playoffWeeks.forEach(function (w) { if (w <= lastReg) problems.push({ code: 'playoff_flag_in_regular_week', week: w }); });
      if (read.playoffWeeks.length && maxReg !== lastReg) problems.push({ code: 'playoffs_before_regular_season_complete', week: maxReg + 1 });
    }
    return read;
  }
  // Status for a view covering `scope` (week numbers). Row-level problems always count; a week's own shortfall counts
  // only when the view covers that week.
  function scopeStatus(read, scope) {
    if (read.unavailable) return { status: 'unavailable', problems: read.problems };
    var probs = read.problems.slice();
    scope.forEach(function (w) { var W = read.weeks[w]; if (W) probs = probs.concat(W.problems); });
    if (probs.length) return { status: 'incomplete', problems: probs };
    if (!read.relevant) return { status: 'preseason', problems: [] };
    return { status: 'ok', problems: [] };
  }
  function viewResult(st, fields) {
    var out = { status: st.status, problems: capProblems(st.problems || []), problem_count: (st.problems || []).length };
    Object.keys(fields).forEach(function (k) { out[k] = fields[k]; });
    return out;
  }
  // One week's descriptive numbers for every expected franchise (the week must be complete).
  function weekStats(read, w) {
    var W = read.weeks[w];
    var out = {};
    read.order.forEach(function (fid) {
      var s = W.scores[fid];
      var higher = 0, lower = 0, equal = 0;
      read.order.forEach(function (o) {
        if (o === fid) return;
        var so = W.scores[o];
        if (so > s) higher++; else if (so < s) lower++; else equal++;
      });
      var rec = { w: 0, l: 0, t: 0 };
      var games = (W.gameList[fid] || []).map(function (g) {
        var result = g.ts > g.os ? 'W' : g.ts < g.os ? 'L' : 'T';
        rec[result === 'W' ? 'w' : result === 'L' ? 'l' : 't']++;
        return { opp: g.opp, opp_name: read.names[g.opp] || 'Franchise ' + g.opp, ts: g.ts, os: g.os, result: result };
      });
      out[fid] = { score: s, rank: higher + 1, bottomRank: lower + 1, ap: { w: lower, l: higher, t: equal }, games: games, record: rec };
    });
    return out;
  }
  function recPct(r) { var n = r.w + r.l + r.t; return n ? (r.w + 0.5 * r.t) / n : null; }
  function withPct(r) { return { w: r.w, l: r.l, t: r.t, pct: recPct(r) }; }
  // Cumulative REGULAR-SEASON All-Play record after each regular week; through(k) = the record over regular weeks <= k
  // (null when no regular week is <= k).
  function cumulativeApThrough(read, statsByWeek, limit) {
    var running = {};
    read.order.forEach(function (f) { running[f] = { w: 0, l: 0, t: 0 }; });
    var snaps = [];
    read.regularWeeks.forEach(function (w) {
      if (limit != null && w > limit) return; // weeks after the view's own week are outside its scope
      var st = statsByWeek[w] || (statsByWeek[w] = weekStats(read, w));
      var copy = {};
      read.order.forEach(function (f) {
        var a = st[f].ap;
        running[f] = { w: running[f].w + a.w, l: running[f].l + a.l, t: running[f].t + a.t };
        copy[f] = running[f];
      });
      snaps.push({ week: w, rec: copy });
    });
    return function through(k) {
      var found = null;
      for (var i = 0; i < snaps.length; i++) if (snaps[i].week <= k) found = snaps[i].rec;
      return found;
    };
  }
  // Descriptive season All-Play rank: 1 + teams with a strictly better cumulative regular-season All-Play %
  // (exact fractions, ties share the rank). NOT the seed.
  function seasonApRankMap(recByFid, order) {
    if (!recByFid) return null;
    var out = {};
    order.forEach(function (f) {
      var a = recByFid[f], an = 2 * (a.w + a.l + a.t), ax = 2 * a.w + a.t;
      var better = 0;
      order.forEach(function (o) {
        if (o === f) return;
        var b = recByFid[o], bn = 2 * (b.w + b.l + b.t), bx = 2 * b.w + b.t;
        if (bx * an > ax * bn) better++;
      });
      out[f] = better + 1;
    });
    return out;
  }
  // Score order for one week: highest first; equal scores keep the response's row order.
  function sortedByScore(read, st) {
    return read.order.map(function (f, i) { return { f: f, i: i }; })
      .sort(function (a, b) { return (st[b.f].score - st[a.f].score) || (a.i - b.i); })
      .map(function (x) { return x.f; });
  }
  // { franchise_ids, score, margin_over_second, second_franchise_id, second_franchise_ids }; a shared top score has
  // margin 0 and no single second.
  function topOfWeek(read, st) {
    var sorted = sortedByScore(read, st);
    var top = st[sorted[0]].score;
    var ids = sorted.filter(function (f) { return st[f].score === top; });
    var rest = sorted.filter(function (f) { return st[f].score !== top; });
    if (ids.length > 1) return { franchise_ids: ids, score: top, margin_over_second: 0, second_franchise_id: null, second_franchise_ids: [] };
    if (!rest.length) return { franchise_ids: ids, score: top, margin_over_second: null, second_franchise_id: null, second_franchise_ids: [] };
    var second = st[rest[0]].score;
    var secondIds = rest.filter(function (f) { return st[f].score === second; });
    return { franchise_ids: ids, score: top, margin_over_second: (hundredths(top) - hundredths(second)) / 100, second_franchise_id: secondIds[0], second_franchise_ids: secondIds };
  }
  function lowOfWeek(read, st) {
    var sorted = sortedByScore(read, st);
    var low = st[sorted[sorted.length - 1]].score;
    return { franchise_ids: sorted.filter(function (f) { return st[f].score === low; }), score: low };
  }
  function safeView(fn, fallback) {
    try { return fn(); } catch (e) { return viewResult({ status: 'unavailable', problems: [{ code: 'internal_error', message: String(e && e.message || e) }] }, fallback); }
  }

  // a. completedWeeks(payload) → { status, problems, regular: [weeks], playoff: [weeks] } — the weeks fully scored for
  //    every expected franchise (weeklyScores only). Any short week makes the result incomplete (lists null).
  function completedWeeks(payload) {
    return safeView(function () {
      var read = readSeasonWeeks(payload, false);
      var st = scopeStatus(read, read.allWeeks);
      if (st.status === 'preseason') return viewResult(st, { regular: [], playoff: [] });
      if (st.status !== 'ok') return viewResult(st, { regular: null, playoff: null });
      return viewResult(st, { regular: read.regularWeeks.slice(), playoff: read.playoffWeeks.slice() });
    }, { regular: null, playoff: null });
  }

  // b. weekTable(payload, week) → { status, problems, week, isPlayoff, rows, top, low }.
  //    rows (score order, highest first): { franchise_id, name, score, rank (ties share the better rank), ap {w,l,t}
  //    that week, games [{ opp, opp_name, ts, os, result }], record {w,l,t} that week, seasonApRank,
  //    seasonApRankBefore, apRankChange (positive = moved up) }. seasonApRank is DESCRIPTIVE — cumulative
  //    regular-season All-Play % through this week (ties share the rank) — and is NOT the seed.
  //    Covers this week and every regular-season week before it (the cumulative All-Play needs them).
  function weekTable(payload, week) {
    var w = strictNum(week);
    var nulls = { week: isWeekNum(w) ? w : null, isPlayoff: null, rows: null, top: null, low: null };
    return safeView(function () {
      if (!isWeekNum(w)) return viewResult({ status: 'unavailable', problems: [{ code: 'bad_week_argument' }] }, nulls);
      var read = readSeasonWeeks(payload, true);
      var scope = read.regularWeeks.filter(function (x) { return x <= w; });
      if (scope.indexOf(w) < 0) scope.push(w);
      var st = scopeStatus(read, scope);
      if (st.status !== 'ok') return viewResult(st, nulls);
      if (!read.weeks[w]) return viewResult({ status: 'unavailable', problems: [{ code: 'week_not_scored', week: w }] }, nulls);
      var statsByWeek = {};
      var stw = statsByWeek[w] = weekStats(read, w);
      var through = cumulativeApThrough(read, statsByWeek, w);
      var after = seasonApRankMap(through(w), read.order);
      var before = seasonApRankMap(through(w - 1), read.order);
      var rows = sortedByScore(read, stw).map(function (f) {
        var s = stw[f];
        var ra = after ? after[f] : null, rb = before ? before[f] : null;
        return {
          franchise_id: f, name: read.names[f], score: s.score, rank: s.rank, ap: s.ap, games: s.games, record: s.record,
          seasonApRank: ra, seasonApRankBefore: rb, apRankChange: (ra != null && rb != null) ? rb - ra : null
        };
      });
      return viewResult(st, { week: w, isPlayoff: read.weeks[w].po === true, rows: rows, top: topOfWeek(read, stw), low: lowOfWeek(read, stw) });
    }, nulls);
  }

  // c. seasonWeeklyLeaders(payload, { weeks: 'regular' | 'all' }) → { status, problems, weeks: [{ week, isPlayoff,
  //    top_franchise_ids, score, margin_over_second }], byFranchise: { fid: { topWeeks, top3, bottom3, avgRank,
  //    bestRank, worstRank, highScore {week,score}, lowScore {week,score} } } }. weeklyScores only.
  //    'regular' (the default) = regular-season weeks; 'playoff' = the playoff weeks only; 'all' = both. Which weeks
  //    count for the league's weekly high-score payout is an open rule question (#1329), so nothing here calls a top
  //    score a prize. Ties: every team on the top score gets the week; bottom3 = at most two teams scored lower;
  //    high/low score ties go to the earliest week.
  function seasonWeeklyLeaders(payload, opts) {
    var nulls = { weeks: null, byFranchise: null };
    return safeView(function () {
      var mode = (opts && opts.weeks != null) ? opts.weeks : 'regular';
      if (mode !== 'regular' && mode !== 'all' && mode !== 'playoff') return viewResult({ status: 'unavailable', problems: [{ code: 'bad_weeks_option', value: String(mode) }] }, nulls);
      var read = readSeasonWeeks(payload, false);
      var scope = mode === 'all' ? read.allWeeks : mode === 'playoff' ? read.playoffWeeks : read.regularWeeks;
      var st = scopeStatus(read, scope);
      if (st.status === 'preseason') return viewResult(st, { weeks: [], byFranchise: {} });
      if (st.status === 'ok' && !scope.length) st = { status: 'incomplete', problems: [{ code: 'no_weeks_in_scope' }] };
      if (st.status !== 'ok') return viewResult(st, nulls);
      var by = {};
      read.order.forEach(function (f) { by[f] = { topWeeks: 0, top3: 0, bottom3: 0, avgRank: null, bestRank: null, worstRank: null, highScore: null, lowScore: null, _ranks: 0 }; });
      var weeks = scope.map(function (w) {
        var stw = weekStats(read, w);
        read.order.forEach(function (f) {
          var s = stw[f], b = by[f];
          if (s.rank === 1) b.topWeeks++;
          if (s.rank <= 3) b.top3++;
          if (s.bottomRank <= 3) b.bottom3++;
          b._ranks += s.rank;
          b.bestRank = b.bestRank == null ? s.rank : Math.min(b.bestRank, s.rank);
          b.worstRank = b.worstRank == null ? s.rank : Math.max(b.worstRank, s.rank);
          if (!b.highScore || s.score > b.highScore.score) b.highScore = { week: w, score: s.score };
          if (!b.lowScore || s.score < b.lowScore.score) b.lowScore = { week: w, score: s.score };
        });
        var top = topOfWeek(read, stw);
        return { week: w, isPlayoff: read.weeks[w].po === true, top_franchise_ids: top.franchise_ids, score: top.score, margin_over_second: top.margin_over_second };
      });
      read.order.forEach(function (f) { by[f].avgRank = ratio2(by[f]._ranks, scope.length); delete by[f]._ranks; });
      return viewResult(st, { weeks: weeks, byFranchise: by });
    }, nulls);
  }

  // d. teamWeeklyHistory(payload, fid) → { status, problems, weeks: [{ week, isPlayoff, unavailable, score, rank, ap,
  //    games, cumulativeAp {w,l,t,pct} (regular season through that week), seasonApRank (descriptive, NOT the seed) }],
  //    seedByWeek: [{ week, orderIndex, seed, inField }], unavailableWeeks: [{ week, problems }] }. A week that fails
  //    its own checks is listed with unavailable: true and null values (its problems attached); the other weeks still
  //    show, and the running All-Play stops (null) from the first unverified regular-season week on. seedByWeek is the WORKER's seed order after each completed
  //    week (payload.regular_season.seed_by_week; [] when absent): seed = orderIndex + 1 inside the top six, else null.
  //    A week the worker couldn't seed reads orderIndex/seed/inField null.
  function seedHistoryFor(payload, fid) {
    var sbw = payload && payload.regular_season && payload.regular_season.seed_by_week;
    if (!sbw || typeof sbw !== 'object' || Array.isArray(sbw)) return [];
    var p = pad4(fid);
    return Object.keys(sbw).map(Number).filter(isWeekNum).sort(function (a, b) { return a - b; }).map(function (w) {
      var list = sbw[w];
      var idx = Array.isArray(list) ? list.map(function (x) { return hasId(x) ? pad4(x) : null; }).indexOf(p) : -1;
      if (idx < 0) return { week: w, orderIndex: null, seed: null, inField: null };
      return { week: w, orderIndex: idx, seed: idx < 6 ? idx + 1 : null, inField: idx < 6 };
    });
  }
  function teamWeeklyHistory(payload, fid) {
    var nulls = { weeks: null, seedByWeek: [], unavailableWeeks: [] };
    return safeView(function () {
      var read = readSeasonWeeks(payload, true);
      if (read.unavailable) return viewResult({ status: 'unavailable', problems: read.problems }, nulls);
      var p = hasId(fid) ? pad4(fid) : null;
      if (!p || !read.expected.hasOwnProperty(p)) return viewResult({ status: 'unavailable', problems: [{ code: 'unknown_franchise' }] }, nulls);
      var seedByWeek = seedHistoryFor(payload, p);
      // Row-level (season-wide) problems still fail the whole view. A week with its own problem is listed as
      // unavailable and the other weeks still show; the running All-Play stops at the first unverified regular week.
      var st = scopeStatus(read, []);
      if (st.status === 'preseason') return viewResult(st, { weeks: [], seedByWeek: seedByWeek, unavailableWeeks: [] });
      if (st.status !== 'ok') return viewResult(st, { weeks: null, seedByWeek: seedByWeek, unavailableWeeks: [] });
      var bad = {}, unavailableWeeks = [];
      read.allWeeks.forEach(function (w) {
        if (read.weeks[w].problems.length) { bad[w] = true; unavailableWeeks.push({ week: w, problems: capProblems(read.weeks[w].problems) }); }
      });
      var firstBadRegular = null;
      read.regularWeeks.forEach(function (w) { if (bad[w] && firstBadRegular == null) firstBadRegular = w; });
      var statsByWeek = {};
      read.allWeeks.forEach(function (w) { if (!bad[w]) statsByWeek[w] = weekStats(read, w); });
      var through = cumulativeApThrough(read, statsByWeek, firstBadRegular == null ? null : firstBadRegular - 1);
      var weeks = read.allWeeks.map(function (w) {
        var isPlayoff = read.weeks[w].po === true;
        if (bad[w]) return { week: w, isPlayoff: isPlayoff, unavailable: true, problems: capProblems(read.weeks[w].problems), score: null, rank: null, ap: null, games: null, cumulativeAp: null, seasonApRank: null };
        var s = statsByWeek[w][p];
        var cum = (firstBadRegular != null && w >= firstBadRegular) ? null : through(w);
        var ranks = seasonApRankMap(cum, read.order);
        return {
          week: w, isPlayoff: isPlayoff, unavailable: false, score: s.score, rank: s.rank, ap: s.ap, games: s.games,
          cumulativeAp: cum ? withPct(cum[p]) : null, seasonApRank: ranks ? ranks[p] : null
        };
      });
      return viewResult(st, { weeks: weeks, seedByWeek: seedByWeek, unavailableWeeks: unavailableWeeks });
    }, nulls);
  }

  // describeProblems(problems) → plain sentences for why a view can't be shown, the same words on both screens
  // (#1329 decision 2: say what is wrong, and which week, never a week that is fine). Grouped by kind and week; a game
  // reported from both sides counts once. Unknown kinds fall back to their code in words.
  function describeProblems(problems) {
    var list = Array.isArray(problems) ? problems.filter(isRowObject) : [];
    var order = [], groups = {};
    list.forEach(function (p) {
      var key = String(p.code) + '|' + (p.week == null ? '' : p.week);
      if (!groups[key]) { groups[key] = { code: String(p.code || ''), week: p.week == null ? null : p.week, items: [] }; order.push(key); }
      groups[key].items.push(p);
    });
    function games(items) {
      var seen = {};
      items.forEach(function (p) { if (hasId(p.franchise_id) && hasId(p.opponent_franchise_id)) seen[[pad4(p.franchise_id), pad4(p.opponent_franchise_id)].sort().join('-')] = true; });
      return Object.keys(seen).length || items.length;
    }
    function teams(items) {
      var seen = {};
      items.forEach(function (p) {
        (Array.isArray(p.missing) ? p.missing : []).concat(Array.isArray(p.franchise_ids) ? p.franchise_ids : []).forEach(function (f) { seen[pad4(f)] = true; });
      });
      return Object.keys(seen).length;
    }
    function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
    return order.map(function (key) {
      var g = groups[key], wk = g.week != null ? 'Week ' + g.week : null;
      if (g.code === 'game_score_mismatch') {
        var n = games(g.items);
        return (wk ? wk + ': ' : '') + plural(n, 'game score doesn’t', 'game scores don’t') + ' match the teams’ final weekly scores.';
      }
      if (g.code === 'partial_week') return (wk ? wk + ' is' : 'A week is') + ' missing scores for ' + plural(teams(g.items), 'team', 'teams') + '.';
      if (g.code === 'missing_games') return (wk ? wk + ' has' : 'A week has') + ' no game for ' + plural(teams(g.items), 'team', 'teams') + '.';
      if (g.code === 'week_gap') return (wk || 'A week') + ' is missing from the results.';
      var words = g.code.replace(/_/g, ' ');
      return words.charAt(0).toUpperCase() + words.slice(1) + (wk ? ' (' + wk + ')' : '') + '.';
    });
  }

  // e. scoredFaced(payload) → regular season only → { status, problems, byFranchise: { fid: {
  //      scored: { pf, pfPerWeek, pfRank (1 = most), avgWeeklyRank, highWeek {week,score}, lowWeek {week,score},
  //                last3: { weeks, avgRank, ap {w,l,t,pct} } },
  //      faced:  { paPerGame, paRank (1 = faced the most points per game), oppVsUsual, closeGames {w,l,t} },
  //      overall: { record, ap, expectedWins, luck, pf, paPerGame } } } }.
  //    Points For is the sum of ONE score per week; Points Against is per GAME (a week can hold two or three games:
  //    2026 has 37 games in 14 weeks). oppVsUsual = mean over your games of (the opponent's score that week minus that
  //    opponent's average weekly score over the OTHER regular-season weeks); positive = opponents played above their
  //    usual (null before a second week). closeGames = games decided by fewer than 10 points (ties count as t).
  //    expectedWins = sum over your games of your All-Play share that week ((AP wins + ties/2) / other teams);
  //    luck = (wins + ties/2) − expectedWins. Ranks share ties. Points are rounded to hundredths the way the worker
  //    rounds regular_season (season total first, then per week / per game), so the two agree to the hundredth.
  function scoredFaced(payload) {
    var nulls = { byFranchise: null };
    return safeView(function () {
      var read = readSeasonWeeks(payload, true);
      var scope = read.regularWeeks;
      var st = scopeStatus(read, scope);
      if (st.status === 'preseason') return viewResult(st, { byFranchise: {} });
      if (st.status === 'ok' && !scope.length) st = { status: 'incomplete', problems: [{ code: 'no_regular_season_weeks' }] };
      if (st.status !== 'ok') return viewResult(st, nulls);
      var stats = {};
      scope.forEach(function (w) { stats[w] = weekStats(read, w); });
      var others = read.order.length - 1;
      var n = scope.length;
      var pfC = {}; // season Points For in hundredths: one score a week
      read.order.forEach(function (f) { pfC[f] = 0; scope.forEach(function (w) { pfC[f] += hundredths(stats[w][f].score); }); });
      var acc = {};
      read.order.forEach(function (f) {
        var ranks = 0, high = null, low = null, ap = { w: 0, l: 0, t: 0 };
        var rec = { w: 0, l: 0, t: 0 }, close = { w: 0, l: 0, t: 0 };
        var games = 0, paC = 0, ewNum = 0, ovuNum = 0;
        scope.forEach(function (w) {
          var s = stats[w][f];
          ranks += s.rank;
          if (!high || s.score > high.score) high = { week: w, score: s.score };
          if (!low || s.score < low.score) low = { week: w, score: s.score };
          ap = { w: ap.w + s.ap.w, l: ap.l + s.ap.l, t: ap.t + s.ap.t };
          s.games.forEach(function (g) {
            var k = g.result === 'W' ? 'w' : g.result === 'L' ? 'l' : 't';
            games++;
            paC += hundredths(g.os);
            rec[k]++;
            if (Math.abs(hundredths(g.ts) - hundredths(g.os)) < 1000) close[k]++; // decided by fewer than 10 points
            ewNum += 2 * s.ap.w + s.ap.t; // this week's All-Play share, x 2·others
            // (opponent's score − its average over the OTHER weeks) x (n − 1), in hundredths
            if (n > 1) ovuNum += hundredths(g.os) * (n - 1) - (pfC[g.opp] - hundredths(stats[w][g.opp].score));
          });
        });
        var lastWeeks = scope.slice(-3);
        var l3ap = { w: 0, l: 0, t: 0 }, l3rank = 0;
        lastWeeks.forEach(function (w) { var s = stats[w][f]; l3rank += s.rank; l3ap = { w: l3ap.w + s.ap.w, l: l3ap.l + s.ap.l, t: l3ap.t + s.ap.t }; });
        var paPerGame = games ? Math.round(paC / games) / 100 : null;
        acc[f] = {
          pfCents: pfC[f], paCents: paC, games: games,
          scored: {
            pf: pfC[f] / 100, pfPerWeek: Math.round(pfC[f] / n) / 100, pfRank: null,
            avgWeeklyRank: ratio2(ranks, n), highWeek: high, lowWeek: low,
            last3: { weeks: lastWeeks, avgRank: ratio2(l3rank, lastWeeks.length), ap: withPct(l3ap) }
          },
          faced: { paPerGame: paPerGame, paRank: null, oppVsUsual: (n > 1 && games) ? Math.round(ovuNum / ((n - 1) * games)) / 100 : null, closeGames: close },
          overall: {
            record: withPct(rec), ap: withPct(ap),
            expectedWins: others > 0 ? ratio2(ewNum, 2 * others) : null,
            luck: others > 0 ? ratio2((2 * rec.w + rec.t) * others - ewNum, 2 * others) : null,
            pf: pfC[f] / 100, paPerGame: paPerGame
          }
        };
      });
      read.order.forEach(function (f) {
        var a = acc[f], pfBetter = 0, paBetter = 0;
        read.order.forEach(function (o) {
          if (o === f) return;
          var b = acc[o];
          if (b.pfCents > a.pfCents) pfBetter++;
          if (b.games && a.games && b.paCents * a.games > a.paCents * b.games) paBetter++;
        });
        a.scored.pfRank = pfBetter + 1;
        a.faced.paRank = a.games ? paBetter + 1 : null;
      });
      var by = {};
      read.order.forEach(function (f) { by[f] = { scored: acc[f].scored, faced: acc[f].faced, overall: acc[f].overall }; });
      return viewResult(st, { byFranchise: by });
    }, nulls);
  }

  // f. matchupTape(payload, fidA, fidB, extras) → the Tale of the Tape for one playoff or Hawk Tuah Bowl matchup.
  //    Descriptive only: it says which side has been stronger in each category and never predicts a winner.
  //    { status, problems, weeks: { regular: [..], last3: [..] }, a, b, meetings: [{ week, isPlayoff, aScore, bScore,
  //      result }], edges: { <category>: 'a' | 'b' | 'even' }, quickEdges: { a, b, even }, offenseIdpStatus }
  //    a / b: { franchise_id, name, record {w,l,t,pct} (regular-season H2H games), ap {w,l,t,pct},
  //      avg {value, rank}, last3 {avg, rank, ap}, apPerWeek {value, rank}, consistency {spread, rank},
  //      ceiling { high {value, week, rank}, top3 {value, rank}, median {value, rank}, bottom3 {value, rank},
  //                low {value, week, rank} },
  //      offense {perWeek, rank} | null, idp {perWeek, rank} | null, faced {perGame, rank} }
  //    Ranks are among every team in the response and share ties: 1 = highest, except consistency (1 = the smallest
  //    week-to-week spread, the population standard deviation of the weekly scores) and faced (1 = faced the most
  //    points per game; schedule, never skill). Season numbers use regular-season weeks. last3 = the three most
  //    recent completed weeks of any kind (regular or playoff); it describes recent results and predicts the rest of
  //    a season less well than the full season does (#1329 backtest), so nothing ranks it above the season.
  //    extras.offenseIdp = { fid: { op, dp } } from MFL leagueStandings (offensive-player and IDP points). It is used
  //    only when every team has numeric op and dp that add up to that team's regular-season Points For (within 0.15);
  //    otherwise offense and idp are null and offenseIdpStatus says why ('missing' | 'mismatch').
  //    extras.throughWeek = N describes the teams as they stood BEFORE a played game: only weeks <= N count, and a
  //    week-specific problem in a later week (e.g. a stat correction that reached one table and not the other) is
  //    outside the view. A malformed playoff flag in any week still blocks everything (F3).
  function median(list) {
    var xs = list.slice().sort(function (p, q) { return p - q; });
    var n = xs.length;
    if (!n) return null;
    return n % 2 ? xs[(n - 1) / 2] : (xs[n / 2 - 1] + xs[n / 2]) / 2;
  }
  function meanOf(list) {
    if (!list.length) return null;
    var c = 0;
    list.forEach(function (x) { c += hundredths(x); });
    return Math.round(c / list.length) / 100;
  }
  function spreadOf(list) {
    if (!list.length) return null;
    var m = list.reduce(function (p, q) { return p + q; }, 0) / list.length;
    var v = list.reduce(function (p, q) { return p + (q - m) * (q - m); }, 0) / list.length;
    return round2(Math.sqrt(v));
  }
  // 1 + teams strictly better (compared in hundredths, so float noise never splits a tie).
  function rankAmong(values, fid, lowerIsBetter) {
    var mine = values[fid];
    if (mine == null) return null;
    var better = 0;
    Object.keys(values).forEach(function (o) {
      if (o === fid || values[o] == null) return;
      var a = hundredths(values[o]), b = hundredths(mine);
      if (lowerIsBetter ? a < b : a > b) better++;
    });
    return better + 1;
  }
  function matchupTape(payload, fidA, fidB, extras) {
    var nulls = { weeks: null, a: null, b: null, meetings: null, edges: null, quickEdges: null, offenseIdpStatus: null };
    return safeView(function () {
      var read = readSeasonWeeks(payload, true);
      if (read.unavailable) return viewResult({ status: 'unavailable', problems: read.problems }, nulls);
      var A = hasId(fidA) ? pad4(fidA) : null, B = hasId(fidB) ? pad4(fidB) : null;
      if (!A || !B || A === B || !read.expected.hasOwnProperty(A) || !read.expected.hasOwnProperty(B)) {
        return viewResult({ status: 'unavailable', problems: [{ code: 'unknown_franchise' }] }, nulls);
      }
      var through = extras && extras.throughWeek != null ? strictNum(extras.throughWeek) : null;
      if (through != null && !isWeekNum(through)) return viewResult({ status: 'unavailable', problems: [{ code: 'bad_through_week' }] }, nulls);
      if (through != null) {
        var F3 = { malformed_playoff_flag: true, mixed_playoff_flags: true, playoff_flag_mismatch: true };
        read.problems = read.problems.filter(function (p) { return F3[p.code] || p.week == null || !(Number(p.week) > through); });
        read.allWeeks = read.allWeeks.filter(function (w) { return w <= through; });
        read.regularWeeks = read.regularWeeks.filter(function (w) { return w <= through; });
      }
      var st = scopeStatus(read, read.allWeeks);
      if (st.status === 'ok' && !read.regularWeeks.length) st = { status: 'incomplete', problems: [{ code: 'no_regular_season_weeks' }] };
      if (st.status !== 'ok') return viewResult(st, nulls);
      var stats = {};
      read.allWeeks.forEach(function (w) { stats[w] = weekStats(read, w); });
      var reg = read.regularWeeks, last = read.allWeeks.slice(-3), n = reg.length;
      var per = {};
      read.order.forEach(function (f) {
        var scores = reg.map(function (w) { return stats[w][f].score; });
        var desc = scores.slice().sort(function (p, q) { return q - p; });
        var ap = { w: 0, l: 0, t: 0 }, rec = { w: 0, l: 0, t: 0 }, games = 0, paC = 0, pfC = 0, high = null, low = null;
        reg.forEach(function (w) {
          var s = stats[w][f];
          pfC += hundredths(s.score);
          ap = { w: ap.w + s.ap.w, l: ap.l + s.ap.l, t: ap.t + s.ap.t };
          if (!high || s.score > high.score) high = { week: w, score: s.score };
          if (!low || s.score < low.score) low = { week: w, score: s.score };
          s.games.forEach(function (g) {
            games++; paC += hundredths(g.os);
            rec[g.result === 'W' ? 'w' : g.result === 'L' ? 'l' : 't']++;
          });
        });
        var l3ap = { w: 0, l: 0, t: 0 };
        last.forEach(function (w) { var a = stats[w][f].ap; l3ap = { w: l3ap.w + a.w, l: l3ap.l + a.l, t: l3ap.t + a.t }; });
        per[f] = {
          pfCents: pfC, record: withPct(rec), ap: withPct(ap),
          avg: meanOf(scores), last3avg: meanOf(last.map(function (w) { return stats[w][f].score; })), last3ap: withPct(l3ap),
          apPerWeek: ratio2(2 * ap.w + ap.t, 2 * n), spread: spreadOf(scores),
          high: high, low: low, top3: meanOf(desc.slice(0, 3)), bottom3: meanOf(desc.slice(-3)), median: median(scores),
          faced: games ? Math.round(paC / games) / 100 : null
        };
      });
      function col(key, sub) {
        var out = {};
        read.order.forEach(function (f) { var v = per[f][key]; out[f] = (sub && v) ? v[sub] : v; });
        return out;
      }
      // Offensive-player and IDP points (MFL leagueStandings op / dp), checked against the weekly scores.
      var oi = extras && extras.offenseIdp, offenseIdpStatus = 'ok', offense = {}, idp = {};
      if (!oi || typeof oi !== 'object') offenseIdpStatus = 'missing';
      else read.order.forEach(function (f) {
        var e = oi[f] || oi[Number(f)] || null;
        var op = e ? strictNum(e.op) : null, dp = e ? strictNum(e.dp) : null;
        if (!isFiniteNum(op) || !isFiniteNum(dp)) { if (offenseIdpStatus === 'ok') offenseIdpStatus = 'missing'; return; }
        if (Math.abs(hundredths(op) + hundredths(dp) - per[f].pfCents) > 15) { offenseIdpStatus = 'mismatch'; return; }
        offense[f] = round2(op / n); idp[f] = round2(dp / n);
      });
      if (offenseIdpStatus !== 'ok') { offense = null; idp = null; }
      var cols = {
        avg: col('avg'), last3: col('last3avg'), apPerWeek: col('apPerWeek'), spread: col('spread'),
        high: col('high', 'score'), top3: col('top3'), median: col('median'), bottom3: col('bottom3'), low: col('low', 'score'),
        faced: col('faced'), l3ap: {}
      };
      read.order.forEach(function (f) { cols.l3ap[f] = per[f].last3ap.pct; });
      function side(f) {
        var p = per[f];
        return {
          franchise_id: f, name: read.names[f], record: p.record, ap: p.ap,
          avg: { value: p.avg, rank: rankAmong(cols.avg, f) },
          last3: { avg: p.last3avg, rank: rankAmong(cols.last3, f), ap: p.last3ap },
          apPerWeek: { value: p.apPerWeek, rank: rankAmong(cols.apPerWeek, f) },
          consistency: { spread: p.spread, rank: rankAmong(cols.spread, f, true) },
          ceiling: {
            high: { value: p.high ? p.high.score : null, week: p.high ? p.high.week : null, rank: rankAmong(cols.high, f) },
            top3: { value: p.top3, rank: rankAmong(cols.top3, f) },
            median: { value: p.median, rank: rankAmong(cols.median, f) },
            bottom3: { value: p.bottom3, rank: rankAmong(cols.bottom3, f) },
            low: { value: p.low ? p.low.score : null, week: p.low ? p.low.week : null, rank: rankAmong(cols.low, f) }
          },
          offense: offense ? { perWeek: offense[f], rank: rankAmong(offense, f) } : null,
          idp: idp ? { perWeek: idp[f], rank: rankAmong(idp, f) } : null,
          faced: { perGame: p.faced, rank: rankAmong(cols.faced, f) }
        };
      }
      function edge(av, bv, lowerIsBetter) {
        if (av == null || bv == null) return null;
        var x = hundredths(av), y = hundredths(bv);
        if (x === y) return 'even';
        return (lowerIsBetter ? x < y : x > y) ? 'a' : 'b';
      }
      var a = side(A), b = side(B);
      var edges = {
        avg: edge(a.avg.value, b.avg.value), last3: edge(a.last3.avg, b.last3.avg), last3ap: edge(a.last3.ap.pct, b.last3.ap.pct),
        apPerWeek: edge(a.apPerWeek.value, b.apPerWeek.value), consistency: edge(a.consistency.spread, b.consistency.spread, true),
        high: edge(a.ceiling.high.value, b.ceiling.high.value), top3: edge(a.ceiling.top3.value, b.ceiling.top3.value),
        median: edge(a.ceiling.median.value, b.ceiling.median.value), bottom3: edge(a.ceiling.bottom3.value, b.ceiling.bottom3.value),
        low: edge(a.ceiling.low.value, b.ceiling.low.value),
        offense: offense ? edge(a.offense.perWeek, b.offense.perWeek) : null, idp: idp ? edge(a.idp.perWeek, b.idp.perWeek) : null
      };
      var quick = { a: 0, b: 0, even: 0 };
      ['avg', 'last3', 'last3ap', 'apPerWeek', 'consistency'].forEach(function (k) { if (edges[k]) quick[edges[k]]++; });
      var meetings = [];
      read.allWeeks.forEach(function (w) {
        (stats[w][A].games || []).forEach(function (g) {
          if (g.opp === B) meetings.push({ week: w, isPlayoff: read.weeks[w].po === true, aScore: g.ts, bScore: g.os, result: g.result });
        });
      });
      return viewResult(st, { weeks: { regular: reg.slice(), last3: last }, a: a, b: b, meetings: meetings, edges: edges, quickEdges: quick, offenseIdpStatus: offenseIdpStatus });
    }, nulls);
  }
  // g. ownerSeries(history, ownerA, ownerB, opts) → the head-to-head games between two OWNERS of record, following
  //    each person across franchise ids and team names (an ownership change never hands a new owner the old owner's
  //    games). history = site/standings/h2h_history.json: { through_season, regular_season_pairings: [seasons],
  //    owners: { season: { fid: owner_name } }, games: [[season, week, fid, opp, fidScore, oppScore, isPlayoff]] }.
  //    opts.current = { season, games: [{ week, isPlayoff, aScore, bScore }] } adds the live season (matchupTape's
  //    meetings, owner A's side first) when it is after through_season.
  //    → { status, games: [{ season, week, isPlayoff, aScore, bScore, result }], regular {w,l,t}, playoff {w,l,t},
  //        seasonsTogether: [seasons both owned a team], pairingSeasons: [the seasons whose regular-season games exist] }
  //    Exact owner-name match only. MFL never exported the regular-season pairings of 2010-2011 and 2013-2019, so
  //    those seasons can only contribute playoff games; the result says which seasons were covered.
  function ownerSeries(history, ownerA, ownerB, opts) {
    var none = { status: 'unavailable', games: null, regular: null, playoff: null, seasonsTogether: null, pairingSeasons: null };
    if (!history || typeof history !== 'object' || !history.owners || !Array.isArray(history.games)) return none;
    var oa = ownerA == null ? '' : String(ownerA), ob = ownerB == null ? '' : String(ownerB);
    if (!oa || !ob || oa === ob) return none;
    var together = [];
    Object.keys(history.owners).forEach(function (season) {
      var m = history.owners[season] || {}, hasA = false, hasB = false;
      Object.keys(m).forEach(function (f) { if (m[f] === oa) hasA = true; if (m[f] === ob) hasB = true; });
      if (hasA && hasB) together.push(Number(season));
    });
    var games = [];
    history.games.forEach(function (g) {
      if (!Array.isArray(g) || g.length < 7) return;
      var season = g[0], m = history.owners[String(season)] || {};
      var o1 = m[pad4(g[2])], o2 = m[pad4(g[3])];
      var aFirst = o1 === oa && o2 === ob, bFirst = o1 === ob && o2 === oa;
      if (!aFirst && !bFirst) return;
      var as = aFirst ? g[4] : g[5], bs = aFirst ? g[5] : g[4];
      games.push({ season: season, week: g[1], isPlayoff: !!g[6], aScore: as, bScore: bs, result: as > bs ? 'W' : as < bs ? 'L' : 'T' });
    });
    var cur = opts && opts.current;
    if (cur && Number(cur.season) > Number(history.through_season) && Array.isArray(cur.games)) {
      if (together.indexOf(Number(cur.season)) < 0) together.push(Number(cur.season));
      cur.games.forEach(function (g) {
        games.push({ season: Number(cur.season), week: g.week, isPlayoff: !!g.isPlayoff, aScore: g.aScore, bScore: g.bScore, result: g.aScore > g.bScore ? 'W' : g.aScore < g.bScore ? 'L' : 'T' });
      });
    }
    games.sort(function (x, y) { return (x.season - y.season) || (x.week - y.week); });
    var reg = { w: 0, l: 0, t: 0 }, po = { w: 0, l: 0, t: 0 };
    games.forEach(function (g) { var r = g.isPlayoff ? po : reg; r[g.result === 'W' ? 'w' : g.result === 'L' ? 'l' : 't']++; });
    together.sort(function (x, y) { return x - y; });
    var pairing = (history.regular_season_pairings || []).map(Number);
    if (cur && Number(cur.season) > Number(history.through_season)) pairing = pairing.concat([Number(cur.season)]);
    return { status: 'ok', games: games, regular: reg, playoff: po, seasonsTogether: together, pairingSeasons: pairing.filter(function (s) { return together.indexOf(s) >= 0; }) };
  }

  // ── Magic numbers (current regular season; descriptive) ─────────────
  // The proverbial magic number: this team's future wins plus a rival's future losses that put the rival out of reach.
  //   Division — MFL decides a division on H2H win % first (standingsSort PCT, canon §F.2): the leader against the
  //     division rival who can still finish highest (the fewest H2H losses). It needs every team's number of
  //     scheduled regular-season H2H games (two or three a week), read from MFL's schedule export; without a
  //     schedule that matches the games already played, the division numbers are unavailable, never assumed.
  //   Wild card — seeds 3-6 go by All-Play % (canon §F.1): each wild-card team against the first team out (the
  //     worker's next_out). All-Play gives every team one result against each other team every week, so no schedule
  //     is needed.
  // Both count to finishing STRICTLY ahead (a tie goes to a tiebreak that later weeks decide):
  //   magic = floor(G_rival − L_rival − W_team − (T_team + T_rival) / 2) + 1, G = the rival's games in the season.
  // Clinched:
  //   division     — the division magic number reached 0 (no rival can even tie).
  //   playoff spot — a separate, sound check. A division is won on H2H and a wild card on All-Play, so a team that
  //     loses its division race can drop into the wild-card race above a wild-card team; a wild-card magic number of
  //     0 is therefore not a clinch by itself. A team has clinched a spot when, in the worst case for it, at most one
  //     other team that could still finish level with or above it on All-Play could also miss its division title.
  // magicNumbers(payload, mflSchedule) -> { status, reason, throughWeek, lastRegularWeek, apGamesLeft,
  //   division: { status, reason, byDivision: { <div>: { leader, vs, magic, clinched } } },
  //   wildCard: { status, reason, vs, teams: [{ franchise_id, magic, clinched }] },
  //   byFid: { <fid of seeds 1-6>: { kind: 'division' | 'wild_card', magic, vs, clinched, clinchedDivision,
  //            clinchedSpot } } }
  // status: 'ok' | 'preseason' | 'final' (nothing to clinch: the regular season is over or recorded) | 'unavailable'.
  // A division or wild-card part that can't be computed says so in its own status/reason; nothing is guessed.
  function scheduleGameCounts(sched, lastReg, fids) {
    var ws = sched && sched.schedule && sched.schedule.weeklySchedule;
    ws = Array.isArray(ws) ? ws : (isRowObject(ws) ? [ws] : null);
    if (!ws) return { status: 'unavailable', reason: 'schedule_unavailable' };
    var known = {}, total = {}, byWeek = {};
    fids.forEach(function (f) { known[f] = true; total[f] = 0; });
    for (var i = 0; i < ws.length; i++) {
      var W = ws[i];
      var wk = isRowObject(W) ? strictNum(W.week) : NaN;
      if (!isWeekNum(wk)) return { status: 'unavailable', reason: 'schedule_unreadable' };
      if (wk > lastReg) continue;
      if (byWeek[wk]) return { status: 'unavailable', reason: 'schedule_unreadable' };
      var counts = byWeek[wk] = {};
      var ms = W.matchup;
      ms = Array.isArray(ms) ? ms : (isRowObject(ms) ? [ms] : []);
      for (var j = 0; j < ms.length; j++) {
        var fr = ms[j] && ms[j].franchise;
        if (!Array.isArray(fr) || fr.length !== 2 || !isRowObject(fr[0]) || !isRowObject(fr[1]) || !hasId(fr[0].id) || !hasId(fr[1].id)) {
          return { status: 'unavailable', reason: 'schedule_unreadable' };
        }
        var a = pad4(fr[0].id), b = pad4(fr[1].id);
        if (a === b || !known[a] || !known[b]) return { status: 'unavailable', reason: 'schedule_unreadable' };
        counts[a] = (counts[a] || 0) + 1; counts[b] = (counts[b] || 0) + 1;
        total[a]++; total[b]++;
      }
    }
    // Every regular-season week is on the schedule and gives every team at least one game.
    for (var w = 1; w <= lastReg; w++) {
      if (!byWeek[w] || fids.some(function (f) { return !byWeek[w][f]; })) return { status: 'unavailable', reason: 'schedule_incomplete' };
    }
    return { status: 'ok', reason: null, total: total, byWeek: byWeek };
  }
  function magicCount(team, rival, rivalGames) {
    return Math.floor(rivalGames - rival.l - team.w - (team.t + rival.t) / 2) + 1;
  }
  function wholeRecord(rec) {
    if (!isRowObject(rec)) return null;
    var w = strictNum(rec.w), l = strictNum(rec.l), t = strictNum(rec.t);
    if (!Number.isInteger(w) || !Number.isInteger(l) || !Number.isInteger(t) || w < 0 || l < 0 || t < 0) return null;
    return { w: w, l: l, t: t };
  }
  function magicNumbers(payload, mflSchedule) {
    var out = { status: 'unavailable', reason: null, throughWeek: null, lastRegularWeek: null, apGamesLeft: null,
      division: { status: 'unavailable', reason: null, byDivision: {} },
      wildCard: { status: 'unavailable', reason: null, vs: null, teams: [] },
      byFid: {} };
    function stop(status, reason) {
      out.status = status; out.reason = reason;
      out.division.reason = reason; out.wildCard.reason = reason;
      if (status !== 'unavailable') { out.division.status = status; out.wildCard.status = status; }
      return out;
    }
    if (!isRowObject(payload)) return stop('unavailable', 'no_standings');
    var rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (payload.standings_basis === 'recorded_final_standings' || rows.some(isRecordedRow)) return stop('final', 'season_over');
    if (payload.preseason === true || payload.standings_basis === 'preseason') return stop('preseason', 'no_games_yet');
    if (payload.standings_basis !== 'regular_season_ladder') return stop('unavailable', 'seeds_unavailable');
    var rs = payload.regular_season;
    if (!isRowObject(rs) || rs.status !== 'ok') return stop('unavailable', 'regular_season_unverified');
    var k = strictNum(rs.through_week), lastReg = strictNum(rs.last_regular_season_week);
    if (!isWeekNum(lastReg)) return stop('unavailable', 'regular_season_unverified');
    if (k === 0) return stop('preseason', 'no_games_yet');
    if (!isWeekNum(k)) return stop('unavailable', 'regular_season_unverified');
    if (rs.complete === true || k >= lastReg) return stop('final', 'regular_season_over');
    out.throughWeek = k; out.lastRegularWeek = lastReg;
    var n = rows.length;
    if (n < 8) return stop('unavailable', 'too_few_teams');
    var teams = {}, fids = [], bad = false;
    rows.forEach(function (r) {
      if (!isRowObject(r) || !hasId(r.franchise_id)) { bad = true; return; }
      var fid = pad4(r.franchise_id);
      var reg = r.regular_season;
      var rec = wholeRecord(reg && reg.record), ap = wholeRecord(reg && reg.all_play);
      // Every team has n-1 All-Play results a week; the H2H record must cover the games the worker counted.
      if (teams[fid] || !rec || !ap || ap.w + ap.l + ap.t !== (n - 1) * k) { bad = true; return; }
      var games = strictNum(reg.games);
      if (reg.games != null && games !== rec.w + rec.l + rec.t) { bad = true; return; }
      if (r.division == null || String(r.division) === '') { bad = true; return; }
      teams[fid] = { fid: fid, division: String(r.division), leader: r.is_division_leader === true,
        rank: strictNum(r.division_rank), seed: r.playoff_seed == null ? null : strictNum(r.playoff_seed),
        status: statusForRow(r), rec: rec, ap: ap };
      fids.push(fid);
    });
    if (bad) return stop('unavailable', 'records_unreadable');
    out.status = 'ok';
    var apGames = (n - 1) * lastReg;
    out.apGamesLeft = (n - 1) * (lastReg - k);
    var divs = {};
    fids.forEach(function (f) { var d = teams[f].division; (divs[d] || (divs[d] = [])).push(teams[f]); });

    // Division races (H2H).
    var counts = scheduleGameCounts(mflSchedule, lastReg, fids);
    var h2hGames = null;
    if (counts.status !== 'ok') { out.division.reason = counts.reason; }
    else {
      var mismatch = fids.some(function (f) {
        var played = 0;
        for (var w = 1; w <= k; w++) played += counts.byWeek[w][f] || 0;
        var r = teams[f].rec;
        return played !== r.w + r.l + r.t;
      });
      if (mismatch) out.division.reason = 'schedule_mismatch';
      else h2hGames = counts.total;
    }
    if (h2hGames) {
      var divOk = Object.keys(divs).every(function (d) {
        var leaders = divs[d].filter(function (x) { return x.leader; });
        if (leaders.length !== 1 || divs[d].length < 2) return false;
        var L = leaders[0], best = null;
        divs[d].forEach(function (x) {
          if (x === L) return;
          var m = magicCount(L.rec, x.rec, h2hGames[x.fid]);
          if (!best || m > best.m || (m === best.m && (x.rank || 99) < (best.x.rank || 99))) best = { x: x, m: m };
        });
        out.division.byDivision[d] = { leader: L.fid, vs: best.x.fid, magic: Math.max(0, best.m), clinched: best.m <= 0 };
        return true;
      });
      if (divOk) { out.division.status = 'ok'; out.division.reason = null; }
      else { out.division.byDivision = {}; out.division.reason = 'division_leaders_unreadable'; }
    }

    // The wild-card race (All-Play).
    var nextOut = hasId(rs.next_out) ? pad4(rs.next_out) : null;
    var wc = fids.map(function (f) { return teams[f]; }).filter(function (x) { return x.status === 'WC'; })
      .sort(function (a, b) { return a.seed - b.seed; });
    if (!nextOut || !teams[nextOut] || teams[nextOut].seed != null || wc.length !== 2) out.wildCard.reason = 'wild_card_race_unreadable';
    else {
      var B = teams[nextOut];
      out.wildCard.status = 'ok'; out.wildCard.reason = null; out.wildCard.vs = nextOut;
      out.wildCard.teams = wc.map(function (A) {
        var m = magicCount(A.ap, B.ap, apGames);
        return { franchise_id: A.fid, magic: Math.max(0, m), reachedZero: m <= 0 };
      });
    }

    // Playoff spot clinched (sound; see the header). Division candidates: a team is out of its division race only
    // when some rival's current H2H win total already beats the most it can reach.
    function h2hMax(x) { return h2hGames ? h2hGames[x.fid] - x.rec.l - x.rec.t / 2 : null; }
    function canWinDivision(x) {
      if (!h2hGames) return true; // no schedule: assume anyone can (the cautious side)
      return !divs[x.division].some(function (y) { return y !== x && y.rec.w + y.rec.t / 2 > h2hMax(x); });
    }
    function clinchedSpot(A) {
      var dA = out.division.byDivision[A.division];
      if (dA && dA.leader === A.fid && dA.clinched) return true;
      var aMin = A.ap.w + A.ap.t / 2;
      var threats = fids.filter(function (f) { var x = teams[f]; return x !== A && apGames - x.ap.l - x.ap.t / 2 >= aMin; });
      var nonWinners = 0;
      Object.keys(divs).forEach(function (d) {
        var T = threats.filter(function (f) { return teams[f].division === d; });
        var cand = divs[d].filter(function (x) { return x !== A && canWinDivision(x); });
        if (d === A.division && !cand.length) { nonWinners = -Infinity; return; } // A must win its division
        if (!T.length) return;
        var nonThreatCanWin = cand.some(function (x) { return T.indexOf(x.fid) < 0; });
        nonWinners += T.length - (nonThreatCanWin || !cand.length ? 0 : 1);
      });
      return nonWinners <= 1;
    }
    fids.forEach(function (f) {
      var x = teams[f];
      if (x.seed == null || !(x.seed >= 1 && x.seed <= 6)) return;
      var spot = clinchedSpot(x);
      if (x.status === 'BYE' || x.status === 'DIV') {
        var dv = out.division.byDivision[x.division];
        var mine = dv && dv.leader === f ? dv : null;
        out.byFid[f] = { kind: 'division', magic: mine ? mine.magic : null, vs: mine ? mine.vs : null,
          clinched: !!(mine && mine.clinched), clinchedDivision: !!(mine && mine.clinched), clinchedSpot: spot };
      } else if (x.status === 'WC') {
        var e = out.wildCard.teams.filter(function (t) { return t.franchise_id === f; })[0] || null;
        if (e) e.clinched = spot;
        out.byFid[f] = { kind: 'wild_card', magic: e ? e.magic : null, vs: e ? out.wildCard.vs : null,
          clinched: spot, clinchedDivision: false, clinchedSpot: spot };
      }
    });
    return out;
  }

  // ── top-level composition ───────────────────────────────────────────
  // race(payload) -> { byFranchise: { <fid>: {...} }, seed2FranchiseId,
  //   seed6FranchiseId, hasSeed6, preseason, standingsBasis, seedsFinal,
  //   bracketFinal, projected, weeklyUnreadable }
  // byFranchise[fid] carries every derived value for that franchise:
  //   status, playoff_seed, apGB, luck, expectedWins, form5, form3,
  //   weeklyRank ({maxWeek, weeks} | null when unavailable), gameLog,
  //   whySeed, divisionRace.
  // Pass the whole /api/standings response: standings_basis and
  // regular_season are read for seedsFinal and "Seeds unavailable".
  //   seedsFinal   — seeds and BYE/DIV/WC are final once the REGULAR season
  //                  is complete (regular_season.complete === true), or the
  //                  season is recorded (standings_basis
  //                  'recorded_final_standings'). Until then they read "if
  //                  the season ended today". A response with neither field
  //                  (an older worker, or a caller passing only part of it)
  //                  falls back to season_complete === true.
  //   bracketFinal — the bracket and draft picks stay projected until the
  //                  whole season is complete (season_complete === true).
  //   projected    — compatibility alias: exactly !seedsFinal.
  function seedsFinalFor(payload) {
    if (!payload) return false;
    var basis = payload.standings_basis;
    if (basis === 'recorded_final_standings') return true;
    if (basis === 'unavailable' || basis === 'preseason') return false;
    var rs = payload.regular_season;
    if (rs && typeof rs === 'object') return rs.complete === true;
    return payload.season_complete === true;
  }
  function race(payload) {
    var rows = (payload && Array.isArray(payload.rows)) ? payload.rows : [];
    // A failed query is null and STAYS null — every derived value then reads "unavailable", never a preseason zero.
    var weekly = payload ? payload.weekly : null;
    var weeklyScores = payload ? payload.weeklyScores : null;
    var expectedFids = rows.map(function (r) { return r && r.franchise_id; });
    // Luck/expectedWins' AP and Overall tables are each derived ONCE here
    // and reused for every franchise below — never re-derived per row,
    // and never capable of disagreeing with each other row-to-row.
    var luckApTable = deriveRegSeasonApTable(weeklyScores, expectedFids);
    var overallTable = deriveRegSeasonOverallTable(weekly, expectedFids);
    var gbMap = apGamesBack(rows, weeklyScores);
    var rankResult = weeklyApRank(weeklyScores, expectedFids);
    var context = payload ? { standings_basis: payload.standings_basis, regular_season: payload.regular_season } : null;
    var seed2 = null, seed6 = null;
    rows.forEach(function (r) {
      if (!r) return;
      var s = Number(r.playoff_seed);
      if (s === 2) seed2 = r;
      if (s === 6) seed6 = r;
    });
    var byFranchise = {};
    rows.forEach(function (r) {
      if (!r) return;
      var fid = pad4(r.franchise_id);
      var form = formForFranchise(weekly, fid);
      byFranchise[fid] = {
        franchise_id: fid,
        status: statusForRow(r),
        playoff_seed: (r.playoff_seed == null ? null : Number(r.playoff_seed)),
        apGB: gbMap.hasOwnProperty(fid) ? gbMap[fid] : null,
        luck: luckForRow(r, overallTable, luckApTable),
        expectedWins: expectedWinsForRow(r, overallTable, luckApTable),
        form5: form.last5,
        form3: form.last3,
        weeklyRank: rankResult ? { maxWeek: rankResult.maxWeek, weeks: rankResult.byFranchise[fid] || {} } : null,
        gameLog: gameLogForFranchise(weekly, rows, fid),
        whySeed: whySeedForRow(r, rows, weeklyScores, context),
        divisionRace: divisionRace(rows, r.division, weeklyScores)
      };
    });
    var seedsFinal = seedsFinalFor(payload);
    return {
      byFranchise: byFranchise,
      seed2FranchiseId: seed2 ? pad4(seed2.franchise_id) : null,
      seed6FranchiseId: seed6 ? pad4(seed6.franchise_id) : null,
      hasSeed6: !!seed6,
      preseason: !!(payload && payload.preseason),
      standingsBasis: (payload && payload.standings_basis) || null,
      // Seeds and BYE/DIV/WC are "if the season ended today" until the regular season is complete; the bracket and
      // draft picks stay projected until the whole season is (see seedsFinalFor).
      seedsFinal: seedsFinal,
      bracketFinal: !!(payload && payload.season_complete === true),
      projected: !seedsFinal, // compatibility alias of !seedsFinal
      weeklyUnreadable: !Array.isArray(weekly) || !Array.isArray(weeklyScores)
    };
  }

  global.UPS_STANDINGS_RACE = {
    race: race,
    // Exposed individually for focused unit testing and for callers that
    // only need one piece (e.g. the mobile bottom sheet computing a
    // single franchise's division race on demand).
    statusForRow: statusForRow,
    apGamesBack: apGamesBack,
    apWinsEquiv: apWinsEquiv,
    deriveRegSeasonApTable: deriveRegSeasonApTable,
    resolveApRecordWithTable: resolveApRecordWithTable,
    apRecordForRow: apRecordForRow,
    apPctFromRecord: apPctFromRecord,
    deriveRegSeasonOverallTable: deriveRegSeasonOverallTable,
    resolveOverallRecordWithTable: resolveOverallRecordWithTable,
    normalizePo: normalizePo,
    luckForRow: luckForRow,
    expectedWinsForRow: expectedWinsForRow,
    formForFranchise: formForFranchise,
    weeklyApRank: weeklyApRank,
    gameLogForFranchise: gameLogForFranchise,
    divisionRace: divisionRace,
    whySeedForRow: whySeedForRow,
    LUCK_TOOLTIP: LUCK_TOOLTIP,
    // Phase II-A2 — projected bracket / draft order / mobile Playoffs mode.
    validateBracketSeeds: validateBracketSeeds,
    chalkBracketSide: chalkBracketSide,
    classifySideGamesFromMatchups: classifySideGamesFromMatchups,
    assignFinishesAndPicks: assignFinishesAndPicks,
    projectChalkBracket: projectChalkBracket,
    buildActualBracketResult: buildActualBracketResult,
    nextDraftYear: nextDraftYear,
    projectedPlayoffGroups: projectedPlayoffGroups,
    BRACKET_FINISH_SLOTS: BRACKET_FINISH_SLOTS,
    // Phase II-A2 correction pass (F2/F5/F9).
    normalizeActualGame: normalizeActualGame,
    projectionMode: projectionMode,
    pickWhyText: pickWhyText,
    // Weekly views (descriptive; never seeds).
    completedWeeks: completedWeeks,
    weekTable: weekTable,
    seasonWeeklyLeaders: seasonWeeklyLeaders,
    teamWeeklyHistory: teamWeeklyHistory,
    scoredFaced: scoredFaced,
    // Playoff / Hawk Tuah Bowl matchup sheet (descriptive; never a prediction).
    matchupTape: matchupTape,
    ownerSeries: ownerSeries,
    // Magic numbers for the division and wild-card races (current regular season; descriptive).
    magicNumbers: magicNumbers,
    scheduleGameCounts: scheduleGameCounts,
    // Plain words for a view's problems, and the finished-season bracket check (#1329 decision 2 items 1-2).
    describeProblems: describeProblems,
    verifyActualSide: verifyActualSide
  };
})(typeof window !== 'undefined' ? window : this);
