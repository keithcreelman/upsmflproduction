// league_year.js — which MFL league year is LIVE right now (the season the */5 drop pipeline runs as).
//
// The calendar year is not the league year. The UPS season ends with NFL Week 17, which can run into January
// (2026: Thu Dec 31 – Mon Jan 4), and MFL does not roll the league over on Jan 1: the 2026 league stays live until
// the commissioner renews it, and until then the 2027 league does not exist — its exports 404 (verified
// 2026-10-09: https://api.myfantasyleague.com/2027/export?TYPE=league&L=74598 → HTTP 404 "Not Found"; a year MFL
// has opened but this league has not been renewed in answers HTTP 200 {"error":{"$t":"Invalid league ID …"}}).
// Run as the calendar year from Jan 1, the drop recorder scans a league that does not exist and every drop made
// in the still-live league is missed.
//
// So the live league year is read from MFL itself:
//   - this calendar year's league EXISTS                                → it is live (the normal case, Mar–Dec)
//   - it is definitively ABSENT, and last year's league exists and its own history lists nothing later than
//     itself                                                             → last year's league is still live
//   - anything else — an unreadable export, a timeout, or the two answers contradicting each other (last year's
//     history already lists this year, yet this year's export is "absent")
//                                                                        → UNRESOLVED: the caller runs nothing.
// UNRESOLVED is never turned into a guess. A drop recorded under the wrong season is priced on the wrong week
// calendar (a 2026 Week-17 drop read on 2027's calendar has 0 weeks earned → the full guarantee), so the pipeline
// waits — the recorder's lookback picks the drop up on the first tick that resolves.
//
// MFL's league history is the cross-check: renewing a league lists the new year in EVERY linked year's history
// (verified 2026-10-09: the 2025 league's export lists 2010–2026), so "last year's league is still the latest"
// is something MFL states, not something inferred from the calendar.
//
// env.YEAR, when set, is an explicit operator pin and wins (unchanged behaviour).

function digits(v) { return String(v == null ? "" : v).replace(/\D/g, ""); }

// Classify one raw MFL `TYPE=league` export response: { state: "exists" | "absent" | "unknown", history_years, detail }.
// Strict on purpose — only the two shapes MFL actually serves for a league year that does not exist count as
// "absent"; everything else that is not this league's own export is "unknown".
export function classifyLeagueExport(res, leagueId) {
  const status = Number(res && res.status) || 0;
  const text = String((res && res.text) || "");
  if (status === 404) return { state: "absent", history_years: null, detail: "http_404" };
  if (status !== 200) return { state: "unknown", history_years: null, detail: status ? `http_${status}` : "no_response" };
  let data = null;
  try { data = JSON.parse(text); } catch (_) { data = null; }
  if (!data || typeof data !== "object") return { state: "unknown", history_years: null, detail: "non_json" };
  const err = data.error && (typeof data.error === "object" ? data.error.$t : data.error);
  if (err) {
    return /invalid league id/i.test(String(err))
      ? { state: "absent", history_years: null, detail: "invalid_league_id" }
      : { state: "unknown", history_years: null, detail: `mfl_error:${String(err).slice(0, 80)}` };
  }
  const lg = data.league;
  if (!lg || typeof lg !== "object" || !digits(lg.id) || digits(lg.id) !== digits(leagueId)) {
    return { state: "unknown", history_years: null, detail: "not_this_league" };
  }
  let hist = lg.history && lg.history.league;
  hist = Array.isArray(hist) ? hist : (hist ? [hist] : []);
  const years = hist.map((h) => Number(digits(h && h.year))).filter((y) => y > 1900);
  return { state: "exists", history_years: years.length ? years : null, detail: "ok" };
}

// Resolve the live league year. `readLeague(year)` returns { status, text } for that year's raw `TYPE=league`
// export (it may throw — a throw is "unknown"). Returns { ok: true, season, source, calendar_year } or
// { ok: false, season: null, reason, calendar_year }.
export async function resolveLiveLeagueYear({ leagueId, nowMs, pinnedYear, readLeague }) {
  const pin = digits(pinnedYear);
  const cal = new Date(Number(nowMs)).getUTCFullYear();
  if (pin) return { ok: true, season: pin, source: "env.YEAR", calendar_year: cal };
  if (!(cal > 1900)) return { ok: false, season: null, reason: "clock_unreadable", calendar_year: null };
  const read = async (y) => {
    try { return classifyLeagueExport(await readLeague(y), leagueId); }
    catch (e) { return { state: "unknown", history_years: null, detail: `fetch_failed:${String((e && e.message) || e).slice(0, 80)}` }; }
  };
  const cur = await read(cal);
  if (cur.state === "exists") return { ok: true, season: String(cal), source: `mfl_league_${cal}_exists`, calendar_year: cal };
  if (cur.state !== "absent") return { ok: false, season: null, reason: `league_${cal}_unreadable:${cur.detail}`, calendar_year: cal };
  const prevYear = cal - 1;
  const prev = await read(prevYear);
  if (prev.state !== "exists") {
    return { ok: false, season: null, reason: `league_${cal}_absent:${cur.detail}+league_${prevYear}_${prev.state}:${prev.detail}`, calendar_year: cal };
  }
  const hist = prev.history_years;
  if (!hist || !hist.includes(prevYear)) {
    return { ok: false, season: null, reason: `league_${cal}_absent+league_${prevYear}_history_unreadable`, calendar_year: cal };
  }
  const later = hist.filter((y) => y > prevYear);
  if (later.length) {
    return { ok: false, season: null, reason: `contradiction:league_${prevYear}_history_lists_${Math.max(...later)}_but_league_${cal}_${cur.detail}`, calendar_year: cal };
  }
  return { ok: true, season: String(prevYear), source: `mfl_league_${cal}_${cur.detail}+league_${prevYear}_latest`, calendar_year: cal };
}
