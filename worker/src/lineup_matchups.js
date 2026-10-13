// Lineup matchup info: GET /api/lineup-matchups?YEAR=&W=[&last=N]
// Read by mobile Lineup (site/m/views/lineup.js, also shared with the Players picker
// through M.lineupIntel) and desktop Game Day (site/gameday/gameday.html).
//
// Review 2026-10-13 (#1249): the route carried its own copy of the old Pts Agst
// engine. The defense numbers now come from worker/src/fpa_engine.js, the engine
// Stats → Pts Agst uses, with the same default window (the full season through the
// latest completed game). So a defense's figure is the same number on Lineup and on
// the Pts Agst board, and the fixes there apply here: final games only, the game-day
// team, never MFL's repeated last week, and a failed MFL read fails the answer.
//
// What it returns (field names kept so every reader keeps working):
//   matchups[team]    this week's game: opp, isHome, kickoff, spread, status.
//   defRatings[team][group]  rank / of / ratio (Allowed ÷ Usual, ranked high to low),
//                     plus games, perGame (Allowed) and usual, exactly as Pts Agst.
//                     For DL/LB/DB the team is the OFFENSE those players faced.
//   playerWindow[pid] the player's MFL points per final game in the window.
//   horizon[team]     the next three weeks' opponents.
//   weather[team]     forecast at the venue near kickoff (Open-Meteo), or dome.
// Read-only: MFL export GETs, one Open-Meteo GET, D1 SELECTs (via the engine).

import {
  FPA_ENGINE_VERSION, FPA_BASELINE, FpaUpstreamError, NFLV_TO_MFL,
  fpaUrls, fpaLoadMfl, fpaCompute, fpaAggregate, fpaWeekStates, fpaGameStatus, fpaSeasonContextCached,
} from "./fpa_engine.js";

export const LINEUP_MU_VERSION = "lmu2-2026-10-13";
const LMU_CACHE_HOST = "https://upsmfl-lineup.local";
const FPA_MFL_TAG = "fpa2";   // the engine's URL tag: Lineup and Pts Agst share one copy of each MFL read

const arr = (x) => Array.isArray(x) ? x : (x == null ? [] : [x]);
const str = (v) => String(v == null ? "" : v).trim();
const r1 = (v) => Math.round(v * 10) / 10;

