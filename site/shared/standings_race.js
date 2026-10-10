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
  // resolve to byFid: null for EVERY franchise, never a partial map. A
  // row for a franchise outside the expected population is ignored
  // entirely, including any malformed `po` it carries.
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
      if (!expected.hasOwnProperty(fid)) return; // foreign franchise — irrelevant, never poisons this table
      sawAnyRelevantRow = true;
      var isPo = normalizePo(m.po);
      if (isPo === null) { sawUnrecognizedPo = true; return; } // fail closed — never guessed as regular season
      if (isPo === true) return; // valid, explicit playoff — excluded, not an error
      var w = Number(m.w);
      if (!isFiniteNum(w)) return;
      var opp = pad4(m.opp);
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
    LUCK_TOOLTIP: LUCK_TOOLTIP
  };
})(typeof window !== 'undefined' ? window : this);
