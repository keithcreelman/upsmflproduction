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
     season_complete — resp.season_complete: until it is true every
                     seed and BYE/DIV/WC status is a PROJECTION.

   None of these fields are invented here — they are the exact field
   names the worker returns. This module does not fetch them and does not
   care how a caller obtained the object; it only reads what's already
   on it.

   SEEDING: this module never ranks, re-ranks or explains a seed by its
   own comparator. The worker seeds (worker/src/seeding.js — canon §F.1:
   All-Play % → Overall → season Points For → head-to-head, Keith
   2026-10-08) and says which step decided each team (row.seed_reason,
   Keith 2026-10-09: "the client never recreates the ladder"). Seasons
   with recorded final standings (2010–2025) are labelled as recorded
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

  // ── 1. Status ────────────────────────────────────────────────────────
  // bye -> BYE, division_winner -> DIV, wild_card -> WC, everything else
  // (non_playoff / missing / unknown) -> null. Never OUT — elimination
  // can't be computed without remaining-schedule data. Reads
  // playoff_status directly; never infers status from seed number alone.
  var STATUS_MAP = { bye: 'BYE', division_winner: 'DIV', wild_card: 'WC' };
  function statusForRow(row) {
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
  // A row with an unparseable score is treated as absent (not zero) for
  // that (week, franchise) — it can't silently become a false zero, and
  // its absence is caught by the same completeness check as a genuinely
  // missing row. A row for a franchise NOT in the expected population
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
    weeklyScores.forEach(function (r) {
      if (!r) return;
      var fid = pad4(r.fid);
      if (!expected.hasOwnProperty(fid)) return; // foreign franchise — irrelevant, never poisons this table
      sawAnyRelevantRow = true;
      var isPo = normalizePo(r.po);
      if (isPo === null) { sawUnrecognizedPo = true; return; } // fail closed — never guessed as regular season
      if (isPo === true) return; // valid, explicit playoff — excluded, not an error
      var w = Number(r.w);
      if (!isFiniteNum(w)) return;
      var ts = Number(r.ts);
      if (!isFiniteNum(ts)) return; // unparseable score -> treat as absent, never as 0
      var bucket = byWeek[w] || (byWeek[w] = {});
      if (bucket.hasOwnProperty(fid) && bucket[fid] !== ts) conflictWeeks[w] = true;
      bucket[fid] = ts; // identical duplicates are idempotent; a real conflict is flagged above and invalidates the whole table below
    });
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

  // ── 2. AP games back ─────────────────────────────────────────────────
  // apGB per franchise_id relative to the seed-6 row's REGULAR-SEASON-ONLY
  // AP wins-equivalent (apRecordForRow's 3-tier hierarchy — never a
  // full-season field). Seeds 1-6 -> 0 unconditionally (a structural fact
  // of their seed, not an AP computation). Everyone else -> max(0,
  // seed6Wins - myWins), or null if either side's regular-season AP can't
  // be resolved (no seed===6 row / incomplete weekly data) — never a
  // value computed from contaminated full-season data.
  function apGamesBack(rows, weeklyScores) {
    var list = Array.isArray(rows) ? rows : [];
    var out = {};
    var seed6 = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && Number(list[i].playoff_seed) === 6) { seed6 = list[i]; break; }
    }
    if (!seed6) {
      list.forEach(function (r) { if (r) out[pad4(r.franchise_id)] = null; });
      return out;
    }
    // One shared table for every row in this call — a 'conflict' or
    // 'incomplete' status is never computed (and can never disagree)
    // per franchise; it applies identically to the whole league.
    var apTable = deriveRegSeasonApTable(weeklyScores, list.map(function (r) { return r && r.franchise_id; }));
    var seed6Wins = apWinsEquiv(resolveApRecordWithTable(seed6, apTable));
    list.forEach(function (r) {
      if (!r) return;
      var fid = pad4(r.franchise_id);
      var seed = Number(r.playoff_seed);
      if (seed >= 1 && seed <= 6) { out[fid] = 0; return; }
      var wins = apWinsEquiv(resolveApRecordWithTable(r, apTable));
      if (seed6Wins == null || wins == null) { out[fid] = null; return; }
      out[fid] = Math.max(0, round1(seed6Wins - wins));
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
    weekly.forEach(function (m) {
      if (!m) return;
      var fid = pad4(m.fid);
      var opp = pad4(m.opp);
      if (!expected.hasOwnProperty(fid) && !expected.hasOwnProperty(opp)) return; // neither side expected — unrelated, never poisons this table
      sawAnyRelevantRow = true; // involves an expected franchise (as fid OR opp) — this payload is not "nobody has played"
      var isPo = normalizePo(m.po);
      if (isPo === null) { sawUnrecognizedPo = true; return; } // fail closed — never guessed as regular season
      if (isPo === true) return; // valid, explicit playoff — excluded, not an error
      if (!expected.hasOwnProperty(fid)) return; // the foreign side of an expected franchise's game — only expected franchises' own rows enter the table
      var w = Number(m.w);
      if (!isFiniteNum(w)) return;
      var ts = Number(m.ts), os = Number(m.os);
      if (!isFiniteNum(ts) || !isFiniteNum(os)) return; // unparseable score -> absent, never zero
      var key = fid + '|' + opp;
      var bucket = byWeek[w] || (byWeek[w] = {});
      if (bucket.hasOwnProperty(key)) {
        if (bucket[key].ts !== ts || bucket[key].os !== os) conflictWeeks[w] = true;
        // identical duplicate -> idempotent, no-op
      } else {
        bucket[key] = { fid: fid, opp: opp, ts: ts, os: os };
      }
    });
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
  // null weekly (a failed query) → { last5: null, last3: null }: unknown, never "no games yet". A row whose playoff flag
  // isn't a clean 0/1 is left out (normalizePo), never guessed as regular season.
  function formForFranchise(weekly, fid) {
    if (!Array.isArray(weekly)) return { last5: null, last3: null };
    var padded = pad4(fid);
    var list = weekly.filter(function (m) {
      return m && pad4(m.fid) === padded && normalizePo(m.po) === false;
    });
    var withIdx = list.map(function (m, i) { return { m: m, i: i }; });
    withIdx.sort(function (a, b) { return (a.m.w - b.m.w) || (a.i - b.i); });
    var results = withIdx.map(function (x) { return resultForMatchup(x.m); });
    return { last5: results.slice(-5), last3: results.slice(-3) };
  }

  // Per-week AP rank (1 = highest score, ties share the better/lower
  // rank number — "1224" competition ranking) computed from
  // weeklyScores[] (already one row per franchise/week; de-duplicated
  // defensively below by (week, fid) in case a payload ever isn't).
  // Returns { maxWeek, byFranchise: { fid: { <week>: {rank, playoff} } } }.
  // A week absent from a franchise's map is simply unplayed/missing.
  function weeklyApRank(weeklyScores) {
    if (!Array.isArray(weeklyScores)) return { maxWeek: 0, byFranchise: {}, unreadable: true };
    var byWeek = {};
    var maxWeek = 0;
    weeklyScores.forEach(function (r) {
      if (!r) return;
      var w = Number(r.w);
      if (!isFiniteNum(w)) return;
      if (w > maxWeek) maxWeek = w;
      var fid = pad4(r.fid);
      (byWeek[w] = byWeek[w] || {})[fid] = { ts: Number(r.ts) || 0, po: !!r.po }; // last occurrence wins (de-dupe)
    });
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
  function gameLogForFranchise(weekly, rows, fid) {
    if (!Array.isArray(weekly)) return null; // unreadable, never an empty log
    var padded = pad4(fid);
    var nameByFid = {};
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      if (r) nameByFid[pad4(r.franchise_id)] = r.franchise_name || ('Franchise ' + pad4(r.franchise_id));
    });
    var list = weekly.filter(function (m) { return m && pad4(m.fid) === padded; });
    var withIdx = list.map(function (m, i) { return { m: m, i: i }; });
    withIdx.sort(function (a, b) { return (a.m.w - b.m.w) || (a.i - b.i); });
    return withIdx.map(function (x) {
      var m = x.m;
      var oppFid = pad4(m.opp);
      return {
        week: m.w,
        opponent_franchise_id: oppFid,
        opponent_name: nameByFid[oppFid] || ('Franchise ' + oppFid),
        team_score: m.ts,
        opponent_score: m.os,
        result: resultForMatchup(m),
        is_playoff: !!m.po
      };
    });
  }

  // ── division race (backs A4's "Division race" disclosure block) ─────
  // Every team in `division`, with Overall record, REGULAR-SEASON-ONLY AP
  // record/% (apRecordForRow's 3-tier hierarchy), and AP GB to the
  // division leader (row.is_division_leader — the worker's own
  // MFL-standingsSort-based flag, same one used for the 👑/leader-pill
  // badges elsewhere). Never hardcodes a team count.
  function divisionRace(rows, division, weeklyScores) {
    var allRows = Array.isArray(rows) ? rows : [];
    var list = allRows.filter(function (r) {
      return r && division != null && String(r.division) === String(division);
    });
    // The expected population for completeness-checking is the FULL
    // league (every franchise on `rows`), never just this division —
    // otherwise every week would look "incomplete" merely because the
    // other 9+ franchises' scores are present in the same weekly bucket.
    var apTable = deriveRegSeasonApTable(weeklyScores, allRows.map(function (r) { return r && r.franchise_id; }));
    var leader = null;
    for (var i = 0; i < list.length; i++) { if (list[i].is_division_leader) { leader = list[i]; break; } }
    var leaderWins = leader ? apWinsEquiv(resolveApRecordWithTable(leader, apTable)) : null;
    return list.map(function (r) {
      var rec = resolveApRecordWithTable(r, apTable);
      var wins = apWinsEquiv(rec);
      var gb = (leaderWins != null && wins != null) ? Math.max(0, round1(leaderWins - wins)) : null;
      return {
        franchise_id: pad4(r.franchise_id),
        franchise_name: r.franchise_name || ('Franchise ' + pad4(r.franchise_id)),
        is_division_leader: !!r.is_division_leader,
        overall: { w: r.h2h_w || 0, l: r.h2h_l || 0, t: r.h2h_t || 0, pct: (r.h2h_pct == null ? null : Number(r.h2h_pct)) },
        ap: rec,
        ap_pct: apPctFromRecord(rec),
        ap_gb: gb
      };
    });
  }

  // ── 7. Seed explanation ─────────────────────────────────────────────
  // Words only: the WORKER decided the seed and says which step of its
  // ladder separated this team from its neighbour (row.seed_reason —
  // worker/src/seeding.js seedLadderSteps). Nothing here compares two teams.
  var STEP_LABEL = {
    all_play: 'All-Play %',
    overall: 'Overall record',
    points_for: 'season Points For',
    head_to_head: 'head-to-head',
    name: 'the name-order fallback after every league step tied — not a league rule',
    franchise_id: 'the franchise-id fallback after every league step tied — not a league rule',
    head_to_head_unavailable: 'a tie that reached head-to-head, which can’t be shown because the regular-season games couldn’t be read'
  };
  var POOL_LABEL = {
    bye: 'the bye pool (the two best division winners)',
    seeds3to6: 'the seeds 3–6 pool',
    outside: 'the race for the last wild card'
  };
  // { blocked, basis, pool, decidingCriterion, text } — blocked (text null) when the response carries no seed reason
  // (a worker that predates it), never a guessed one.
  function whySeedForRow(row, rows, weeklyScores) {
    if (!row) return null;
    var reason = row.seed_reason;
    var seed = Number(row.playoff_seed);
    var seeded = seed >= 1 && seed <= 6;
    if (reason && reason.basis === 'recorded_final_standings') {
      return {
        blocked: false, basis: 'recorded_final_standings', pool: null, decidingCriterion: null,
        text: (seeded ? 'Seed ' + seed : 'Outside the top six') + ' — from the recorded final standings.'
      };
    }
    if (!reason || reason.basis !== 'ladder') {
      return { blocked: true, basis: null, pool: null, decidingCriterion: null, text: null,
        reason: 'The standings response carries no seed reason for this team.' };
    }
    var rival = reason.rival_name || (reason.rival_franchise_id ? 'Franchise ' + pad4(reason.rival_franchise_id) : null);
    var stepText = reason.step ? STEP_LABEL[reason.step] || reason.step : null;
    if (!seeded) {
      var list = (Array.isArray(rows) ? rows : []).filter(Boolean);
      var gb = apGamesBack(list, weeklyScores)[pad4(row.franchise_id)];
      var lead = (gb == null) ? 'Outside the top six — AP games back unavailable' : 'Outside the top six — ' + gb + ' AP win' + (gb === 1 ? '' : 's') + ' back';
      return {
        blocked: false, basis: 'ladder', pool: 'outside', decidingCriterion: reason.step || null,
        text: lead + (rival && stepText ? '; behind ' + rival + ' (the last wild card) on ' + stepText : '') + '.'
      };
    }
    var poolLabel = POOL_LABEL[reason.pool] || 'its pool';
    if (!rival || !stepText) {
      return { blocked: false, basis: 'ladder', pool: reason.pool || null, decidingCriterion: null,
        text: 'Seed ' + seed + ': eligibility placed the team in ' + poolLabel + '.' };
    }
    return {
      blocked: false, basis: 'ladder', pool: reason.pool || null, decidingCriterion: reason.step,
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
  // (seeds 1-6 for the UPS championship side, 7-12 for the Hawktuah Bowl
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
  // 1.01 = Cleon Ca$h (finish 7, the real 2025 Hawktuah Bowl champion).
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
  // championship side (seeds 1-6), 6 for the Hawktuah side (7-12).
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
    champ: { final: 'the UPS Championship', third: 'the championship 3rd-place game', placement: 'the championship placement game' },
    hawk:  { final: 'the Hawktuah Bowl', third: 'the Toilet 3rd-place game', placement: 'the Toilet placement game' }
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
  // exactly as A1 already does. IN THE HUNT is sorted by AP GB ascending
  // (nulls last), tie-broken by seed (when present) then franchise_id
  // for a fully deterministic order.
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
    // Teams outside the field: by AP games back of the 6-seed, and otherwise in the WORKER's order (its ladder) —
    // never by franchise id, which would be a ranking of our own.
    inTheHunt.sort(function (a, b) {
      var ag = a.apGB == null ? Infinity : a.apGB, bg = b.apGB == null ? Infinity : b.apGB;
      if (ag !== bg) return ag - bg;
      return a.order - b.order;
    });
    return { byes: byes, divisionWinners: divisionWinners, wildCards: wildCards, inTheHunt: inTheHunt };
  }

  // ── top-level composition ───────────────────────────────────────────
  // race(payload) -> { byFranchise: { <fid>: {...} }, seed2FranchiseId,
  //   seed6FranchiseId, hasSeed6, preseason }
  // byFranchise[fid] carries every derived value for that franchise:
  //   status, playoff_seed, apGB, luck, expectedWins, form5, form3,
  //   weeklyRank ({maxWeek, weeks}), gameLog, whySeed, divisionRace.
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
    var rankResult = weeklyApRank(weeklyScores);
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
        weeklyRank: { maxWeek: rankResult.maxWeek, weeks: rankResult.byFranchise[fid] || {} },
        gameLog: gameLogForFranchise(weekly, rows, fid),
        whySeed: whySeedForRow(r, rows, weeklyScores),
        divisionRace: divisionRace(rows, r.division, weeklyScores)
      };
    });
    return {
      byFranchise: byFranchise,
      seed2FranchiseId: seed2 ? pad4(seed2.franchise_id) : null,
      seed6FranchiseId: seed6 ? pad4(seed6.franchise_id) : null,
      hasSeed6: !!seed6,
      preseason: !!(payload && payload.preseason),
      // Until the season is complete every seed and BYE/DIV/WC status is a projection — pages say so.
      projected: !(payload && payload.season_complete),
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
    pickWhyText: pickWhyText
  };
})(typeof window !== 'undefined' ? window : this);