function currentSeason(nowMs) {
  const d = new Date(nowMs);
  return d.getUTCMonth() >= 2 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

// One week's games by team, from MFL's nflSchedule rows. spread = MFL's line for that
// team (negative = favored), kept only when the two sides agree (a = −b); MFL's
// future-week lines often don't, and 0 / blank means no line posted yet.
const spreadOf = (t) => (t && t.spread != null && str(t.spread) !== "" && isFinite(Number(t.spread)) ? Number(t.spread) : null);
export function lmuMatchups(rows, nowMs) {
  const out = {};
  for (const m of arr(rows)) {
    const ts = arr(m.team); if (ts.length < 2) continue;
    const ko = Number(m.kickoff) || 0, st = fpaGameStatus(m, nowMs);
    let a = spreadOf(ts[0]), b = spreadOf(ts[1]);
    if (a == null || b == null || a === 0 || Math.abs(a + b) > 1e-9) { a = null; b = null; }
    const mk = (t, o, sp) => ({ opp: str(o.id).toUpperCase(), isHome: str(t.isHome) === "1", kickoff: ko, spread: sp,
      rushDefRank: Number(t.rushDefenseRank) || null, passDefRank: Number(t.passDefenseRank) || null, status: st });
    out[str(ts[0].id).toUpperCase()] = mk(ts[0], ts[1], a);
    out[str(ts[1].id).toUpperCase()] = mk(ts[1], ts[0], b);
  }
  return out;
}

// The next three weeks' opponents per team.
export function lmuHorizon(schedByWeek, weeks) {
  const out = {};
  for (const w of weeks) {
    for (const m of arr(schedByWeek[w])) {
      const ts = arr(m.team); if (ts.length < 2) continue;
      const a = str(ts[0].id).toUpperCase(), b = str(ts[1].id).toUpperCase();
      (out[a] = out[a] || []).push({ wk: w, opp: b, isHome: str(ts[0].isHome) === "1" });
      (out[b] = out[b] || []).push({ wk: w, opp: a, isHome: str(ts[1].isHome) === "1" });
    }
  }
  return out;
}

// Ratings and each player's per-game points for one engine run.
export function lmuRatings(E, agg) {
  const defRatings = {};
  for (const d in agg) {
    for (const g in agg[d]) {
      const c = agg[d][g];
      (defRatings[d] = defRatings[d] || {})[g] = {
        rank: c.adj ? c.adj.rank : null, of: c.adj ? c.adj.of : null, ratio: c.adj ? c.adj.ratio : null,
        games: c.raw.games, perGame: c.raw.perGame, usual: c.raw.oppNorm,
      };
    }
  }
  const playerWindow = {};
  const per = {};
  for (const x of E.pg) { const t = per[x.pid] || (per[x.pid] = { s: 0, n: 0 }); t.s += x.pts; t.n++; }
  for (const pid in per) playerWindow[pid] = { total: r1(per[pid].s), games: per[pid].n, avg: r1(per[pid].s / per[pid].n) };
  return { defRatings, playerWindow };
}

// Teams playing at a neutral site that week (London, Munich, Melbourne, …), from
// nflverse games.csv `location` — MFL's schedule has no venue, so the home team's
// stadium would be wrong for them. Only that week's rows are parsed (the file is
// ~2 MB; the game_id starts "<season>_<WW>_"). null = the file couldn't be read.
export function lmuNeutralTeams(csv, yr, wk) {
  if (typeof csv !== "string" || csv.indexOf("game_id,") !== 0) return null;
  const hdr = csv.slice(0, csv.indexOf("\n")).replace(/\r$/, "").split(",");
  const ix = (n) => hdr.indexOf(n);
  const iA = ix("away_team"), iH = ix("home_team"), iL = ix("location"), iT = ix("game_type");
  if (iA < 0 || iH < 0 || iL < 0) return null;
  const tag = "\n" + yr + "_" + (wk < 10 ? "0" : "") + wk + "_";
  const out = new Set();
  for (let at = csv.indexOf(tag); at >= 0; at = csv.indexOf(tag, at + 1)) {
    const end = csv.indexOf("\n", at + 1);
    const c = csv.slice(at + 1, end < 0 ? csv.length : end).replace(/\r$/, "").split(",");
    if (iT >= 0 && c[iT] !== "REG") continue;
    if (c[iL] !== "Neutral") continue;
    for (const t of [c[iA], c[iH]]) if (t) out.add(NFLV_TO_MFL[t] || t);
  }
  return out;
}

// ── Weather at each game's venue near kickoff (Open-Meteo, no key). Domes and fixed
// roofs are flagged, not fetched. Keyed on the HOME team's stadium, so a neutral-site
// game gets no forecast, and when the venue list can't be read nobody gets one.
const STADIUMS = {
  ARI: { la: 33.5277, lo: -112.2626, dome: 1 }, ATL: { la: 33.7554, lo: -84.4008, dome: 1 },
  BAL: { la: 39.2780, lo: -76.6227 }, BUF: { la: 42.7738, lo: -78.7870 },
  CAR: { la: 35.2258, lo: -80.8528 }, CHI: { la: 41.8623, lo: -87.6167 },
  CIN: { la: 39.0955, lo: -84.5161 }, CLE: { la: 41.5061, lo: -81.6995 },
  DAL: { la: 32.7473, lo: -97.0945, dome: 1 }, DEN: { la: 39.7439, lo: -105.0201 },
  DET: { la: 42.3400, lo: -83.0456, dome: 1 }, GBP: { la: 44.5013, lo: -88.0622 },
  HOU: { la: 29.6847, lo: -95.4107, dome: 1 }, IND: { la: 39.7601, lo: -86.1639, dome: 1 },
  JAC: { la: 30.3239, lo: -81.6373 }, KCC: { la: 39.0489, lo: -94.4839 },
  LVR: { la: 36.0909, lo: -115.1833, dome: 1 }, LAC: { la: 33.9535, lo: -118.3392, dome: 1 },
  LAR: { la: 33.9535, lo: -118.3392, dome: 1 }, MIA: { la: 25.9580, lo: -80.2389 },
  MIN: { la: 44.9736, lo: -93.2575, dome: 1 }, NEP: { la: 42.0909, lo: -71.2643 },
  NOS: { la: 29.9511, lo: -90.0812, dome: 1 }, NYG: { la: 40.8135, lo: -74.0745 },
  NYJ: { la: 40.8135, lo: -74.0745 }, PHI: { la: 39.9008, lo: -75.1675 },
  PIT: { la: 40.4468, lo: -80.0158 }, SFO: { la: 37.4032, lo: -121.9698 },
  SEA: { la: 47.5952, lo: -122.3316 }, TBB: { la: 27.9759, lo: -82.5033 },
  TEN: { la: 36.1665, lo: -86.7713 }, WAS: { la: 38.9076, lo: -76.8645 },
};
const wmo = (c) => { c = Number(c);
  if (c === 0) return "Clear"; if (c <= 2) return "P.Cloudy"; if (c === 3) return "Overcast";
  if (c <= 48) return "Fog"; if (c <= 57) return "Drizzle"; if (c <= 67) return "Rain";
  if (c <= 77) return "Snow"; if (c <= 82) return "Showers"; if (c <= 86) return "Snow"; return "T-storm"; };

export async function lmuWeather(matchups, fetchJson, nowMs, neutral) {
  const weather = {}, games = [], seenHome = {};
  if (!neutral) return { weather, state: "unavailable" };
  for (const t in matchups) {
    const m = matchups[t], home = m.isHome ? t : m.opp;
    if (seenHome[home]) continue; seenHome[home] = 1;
    games.push({ home, away: m.isHome ? m.opp : t, kickoff: m.kickoff });
  }
  for (const g of games) {
    if (neutral.has(g.home) || neutral.has(g.away)) { weather[g.home] = { neutral: true }; weather[g.away] = weather[g.home]; continue; }
    const st = STADIUMS[g.home]; if (st && st.dome) { weather[g.home] = { dome: true }; weather[g.away] = weather[g.home]; }
  }
  const outdoor = games.filter((g) => { const st = STADIUMS[g.home]; return st && !st.dome && g.kickoff && !weather[g.home]; });
  if (!outdoor.length) return { weather, state: "ok" };
  const nowSec = nowMs / 1000;
  const dstr = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
  const kos = outdoor.map((g) => g.kickoff);
  const minK = Math.min.apply(null, kos), maxK = Math.max.apply(null, kos);
  const past = maxK < nowSec - 36 * 3600;
  const host = past ? "https://archive-api.open-meteo.com/v1/archive" : "https://api.open-meteo.com/v1/forecast";
  const u = host + "?latitude=" + outdoor.map((g) => STADIUMS[g.home].la).join(",") +
    "&longitude=" + outdoor.map((g) => STADIUMS[g.home].lo).join(",") +
    "&hourly=temperature_2m,precipitation,wind_speed_10m,weather_code" +
    "&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timeformat=unixtime&timezone=auto" +
    "&start_date=" + dstr(minK - 86400) + "&end_date=" + dstr(maxK + 86400);
  const res = await fetchJson(u, past ? 604800 : 1800);
  const list = Array.isArray(res) ? res : (res ? [res] : []);
  let got = 0;
  outdoor.forEach((g, gi) => {
    const h = list[gi] && list[gi].hourly;
    if (!h || !Array.isArray(h.time) || !h.time.length) return;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < h.time.length; i++) { const dd = Math.abs(h.time[i] - g.kickoff); if (dd < bd) { bd = dd; bi = i; } }
    if (bd > 3 * 3600) return;   // no forecast hour near kickoff (too far out): say nothing
    const wx = { tempF: Math.round(h.temperature_2m[bi]), windMph: Math.round(h.wind_speed_10m[bi]),
      precip: Math.round((h.precipitation[bi] || 0) * 100) / 100, summary: wmo(h.weather_code[bi]) };
    weather[g.home] = wx; weather[g.away] = wx; got++;
  });
  return { weather, state: got === outdoor.length ? "ok" : (got ? "partial" : "unavailable") };
}

async function cacheMatch(key) {
  if (typeof caches === "undefined" || !caches.default) return null;
  try { return await caches.default.match(new Request(key)); } catch (_) { return null; }
}
function cachePut(ctx, key, body, ttl) {
  if (typeof caches === "undefined" || !caches.default || !ttl) return;
  try {
    const r = new Response(body, { headers: { "content-type": "application/json", "Cache-Control": "public, max-age=" + ttl } });
    const p = caches.default.put(new Request(key), r);
    if (ctx && ctx.waitUntil) ctx.waitUntil(p.catch(() => {}));
  } catch (_) {}
}

export async function handleLineupMatchups(request, env, ctx, { jsonOut, nowMs, lid, fetchImpl }) {
  const url = new URL(request.url);
  const now = nowMs || Date.now();
  const doFetch = fetchImpl || fetch;
  const L = lid || "74598";
  const yr = str(url.searchParams.get("YEAR") || String(currentSeason(now))).replace(/\D/g, "");
  const wk = parseInt(url.searchParams.get("W") || "", 10);
  const last = Math.max(0, parseInt(url.searchParams.get("last") || "0", 10) || 0);
  if (!/^\d{4}$/.test(yr)) return jsonOut(400, { ok: false, error: "YEAR must be a 4-digit season" });
  if (!(wk >= 1 && wk <= 22)) return jsonOut(400, { ok: false, error: "W must be a week number" });
  const asOf = new Date(now).toISOString();

  const sp = new URLSearchParams();
  sp.set("YEAR", yr); sp.set("W", String(wk)); if (last) sp.set("last", String(last));
  const cacheKey = LMU_CACHE_HOST + "/api/lineup-matchups?" + sp.toString() + "&v=" + LINEUP_MU_VERSION + "&e=" + FPA_ENGINE_VERSION;
  const noCache = str(url.searchParams.get("NO_CACHE")) === "1";
  if (!noCache) {
    const hit = await cacheMatch(cacheKey);
    if (hit) { const body = await hit.text(); return new Response(body, { status: 200, headers: jsonOut(200, {}).headers }); }
  }

  const fetchJson = (u, ttl) => doFetch(u, { cf: { cacheTtlByStatus: { "200-299": ttl, "404": 60, "500-599": 0 }, cacheEverything: true }, headers: { "User-Agent": "ups-worker", Accept: "application/json" } })
    .then((r) => (r && r.ok ? r.json() : null)).catch(() => null);
  const cur = currentSeason(now);
  const U = fpaUrls(yr, L, FPA_MFL_TAG);
  const horizonWeeks = [wk + 1, wk + 2, wk + 3];

  try {
    // Which season the defense numbers describe. From Week 2 on, this season. In
    // Week 1, this season once one of its games is final; before that, last season
    // (labeled as such), the same rule as the Pts Agst board.
    let ratingYr = yr, priorSeason = false, firstWeek = null;
    if (wk === 1) {
      firstWeek = await fetchJson(U.sched(1), 120);
      if (!(firstWeek && firstWeek.nflSchedule)) throw new FpaUpstreamError("NFL schedule", [1]);
      const anyFinal = arr(firstWeek.nflSchedule.matchup).some((m) => fpaGameStatus(m, now) === "final");
      if (!anyFinal) { ratingYr = String(Number(yr) - 1); priorSeason = true; }
    }
    const past = Number(ratingYr) < cur;
    const mfl = await fpaLoadMfl({ yr: ratingYr, wMin: 1, wMax: 99, lid: L, fetchJson, nowMs: now, currentSeason: !past, tag: FPA_MFL_TAG });

    // This week's games and the next three weeks. When the ratings are this season's,
    // the engine has already read every week of it.
    const schedFor = {};
    const need = [wk].concat(horizonWeeks);
    if (!priorSeason) for (const w of need) if (mfl.schedByWeek[w]) schedFor[w] = mfl.schedByWeek[w];
    if (priorSeason && firstWeek) schedFor[1] = arr(firstWeek.nflSchedule.matchup);
    const missing = need.filter((w) => !schedFor[w] && w <= 18);
    const extra = await Promise.all(missing.map((w) => fetchJson(U.sched(w), 120)));
    const bad = [];
    missing.forEach((w, i) => { if (extra[i] && extra[i].nflSchedule) schedFor[w] = arr(extra[i].nflSchedule.matchup); else if (w === wk) bad.push(w); });
    if (bad.length) throw new FpaUpstreamError("NFL schedule", bad);
    const matchups = lmuMatchups(schedFor[wk], now);
    const horizonRead = horizonWeeks.filter((w) => w <= mfl.endWeek && schedFor[w] && schedFor[w].length);
    const horizon = lmuHorizon(schedFor, horizonRead);

    // The window: the full season through the latest completed game (the Pts Agst
    // default), or the last N weeks of it.
    const ws = fpaWeekStates(mfl, now);
    const hi = ws.latestFinal;
    const lo = last && hi ? Math.max(1, hi - last + 1) : 1;
    const { ctx: seasonCtx, state: ctxState } = await fpaSeasonContextCached(env, ctx, ratingYr, past);
    let defRatings = {}, playerWindow = {}, weeksUsed = [], attribution = null;
    if (hi >= 1) {
      const E = fpaCompute(mfl, seasonCtx, { wMin: lo, wMax: hi, nowMs: now, baseline: FPA_BASELINE });
      ({ defRatings, playerWindow } = lmuRatings(E, fpaAggregate(E)));
      for (let w = lo; w <= hi; w++) if ((E.weekGames[w] || []).some((g) => g.status === "final")) weeksUsed.push(w);
      attribution = { ...E.attribution, context: ctxState, nflverseThrough: seasonCtx ? seasonCtx.through : 0 };
    }

    const csv = await doFetch("https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv", { cf: { cacheTtl: 21600, cacheEverything: true }, headers: { "User-Agent": "ups-worker" } })
      .then((r) => (r && r.ok ? r.text() : null)).catch(() => null);
    const wx = await lmuWeather(matchups, fetchJson, now, lmuNeutralTeams(csv, yr, wk));
    const weeksAvailable = priorSeason ? 0 : ws.latestFinal;
    const basis = !weeksUsed.length ? "" : (priorSeason ? ratingYr + " season" : (weeksUsed.length === 1 ? "Wk " + weeksUsed[0] : "Wks " + weeksUsed[0] + "–" + weeksUsed[weeksUsed.length - 1]));
    const payload = {
      ok: true, engine: FPA_ENGINE_VERSION, version: LINEUP_MU_VERSION, baseline: FPA_BASELINE,
      year: yr, week: wk, ratingYear: ratingYr, priorSeason,
      window: last || null,
      ratingWindow: { week_min: lo, week_max: hi, last: last || null, auto: true },
      weeksUsed, weeksAvailable, ratingsBasis: basis,
      season: { endWeek: mfl.endWeek, lastCompleteWeek: ws.lastComplete, latestFinalWeek: ws.latestFinal },
      matchups, defRatings, playerWindow, horizon, horizonWeeks: horizonRead, weather: wx.weather, weatherState: wx.state,
      attribution, as_of: asOf, mfl_read_at: new Date(mfl.readAtMs).toISOString(),
    };
    const body = JSON.stringify(payload);
    // A complete answer only. The week's games, spread and weather move, so at most
    // 5 minutes; 2 minutes while a game in the window or this week is not final.
    const anyOpen = Object.keys(matchups).some((t) => matchups[t].status !== "final") || ws.latestFinal > ws.lastComplete;
    let ttl = anyOpen ? 120 : 300;
    if (wx.state !== "ok") ttl = 60;
    if (ctxState === "ok" || hi < 1) cachePut(ctx, cacheKey, body, ttl);
    return new Response(body, { status: 200, headers: jsonOut(200, {}).headers });
  } catch (e) {
    if (e instanceof FpaUpstreamError) return jsonOut(502, { ok: false, error: "mfl_unavailable", detail: e.message, failedWeeks: e.weeks, as_of: asOf });
    throw e;
  }
}
