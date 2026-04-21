const acquisitionLiveMemoryCache = new Map();
const contractDiscordChannelQueues = new Map();
const contractDiscordChannelLastSendMs = new Map();

// Phase 2 backup helper — snapshots MFL public exports for the league
// to the R2 bucket bound at env.UPS_MFL_BACKUPS. Key layout:
//   snapshots/YYYY-MM-DD/{rosters,salaries,transactions,injuries,league,freeAgents,draftResults}.json
//   snapshots/YYYY-MM-DD/_snapshot_meta.json
// Mirrors what the GitHub Actions workflow writes into the repo, so a
// future read path can fall back from R2 to the git-committed copy
// without schema translation. Fails loudly in the Worker log; the
// scheduled-handler caller wraps this in waitUntil with its own catch.
async function snapshotMflToR2(env, nowUtc) {
  const bucket = env.UPS_MFL_BACKUPS;
  if (!bucket) throw new Error("R2 binding UPS_MFL_BACKUPS missing");
  const leagueId = String(env.LEAGUE_ID || "74598");
  const season = String(env.YEAR || nowUtc.getUTCFullYear());
  const y = nowUtc.getUTCFullYear();
  const m = String(nowUtc.getUTCMonth() + 1).padStart(2, "0");
  const d = String(nowUtc.getUTCDate()).padStart(2, "0");
  const dateKey = `${y}-${m}-${d}`;
  const prefix = `snapshots/${dateKey}`;
  const UA = "upsmflproduction-worker-daily-snapshot";
  const exports = [
    ["salaries",     `https://api.myfantasyleague.com/${season}/export?TYPE=salaries&L=${leagueId}&JSON=1`],
    ["transactions", `https://www48.myfantasyleague.com/${season}/export?TYPE=transactions&L=${leagueId}&JSON=1`],
    ["rosters",      `https://www48.myfantasyleague.com/${season}/export?TYPE=rosters&L=${leagueId}&JSON=1`],
    ["injuries",     `https://www48.myfantasyleague.com/${season}/export?TYPE=injuries&L=${leagueId}&JSON=1`],
    ["league",       `https://www48.myfantasyleague.com/${season}/export?TYPE=league&L=${leagueId}&JSON=1`],
    ["freeAgents",   `https://www48.myfantasyleague.com/${season}/export?TYPE=freeAgents&L=${leagueId}&JSON=1`],
    ["draftResults", `https://api.myfantasyleague.com/${season}/export?TYPE=draftResults&L=${leagueId}&JSON=1`],
  ];
  const results = await Promise.allSettled(
    exports.map(async ([name, url]) => {
      const res = await fetch(url, { headers: { "User-Agent": UA }, cf: { cacheTtl: 0 } });
      if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
      const text = await res.text();
      // Pretty-print + sort keys for diff-friendly storage, matching the GH Action.
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {}
      await bucket.put(`${prefix}/${name}.json`, pretty, {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: { mfl_league_id: leagueId, season, snapshot_date: dateKey },
      });
      return { name, bytes: pretty.length };
    })
  );
  const meta = {
    snapshot_date_utc: dateKey,
    iso_timestamp: nowUtc.toISOString(),
    league_id: leagueId,
    season_year: season,
    source: "cloudflare-worker-scheduled",
    parts: results.map((r, i) =>
      r.status === "fulfilled"
        ? { name: exports[i][0], ok: true, bytes: r.value.bytes }
        : { name: exports[i][0], ok: false, error: String(r.reason && r.reason.message || r.reason) }
    ),
  };
  await bucket.put(`${prefix}/_snapshot_meta.json`, JSON.stringify(meta, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  const failed = meta.parts.filter((p) => !p.ok);
  console.log(
    `[snapshotMflToR2] ${dateKey}: ${meta.parts.length - failed.length}/${meta.parts.length} OK` +
      (failed.length ? ` — failed: ${failed.map((p) => p.name).join(", ")}` : "")
  );
}

export default {
  // Cloudflare cron trigger — fires every hour at :05 past per wrangler.toml.
  // RULE-WORKFLOW-004: scan MFL add/drop transactions for new drop penalties,
  // post them as salaryAdjustments to MFL, and fire a Discord Cap Penalty
  // Announcement for each (batched per-team). MFL's salaryAdjustments export
  // is the dedup ledger — runs are idempotent by ups_drop_penalty:{ledger_key}.
  async scheduled(event, env, ctx) {
    // Phase 2 backup: once per day (at the 09:05 UTC firing) snapshot the
    // MFL public exports for our league to R2. This runs in parallel with
    // the existing drop-penalty scan below — independent try/catch so one
    // failure doesn't kill the other.
    try {
      const nowUtc = new Date();
      const isDailySnapshotHour = nowUtc.getUTCHours() === 9;
      if (isDailySnapshotHour && env.UPS_MFL_BACKUPS) {
        ctx.waitUntil(snapshotMflToR2(env, nowUtc).catch((e) =>
          console.error(`[scheduled] snapshotMflToR2 failed: ${e && e.message}`)
        ));
      }
    } catch (e) {
      console.error(`[scheduled] snapshot dispatch failed: ${e && e.message}`);
    }

    try {
      const season = String(env.YEAR || new Date().getUTCFullYear());
      const leagueId = String(env.LEAGUE_ID || "74598");
      const origin = String(env.WORKER_ORIGIN || "https://upsmflproduction.keith-creelman.workers.dev");
      const commishApiKey = String(env.COMMISH_API_KEY || "").trim();
      const authHeader = commishApiKey
        ? { "X-Internal-Auth": commishApiKey }
        : {};
      // Step 1: ask ourselves to scan + import new drop penalties to MFL.
      const importUrl = `${origin}/admin/import-drop-penalties?L=${leagueId}&YEAR=${season}`;
      const importRes = await fetch(importUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ season, league_id: leagueId, dry_run: false }),
      });
      const importData = await importRes.json().catch(() => ({}));
      const newlyPosted = Array.isArray(importData.posted_rows) ? importData.posted_rows : [];
      // Step 2: for each franchise that got NEW penalties posted this run,
      // fire a Discord Cap Penalty Announcement. We group by franchise.
      if (!newlyPosted.length) {
        console.log(`[scheduled ${new Date().toISOString()}] drop-penalty scan: no new drops`);
        return;
      }
      const byFranchise = {};
      for (const row of newlyPosted) {
        const fid = String(row.franchise_id || "").padStart(4, "0");
        if (!fid) continue;
        if (!byFranchise[fid]) byFranchise[fid] = { franchise_id: fid, total: 0, lines: [] };
        const m = String(row.explanation || "").match(/UPS drop penalty\s+([A-Za-z0-9 ,.'’\-]+?)\s+(\d+)\s+id:/);
        const playerName = m ? m[1].trim() : "Player";
        const amount = parseInt(row.amount, 10) || 0;
        byFranchise[fid].total += amount;
        byFranchise[fid].lines.push(
          `**${playerName}** dropped — cap penalty **$${amount.toLocaleString("en-US")}**. Applied to ${season}.`
        );
      }
      const capPenaltyChannel = String(env.DISCORD_CAP_PENALTY_CHANNEL_ID || "1066390675207233618");
      const postUrl = `${origin}/admin/cap-penalty/post?L=${leagueId}&YEAR=${season}`;
      for (const [fid, team] of Object.entries(byFranchise)) {
        await fetch(postUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader },
          body: JSON.stringify({
            league_id: leagueId,
            season,
            franchise_id: fid,
            franchise_name: team.franchise_name || "",
            team_total_dollars: team.total,
            activity_year_label: `${season} Activity (auto-detected)`,
            cap_penalty_lines: team.lines,
            channel_id_override: capPenaltyChannel,
          }),
        }).catch((e) => console.error(`[scheduled] discord post failed for ${fid}: ${e.message}`));
      }
      console.log(
        `[scheduled ${new Date().toISOString()}] drop-penalty scan: posted ${newlyPosted.length} penalties across ${Object.keys(byFranchise).length} teams`
      );
    } catch (err) {
      console.error(`[scheduled] drop-penalty cron failed: ${err && err.message}`);
    }
  },

  async fetch(request, env) {
    try {
      // ---------- CORS ----------
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      };
      if (request.method === "OPTIONS") {
        return new Response("", { headers: corsHeaders });
      }

      // ---------- Inputs ----------
      const url = new URL(request.url);
      const path = url.pathname || "/";
      const L = url.searchParams.get("L") || "";
      const defaultSeason = String(new Date().getUTCFullYear());
      const pathYearMatch = String(path || "").match(/\/(\d{4})(?:\/|$)/);
      const YEAR = String(
        url.searchParams.get("YEAR") ||
          (pathYearMatch ? pathYearMatch[1] : defaultSeason) ||
          defaultSeason
      ).trim() || defaultSeason;
      const browserMflUserId = String(url.searchParams.get("MFL_USER_ID") || "").trim();
      const browserApiKey = String(url.searchParams.get("APIKEY") || "").trim();

      if (
        !L &&
        !path.startsWith("/mcm") &&
        path !== "/offer-mym" &&
        path !== "/offer-restructure" &&
        path !== "/commish-contract-update" &&
        path !== "/roster-workbench" &&
        path !== "/roster-workbench/action" &&
        path !== "/trade-workbench" &&
        path !== "/acquisition-hub/bootstrap" &&
        path !== "/acquisition-hub/rookie-draft/live" &&
        path !== "/acquisition-hub/rookie-draft/history" &&
        path !== "/acquisition-hub/rookie-draft/action" &&
        path !== "/acquisition-hub/free-agent-auction/live" &&
        path !== "/acquisition-hub/free-agent-auction/history" &&
        path !== "/acquisition-hub/free-agent-auction/action" &&
        path !== "/acquisition-hub/expired-rookie-auction/live" &&
        path !== "/acquisition-hub/expired-rookie-auction/history" &&
        path !== "/acquisition-hub/expired-rookie-auction/action" &&
        path !== "/acquisition-hub/waivers" &&
        path !== "/acquisition-hub/admin/refresh" &&
        !path.startsWith("/trade-offers") &&
        !path.startsWith("/trade-outbox") &&
        path !== "/refresh/after-trade" &&
        path !== "/trade-pending" &&
        path !== "/salary-alignment-check" &&
        path !== "/admin/test-sync/prod-rosters" &&
        path !== "/admin/test-sync/prod-statuses" &&
        path !== "/admin/test-sync/prod-salaries" &&
        path !== "/admin/discord/post" &&
        path !== "/admin/deadline-reminders/test-discord" &&
        path !== "/admin/deadline-reminders/run" &&
        path !== "/admin/contract-activity/test-discord" &&
        path !== "/admin/trade-notification/test-discord" &&
        path !== "/admin/trade-notification/post" &&
        path !== "/admin/cap-penalty/test-discord" &&
        path !== "/admin/cap-penalty/post" &&
        path !== "/admin/restructure-alert/test-discord" &&
        path !== "/admin/restructure-alert/post" &&
        path !== "/admin/contract-activity/test-discord-batch" &&
        path !== "/admin/contract-activity/post" &&
        path !== "/admin/contract-activity/post-batch" &&
        path !== "/admin/contract-activity/edit" &&
        path !== "/admin/bug-report/status" &&
        path !== "/admin/bug-report/triage-note" &&
        path !== "/admin/bug-report/test-discord" &&
        path !== "/admin/snapshot-mfl-now" &&
        path !== "/bug-report" &&
        path !== "/bug-reports" &&
        path !== "/extension-assistant" &&
        !path.startsWith("/api/trades/proposals") &&
        !path.startsWith("/api/trades/outbox") &&
        !path.startsWith("/api/trades/reconcile") &&
        !path.startsWith("/api/trades/refresh-after-trade")
      ) {
        return new Response(
          JSON.stringify({ ok: false, isAdmin: false, reason: "Missing L param" }),
          { status: 400, headers: { "content-type": "application/json", ...corsHeaders } }
        );
      }

      // ---------- Admin: manual MFL→R2 snapshot trigger ----------
      // Lets us verify the R2 backup path without waiting for the 09:05 UTC
      // cron. Protected with the same X-Internal-Auth header the other
      // admin endpoints use. GET is fine here — it's idempotent (an extra
      // snapshot for today's date just overwrites).
      if (path === "/admin/snapshot-mfl-now") {
        const commishApiKey = String(env.COMMISH_API_KEY || "").trim();
        const authHeader = String(request.headers.get("X-Internal-Auth") || "").trim();
        if (commishApiKey && authHeader !== commishApiKey) {
          return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json", ...corsHeaders },
          });
        }
        try {
          await snapshotMflToR2(env, new Date());
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json", ...corsHeaders },
          });
        } catch (e) {
          return new Response(JSON.stringify({ ok: false, error: String(e && e.message || e) }), {
            status: 500,
            headers: { "content-type": "application/json", ...corsHeaders },
          });
        }
      }

      // ---------- MCM (No MFL Cookie Required) ----------
      const jsonOut = (status, payload) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json", ...corsHeaders },
        });

      const MCM_SEED_URL = "https://keithcreelman.github.io/upsmflproduction/site/mcm/mcm_seed.json";
      const MCM_VOTES_URL = "https://keithcreelman.github.io/upsmflproduction/site/mcm/mcm_votes.json";
      const MCM_NOMS_URL = "https://keithcreelman.github.io/upsmflproduction/site/mcm/mcm_nominations.json";

      const fetchJson = async (u, fallback) => {
        try {
          const res = await fetch(u, {
            headers: { "Cache-Control": "no-store" },
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          if (!res.ok) return fallback;
          return await res.json();
        } catch (_) {
          return fallback;
        }
      };

      const safeStr = (v) => String(v == null ? "" : v).trim();

      const isValidUrl = (v) => {
        const s = safeStr(v);
        if (!s) return false;
        try {
          const p = new URL(s);
          return p.protocol === "http:" || p.protocol === "https:";
        } catch (_) {
          return false;
        }
      };

      const sha256Hex = async (text) => {
        const buf = new TextEncoder().encode(String(text || ""));
        const hash = await crypto.subtle.digest("SHA-256", buf);
        return Array.from(new Uint8Array(hash))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      };

      const utcNowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

      const utcYmd = (d) => {
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, "0");
        const day = String(d.getUTCDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
      };

      const firstMondayOfYearUtc = (year) => {
        const d = new Date(Date.UTC(year, 0, 1));
        const weekday = d.getUTCDay(); // Sun=0..Sat=6
        const offset = (8 - (weekday || 7)) % 7; // to Monday
        d.setUTCDate(d.getUTCDate() + offset);
        return d;
      };

      const currentSeasonYear = (seed) => {
        const mode = safeStr(seed?.season?.year_mode || "current");
        if (!mode || mode === "current") return new Date().getUTCFullYear();
        const n = Number(mode);
        return Number.isFinite(n) && n >= 2000 ? n : new Date().getUTCFullYear();
      };

      const seasonStartUtc = (seed, year) => {
        const start = safeStr(seed?.season?.season_start || "first_monday");
        if (!start || start === "first_monday") return firstMondayOfYearUtc(year);
        const m = start.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
        return firstMondayOfYearUtc(year);
      };

      const weekInfoByNumber = (seed, cycle, weekNoRaw) => {
        const year = currentSeasonYear(seed);
        const start = seasonStartUtc(seed, year);
        const regularWeeks = Number(seed?.season?.regular_weeks || 48);
        const playoffWeeks = Number(seed?.season?.playoff_weeks || 4);
        const totalWeeks = regularWeeks + playoffWeeks;
        const w = Math.max(1, Math.min(totalWeeks, Number(weekNoRaw || 1) || 1));
        const phase = w <= regularWeeks ? "regular" : "playoffs";
        const genreId = phase === "regular" ? cycle[(w - 1) % cycle.length] : "playoffs";
        const weekStart = new Date(start.getTime());
        weekStart.setUTCDate(weekStart.getUTCDate() + (w - 1) * 7);
        const weekEnd = new Date(weekStart.getTime());
        weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
        return {
          season_year: year,
          season_start: utcYmd(start),
          regular_weeks: regularWeeks,
          playoff_weeks: playoffWeeks,
          total_weeks: totalWeeks,
          week_no: w,
          phase,
          genre_id: genreId,
          week_start: utcYmd(weekStart),
          week_end: utcYmd(weekEnd),
          today_utc: utcYmd(new Date()),
        };
      };

      const weekInfoNow = (seed, cycle) => {
        const year = currentSeasonYear(seed);
        const start = seasonStartUtc(seed, year);
        const today = new Date();
        const msPerDay = 86400000;
        const deltaDays = Math.floor((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - start.getTime()) / msPerDay);
        const regularWeeks = Number(seed?.season?.regular_weeks || 48);
        const playoffWeeks = Number(seed?.season?.playoff_weeks || 4);
        const totalWeeks = regularWeeks + playoffWeeks;
        const computedWeek = deltaDays < 0 ? 1 : Math.floor(deltaDays / 7) + 1;
        return weekInfoByNumber(seed, cycle, Math.max(1, Math.min(totalWeeks, computedWeek)));
      };

      const playoffRoundForWeek = (weekNo, regularWeeks, playoffWeeks) => {
        if (playoffWeeks < 4) return null;
        const offset = weekNo - regularWeeks;
        if (offset === 1) return { id: "R16", name: "Round of 16", matchups: 8 };
        if (offset === 2) return { id: "QF", name: "Quarterfinals", matchups: 4 };
        if (offset === 3) return { id: "SF", name: "Semifinals", matchups: 2 };
        if (offset === 4) return { id: "F", name: "Final", matchups: 1 };
        return null;
      };

      const buildNominees = (seed, nomDoc) => {
        const out = [];
        const seedNominees = Array.isArray(seed?.nominees) ? seed.nominees : [];
        for (const n of seedNominees) {
          if (!n || !safeStr(n.id)) continue;
          out.push({
            id: safeStr(n.id),
            display_name: safeStr(n.display_name),
            genre_id: safeStr(n.genre_id),
            primary_url: safeStr(n.primary_url),
            image_url: safeStr(n.image_url),
            source: "seed",
            active: true,
          });
        }

        const noms = Array.isArray(nomDoc?.nominations) ? nomDoc.nominations : [];
        for (const n of noms) {
          if (!n) continue;
          const status = safeStr(n.status || "approved");
          if (status === "rejected") continue;
          const nid = safeStr(n.nomination_id);
          if (!nid) continue;
          out.push({
            id: "user-" + nid,
            display_name: safeStr(n.display_name),
            genre_id: safeStr(n.genre_id),
            primary_url: safeStr(n.primary_url),
            image_url: safeStr(n.image_url),
            notes: safeStr(n.notes),
            source: status === "approved" ? "approved" : "pending",
            active: true,
          });
        }

        // De-dupe by id
        const seen = new Set();
        return out.filter((n) => {
          if (!n.id || seen.has(n.id)) return false;
          seen.add(n.id);
          return true;
        });
      };

      const voteCounts = (voteDoc, seasonYear, weekNo, phase, matchupKey) => {
        const votes = Array.isArray(voteDoc?.votes) ? voteDoc.votes : [];
        const out = new Map();
        for (const v of votes) {
          if (!v) continue;
          if (Number(v.season_year) !== Number(seasonYear)) continue;
          if (Number(v.week_no) !== Number(weekNo)) continue;
          const mk = safeStr(v.matchup_key || "regular");
          if (safeStr(matchupKey) !== mk) continue;
          const keyPhase = phase || (mk === "regular" ? "regular" : "playoffs");
          // We don't store phase in JSON; infer it.
          const inferred = mk === "regular" ? "regular" : "playoffs";
          if (keyPhase && inferred !== keyPhase) continue;
          const nid = safeStr(v.nominee_id);
          if (!nid) continue;
          out.set(nid, (out.get(nid) || 0) + 1);
        }
        return out;
      };

      const seedMapFromVotes = (voteDoc, nominees, seasonYear, regularWeeks, want) => {
        const votes = Array.isArray(voteDoc?.votes) ? voteDoc.votes : [];
        const counts = new Map();
        for (const v of votes) {
          if (!v) continue;
          if (Number(v.season_year) !== Number(seasonYear)) continue;
          if (Number(v.week_no) > Number(regularWeeks)) continue;
          if (safeStr(v.matchup_key || "regular") !== "regular") continue;
          const nid = safeStr(v.nominee_id);
          if (!nid) continue;
          counts.set(nid, (counts.get(nid) || 0) + 1);
        }

        const allIds = nominees.map((n) => n.id);
        const ranked = allIds
          .map((id) => ({ id, votes: counts.get(id) || 0 }))
          .sort((a, b) => (b.votes - a.votes) || a.id.localeCompare(b.id))
          .slice(0, want);

        const map = {};
        for (let i = 0; i < ranked.length; i += 1) map[ranked[i].id] = i + 1;
        return map;
      };

      const matchupPairsForRound = (roundId, seedMap, prevWinners) => {
        const bySeed = {};
        for (const [nid, seedNo] of Object.entries(seedMap || {})) bySeed[Number(seedNo)] = nid;
        const s = (n) => bySeed[n] || "";
        if (roundId === "R16") {
          const pairs = [
            [1, 16],
            [8, 9],
            [5, 12],
            [4, 13],
            [6, 11],
            [3, 14],
            [7, 10],
            [2, 15],
          ];
          return pairs.map(([a, b], i) => [`R16-${i + 1}`, s(a), s(b)]);
        }
        if (roundId === "QF") {
          return [
            ["QF-1", prevWinners["R16-1"] || "", prevWinners["R16-2"] || ""],
            ["QF-2", prevWinners["R16-3"] || "", prevWinners["R16-4"] || ""],
            ["QF-3", prevWinners["R16-5"] || "", prevWinners["R16-6"] || ""],
            ["QF-4", prevWinners["R16-7"] || "", prevWinners["R16-8"] || ""],
          ];
        }
        if (roundId === "SF") {
          return [
            ["SF-1", prevWinners["QF-1"] || "", prevWinners["QF-2"] || ""],
            ["SF-2", prevWinners["QF-3"] || "", prevWinners["QF-4"] || ""],
          ];
        }
        if (roundId === "F") {
          return [["F-1", prevWinners["SF-1"] || "", prevWinners["SF-2"] || ""]];
        }
        return [];
      };

      const winnerForMatchup = (voteDoc, seasonYear, weekNo, matchupKey, aId, bId, seedMap) => {
        if (!aId || !bId) return aId || bId || "";
        const counts = voteCounts(voteDoc, seasonYear, weekNo, "playoffs", matchupKey);
        const aC = counts.get(aId) || 0;
        const bC = counts.get(bId) || 0;
        if (aC > bC) return aId;
        if (bC > aC) return bId;
        const aSeed = Number(seedMap[aId] || 10000);
        const bSeed = Number(seedMap[bId] || 10000);
        if (aSeed < bSeed) return aId;
        if (bSeed < aSeed) return bId;
        return aId < bId ? aId : bId;
      };

      const getIpHash = async () => {
        const ip =
          safeStr(request.headers.get("CF-Connecting-IP")) ||
          safeStr((request.headers.get("X-Forwarded-For") || "").split(",")[0]) ||
          "";
        const salt = safeStr(env.MCM_SALT || "");
        return sha256Hex(`${salt}|${ip}`);
      };

      // ---------- Rookie Draft Hub: /api/player-bundle ----------
      // Lean port of build_player_bundle from rookie_draft_bridge.py. Fetches
      // the MFL-public surface: playerProfile (bio/career), players DETAILS
      // (college/draft/jersey), injuries, live rosters (current contract +
      // franchise), and freeAgents (is-FA fallback). Skipped vs the Python
      // bridge (needs local mfl_database.db): career_summary, last_add,
      // trade_history, weekly game logs, rosters_weekly fallback. The Draft
      // Hub UI degrades gracefully when those fields are absent.
      if (path === "/api/player-bundle" && request.method === "GET") {
        const pid = safeStr(url.searchParams.get("pid"));
        if (!pid) return jsonOut(400, { error: "missing pid" });
        const year = YEAR;
        const leagueId = L || "74598";
        const mflFetch = (u, ttl) =>
          fetch(u, {
            headers: { "User-Agent": "upsmflproduction-worker" },
            cf: { cacheTtl: ttl || 60, cacheEverything: true },
          });
        const bundle = { player_id: pid };
        // Public MFL endpoints — fetch in parallel.
        const [profileRes, detailsRes, injRes, rostersRes, leagueRes] = await Promise.allSettled([
          mflFetch(`https://api.myfantasyleague.com/${encodeURIComponent(year)}/export?TYPE=playerProfile&P=${encodeURIComponent(pid)}&JSON=1`, 60),
          mflFetch(`https://api.myfantasyleague.com/${encodeURIComponent(year)}/export?TYPE=players&DETAILS=1&PLAYERS=${encodeURIComponent(pid)}&JSON=1`, 86400),
          mflFetch(`https://www48.myfantasyleague.com/${encodeURIComponent(year)}/export?TYPE=injuries&L=${encodeURIComponent(leagueId)}&JSON=1`, 300),
          mflFetch(`https://www48.myfantasyleague.com/${encodeURIComponent(year)}/export?TYPE=rosters&L=${encodeURIComponent(leagueId)}&JSON=1`, 60),
          mflFetch(`https://www48.myfantasyleague.com/${encodeURIComponent(year)}/export?TYPE=league&L=${encodeURIComponent(leagueId)}&JSON=1`, 600),
        ]);
        // 1. playerProfile
        try {
          if (profileRes.status === "fulfilled" && profileRes.value.ok) {
            bundle.profile = await profileRes.value.json();
          } else {
            bundle.profile_error = profileRes.status === "fulfilled" ? `HTTP ${profileRes.value.status}` : String(profileRes.reason);
          }
        } catch (e) {
          bundle.profile_error = String(e && e.message ? e.message : e);
        }
        // 2. DETAILS — merge into bundle.profile.playerProfile.player
        try {
          if (detailsRes.status === "fulfilled" && detailsRes.value.ok) {
            const details = await detailsRes.value.json();
            let ps = details?.players?.player;
            if (ps && !Array.isArray(ps)) ps = [ps];
            if (ps && ps[0]) {
              if (!bundle.profile) bundle.profile = {};
              const pp = bundle.profile.playerProfile || {};
              if (!pp.player) pp.player = {};
              for (const k of Object.keys(ps[0])) {
                if (pp.player[k] === undefined) pp.player[k] = ps[0][k];
              }
              bundle.profile.playerProfile = pp;
            }
          } else {
            bundle.details_error = detailsRes.status === "fulfilled" ? `HTTP ${detailsRes.value.status}` : String(detailsRes.reason);
          }
        } catch (e) {
          bundle.details_error = String(e && e.message ? e.message : e);
        }
        // 3. Injuries — filter to this pid
        try {
          if (injRes.status === "fulfilled" && injRes.value.ok) {
            const data = await injRes.value.json();
            let players = data?.injuries?.injury || [];
            if (players && !Array.isArray(players)) players = [players];
            for (const p of players) {
              if (String(p.id) === String(pid)) { bundle.injury = p; break; }
            }
          } else if (injRes.status === "rejected") {
            bundle.injuries_error = String(injRes.reason);
          }
        } catch (e) {
          bundle.injuries_error = String(e && e.message ? e.message : e);
        }
        // 4. Live rosters — is player currently rostered, and under what contract?
        try {
          let rosterData = null;
          let leagueData = null;
          if (rostersRes.status === "fulfilled" && rostersRes.value.ok) rosterData = await rostersRes.value.json();
          if (leagueRes.status === "fulfilled" && leagueRes.value.ok) leagueData = await leagueRes.value.json();
          let franchises = rosterData?.rosters?.franchise || [];
          if (!Array.isArray(franchises)) franchises = [franchises];
          let lf = leagueData?.league?.franchises?.franchise || [];
          if (!Array.isArray(lf)) lf = [lf];
          const fidToName = {};
          for (const f of lf) fidToName[String(f.id)] = f.name || "";
          let rd = null;
          for (const f of franchises) {
            const fid = String(f.id);
            let players = f.player || [];
            if (!Array.isArray(players)) players = [players];
            for (const pp of players) {
              if (String(pp.id) !== String(pid)) continue;
              rd = {
                season: Number(year),
                franchise_id: fid,
                team_name: fidToName[fid] || fid,
                salary: Math.round(Number(pp.salary || 0)),
                contract_year: Number(pp.contractYear || 0),
                contract_status: pp.contractStatus || "",
                contract_info: pp.contractInfo || "",
                status: pp.status || "",
              };
              break;
            }
            if (rd) break;
          }
          if (rd) {
            bundle.current_roster = rd;
          } else if (rosterData) {
            // 5. FA fallback — check the free-agent pool.
            try {
              const faRes = await mflFetch(
                `https://www48.myfantasyleague.com/${encodeURIComponent(year)}/export?TYPE=freeAgents&L=${encodeURIComponent(leagueId)}&JSON=1`,
                60
              );
              if (faRes.ok) {
                const faData = await faRes.json();
                let faPlayers = faData?.freeAgents?.leagueUnit?.player || [];
                if (faPlayers && !Array.isArray(faPlayers)) faPlayers = [faPlayers];
                if (faPlayers.some((p) => String(p.id) === String(pid))) {
                  bundle.is_free_agent = true;
                } else {
                  bundle.is_not_rostered = true;
                }
              } else {
                bundle.fa_check_error = `HTTP ${faRes.status}`;
                bundle.is_not_rostered = true;
              }
            } catch (e) {
              bundle.fa_check_error = String(e && e.message ? e.message : e);
              bundle.is_not_rostered = true;
            }
          } else {
            bundle.live_roster_error = "rosters fetch failed";
          }
        } catch (e) {
          bundle.live_roster_error = String(e && e.message ? e.message : e);
        }
        // ---- Comprehensive enrichment: career_summary + last_add + trade_history ----
        // All sourced from MFL public APIs so no local DB dependency. Same shapes
        // as the Python bridge's build_player_bundle for these keys.
        const curYear = Number(year);
        // Fence how far we look back; 10 seasons is a good career window and still
        // cheap (10 parallel YTD lookups + 3 parallel transactions queries).
        const careerYears = [];
        for (let y = curYear; y >= Math.max(2012, curYear - 10); y--) careerYears.push(String(y));
        // Recent seasons to scan for trade_history and last_add. Transactions are
        // season-scoped on MFL — current + 2 back covers "the most recent movement."
        const txYears = [String(curYear), String(curYear - 1), String(curYear - 2)];

        // --- career_summary: one YTD fetch per season ---
        const careerFetches = careerYears.map((y) =>
          mflFetch(
            `https://api.myfantasyleague.com/${encodeURIComponent(y)}/export?TYPE=playerScores&L=${encodeURIComponent(leagueId)}&P=${encodeURIComponent(pid)}&W=YTD&JSON=1`,
            600
          ).then(async (res) => {
            if (!res.ok) return { season: Number(y), error: "HTTP " + res.status };
            const j = await res.json();
            let ps = j?.playerScores?.playerScore;
            if (ps && Array.isArray(ps)) ps = ps[0];
            const pts = ps ? Number(ps.score) : 0;
            return { season: Number(y), season_points: Number.isFinite(pts) ? Math.round(pts * 10) / 10 : 0 };
          }).catch((e) => ({ season: Number(y), error: String(e && e.message ? e.message : e) }))
        );

        // --- trade_history + last_add: season-scoped transactions scans ---
        const txFetches = txYears.map((y) =>
          mflFetch(
            `https://www48.myfantasyleague.com/${encodeURIComponent(y)}/export?TYPE=transactions&L=${encodeURIComponent(leagueId)}&JSON=1`,
            300
          ).then(async (res) => {
            if (!res.ok) return { year: y, rows: [] };
            const j = await res.json();
            let rows = j?.transactions?.transaction || [];
            if (rows && !Array.isArray(rows)) rows = [rows];
            return { year: y, rows };
          }).catch(() => ({ year: y, rows: [] }))
        );

        const [careerSettled, txSettled] = await Promise.all([
          Promise.all(careerFetches),
          Promise.all(txFetches),
        ]);

        bundle.career_summary = careerSettled
          .filter((r) => !r.error && r.season_points > 0)
          .sort((a, b) => b.season - a.season);

        // Flatten transactions across seasons, keep only those touching this pid.
        // Trade entries: MFL packs given-up/received into franchise1_gave_up +
        // franchise2_gave_up (comma-delimited asset tokens). Each numeric token
        // without an "FP_"/"DP_" prefix is a player_id.
        const trades = [];
        let lastAdd = null;
        const tokensIncludePid = (s) => {
          if (!s) return false;
          return s.split(",").some((tok) => {
            const t = tok.trim();
            return t && !t.startsWith("FP_") && !t.startsWith("DP_") && t === String(pid);
          });
        };
        for (const { year: txYear, rows } of txSettled) {
          for (const t of rows) {
            const type = String(t.type || "").toUpperCase();
            const ts = Number(t.timestamp) || 0;
            if (type === "TRADE") {
              const inF1 = tokensIncludePid(t.franchise1_gave_up || "");
              const inF2 = tokensIncludePid(t.franchise2_gave_up || "");
              if (!inF1 && !inF2) continue;
              // Asset role = "sent" if the player was in the gaveUp side, so the
              // owning franchise at the time is the one that gave him up.
              const giverFid = inF1 ? String(t.franchise || "") : String(t.franchise2 || "");
              trades.push({
                season: Number(txYear),
                unix_timestamp: ts,
                datetime_et: ts ? new Date(ts * 1000).toISOString().replace("T", " ").replace(/\..*/, "") : "",
                franchise_id: giverFid,
                asset_role: "sent",
                comments: String(t.comments || ""),
              });
              continue;
            }
            // Acquisition-type transactions: capture the most recent one that
            // involves this pid. MFL names vary (FREE_AGENT, WAIVER, AUCTION_*,
            // BBID_AUCTION_WON, DRAFT, etc.). The pid appears in the
            // "transaction" field, typically as a leading token or after $.
            if (/ADD|FREE_AGENT|WAIVER|AUCTION|DRAFT|BBID/.test(type)) {
              const raw = String(t.transaction || "");
              const leadTok = raw.split(/[,|]/)[0].split("$")[0].trim();
              if (leadTok !== String(pid)) continue;
              if (!lastAdd || ts > (lastAdd._ts || 0)) {
                lastAdd = {
                  season: Number(txYear),
                  franchise_id: String(t.franchise || ""),
                  franchise_name: "",
                  move_type: "ADD",
                  method: type,
                  salary: null,
                  datetime_et: ts ? new Date(ts * 1000).toISOString().replace("T", " ").replace(/\..*/, "") : "",
                  _ts: ts,
                };
                // Crude salary parse — auction tokens often look like "pid$500$"
                const m = raw.match(/\$(\d+(?:\.\d+)?)/);
                if (m) lastAdd.salary = Number(m[1]);
              }
            }
          }
        }
        if (lastAdd) delete lastAdd._ts;
        trades.sort((a, b) => b.unix_timestamp - a.unix_timestamp);
        bundle.trade_history = trades;
        bundle.last_add = lastAdd || {};
        // weekly (game-log details) still needs baselines → keep empty for now.
        bundle.weekly = [];
        bundle.weekly_by_season = {};
        return jsonOut(200, bundle);
      }

      if (path.startsWith("/mcm")) {
        const seed = await fetchJson(MCM_SEED_URL, null);
        if (!seed || seed.schema_version !== "v1") {
          return jsonOut(500, { ok: false, error: "MCM seed missing or invalid." });
        }
        const genreLookup = {};
        const genres = Array.isArray(seed.genres) ? seed.genres : [];
        for (const g of genres) if (g && safeStr(g.id)) genreLookup[safeStr(g.id)] = g;
        const cycleRaw = Array.isArray(seed.genres_cycle) ? seed.genres_cycle : genres.map((g) => g.id);
        const cycle = cycleRaw.map(safeStr).filter((x) => x && genreLookup[x]);
        if (!cycle.length) return jsonOut(500, { ok: false, error: "MCM genres_cycle invalid." });

        const voteDoc = await fetchJson(MCM_VOTES_URL, { votes: [] });
        const nomDoc = await fetchJson(MCM_NOMS_URL, { nominations: [] });
        const nominees = buildNominees(seed, nomDoc);
        const nomineesById = {};
        for (const n of nominees) nomineesById[n.id] = n;

        const reqWeek = safeStr(url.searchParams.get("week_no"));
        const week = reqWeek ? weekInfoByNumber(seed, cycle, reqWeek) : weekInfoNow(seed, cycle);
        const round = week.phase === "playoffs" ? playoffRoundForWeek(week.week_no, week.regular_weeks, week.playoff_weeks) : null;

        const decorate = (n) => ({
          ...n,
          genre: genreLookup[n.genre_id] || { id: n.genre_id, name: n.genre_id },
        });

        if (path === "/mcm/config" && request.method === "GET") {
          return jsonOut(200, {
            ok: true,
            season: seed.season || {},
            genres,
            genres_cycle: cycle,
          });
        }

        if (path === "/mcm/week" && request.method === "GET") {
          const out = { ...week };
          out.genre = week.phase === "regular" ? genreLookup[week.genre_id] : { id: "playoffs", name: "Playoffs" };
          return jsonOut(200, { ok: true, week: out, round });
        }

        if (path === "/mcm/botd" && request.method === "GET") {
          const active = nominees.filter((n) => n.active);
          if (!active.length) return jsonOut(200, { ok: true, nominee: null, date_utc: utcYmd(new Date()) });
          const today = new Date();
          const ord = Math.floor(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) / 86400000);
          const idx = (ord + 1337) % active.length;
          return jsonOut(200, { ok: true, nominee: decorate(active[idx]), date_utc: utcYmd(today) });
        }

        if (path === "/mcm/ballot" && request.method === "GET") {
          if (week.phase === "regular") {
            const ballotSize = Number(seed?.season?.ballot_size || 8);
            const picks = nominees
              .filter((n) => n.active && n.genre_id === week.genre_id)
              .sort((a, b) => (b.source || "").localeCompare(a.source || "") || (a.display_name || "").localeCompare(b.display_name || ""))
              .slice(0, ballotSize);
            const counts = voteCounts(voteDoc, week.season_year, week.week_no, "regular", "regular");
            const ballot = picks.map((n) => ({ ...decorate(n), votes: counts.get(n.id) || 0, matchup_key: "regular" }));
            return jsonOut(200, { ok: true, week, ballot });
          }

          if (!round) return jsonOut(400, { ok: false, error: "Playoff schedule not configured." });
          const seedMap = seedMapFromVotes(voteDoc, nominees.filter((n) => n.active), week.season_year, week.regular_weeks, 16);

          // Prior winners
          const r16Pairs = matchupPairsForRound("R16", seedMap, {});
          const r16Week = week.regular_weeks + 1;
          const r16Winners = {};
          for (const [key, a, b] of r16Pairs) r16Winners[key] = winnerForMatchup(voteDoc, week.season_year, r16Week, key, a, b, seedMap);
          const qfPairs = matchupPairsForRound("QF", seedMap, r16Winners);
          const qfWeek = week.regular_weeks + 2;
          const qfWinners = {};
          for (const [key, a, b] of qfPairs) qfWinners[key] = winnerForMatchup(voteDoc, week.season_year, qfWeek, key, a, b, seedMap);
          const sfPairs = matchupPairsForRound("SF", seedMap, qfWinners);
          const sfWeek = week.regular_weeks + 3;
          const sfWinners = {};
          for (const [key, a, b] of sfPairs) sfWinners[key] = winnerForMatchup(voteDoc, week.season_year, sfWeek, key, a, b, seedMap);

          let pairs = [];
          if (round.id === "R16") pairs = r16Pairs;
          else if (round.id === "QF") pairs = qfPairs;
          else if (round.id === "SF") pairs = sfPairs;
          else pairs = matchupPairsForRound("F", seedMap, sfWinners);

          const matchups = [];
          for (const [matchupKey, aId, bId] of pairs) {
            const candidates = [];
            for (const nid of [aId, bId]) {
              if (!nid || !nomineesById[nid]) continue;
              candidates.push({
                ...decorate(nomineesById[nid]),
                seed: seedMap[nid] || null,
                matchup_key: matchupKey,
              });
            }
            const counts = voteCounts(voteDoc, week.season_year, week.week_no, "playoffs", matchupKey);
            for (const c of candidates) c.votes = counts.get(c.id) || 0;
            matchups.push({ matchup_key: matchupKey, candidates });
          }

          return jsonOut(200, { ok: true, week, round, matchups, seeds: seedMap });
        }

        if (path === "/mcm/results" && request.method === "GET") {
          if (week.phase === "regular") {
            const counts = voteCounts(voteDoc, week.season_year, week.week_no, "regular", "regular");
            const results = Array.from(counts.entries())
              .map(([id, votes]) => ({ id, votes }))
              .filter((r) => nomineesById[r.id])
              .map((r) => ({ ...decorate(nomineesById[r.id]), votes: r.votes }))
              .sort((a, b) => (b.votes - a.votes) || (a.display_name || "").localeCompare(b.display_name || ""));
            return jsonOut(200, { ok: true, week, results });
          }

          if (!round) return jsonOut(400, { ok: false, error: "Playoff schedule not configured." });
          const seedMap = seedMapFromVotes(voteDoc, nominees.filter((n) => n.active), week.season_year, week.regular_weeks, 16);

          const r16Pairs = matchupPairsForRound("R16", seedMap, {});
          const r16Week = week.regular_weeks + 1;
          const r16Winners = {};
          for (const [key, a, b] of r16Pairs) r16Winners[key] = winnerForMatchup(voteDoc, week.season_year, r16Week, key, a, b, seedMap);
          const qfPairs = matchupPairsForRound("QF", seedMap, r16Winners);
          const qfWeek = week.regular_weeks + 2;
          const qfWinners = {};
          for (const [key, a, b] of qfPairs) qfWinners[key] = winnerForMatchup(voteDoc, week.season_year, qfWeek, key, a, b, seedMap);
          const sfPairs = matchupPairsForRound("SF", seedMap, qfWinners);
          const sfWeek = week.regular_weeks + 3;
          const sfWinners = {};
          for (const [key, a, b] of sfPairs) sfWinners[key] = winnerForMatchup(voteDoc, week.season_year, sfWeek, key, a, b, seedMap);

          let pairs = [];
          if (round.id === "R16") pairs = r16Pairs;
          else if (round.id === "QF") pairs = qfPairs;
          else if (round.id === "SF") pairs = sfPairs;
          else pairs = matchupPairsForRound("F", seedMap, sfWinners);

          const matchups = [];
          for (const [matchupKey, aId, bId] of pairs) {
            const candidates = [];
            const counts = voteCounts(voteDoc, week.season_year, week.week_no, "playoffs", matchupKey);
            for (const nid of [aId, bId]) {
              if (!nid || !nomineesById[nid]) continue;
              candidates.push({
                ...decorate(nomineesById[nid]),
                seed: seedMap[nid] || null,
                matchup_key: matchupKey,
                votes: counts.get(nid) || 0,
              });
            }
            const winnerId = winnerForMatchup(voteDoc, week.season_year, week.week_no, matchupKey, aId, bId, seedMap);
            matchups.push({ matchup_key: matchupKey, candidates, winner_nominee_id: winnerId });
          }
          return jsonOut(200, { ok: true, week, round, matchups });
        }

        if (path === "/mcm/nominate" && request.method === "POST") {
          let payload = null;
          try {
            payload = await request.json();
          } catch (_) {
            return jsonOut(400, { ok: false, error: "Invalid JSON payload." });
          }

          const displayName = safeStr(payload?.display_name);
          const genreId = safeStr(payload?.genre_id);
          const primaryUrl = safeStr(payload?.primary_url);
          const imageUrl = safeStr(payload?.image_url);
          const notes = safeStr(payload?.notes);
          const attAdult = !!payload?.attestation_adult;
          const attRespectful = !!payload?.attestation_respectful;

          const errors = [];
          if (displayName.length < 2 || displayName.length > 80) errors.push("display_name must be 2-80 chars.");
          if (!genreLookup[genreId]) errors.push("Invalid genre_id.");
          if (!isValidUrl(primaryUrl) || primaryUrl.length > 500) errors.push("primary_url must be a valid http(s) URL.");
          if (imageUrl && (!isValidUrl(imageUrl) || imageUrl.length > 500)) errors.push("image_url must be a valid http(s) URL or blank.");
          if (notes.length > 500) errors.push("notes max length is 500.");
          if (!attAdult) errors.push("attestation_adult is required.");
          if (!attRespectful) errors.push("attestation_respectful is required.");
          if (errors.length) return jsonOut(400, { ok: false, errors });

          const ipHash = await getIpHash();
          const dispatchOut = await dispatchRepoEvent("log-mcm-nomination", {
            display_name: displayName,
            genre_id: genreId,
            primary_url: primaryUrl,
            image_url: imageUrl,
            notes,
            ip_hash: ipHash,
            attestation_adult: attAdult ? 1 : 0,
            attestation_respectful: attRespectful ? 1 : 0,
            created_at_utc: utcNowIso(),
            status: "approved",
            source: "worker-mcm-nominate",
          });
          if (!dispatchOut.ok) return jsonOut(500, { ok: false, error: dispatchOut.reason || "Dispatch failed." });
          return jsonOut(201, { ok: true, message: "Nomination queued." });
        }

        if (path === "/mcm/vote" && request.method === "POST") {
          let payload = null;
          try {
            payload = await request.json();
          } catch (_) {
            return jsonOut(400, { ok: false, error: "Invalid JSON payload." });
          }
          const nomineeId = safeStr(payload?.nominee_id);
          const matchupKey = safeStr(payload?.matchup_key || "regular") || "regular";
          if (!nomineeId) return jsonOut(400, { ok: false, error: "nominee_id is required." });
          if (matchupKey.length > 40) return jsonOut(400, { ok: false, error: "matchup_key too long." });
          const nominee = nomineesById[nomineeId];
          if (!nominee) return jsonOut(400, { ok: false, error: "Unknown nominee_id." });

          if (week.phase === "regular") {
            if (matchupKey !== "regular") return jsonOut(400, { ok: false, error: "matchup_key is not used for regular weeks." });
            if (nominee.genre_id !== week.genre_id) return jsonOut(400, { ok: false, error: "Nominee not on this week's ballot." });
          } else {
            if (!round) return jsonOut(400, { ok: false, error: "Playoff schedule not configured." });
            if (matchupKey === "regular") return jsonOut(400, { ok: false, error: "matchup_key is required for playoff votes." });

            const seedMap = seedMapFromVotes(voteDoc, nominees.filter((n) => n.active), week.season_year, week.regular_weeks, 16);
            const r16Pairs = matchupPairsForRound("R16", seedMap, {});
            const r16Week = week.regular_weeks + 1;
            const r16Winners = {};
            for (const [key, a, b] of r16Pairs) r16Winners[key] = winnerForMatchup(voteDoc, week.season_year, r16Week, key, a, b, seedMap);
            const qfPairs = matchupPairsForRound("QF", seedMap, r16Winners);
            const qfWeek = week.regular_weeks + 2;
            const qfWinners = {};
            for (const [key, a, b] of qfPairs) qfWinners[key] = winnerForMatchup(voteDoc, week.season_year, qfWeek, key, a, b, seedMap);
            const sfPairs = matchupPairsForRound("SF", seedMap, qfWinners);
            const sfWeek = week.regular_weeks + 3;
            const sfWinners = {};
            for (const [key, a, b] of sfPairs) sfWinners[key] = winnerForMatchup(voteDoc, week.season_year, sfWeek, key, a, b, seedMap);

            let pairs = [];
            if (round.id === "R16") pairs = r16Pairs;
            else if (round.id === "QF") pairs = qfPairs;
            else if (round.id === "SF") pairs = sfPairs;
            else pairs = matchupPairsForRound("F", seedMap, sfWinners);

            const m = pairs.find((p) => p[0] === matchupKey);
            if (!m) return jsonOut(400, { ok: false, error: "Unknown matchup_key for this round." });
            const aId = m[1];
            const bId = m[2];
            if (nomineeId !== aId && nomineeId !== bId) return jsonOut(400, { ok: false, error: "Nominee not in this matchup." });
          }

          const ipHash = await getIpHash();
          // Enforce one vote per IP per week/matchup_key against current log.
          const votes = Array.isArray(voteDoc?.votes) ? voteDoc.votes : [];
          const already = votes.some((v) => {
            if (!v) return false;
            if (Number(v.season_year) !== Number(week.season_year)) return false;
            if (Number(v.week_no) !== Number(week.week_no)) return false;
            if (safeStr(v.matchup_key || "regular") !== matchupKey) return false;
            return safeStr(v.ip_hash) === ipHash;
          });
          if (already) {
            return jsonOut(409, {
              ok: false,
              error: week.phase === "regular" ? "You already voted this week (per IP)." : "You already voted in this matchup (per IP).",
            });
          }

          const dispatchOut = await dispatchRepoEvent("log-mcm-vote", {
            season_year: week.season_year,
            week_no: week.week_no,
            matchup_key: matchupKey,
            nominee_id: nomineeId,
            ip_hash: ipHash,
            submitted_at_utc: utcNowIso(),
            source: "worker-mcm-vote",
          });
          if (!dispatchOut.ok) return jsonOut(500, { ok: false, error: dispatchOut.reason || "Dispatch failed." });

          return jsonOut(201, {
            ok: true,
            message: "Vote queued.",
            nominee_id: nomineeId,
            nominee_name: nominee.display_name,
            week_no: week.week_no,
            season_year: week.season_year,
            matchup_key: matchupKey,
          });
        }

        return jsonOut(404, { ok: false, error: "Not found" });
      }

      // ---------- Cookie ----------
      const cookie = env.MFL_COOKIE || "";
      if (!cookie) {
        if (path === "/roster-workbench" || path === "/trade-workbench" || path.startsWith("/trade-offers")) {
          // Allow public roster/trade workbench payloads (league/rosters/players) without a commish cookie.
          // Draft picks (assets export) and default-franchise detection may be unavailable and are surfaced as warnings.
        } else if (path.startsWith("/acquisition-hub/") && request.method === "GET") {
          // Allow read-only Acquisition Hub routes without a commish cookie secret.
          // Auction pages that require auth will degrade to stale/native-fallback states.
        } else if (
          path === "/bug-report" ||
          path === "/bug-reports" ||
          path === "/admin/bug-report/status" ||
          path === "/admin/bug-report/triage-note" ||
          path === "/admin/bug-report/test-discord"
        ) {
          // Allow bug report intake/read without commish cookie.
        } else {
        return new Response(
          JSON.stringify({ ok: false, isAdmin: false, reason: "Missing MFL_COOKIE secret" }),
          { status: 500, headers: { "content-type": "application/json", ...corsHeaders } }
        );
        }
      }
      const normalizeCookieValue = (raw) => {
        let v = String(raw || "").trim();
        if (!v) return "";
        const embeddedMatch = v.match(/(?:^|;\s*)MFL_USER_ID=([^;]+)/i);
        if (embeddedMatch && embeddedMatch[1]) {
          v = embeddedMatch[1].trim();
        } else {
          v = v.replace(/^MFL_USER_ID=/i, "").split(";")[0].trim();
        }
        try {
          v = decodeURIComponent(v);
        } catch (_) {}
        return v;
      };
      const secretCookieValue = normalizeCookieValue(cookie);
      const browserCookieValue = normalizeCookieValue(browserMflUserId);
      const sessionByCookie = !!browserCookieValue && browserCookieValue === secretCookieValue;
      const commishApiKey = String(env.COMMISH_API_KEY || "").trim();
      const sessionByApiKey = !!commishApiKey && !!browserApiKey && browserApiKey === commishApiKey;
      const sessionKnown = !!browserCookieValue || (!!commishApiKey && !!browserApiKey);
      const sessionMatch = sessionByCookie || sessionByApiKey;
      const cookieHeader = cookie
        ? (cookie.includes("=") ? cookie : `MFL_USER_ID=${cookie}`)
        : "";
      const browserCookieHeader = browserCookieValue
        ? `MFL_USER_ID=${browserCookieValue}`
        : "";
      const viewerCookieHeader = browserCookieHeader || cookieHeader;

      const getLeagueAdminState = async (leagueId, year) => {
        const mflUrl = `https://api.myfantasyleague.com/${encodeURIComponent(
          year
        )}/export?TYPE=league&L=${encodeURIComponent(leagueId)}&JSON=1&_=${Date.now()}`;

        const res = await fetch(mflUrl, {
          headers: {
            Cookie: cookieHeader,
            "User-Agent": "upsmflproduction-worker",
          },
          cf: { cacheTtl: 0, cacheEverything: false },
        });

        if (!res.ok) {
          return {
            ok: false,
            isAdmin: false,
            reason: `MFL HTTP ${res.status}`,
            emailCount: 0,
            mflHttp: res.status,
          };
        }

        const data = await res.json();
        const league = data.league || data;
        const frBlock =
          league.franchises ||
          (league.league && league.league.franchises) ||
          null;

        const frArr = (frBlock && (frBlock.franchise || frBlock)) || [];
        const franchises = Array.isArray(frArr) ? frArr : [frArr].filter(Boolean);

        const emailCount = franchises.reduce((acc, f) => {
          const hasEmail = !!(f && (f.email || (f.owner && f.owner.email)));
          return acc + (hasEmail ? 1 : 0);
        }, 0);

        let commishFranchiseId = "";
        try {
          const myFrUrl = `https://api.myfantasyleague.com/${encodeURIComponent(
            year
          )}/export?TYPE=myfranchise&L=${encodeURIComponent(leagueId)}&JSON=1&_=${Date.now()}`;
          const myFrRes = await fetch(myFrUrl, {
            headers: {
              Cookie: cookieHeader,
              "User-Agent": "upsmflproduction-worker",
            },
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          if (myFrRes.ok) {
            const myFrData = await myFrRes.json();
            const cand =
              (myFrData &&
                (myFrData?.franchise?.id ||
                  myFrData?.myfranchise?.id ||
                  myFrData?.myfranchise?.franchise?.id ||
                  myFrData?.franchise?.franchise_id ||
                  myFrData?.myfranchise?.franchise_id)) ||
              "";
            commishFranchiseId = String(cand || "")
              .replace(/\D/g, "")
              .padStart(4, "0")
              .slice(-4);
          }
        } catch (_) {}

        const commishCookieMatch = String(cookieHeader || "").match(/(?:^|;\s*)MFL_IS_COMMISH=([^;]+)/i);
        const hasCommishCookieFlag = !!(commishCookieMatch && safeStr(commishCookieMatch[1]));
        const isAdmin = emailCount > 1 || hasCommishCookieFlag;

        return {
          ok: true,
          isAdmin,
          reason: emailCount > 1
            ? "Private owner data visible (commish)"
            : hasCommishCookieFlag
              ? "Commish cookie flag present (MFL_IS_COMMISH)"
              : "No private owner data visible (not commish)",
          emailCount,
          commishFranchiseId,
          mflHttp: 200,
        };
      };

      const adminStateResponse = async () => {
        const adminState = await getLeagueAdminState(L, YEAR);
        if (!adminState.ok) {
          return new Response(
            JSON.stringify({
              ok: false,
              isAdmin: false,
              reason: adminState.reason,
              sessionKnown,
              sessionMatch,
            }),
            { status: 200, headers: { "content-type": "application/json", ...corsHeaders } }
          );
        }

        return new Response(
          JSON.stringify({
            ok: true,
            isAdmin: adminState.isAdmin,
            reason: adminState.reason,
            emailCount: adminState.emailCount,
            commishFranchiseId: adminState.commishFranchiseId || "",
            sessionKnown,
            sessionMatch,
            sessionByCookie,
            sessionByApiKey,
          }),
          { status: 200, headers: { "content-type": "application/json", ...corsHeaders } }
        );
      };

      async function dispatchRepoEvent(eventType, clientPayload) {
        const repoOwner = String(env.GITHUB_REPO_OWNER || "keithcreelman").trim();
        const repoName = String(env.GITHUB_REPO_NAME || "upsmflproduction").trim();
        const githubToken = String(env.GITHUB_PAT || "").trim();
        if (!githubToken) {
          return {
            ok: false,
            queued: false,
            reason: "Missing GITHUB_PAT worker secret",
          };
        }

        const dispatchUrl = `https://api.github.com/repos/${encodeURIComponent(
          repoOwner
        )}/${encodeURIComponent(repoName)}/dispatches`;

        const dispatchRes = await fetch(dispatchUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "upsmflproduction-worker",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({
            event_type: eventType,
            client_payload: clientPayload || {},
          }),
          cf: { cacheTtl: 0, cacheEverything: false },
        });

        if (dispatchRes.status !== 204) {
          const preview = (await dispatchRes.text()).slice(0, 600);
          return {
            ok: false,
            queued: false,
            reason: "GitHub dispatch failed",
            upstreamStatus: dispatchRes.status,
            upstreamPreview: preview,
            repo: `${repoOwner}/${repoName}`,
          };
        }

        return {
          ok: true,
          queued: true,
          reason: "Dispatch queued",
          repo: `${repoOwner}/${repoName}`,
        };
      }

      const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
      const safeInt = (v, fallback = 0) => {
        const n = Number.parseInt(String(v == null ? "" : v), 10);
        return Number.isFinite(n) ? n : fallback;
      };
      const safeFloat = (v, fallback = 0) => {
        const n = Number.parseFloat(String(v == null ? "" : v));
        return Number.isFinite(n) ? n : fallback;
      };
      const safeMoneyInt = (v, fallback = null) => {
        if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
        const s = String(v == null ? "" : v).trim();
        if (!s) return fallback;
        const cleaned = s.replace(/[^0-9.-]/g, "");
        if (!cleaned || cleaned === "-" || cleaned === ".") return fallback;
        const n = Number.parseFloat(cleaned);
        return Number.isFinite(n) ? Math.round(n) : fallback;
      };
      const padFranchiseId = (v) =>
      {
        const digits = String(v == null ? "" : v).replace(/\D/g, "");
        if (!digits) return "";
        return digits.padStart(4, "0").slice(-4);
      };
      const firstTruthy = (...vals) => {
        for (const v of vals) {
          const s = safeStr(v);
          if (s) return s;
        }
        return "";
      };
      const contractLengthFromInfo = (contractInfo) => {
        const m = String(contractInfo || "").match(/\bCL\s*([0-9]+)/i);
        if (!m) return null;
        const n = Number.parseInt(m[1], 10);
        return Number.isFinite(n) ? n : null;
      };
      const yearsRemainingFromRoster = (playerRow) => {
        const status = safeStr(playerRow?.status || "").toUpperCase();
        if (status.includes("TAXI")) return null;
        const contractYearRaw = safeStr(playerRow?.contractYear || playerRow?.contractyear);
        if (!contractYearRaw) return null;
        const contractYear = safeInt(contractYearRaw, NaN);
        if (!Number.isFinite(contractYear)) return null;
        return Math.max(contractYear, 0);
      };

      const redactUrlSecrets = (rawUrl) => {
        try {
          const u = new URL(String(rawUrl || ""));
          const secretKeys = ["APIKEY", "MFL_USER_ID", "COMMISH_API_KEY"];
          for (const key of secretKeys) {
            if (!u.searchParams.has(key)) continue;
            u.searchParams.set(key, "[redacted]");
          }
          return u.toString();
        } catch (_) {
          return safeStr(rawUrl);
        }
      };

      const fetchMflJson = async (rawUrl, headers) => {
        const safeUrl = redactUrlSecrets(rawUrl);
        let res;
        let text = "";
        try {
          res = await fetch(rawUrl, {
            headers,
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          text = await res.text();
        } catch (e) {
          return {
            ok: false,
            status: 0,
            url: safeUrl,
            error: `fetch_failed: ${e?.message || String(e)}`,
            data: null,
            textPreview: "",
          };
        }

        let data = null;
        try {
          data = JSON.parse(text);
        } catch (_) {
          data = null;
        }
        const parsedOk = !!data && typeof data === "object";
        const payloadErr = parsedOk ? mflErrorFromJsonPayload(data) : "";
        return {
          ok: !!res.ok && parsedOk && !payloadErr,
          status: res.status,
          url: safeUrl,
          data,
          error: payloadErr || (parsedOk ? "" : "non_json_response"),
          textPreview: String(text || "").slice(0, 500),
        };
      };

      const mflExportJson = async (year, leagueId, type, extraParams = {}, options = {}) => {
        const cacheBust = options.cacheBust !== false;
        const baseQs = new URLSearchParams({
          TYPE: String(type || "").trim(),
          L: String(leagueId || "").trim(),
          JSON: "1",
        });
        if (cacheBust) baseQs.set("_", String(Date.now()));
        for (const [k, v] of Object.entries(extraParams || {})) {
          if (v == null) continue;
          const s = String(v).trim();
          if (!s) continue;
          baseQs.set(k, s);
        }

        const headers = { "User-Agent": "upsmflproduction-worker" };
        if (options.useCookie !== false && cookieHeader) headers.Cookie = cookieHeader;

        const baseHost =
          `https://api.myfantasyleague.com/${encodeURIComponent(String(year || YEAR || new Date().getUTCFullYear()))}`;

        const withKeyQs = new URLSearchParams(baseQs.toString());
        const wantsApiKey = !!options.includeApiKey;
        if (wantsApiKey) {
          const apiKey = safeStr(env.MFL_APIKEY || "");
          if (apiKey) withKeyQs.set("APIKEY", apiKey);
        }
        const withKeyUrl = `${baseHost}/export?${withKeyQs.toString()}`;
        const first = await fetchMflJson(withKeyUrl, headers);
        if (!wantsApiKey) return first;
        if (first.ok) return first;
        const firstErr = safeStr(first.error).toLowerCase();
        const invalidApiKey =
          firstErr.indexOf("api key validation failed") !== -1 ||
          firstErr.indexOf("missing_worker_mfl_apikey") !== -1 ||
          firstErr.indexOf("invalid apikey") !== -1;
        if (!invalidApiKey) return first;
        const noKeyUrl = `${baseHost}/export?${baseQs.toString()}`;
        const second = await fetchMflJson(noKeyUrl, headers);
        if (second.ok) {
          return {
            ...second,
            fallback_without_apikey: true,
            fallback_reason: first.error || "APIKEY rejected",
          };
        }
        return {
          ...first,
          fallback_without_apikey_attempted: true,
          fallback_without_apikey_error: second.error || "",
          fallback_without_apikey_status: safeInt(second.status, 0),
        };
      };

      const mflExportJsonForCookie = async (cookieHeaderOverride, year, leagueId, type, extraParams = {}, options = {}) => {
        const cacheBust = options.cacheBust !== false;
        const baseQs = new URLSearchParams({
          TYPE: String(type || "").trim(),
          L: String(leagueId || "").trim(),
          JSON: "1",
        });
        if (cacheBust) baseQs.set("_", String(Date.now()));
        for (const [k, v] of Object.entries(extraParams || {})) {
          if (v == null) continue;
          const s = String(v).trim();
          if (!s) continue;
          baseQs.set(k, s);
        }
        const headers = { "User-Agent": "upsmflproduction-worker" };
        if (options.useCookie !== false && cookieHeaderOverride) headers.Cookie = cookieHeaderOverride;
        const baseHost =
          `https://api.myfantasyleague.com/${encodeURIComponent(String(year || YEAR || new Date().getUTCFullYear()))}`;
        const url = `${baseHost}/export?${baseQs.toString()}`;
        return fetchMflJson(url, headers);
      };

      const mflExportJsonWithRetry = async (
        year,
        leagueId,
        type,
        extraParams = {},
        options = {}
      ) => {
        const first = await mflExportJson(year, leagueId, type, extraParams, options);
        if (first.ok) return first;
        const status = safeInt(first.status, 0);
        const errText = safeStr(first.error).toLowerCase();
        const shouldRetry =
          status === 429 ||
          status === 502 ||
          status === 503 ||
          status === 504 ||
          errText.includes("api key validation failed");
        if (!shouldRetry) return first;
        await new Promise((resolve) => setTimeout(resolve, 250));
        return mflExportJson(year, leagueId, type, extraParams, { ...options, cacheBust: false });
      };

      const mflExportJsonAsViewer = async (
        year,
        leagueId,
        type,
        extraParams = {},
        options = {}
      ) => {
        if (!browserCookieHeader) {
          return mflExportJson(year, leagueId, type, extraParams, options);
        }
        return mflExportJsonForCookie(
          browserCookieHeader,
          year,
          leagueId,
          type,
          extraParams,
          { ...options, useCookie: true }
        );
      };

      const mflExportJsonWithRetryAsViewer = async (
        year,
        leagueId,
        type,
        extraParams = {},
        options = {}
      ) => {
        const first = await mflExportJsonAsViewer(year, leagueId, type, extraParams, options);
        if (first.ok) return first;
        const status = safeInt(first.status, 0);
        const errText = safeStr(first.error).toLowerCase();
        const shouldRetry =
          status === 429 ||
          status === 502 ||
          status === 503 ||
          status === 504 ||
          errText.includes("api key validation failed");
        if (!shouldRetry) return first;
        await new Promise((resolve) => setTimeout(resolve, 250));
        return mflExportJsonAsViewer(year, leagueId, type, extraParams, {
          ...options,
          cacheBust: false,
        });
      };

      const postMflImportFormAsViewer = async (
        season,
        formFields,
        probeFields,
        requestOptions = {}
      ) => {
        if (!browserCookieHeader) {
          return postMflImportForm(season, formFields, probeFields, requestOptions);
        }
        return postMflImportFormForCookie(
          browserCookieHeader,
          season,
          formFields,
          probeFields,
          requestOptions
        );
      };

      const parseLeagueFranchises = (leaguePayload) => {
        const league = leaguePayload?.league || leaguePayload || {};
        const frBlock = league?.franchises || league?.league?.franchises || {};
        const frList = asArray(frBlock?.franchise || frBlock).filter(Boolean);
        const out = [];
        for (const fr of frList) {
          const franchiseId = padFranchiseId(fr?.id || fr?.franchise_id);
          if (!franchiseId) continue;
          out.push({
            franchise_id: franchiseId,
            franchise_name: safeStr(fr?.name || fr?.franchise_name || franchiseId),
            franchise_abbrev: safeStr(fr?.abbrev || fr?.franchise_abbrev || franchiseId),
            icon_url: firstTruthy(
              fr?.icon,
              fr?.iconURL,
              fr?.iconUrl,
              fr?.franchiseIcon,
              fr?.logo,
              fr?.logoURL,
              fr?.logoUrl
            ),
            available_salary_dollars: safeMoneyInt(
              firstTruthy(
                fr?.salaryCapAmount,
                fr?.salary_cap_amount,
                fr?.salaryCapAvailable,
                fr?.salaryCapRoom
              ),
              null
            ),
          });
        }
        return out;
      };

      const parseRostersExport = (rostersPayload) => {
        const rosters = rostersPayload?.rosters || rostersPayload || {};
        const franchiseRows = asArray(rosters?.franchise || rosters?.franchises).filter(Boolean);
        const rosterAssetsByFranchise = {};
        const allPlayerIds = new Set();

        for (const fr of franchiseRows) {
          const franchiseId = padFranchiseId(fr?.id || fr?.franchise_id);
          if (!franchiseId) continue;
          const playerRows = asArray(fr?.player || fr?.players).filter(Boolean);
          const assets = [];
          for (const p of playerRows) {
            const playerId = String(p?.id || p?.player_id || "").replace(/\D/g, "");
            if (!playerId) continue;
            allPlayerIds.add(playerId);
            const status = safeStr(p?.status || "").toUpperCase();
            const contractStatus = safeStr(p?.contractStatus || p?.contractstatus);
            const isTaxi = status.includes("TAXI") || contractStatus.toUpperCase() === "TAXI";
            assets.push({
              type: "PLAYER",
              asset_id: `player:${playerId}`,
              franchise_id: franchiseId,
              player_id: playerId,
              salary: safeInt(p?.salary, 0),
              years: yearsRemainingFromRoster(p),
              contract_type: isTaxi ? "Taxi" : contractStatus,
              contract_info: safeStr(p?.contractInfo || p?.contractinfo),
              taxi: isTaxi,
              roster_status: status,
              notes: safeStr(p?.drafted || p?.acquired || p?.added || ""),
            });
          }
          rosterAssetsByFranchise[franchiseId] = assets;
        }

        return { rosterAssetsByFranchise, allPlayerIds: Array.from(allPlayerIds) };
      };

      const parsePlayersExport = (playersPayload) => {
        const playerRows = asArray(playersPayload?.players?.player || playersPayload?.player).filter(Boolean);
        const byId = {};
        for (const p of playerRows) {
          const playerId = String(p?.id || "").replace(/\D/g, "");
          if (!playerId) continue;
          byId[playerId] = {
            player_name: safeStr(p?.name || p?.player_name),
            nfl_team: safeStr(p?.team || p?.nfl_team),
            position: safeStr(p?.position || p?.pos).toUpperCase(),
            injury: firstTruthy(p?.injury_status, p?.injuryStatus, p?.status),
          };
        }
        return byId;
      };

      const parseAssetsExportPicks = (assetsPayload) => {
        const extractPickToken = (input) => {
          const s = safeStr(input).toUpperCase();
          if (!s) return "";
          const m = s.match(/\b(DP_[0-9]{1,2}_[0-9]{1,2}|FP_[0-9]{4}_[0-9]{4}_[0-9]{1,2})\b/);
          return m ? m[1] : "";
        };

        const parsePickMeta = (row, pickKey, seasonValue) => {
          const token = extractPickToken(pickKey);
          const rawDescription = safeStr(row?.description || row?.name || row?.label);
          let year = safeInt(
            row?.year || row?.season || row?.pick_season || row?.draft_year,
            0
          );
          let round = safeInt(
            row?.round || row?.draft_round || row?.pick_round,
            0
          );
          let pick = safeInt(
            row?.slot || row?.pick_slot || row?.pick_no || row?.pick_number,
            0
          );

          if (!pick) {
            const dottedSlot = safeStr(
              row?.pick_slot || row?.slot || row?.pick || ""
            ).match(/^\s*(\d+)\.(\d+)\s*$/);
            if (dottedSlot) {
              round = round || safeInt(dottedSlot[1], 0);
              pick = pick || safeInt(dottedSlot[2], 0);
            }
          }

          if ((!year || !round || !pick) && token.startsWith("DP_")) {
            const dp = token.match(/^DP_(\d+)_(\d+)$/i);
            if (dp) {
              year = year || safeInt(seasonValue, 0);
              round = round || (safeInt(dp[1], 0) + 1);
              pick = pick || (safeInt(dp[2], 0) + 1);
            }
          }

          if ((!year || !round) && token.startsWith("FP_")) {
            const fp = token.match(/^FP_[A-Z0-9]+_(\d{4})_(\d+)$/i);
            if (fp) {
              year = year || safeInt(fp[1], 0);
              round = round || safeInt(fp[2], 0);
            }
          }

          if (!year || !round || !pick) {
            const yearDraft = rawDescription.match(/Year\s*(\d{4})\s*Draft Pick\s*(\d+)\.(\d+)/i);
            if (yearDraft) {
              year = year || safeInt(yearDraft[1], 0);
              round = round || safeInt(yearDraft[2], 0);
              pick = pick || safeInt(yearDraft[3], 0);
            }
          }

          if (!year || !round || !pick) {
            const dottedPick = rawDescription.match(/(\d{4}).*?(\d+)\.(\d+)/i);
            if (dottedPick) {
              year = year || safeInt(dottedPick[1], 0);
              round = round || safeInt(dottedPick[2], 0);
              pick = pick || safeInt(dottedPick[3], 0);
            }
          }

          if (!year || !round || !pick) {
            const roundPick = rawDescription.match(/(\d{4}).*?(?:Round|Rookie)\s*(\d+).*?(?:Pick|\.)(?:\s*|0*)(\d+)/i);
            if (roundPick) {
              year = year || safeInt(roundPick[1], 0);
              round = round || safeInt(roundPick[2], 0);
              pick = pick || safeInt(roundPick[3], 0);
            }
          }

          if (!year || !round) {
            const rookieRound = rawDescription.match(/(\d{4}).*?Rookie\s*Round\s*(\d+)/i);
            if (rookieRound) {
              year = year || safeInt(rookieRound[1], 0);
              round = round || safeInt(rookieRound[2], 0);
            }
          }

          const slotText = round && pick
            ? `${round}.${String(pick).padStart(2, "0")}`
            : (round ? `R${round}` : "");

          return {
            token,
            year,
            round,
            pick,
            slot_text: slotText,
          };
        };

        const rookieLabelFromDescription = (description, pickKey, seasonValue, pickMeta) => {
          const raw = safeStr(description);
          const meta = pickMeta && typeof pickMeta === "object" ? pickMeta : parsePickMeta({}, pickKey, seasonValue);
          if (safeInt(meta.year, 0) && safeInt(meta.round, 0) && safeInt(meta.pick, 0)) {
            return `${meta.year} Rookie ${meta.round}.${String(meta.pick).padStart(2, "0")}`;
          }
          if (safeInt(meta.year, 0) && safeInt(meta.round, 0)) {
            return `${meta.year} Rookie Round ${meta.round}`;
          }
          let m = raw.match(/Year\s*(\d{4})\s*Draft Pick\s*(\d+)\.(\d+)/i);
          if (m) return `${m[1]} Rookie ${m[2]}.${String(m[3]).padStart(2, "0")}`;
          m = raw.match(/(\d{4}).*?(\d+)\.(\d+)/i);
          if (m) return `${m[1]} Rookie ${m[2]}.${String(m[3]).padStart(2, "0")}`;
          m = raw.match(/(\d{4}).*?Round\s*(\d+).*?Pick\s*(\d+)/i);
          if (m) return `${m[1]} Rookie ${m[2]}.${String(m[3]).padStart(2, "0")}`;

          const token = extractPickToken(pickKey);
          if (/^DP_/.test(token)) {
            const parts = token.split("_");
            const round = safeInt(parts[1], 0) + 1;
            const slot = safeInt(parts[2], 0) + 1;
            return `${safeInt(seasonValue, 0)} Rookie ${round}.${String(slot).padStart(2, "0")}`;
          }
          if (/^FP_/.test(token)) {
            const parts = token.split("_");
            const year = safeInt(parts[2], 0);
            const round = safeInt(parts[3], 0);
            if (year && round) return `${year} Rookie Round ${round}`;
          }
          return raw || "Rookie Pick";
        };

        const readPickKey = (row) => {
          const direct = [
            row?.pick,
            row?.id,
            row?.asset_id,
            row?.pick_key,
            row?.token,
            row?.key,
            row?.label,
            row?.name,
            row?.description,
          ];
          for (const v of direct) {
            const token = extractPickToken(v);
            if (token) return token;
          }
          const year = safeInt(row?.year || row?.season, 0);
          const round = safeInt(row?.round || row?.draft_round, 0);
          const slot = safeInt(row?.slot || row?.pick_slot || row?.pick_no || row?.pick_number || row?.pick, 0);
          if (year && round && slot) {
            return `PICK_${year}_${round}_${slot}`;
          }
          return "";
        };

        const gatherPickCandidates = (franchiseNode) => {
          const out = [];
          const seen = new Set();
          const maybePush = (node) => {
            if (!node || typeof node !== "object") return;
            if (seen.has(node)) return;
            seen.add(node);
            const token = readPickKey(node);
            const hasShape =
              token ||
              node?.round != null ||
              node?.draft_round != null ||
              node?.pick_slot != null ||
              node?.pick_number != null ||
              safeStr(node?.description || node?.name || node?.label);
            if (hasShape) out.push(node);
          };
          const visit = (node, keyHint, depth) => {
            if (!node || depth > 7) return;
            if (Array.isArray(node)) {
              for (const item of node) visit(item, keyHint, depth + 1);
              return;
            }
            if (typeof node !== "object") return;
            const key = safeStr(keyHint).toLowerCase();
            if (
              key.includes("draftpick") ||
              key === "pick" ||
              key.endsWith("picks") ||
              key.includes("futureyear") ||
              key.includes("currentyear")
            ) {
              maybePush(node);
            }
            for (const [childKey, childVal] of Object.entries(node)) {
              visit(childVal, childKey, depth + 1);
            }
          };
          visit(franchiseNode, "", 0);
          return out;
        };

        const franchiseRows = asArray(assetsPayload?.assets?.franchise || assetsPayload?.franchise).filter(Boolean);
        const out = {};
        for (const fr of franchiseRows) {
          const franchiseId = padFranchiseId(fr?.id || fr?.franchise_id);
          if (!franchiseId) continue;
          const rows = [];
          const seen = new Set();
          const pushPicks = (pickRows) => {
            for (const p of asArray(pickRows).filter(Boolean)) {
              const pickKey = readPickKey(p);
              const pickMeta = parsePickMeta(
                p,
                pickKey,
                assetsPayload?.assets?.year || assetsPayload?.year || 0
              );
              const description = rookieLabelFromDescription(
                safeStr(p?.description || p?.name || p?.label || pickKey || "Rookie Pick"),
                pickKey,
                assetsPayload?.assets?.year || assetsPayload?.year || 0,
                pickMeta
              );
              const key = pickMeta.token || pickKey || safeStr(description).toUpperCase().replace(/[^A-Z0-9_.-]/g, "_");
              if (!key || seen.has(key)) continue;
              seen.add(key);
              rows.push({
                type: "PICK",
                asset_id: `pick:${key}`,
                pick_key: key,
                description,
                pick_season: safeInt(pickMeta.year, 0) || undefined,
                pick_round: safeInt(pickMeta.round, 0) || undefined,
                pick_slot: safeStr(pickMeta.slot_text),
              });
            }
          };
          pushPicks(fr?.currentYearDraftPicks?.draftPick || fr?.currentYearDraftPicks?.draftpick);
          pushPicks(fr?.currentYearDraftPick?.draftPick || fr?.currentYearDraftPick?.draftpick);
          pushPicks(fr?.futureYearDraftPicks?.draftPick || fr?.futureYearDraftPicks?.draftpick);
          pushPicks(fr?.futureYearDraftPick?.draftPick || fr?.futureYearDraftPick?.draftpick);
          pushPicks(fr?.draftPicks?.draftPick || fr?.draftPicks?.draftpick);
          pushPicks(gatherPickCandidates(fr));
          out[franchiseId] = rows;
        }
        return out;
      };

      const parseMyFranchiseId = (myFrPayload) => {
        const directCandidates = [
          myFrPayload?.franchise?.id,
          myFrPayload?.franchise?.franchise_id,
          myFrPayload?.myfranchise?.id,
          myFrPayload?.myfranchise?.franchise_id,
          myFrPayload?.myfranchise?.franchise?.id,
          myFrPayload?.myfranchise?.franchise?.franchise_id,
          myFrPayload?.myfranchise?.franchise?.[0]?.id,
          myFrPayload?.myfranchise?.franchise?.[0]?.franchise_id,
          myFrPayload?.myFranchise?.id,
          myFrPayload?.myFranchise?.franchise_id,
          myFrPayload?.myFranchise?.franchise?.id,
          myFrPayload?.myFranchise?.franchise?.franchise_id,
          myFrPayload?.myFranchise?.franchise?.[0]?.id,
          myFrPayload?.myFranchise?.franchise?.[0]?.franchise_id,
        ];
        for (const c of directCandidates) {
          const id = padFranchiseId(c);
          if (id) return id;
        }

        const seen = new Set();
        const visit = (node, trustIds = false) => {
          if (!node) return "";
          if (Array.isArray(node)) {
            for (const item of node) {
              const got = visit(item, trustIds);
              if (got) return got;
            }
            return "";
          }
          if (typeof node !== "object") {
            return trustIds ? padFranchiseId(node) : "";
          }
          if (seen.has(node)) return "";
          seen.add(node);

          const byFranchiseField = padFranchiseId(
            node?.franchise_id || node?.franchiseId || node?.franchiseID || ""
          );
          if (byFranchiseField) return byFranchiseField;

          if (trustIds) {
            const byId = padFranchiseId(node?.id || "");
            if (byId) return byId;
          }

          const priorityKeys = ["myfranchise", "myFranchise", "franchise", "user_franchise", "userfranchise"];
          for (const key of priorityKeys) {
            if (!(key in node)) continue;
            const got = visit(node[key], true);
            if (got) return got;
          }

          for (const [key, value] of Object.entries(node)) {
            if (priorityKeys.includes(key)) continue;
            const got = visit(value, trustIds || /franchise/i.test(String(key)));
            if (got) return got;
          }
          return "";
        };

        return visit(myFrPayload, false);
      };

      const fetchPlayersByIdsChunked = async (season, leagueId, playerIds) => {
        const byId = {};
        const ids = Array.isArray(playerIds) ? playerIds.filter(Boolean) : [];
        if (!ids.length) return byId;
        const chunkSize = 200;
        for (let i = 0; i < ids.length; i += chunkSize) {
          const chunk = ids.slice(i, i + chunkSize);
          const res = await mflExportJson(
            season,
            leagueId,
            "players",
            { P: chunk.join(","), DETAILS: "1" },
            { includeApiKey: true, useCookie: true }
          );
          if (!res.ok) continue;
          Object.assign(byId, parsePlayersExport(res.data));
        }
        return byId;
      };

      const fetchExtensionPreviewRows = async (season, queryParams) => {
        const extUrlParam = safeStr(queryParams.get("EXT_URL") || queryParams.get("extension_previews_url"));
        const baseUrl = safeStr(env.TRADE_EXTENSION_PREVIEWS_BASE_URL || "https://keithcreelman.github.io/upsmflproduction/site/trades").replace(/\/+$/, "");
        const fileName = `extension_previews_${encodeURIComponent(String(season))}.json`;
        const candidates = [];
        if (extUrlParam) {
          candidates.push(extUrlParam);
        } else {
          candidates.push(`${baseUrl}/${fileName}`);
          candidates.push(`https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/trades/${fileName}`);
        }
        let lastErr = null;
        for (const extUrl of candidates) {
          try {
            const res = await fetch(extUrl, {
              headers: { "Cache-Control": "no-store" },
              cf: { cacheTtl: 0, cacheEverything: false },
            });
            if (!res.ok) {
              lastErr = {
                ok: false,
                status: res.status,
                url: extUrl,
                rows: [],
                error: `HTTP ${res.status}`,
              };
              continue;
            }
            const payload = await res.json();
            const rows = Array.isArray(payload)
              ? payload
              : Array.isArray(payload?.rows)
                ? payload.rows
                : [];
            return {
              ok: true,
              status: 200,
              url: extUrl,
              rows,
              meta: payload?.meta || null,
            };
          } catch (e) {
            lastErr = {
              ok: false,
              status: 0,
              url: extUrl,
              rows: [],
              error: `fetch_failed: ${e?.message || String(e)}`,
            };
          }
        }
        return (
          lastErr || {
            ok: false,
            status: 0,
            url: "",
            rows: [],
            error: "no_extension_preview_url_candidates",
          }
        );
      };

      const remapExtensionPreviewRowsToCurrentOwners = (rows, rosterAssetsByFranchise, franchiseMetaById) => {
        const list = Array.isArray(rows) ? rows : [];
        if (!list.length) return { rows: [], remapped_count: 0 };

        const ownerByPlayerId = {};
        for (const [franchiseIdRaw, assets] of Object.entries(rosterAssetsByFranchise || {})) {
          const franchiseId = padFranchiseId(franchiseIdRaw);
          if (!franchiseId) continue;
          const arr = Array.isArray(assets) ? assets : [];
          for (const asset of arr) {
            if (!asset || safeStr(asset.type).toUpperCase() !== "PLAYER") continue;
            const playerId = String(asset.player_id || asset.id || "").replace(/\D/g, "");
            if (!playerId) continue;
            ownerByPlayerId[playerId] = franchiseId;
          }
        }

        let remappedCount = 0;
        const out = list.map((row) => {
          if (!row || typeof row !== "object") return row;
          const next = { ...row };
          const playerId = String(next.player_id || "").replace(/\D/g, "");
          if (!playerId) return next;

          const currentOwner = ownerByPlayerId[playerId] || "";
          const previewOwner = padFranchiseId(next.franchise_id || next.franchiseId || "");
          if (!currentOwner || !previewOwner || currentOwner === previewOwner) return next;

          remappedCount += 1;
          next.original_franchise_id = previewOwner;
          next.franchise_id = currentOwner;
          if (franchiseMetaById && franchiseMetaById[currentOwner]) {
            const meta = franchiseMetaById[currentOwner];
            next.franchise_name = safeStr(meta.franchise_name || next.franchise_name || currentOwner);
            const abbr = safeStr(meta.franchise_abbrev || "");
            if (abbr && safeStr(next.preview_contract_info_string)) {
              next.preview_contract_info_string = safeStr(next.preview_contract_info_string).replace(
                /(\|Ext:\s*)([^|]+)(\|?)/i,
                `$1${abbr}$3`
              );
            }
          }
          return next;
        });

        return {
          rows: out,
          remapped_count: remappedCount,
        };
      };

      const acqCacheGet = (key, ttlMs) => {
        const entry = acquisitionLiveMemoryCache.get(String(key || ""));
        if (!entry) return null;
        if (Date.now() - safeInt(entry.ts, 0) > safeInt(ttlMs, 0)) {
          acquisitionLiveMemoryCache.delete(String(key || ""));
          return null;
        }
        return entry.value || null;
      };

      const acqCacheSet = (key, value) => {
        acquisitionLiveMemoryCache.set(String(key || ""), {
          ts: Date.now(),
          value,
        });
        return value;
      };

      const acqCacheBustPrefix = (prefix) => {
        const target = safeStr(prefix);
        if (!target) return;
        for (const key of acquisitionLiveMemoryCache.keys()) {
          if (String(key || "").indexOf(target) === 0) acquisitionLiveMemoryCache.delete(key);
        }
      };

      const jsonNoStore = (status, payload) => {
        const resp = jsonOut(status, payload);
        resp.headers.set("Cache-Control", "no-store");
        return resp;
      };

      const ACQ_ARTIFACT_FILES = {
        rookie_draft_history: "rookie_draft_history.json",
        free_agent_auction_history: "free_agent_auction_history.json",
        expired_rookie_history: "expired_rookie_history.json",
        waiver_history: "waiver_history.json",
        manifest: "manifest.json",
      };

      const readAcquisitionRules = () => ({
        roster_min: 27,
        roster_max: 35,
        free_agent_reset_hours: 24,
        expired_rookie_reset_hours: 36,
        lineup: {
          QB: 1,
          RB: 2,
          WR: 2,
          TE: 1,
          FLEX: 2,
          SUPERFLEX: 1,
          PK: 1,
          PN: 1,
          DL: 2,
          LB: 2,
          DB: 2,
          DFLEX: 1,
        },
      });

      const textValueAcq = (value) => {
        if (value == null) return "";
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          return String(value).trim();
        }
        if (Array.isArray(value)) {
          for (const item of value) {
            const text = textValueAcq(item);
            if (text) return text;
          }
          return "";
        }
        if (typeof value === "object") {
          return firstTruthy(
            value?.$t,
            value?.text,
            value?.value,
            value?.label,
            value?.name,
            value?.title,
            value?.description,
            value?.summary,
            value?.display,
            value?.happens
          );
        }
        return "";
      };

      const pickTextAcq = (...values) => {
        for (const value of values) {
          const text = textValueAcq(value);
          if (text) return text;
        }
        return "";
      };

      const parseCalendarInstantAcq = (rawValue) => {
        const raw = pickTextAcq(rawValue).replace(/\u00a0/g, " ").trim();
        if (!raw) return "";
        if (/^\d{13}$/.test(raw)) return new Date(Number(raw)).toISOString();
        if (/^\d{10}$/.test(raw)) return new Date(Number(raw) * 1000).toISOString();

        let match = raw.match(/^(\d{8})T?(\d{6})Z?$/);
        if (match) {
          const year = safeInt(match[1].slice(0, 4), 0);
          const month = safeInt(match[1].slice(4, 6), 1) - 1;
          const day = safeInt(match[1].slice(6, 8), 1);
          const hour = safeInt(match[2].slice(0, 2), 0);
          const minute = safeInt(match[2].slice(2, 4), 0);
          const second = safeInt(match[2].slice(4, 6), 0);
          return new Date(Date.UTC(year, month, day, hour, minute, second)).toISOString();
        }

        match = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
        if (match) {
          return new Date(Date.UTC(safeInt(match[1], 0), safeInt(match[2], 1) - 1, safeInt(match[3], 1), 0, 0, 0)).toISOString();
        }

        match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
        if (match) {
          return new Date(
            Date.UTC(
              safeInt(match[1], 0),
              safeInt(match[2], 1) - 1,
              safeInt(match[3], 1),
              safeInt(match[4], 0),
              safeInt(match[5], 0),
              safeInt(match[6], 0)
            )
          ).toISOString();
        }

        match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?:\s*([AP]M))?)?$/i);
        if (match) {
          let hour = safeInt(match[4], 0);
          const meridiem = safeStr(match[6]).toUpperCase();
          if (meridiem === "PM" && hour < 12) hour += 12;
          if (meridiem === "AM" && hour === 12) hour = 0;
          return new Date(
            Date.UTC(
              safeInt(match[3], 0),
              safeInt(match[1], 1) - 1,
              safeInt(match[2], 1),
              hour,
              safeInt(match[5], 0),
              0
            )
          ).toISOString();
        }

        const parsed = Date.parse(raw);
        return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
      };

      const formatCalendarInstantEtAcq = (iso) => {
        const ts = Date.parse(safeStr(iso));
        if (!Number.isFinite(ts)) return "";
        try {
          return new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York",
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
          }).format(new Date(ts));
        } catch (_) {
          return new Date(ts).toISOString();
        }
      };

      const extractCalendarEventsAcq = (payload) => {
        const root = payload?.calendar || payload || {};
        const out = [];
        const stack = [root];
        const seen = new Set();
        while (stack.length) {
          const current = stack.pop();
          if (!current || typeof current !== "object" || seen.has(current)) continue;
          seen.add(current);
          if (Array.isArray(current)) {
            for (const item of current) stack.push(item);
            continue;
          }
          const keys = Object.keys(current);
          const hasDateish = keys.some((key) => /start|end|date|time|when|happens/i.test(key));
          const hasEventish = keys.some((key) => /event|type|title|name|desc|label|summary/i.test(key));
          if (hasDateish && hasEventish) out.push(current);
          for (const key of keys) {
            const child = current[key];
            if (child && typeof child === "object") stack.push(child);
          }
        }
        return out;
      };

      const normalizeCalendarEventAcq = (row) => {
        const type = pickTextAcq(row?.event_type, row?.eventType, row?.type, row?.type_name, row?.eventTypeName, row?.event);
        const title = pickTextAcq(row?.title, row?.name, row?.label, row?.summary, row?.description, row?.details, row?.happens);
        const description = pickTextAcq(row?.description, row?.details, row?.summary, row?.note, row?.notes);
        const startAt = parseCalendarInstantAcq(
          pickTextAcq(row?.start_time, row?.startTime, row?.start, row?.begin, row?.date, row?.datetime, row?.when, row?.happens)
        );
        const endAt = parseCalendarInstantAcq(
          pickTextAcq(row?.end_time, row?.endTime, row?.end, row?.until, row?.ends)
        );
        return {
          event_type: type,
          title,
          description,
          start_at: startAt,
          end_at: endAt,
        };
      };

      const fetchLeagueCalendarAcq = async (season, leagueId) => {
        const cacheKey = `acq:calendar:${season}:${leagueId}`;
        const cached = acqCacheGet(cacheKey, 10 * 60 * 1000);
        if (cached) return cached;
        const res = await mflExportJsonWithRetryAsViewer(season, leagueId, "calendar", {}, { useCookie: true });
        const value = {
          ok: !!res.ok,
          status: safeInt(res.status, 0),
          url: safeStr(res.url),
          error: safeStr(res.error),
          data: res.ok ? (res.data || {}) : null,
        };
        return acqCacheSet(cacheKey, value);
      };

      const findRookieDraftCalendarEventAcq = (calendarPayload, leaguePayload) => {
        const leagueRoot = leaguePayload?.league || leaguePayload || {};
        const draftPool = safeStr(firstTruthy(leagueRoot?.draftPlayerPool, leagueRoot?.draft_player_pool)).toLowerCase();
        const now = Date.now();
        const ranked = extractCalendarEventsAcq(calendarPayload)
          .map((row) => normalizeCalendarEventAcq(row))
          .filter((row) => row.start_at)
          .map((row) => {
            const blob = `${safeStr(row.event_type)} ${safeStr(row.title)} ${safeStr(row.description)}`.toLowerCase();
            let score = 0;
            if (blob.includes("rookie")) score += 6;
            if (blob.includes("draft")) score += 4;
            if (blob.includes("draft start")) score += 3;
            if (safeStr(row.event_type).toUpperCase() === "DRAFT_START") score += 4;
            if (draftPool === "rookie" && (blob.includes("draft") || safeStr(row.event_type).toUpperCase() === "DRAFT_START")) score += 3;
            if (blob.includes("auction")) score -= 6;
            const deltaMs = Math.abs(Date.parse(row.start_at) - now);
            return { ...row, score, delta_ms: Number.isFinite(deltaMs) ? deltaMs : Number.MAX_SAFE_INTEGER };
          })
          .filter((row) => row.score >= 4)
          .sort((a, b) =>
            safeInt(b.score, 0) - safeInt(a.score, 0) ||
            safeInt(a.delta_ms, Number.MAX_SAFE_INTEGER) - safeInt(b.delta_ms, Number.MAX_SAFE_INTEGER) ||
            safeStr(a.start_at).localeCompare(safeStr(b.start_at))
          );
        return ranked.length ? ranked[0] : null;
      };

      const rookieDraftLooksActiveAcq = (statusInfo) => {
        const blob = `${safeStr(statusInfo?.message)} ${safeStr(statusInfo?.timer_text)}`.toLowerCase();
        if (/complete|completed|ended|closed|finished/.test(blob)) return false;
        if (statusInfo?.current_pick && (safeInt(statusInfo?.current_pick?.round, 0) > 0 || safeInt(statusInfo?.current_pick?.pick, 0) > 0)) return true;
        if (statusInfo?.timer_seconds != null && safeInt(statusInfo?.timer_seconds, -1) >= 0) return true;
        return /on the clock|draft in progress|live draft|paused|timer|pick is in/.test(blob);
      };

      const deriveRookieDraftRefreshPlanAcq = (calendarEvent, statusInfo) => {
        const fastVisibleMs = 5000;
        const fastHiddenMs = 15000;
        const slowVisibleMs = 60000;
        const slowHiddenMs = 300000;
        const startMs = Date.parse(safeStr(calendarEvent?.start_at));
        const endMsRaw = Date.parse(safeStr(calendarEvent?.end_at));
        const fallbackEndMs = Number.isFinite(startMs) ? startMs + (4 * 60 * 60 * 1000) : NaN;
        const endMs = Number.isFinite(endMsRaw) ? endMsRaw : fallbackEndMs;
        const now = Date.now();
        const fastWindowActive =
          Number.isFinite(startMs) &&
          now >= (startMs - (6 * 60 * 60 * 1000)) &&
          now <= ((Number.isFinite(endMs) ? endMs : startMs) + (12 * 60 * 60 * 1000));
        const liveActive = rookieDraftLooksActiveAcq(statusInfo);
        const fast = !!liveActive || !!fastWindowActive;
        const startLabel = safeStr(calendarEvent?.start_at) ? formatCalendarInstantEtAcq(calendarEvent.start_at) : "";
        const endLabel = safeStr(calendarEvent?.end_at) ? formatCalendarInstantEtAcq(calendarEvent.end_at) : "";
        return {
          next_refresh_recommended_ms: fast ? fastVisibleMs : slowVisibleMs,
          hidden_refresh_recommended_ms: fast ? fastHiddenMs : slowHiddenMs,
          refresh_mode: liveActive ? "live_draft_active" : (fastWindowActive ? "draft_night_window" : "offseason"),
          draft_event: calendarEvent
            ? {
                event_type: safeStr(calendarEvent.event_type),
                title: safeStr(calendarEvent.title),
                description: safeStr(calendarEvent.description),
                start_at: safeStr(calendarEvent.start_at),
                end_at: safeStr(calendarEvent.end_at),
                start_label: startLabel,
                end_label: endLabel,
                fast_window_active: !!fastWindowActive,
              }
            : null,
        };
      };

      const resolveAcquisitionArtifactsBaseUrls = () => {
        const preferred = safeStr(env.ACQUISITION_ARTIFACTS_BASE_URL || "https://keithcreelman.github.io/upsmflproduction/site/acquisition").replace(/\/+$/, "");
        const repoOwner = encodeURIComponent(safeStr(env.GITHUB_REPO_OWNER || "keithcreelman"));
        const repoName = encodeURIComponent(safeStr(env.GITHUB_REPO_NAME || "upsmflproduction"));
        const branch = encodeURIComponent(safeStr(env.GITHUB_REPO_BRANCH || "main"));
        const fallbacks = [
          `https://raw.githubusercontent.com/${repoOwner}/${repoName}/${branch}/site/acquisition`,
          `https://cdn.jsdelivr.net/gh/${repoOwner}/${repoName}@${branch}/site/acquisition`,
          preferred,
        ];
        return Array.from(new Set(fallbacks.filter(Boolean)));
      };

      const fetchArtifactJson = async (kind) => {
        const fileName = ACQ_ARTIFACT_FILES[kind];
        if (!fileName) return { ok: false, status: 404, error: "unknown_artifact_kind", data: null, url: "" };
        const candidates = resolveAcquisitionArtifactsBaseUrls().map((base) => `${base}/${fileName}`);
        let lastError = { ok: false, status: 0, error: "artifact_fetch_failed", data: null, url: "" };
        for (const artifactUrl of candidates) {
          try {
            const res = await fetch(artifactUrl, {
              headers: { "Cache-Control": "no-store" },
              cf: { cacheTtl: 0, cacheEverything: false },
            });
            if (!res.ok) {
              lastError = {
                ok: false,
                status: res.status,
                error: `artifact_http_${res.status}`,
                data: null,
                url: artifactUrl,
              };
              continue;
            }
            return {
              ok: true,
              status: res.status,
              error: "",
              data: await res.json(),
              url: artifactUrl,
            };
          } catch (e) {
            lastError = {
              ok: false,
              status: 0,
              error: `artifact_fetch_failed: ${e?.message || String(e)}`,
              data: null,
              url: artifactUrl,
            };
          }
        }
        return lastError;
      };

      const htmlDecode = (text) =>
        safeStr(text)
          .replace(/&nbsp;/gi, " ")
          .replace(/&amp;/gi, "&")
          .replace(/&quot;/gi, '"')
          .replace(/&#39;/gi, "'")
          .replace(/&lt;/gi, "<")
          .replace(/&gt;/gi, ">");

      const stripHtml = (html) =>
        htmlDecode(String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

      const parseXmlAttributesLoose = (tagText) => {
        const attrs = {};
        const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
        let m;
        while ((m = re.exec(String(tagText || "")))) {
          attrs[String(m[1] || "").toLowerCase()] = m[3] != null ? m[3] : (m[4] != null ? m[4] : (m[5] || ""));
        }
        return attrs;
      };

      const xmlTextNodes = (xml, tagName) => {
        const out = [];
        const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
        let m;
        while ((m = re.exec(String(xml || "")))) out.push(stripHtml(m[1]));
        return out;
      };

      const xmlTagNodes = (xml, tagNames) => {
        const names = Array.isArray(tagNames) ? tagNames.filter(Boolean) : [tagNames].filter(Boolean);
        if (!names.length) return [];
        const out = [];
        for (const name of names) {
          const re = new RegExp(`<${name}\\b([^>]*)\\/?>`, "gi");
          let m;
          while ((m = re.exec(String(xml || "")))) {
            out.push({ name, attrs: parseXmlAttributesLoose(m[1] || "") });
          }
        }
        return out;
      };

      const normalizeAcqPos = (raw) => {
        const pos = safeStr(raw).toUpperCase();
        if (pos === "K") return "PK";
        if (pos === "P") return "PN";
        if (pos === "DE" || pos === "DT" || pos === "EDGE" || pos === "DL") return "DL";
        if (pos === "CB" || pos === "S" || pos === "FS" || pos === "SS" || pos === "DB") return "DB";
        return pos || "OTHER";
      };

      const parseDurationSeconds = (text) => {
        const src = safeStr(text).toLowerCase();
        if (!src) return null;
        let total = 0;
        let matched = false;
        const patterns = [
          [/(\d+)\s*d(?:ay)?s?/g, 86400],
          [/(\d+)\s*h(?:our|r)?s?/g, 3600],
          [/(\d+)\s*m(?:in(?:ute)?)?s?/g, 60],
          [/(\d+)\s*s(?:ec(?:ond)?)?s?/g, 1],
        ];
        for (const [re, scale] of patterns) {
          let m;
          while ((m = re.exec(src))) {
            total += safeInt(m[1], 0) * scale;
            matched = true;
          }
        }
        if (matched) return total;
        const colon = src.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
        if (colon) {
          return safeInt(colon[1], 0) * 3600 + safeInt(colon[2], 0) * 60 + safeInt(colon[3], 0);
        }
        return null;
      };

      const parseMoneyLoose = (raw) => {
        const src = safeStr(raw);
        if (!src) return null;
        const m = src.match(/\$?\s*([0-9][0-9,]*)(?:\s*K)?/i);
        if (!m) return null;
        const num = safeInt(String(m[1] || "").replace(/,/g, ""), 0);
        if (!num) return 0;
        return /k\b/i.test(src) ? num * 1000 : num;
      };

      const summarizeTimeText = (text) => {
        const src = safeStr(text);
        if (!src) return "";
        const durationMatch = src.match(/(\d+\s*d(?:ay)?s?.{0,24})|(\d+\s*h(?:our|r)?s?.{0,24})|(\d+\s*m(?:in(?:ute)?)?s?.{0,24})/i);
        if (durationMatch) return safeStr(durationMatch[0]).slice(0, 32);
        const absoluteMatch = src.match(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/i);
        return absoluteMatch ? safeStr(absoluteMatch[0]) : "";
      };

      const parseHtmlForms = (html, pageUrl) => {
        const forms = [];
        const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
        let formMatch;
        while ((formMatch = formRe.exec(String(html || "")))) {
          const formAttrs = parseXmlAttributesLoose(formMatch[1] || "");
          const bodyHtml = String(formMatch[2] || "");
          const actionUrl = new URL(safeStr(formAttrs.action || pageUrl), pageUrl).toString();
          const method = safeStr(formAttrs.method || "POST").toUpperCase() === "GET" ? "GET" : "POST";
          const fields = {};
          const submitOptions = [];
          const inputRe = /<input\b[^>]*>/gi;
          let inputMatch;
          while ((inputMatch = inputRe.exec(bodyHtml))) {
            const attrs = parseXmlAttributesLoose(inputMatch[0] || "");
            const name = safeStr(attrs.name);
            const type = safeStr(attrs.type || "text").toLowerCase();
            const value = safeStr(attrs.value);
            if (!name) continue;
            if (type === "submit" || type === "button" || type === "image") {
              submitOptions.push({ name, value, label: stripHtml(inputMatch[0]) || value || name });
              continue;
            }
            if (!(name in fields)) fields[name] = value;
          }
          const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
          let selectMatch;
          while ((selectMatch = selectRe.exec(bodyHtml))) {
            const attrs = parseXmlAttributesLoose(selectMatch[1] || "");
            const name = safeStr(attrs.name);
            if (!name) continue;
            const optionsHtml = String(selectMatch[2] || "");
            const selected = optionsHtml.match(/<option\b[^>]*selected[^>]*value\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
            const first = optionsHtml.match(/<option\b[^>]*value\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
            const value = selected ? (selected[2] || selected[3] || selected[4] || "") : (first ? (first[2] || first[3] || first[4] || "") : "");
            if (!(name in fields)) fields[name] = safeStr(value);
          }
          forms.push({
            actionUrl,
            method,
            fields,
            submitOptions,
            rawHtml: bodyHtml,
            text: stripHtml(bodyHtml),
          });
        }
        return forms;
      };

      const pickSubmitOption = (form, keywords) => {
        const list = Array.isArray(form?.submitOptions) ? form.submitOptions : [];
        const wants = Array.isArray(keywords) ? keywords : [keywords];
        for (const option of list) {
          const blob = `${safeStr(option?.name)} ${safeStr(option?.value)} ${safeStr(option?.label)}`.toLowerCase();
          if (wants.some((want) => blob.includes(safeStr(want).toLowerCase()))) return option;
        }
        return list[0] || null;
      };

      const deriveAuctionPlayerId = (blob) => {
        const text = String(blob || "");
        const patterns = [
          /(?:player_id|pid|playerid)[^0-9]{0,8}([0-9]{3,8})/i,
          /[?&]P=([0-9]{3,8})(?:&|$)/i,
          /[?&]PLAYER=([0-9]{3,8})(?:&|$)/i,
          /\/player\/([0-9]{3,8})(?:\/|$)/i,
        ];
        for (const re of patterns) {
          const m = text.match(re);
          if (m && m[1]) return String(m[1]).replace(/\D/g, "");
        }
        return "";
      };

      const parseAuctionPage = (html, pageUrl) => {
        const forms = parseHtmlForms(html, pageUrl);
        const auctions = [];
        const seen = new Set();
        for (const form of forms) {
          const rawHtml = safeStr(form.rawHtml);
          const text = safeStr(form.text);
          const playerId =
            String(
              firstTruthy(
                form.fields.player_id,
                form.fields.playerid,
                form.fields.pid,
                form.fields.player,
                deriveAuctionPlayerId(rawHtml)
              ) || ""
            ).replace(/\D/g, "");
          const playerNameMatch =
            rawHtml.match(/>([^<>]{2,80},\s*[^<>]{1,80})<\/a>/i) ||
            text.match(/([A-Z][A-Za-z'. -]{1,40},\s*[A-Z][A-Za-z'. -]{1,40})/);
          const playerName = safeStr(playerNameMatch && playerNameMatch[1]);
          const positionMatch = text.match(/\b(QB|RB|WR|TE|K|PK|P|PN|DE|DT|DL|LB|CB|S|DB)\b/);
          const highBid = parseMoneyLoose(text);
          const bidderMatch = text.match(/(?:high bidder|current bidder|leader)\s*:?\s*([A-Za-z0-9 '&().-]{2,40})/i);
          const timerText = summarizeTimeText(text);
          if (!playerId && !playerName) continue;
          const key = playerId || `${playerName}|${highBid}`;
          if (seen.has(key)) continue;
          seen.add(key);
          auctions.push({
            player_id: playerId,
            player_name: playerName || (playerId ? `Player ${playerId}` : "Unknown"),
            position: normalizeAcqPos(positionMatch ? positionMatch[1] : ""),
            high_bid_amount: highBid,
            high_bidder_label: safeStr(bidderMatch && bidderMatch[1]),
            timer_text: timerText,
            timer_seconds: parseDurationSeconds(timerText || text),
            page_text: text.slice(0, 240),
          });
        }
        const availableFundsMatch = stripHtml(html).match(/available funds[^0-9$]*\$?\s*([0-9,]+)/i);
        return {
          active_auctions: auctions,
          forms,
          available_funds_hint: availableFundsMatch ? safeInt(String(availableFundsMatch[1] || "").replace(/,/g, ""), 0) : null,
        };
      };

      const fetchAuctionPageForCookie = async (cookieHeaderOverride, season, leagueId, franchiseId) => {
        const targetFranchiseId = padFranchiseId(franchiseId || "");
        const pageUrl =
          `https://www48.myfantasyleague.com/${encodeURIComponent(String(season || YEAR))}` +
          `/options?L=${encodeURIComponent(leagueId)}&O=43` +
          (targetFranchiseId ? `&FRANCHISE=${encodeURIComponent(targetFranchiseId)}` : "");
        const resp = await fetchTextWithCookie(pageUrl, cookieHeaderOverride, { method: "GET" });
        const unauthorized = /login required|sign in|league login|not logged in/i.test(safeStr(resp.text));
        return {
          ok: resp.status >= 200 && resp.status < 400 && !unauthorized,
          status: resp.status,
          pageUrl,
          html: safeStr(resp.text),
          url: resp.url || pageUrl,
          unauthorized,
        };
      };

      const normalizeAuctionActionRequest = (body, fallbackKind) => ({
        action: safeStr(body?.action).toLowerCase(),
        player_id: String(body?.player_id || body?.playerId || "").replace(/\D/g, ""),
        amount: safeMoneyInt(body?.amount, null),
        franchise_id: padFranchiseId(body?.franchise_id || body?.franchiseId || body?.franchise || body?.F || ""),
        comment: safeStr(body?.comment || ""),
        auction_kind: safeStr(body?.auction_kind || fallbackKind || "free-agent").toLowerCase(),
      });

      const auctionActionFormFromPage = (parsedPage, normalizedAction) => {
        const forms = Array.isArray(parsedPage?.forms) ? parsedPage.forms : [];
        const action = safeStr(normalizedAction?.action).toLowerCase();
        const playerId = safeStr(normalizedAction?.player_id).replace(/\D/g, "");
        if (!forms.length) return null;
        if (action === "bid") {
          for (const form of forms) {
            const blob = `${JSON.stringify(form.fields)} ${form.rawHtml}`.toLowerCase();
            const candidatePlayerId =
              String(firstTruthy(form.fields.player_id, form.fields.playerid, form.fields.pid, form.fields.player) || "").replace(/\D/g, "") ||
              deriveAuctionPlayerId(blob);
            if (!candidatePlayerId || candidatePlayerId !== playerId) continue;
            const nextFields = { ...form.fields };
            const amountField = Object.keys(nextFields).find((key) => /amount|bid/i.test(String(key)));
            if (!amountField) return null;
            nextFields[amountField] = String(safeInt(normalizedAction.amount, 0));
            const submit = pickSubmitOption(form, ["bid", "submit", "raise"]);
            if (submit && submit.name) nextFields[submit.name] = safeStr(submit.value || "Submit");
            return { actionUrl: form.actionUrl, method: form.method, fields: nextFields };
          }
        }
        if (action === "nominate") {
          for (const form of forms) {
            const keys = Object.keys(form.fields || {});
            const hasPlayerField = keys.some((key) => /player|pid/i.test(String(key)));
            const hasAmountField = keys.some((key) => /amount|bid/i.test(String(key)));
            if (!hasPlayerField || !hasAmountField) continue;
            const nextFields = { ...form.fields };
            for (const key of Object.keys(nextFields)) {
              if (/player|pid/i.test(String(key))) nextFields[key] = playerId || safeStr(nextFields[key]);
              if (/amount|bid/i.test(String(key))) nextFields[key] = String(safeInt(normalizedAction.amount, 0));
              if (/franchise/i.test(String(key)) && normalizedAction.franchise_id) nextFields[key] = normalizedAction.franchise_id;
            }
            const submit = pickSubmitOption(form, ["nominate", "add", "submit"]);
            if (submit && submit.name) nextFields[submit.name] = safeStr(submit.value || "Submit");
            return { actionUrl: form.actionUrl, method: form.method, fields: nextFields };
          }
        }
        return null;
      };

      const postAuctionActionForCookie = async (cookieHeaderOverride, preparedForm) => {
        if (!preparedForm || !preparedForm.actionUrl) {
          return { ok: false, status: 0, error: "auction_form_not_found", preview: "", url: "" };
        }
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(preparedForm.fields || {})) {
          if (!safeStr(key)) continue;
          params.set(key, safeStr(value));
        }
        const resp = await fetchTextWithCookie(preparedForm.actionUrl, cookieHeaderOverride, {
          method: preparedForm.method || "POST",
          contentType: "application/x-www-form-urlencoded;charset=UTF-8",
          body: params.toString(),
        });
        const text = safeStr(resp.text);
        const lowered = text.toLowerCase();
        const ok =
          resp.status >= 200 &&
          resp.status < 400 &&
          !lowered.includes("not authorized") &&
          !lowered.includes("login required") &&
          !lowered.includes("invalid");
        return {
          ok,
          status: resp.status,
          error: ok ? "" : "auction_post_failed",
          preview: text.slice(0, 1200),
          url: resp.url || preparedForm.actionUrl,
        };
      };

      const parseRookieDraftResultsXml = (xml, franchiseMap) => {
        const nodes = xmlTagNodes(xml, ["draftpick", "pick", "selection"]);
        const out = [];
        for (const node of nodes) {
          const attrs = node.attrs || {};
          const playerId = String(firstTruthy(attrs.player_id, attrs.playerid, attrs.pid, attrs.player) || "").replace(/\D/g, "");
          const franchiseId = padFranchiseId(firstTruthy(attrs.franchise_id, attrs.franchise, attrs.team_id, attrs.fid, attrs.owner));
          const playerName = safeStr(firstTruthy(attrs.player_name, attrs.playername, attrs.name, attrs.player));
          const round = safeInt(firstTruthy(attrs.round, attrs.draft_round), 0);
          const pickInRound = safeInt(firstTruthy(attrs.pick, attrs.pick_in_round, attrs.round_pick), 0);
          const overallPick = safeInt(firstTruthy(attrs.overallpick, attrs.pick_overall, attrs.overall), 0);
          if (!playerId && !playerName && !round && !pickInRound) continue;
          out.push({
            round,
            pick_in_round: pickInRound,
            pick_overall: overallPick,
            player_id: playerId,
            player_name: playerName || (playerId ? `Player ${playerId}` : ""),
            franchise_id: franchiseId,
            franchise_name: franchiseMap[franchiseId]?.franchise_name || franchiseId,
            timestamp: safeStr(firstTruthy(attrs.timestamp, attrs.datetime, attrs.time, attrs.ts)),
          });
        }
        out.sort((a, b) => safeInt(a.pick_overall, 0) - safeInt(b.pick_overall, 0) || safeInt(a.round, 0) - safeInt(b.round, 0) || safeInt(a.pick_in_round, 0) - safeInt(b.pick_in_round, 0));
        return out;
      };

      const parseRookieDraftStatusXml = (xml) => {
        const attrs = xmlTagNodes(xml, ["draftstatus", "status"]);
        const texts = [
          ...xmlTextNodes(xml, "status"),
          ...xmlTextNodes(xml, "message"),
        ].filter(Boolean);
        const joined = texts.join(" ").trim();
        const firstAttrs = attrs[0] && attrs[0].attrs ? attrs[0].attrs : {};
        const round = safeInt(firstTruthy(firstAttrs.round, firstAttrs.current_round), 0);
        const pick = safeInt(firstTruthy(firstAttrs.pick, firstAttrs.current_pick), 0);
        const franchiseId = padFranchiseId(firstTruthy(firstAttrs.franchise_id, firstAttrs.franchise, firstAttrs.fid));
        const playerClock = safeStr(firstTruthy(firstAttrs.timer, firstAttrs.timeleft, firstAttrs.clock));
        return {
          message: joined,
          current_pick: round || pick ? { round, pick, franchise_id: franchiseId } : null,
          timer_text: playerClock || summarizeTimeText(joined),
          timer_seconds: parseDurationSeconds(playerClock || joined),
        };
      };

      const parseRookieDraftChatXml = (xml) => {
        const messages = [];
        const nodes = xmlTagNodes(xml, ["message", "chat", "chatmessage"]);
        for (const node of nodes) {
          const attrs = node.attrs || {};
          const text = safeStr(firstTruthy(attrs.text, attrs.message, attrs.msg));
          const author = safeStr(firstTruthy(attrs.user, attrs.owner, attrs.franchise, attrs.name));
          if (text) messages.push({ author, text, timestamp: safeStr(firstTruthy(attrs.time, attrs.timestamp, attrs.ts)) });
        }
        return messages.slice(-25);
      };

      const ACQ_EXTENSION_RATES_BY_SEASON = {
        "2024": { QB: { 1: 10000 }, RB: { 1: 10000 }, WR: { 1: 10000 }, TE: { 1: 10000 }, DL: { 1: 3000 }, LB: { 1: 3000 }, DB: { 1: 3000 }, PK: { 1: 3000 }, PN: { 1: 3000 }, OTHER: { 1: 3000 } },
        "2025": { QB: { 1: 10000 }, RB: { 1: 10000 }, WR: { 1: 10000 }, TE: { 1: 10000 }, DL: { 1: 3000 }, LB: { 1: 3000 }, DB: { 1: 3000 }, PK: { 1: 3000 }, PN: { 1: 3000 }, OTHER: { 1: 3000 } },
        "2026": { QB: { 1: 10000 }, RB: { 1: 10000 }, WR: { 1: 10000 }, TE: { 1: 10000 }, DL: { 1: 3000 }, LB: { 1: 3000 }, DB: { 1: 3000 }, PK: { 1: 3000 }, PN: { 1: 3000 }, OTHER: { 1: 3000 } },
      };

      const formatContractKAcq = (amount) => {
        const dollars = safeInt(amount, 0);
        if (!dollars) return "0";
        if (dollars % 1000 === 0) return `${Math.round(dollars / 1000)}K`;
        const value = Math.round((dollars / 1000) * 10) / 10;
        return `${value}K`;
      };

      const round2Acq = (value) => Math.round(safeFloat(value, 0) * 100) / 100;

      const resolveAcqPosForExtensionRate = (raw) => {
        const pos = normalizeAcqPos(raw || "");
        return pos === "K" ? "PK" : (pos || "OTHER");
      };

      const getAcqExtensionRaise = (position, season, yearsToAdd) => {
        const seasonKey = safeStr(season || YEAR || "");
        const seasonMap =
          ACQ_EXTENSION_RATES_BY_SEASON[seasonKey] ||
          ACQ_EXTENSION_RATES_BY_SEASON[String(Math.max(2024, safeInt(seasonKey, 2025) - 1))] ||
          ACQ_EXTENSION_RATES_BY_SEASON["2025"];
        const posKey = resolveAcqPosForExtensionRate(position);
        const rec = seasonMap[posKey] || seasonMap.OTHER || { 1: 3000 };
        return safeInt(rec[safeInt(yearsToAdd, 1)] || rec[1], 0);
      };

      const buildRookieOptionStateAcq = ({ season, round, position, baseSalary }) => {
        const classSeason = safeInt(season, 0);
        const isEligible = classSeason >= 2025 && safeInt(round, 0) === 1;
        if (!isEligible) {
          return {
            rookie_option_eligible: false,
            rookie_option_exercised: false,
            rookie_option_class_season: classSeason || null,
            rookie_option_deadline_season: null,
            rookie_option_base_salary: safeInt(baseSalary, 0),
            rookie_option_half_raise_salary: null,
            rookie_option_year_salary: null,
          };
        }
        const base = Math.max(0, safeInt(baseSalary, 0));
        const raise = getAcqExtensionRaise(position, classSeason, 1);
        const optionSalary = base + Math.round(raise / 2);
        return {
          rookie_option_eligible: true,
          rookie_option_exercised: false,
          rookie_option_class_season: classSeason,
          rookie_option_deadline_season: classSeason + 2,
          rookie_option_base_salary: base,
          rookie_option_half_raise_salary: optionSalary,
          rookie_option_year_salary: optionSalary,
        };
      };

      const buildRookieOptionInfoSegmentAcq = (optionState, mode) => {
        if (!optionState || !optionState.rookie_option_eligible) return "";
        return [
          "ROPT",
          `status=${safeStr(mode || (optionState.rookie_option_exercised ? "exercised" : "eligible"))}`,
          `class=${safeInt(optionState.rookie_option_class_season, 0)}`,
          `deadline=${safeInt(optionState.rookie_option_deadline_season, 0)}`,
          `base=${formatContractKAcq(optionState.rookie_option_base_salary)}`,
          `option=${formatContractKAcq(optionState.rookie_option_year_salary)}`,
        ].join(" ");
      };

      const buildRookieContractInfoAcq = ({ yearsRemaining, baseSalary, optionState, mode }) => {
        const years = Math.max(1, safeInt(yearsRemaining, 0));
        const base = Math.max(1000, safeInt(baseSalary, 0));
        const yearValues = [];
        for (let i = 1; i <= years; i += 1) yearValues.push(base);
        if (mode === "exercised" && optionState && optionState.rookie_option_year_salary && years >= 2) {
          yearValues[years - 1] = safeInt(optionState.rookie_option_year_salary, base);
        }
        const total = yearValues.reduce((sum, value) => sum + safeInt(value, 0), 0);
        const aav = Math.round(total / Math.max(1, years));
        const gtd = total > 4000 ? Math.round(total * 0.75) : Math.max(0, total - safeInt(yearValues[0], 0));
        const yearText = yearValues.map((value, idx) => `Y${idx + 1}-${formatContractKAcq(value)}`).join(", ");
        const parts = [
          `CL ${years}`,
          `TCV ${formatContractKAcq(total)}`,
          `AAV ${formatContractKAcq(aav)}`,
          yearText,
          `GTD: ${formatContractKAcq(gtd)}`,
        ];
        const optionSegment = buildRookieOptionInfoSegmentAcq(optionState, mode);
        if (optionSegment) parts.push(optionSegment);
        return parts.join("|");
      };

      const parseRookieOptionInfoAcq = (contractInfo) => {
        const src = safeStr(contractInfo);
        const match = src.match(/(?:^|\|)\s*ROPT\s+([^|]+)/i);
        if (!match) return null;
        const blob = safeStr(match[1]);
        const statusMatch = blob.match(/\bstatus=([a-z-]+)/i);
        const classMatch = blob.match(/\bclass=(\d{4})\b/i);
        const deadlineMatch = blob.match(/\bdeadline=(\d{4})\b/i);
        const baseMatch = blob.match(/\bbase=([0-9.]+)K\b/i);
        const optionMatch = blob.match(/\boption=([0-9.]+)K\b/i);
        const parseK = (m) => {
          const n = Number(m && m[1]);
          return Number.isFinite(n) ? Math.round(n * 1000) : 0;
        };
        return {
          rookie_option_eligible: true,
          rookie_option_exercised: safeStr(statusMatch && statusMatch[1]).toLowerCase() === "exercised",
          rookie_option_class_season: safeInt(classMatch && classMatch[1], 0),
          rookie_option_deadline_season: safeInt(deadlineMatch && deadlineMatch[1], 0),
          rookie_option_base_salary: parseK(baseMatch),
          rookie_option_half_raise_salary: parseK(optionMatch),
          rookie_option_year_salary: parseK(optionMatch),
        };
      };

      const rookieContractStatusLikeAcq = (raw) => {
        const text = safeStr(raw).toLowerCase();
        return text === "r" || text === "r-opt" || text.startsWith("r-") || text.indexOf("rookie") !== -1;
      };

      const parseSalaryExportRowsAcq = (payload) => {
        const leagueUnit = payload?.salaries?.leagueUnit || payload?.salaries?.leagueunit || payload?.leagueUnit || payload || {};
        const rows = asArray(leagueUnit?.player || leagueUnit?.players || payload?.player).filter(Boolean);
        const out = {};
        for (const row of rows) {
          const playerId = String(row?.id || row?.player_id || "").replace(/\D/g, "");
          if (!playerId) continue;
          out[playerId] = {
            player_id: playerId,
            salary: safeInt(row?.salary, 0),
            contractYear: safeInt(row?.contractYear || row?.contractyear, 0),
            contractStatus: safeStr(row?.contractStatus || row?.contractstatus),
            contractInfo: safeStr(row?.contractInfo || row?.contractinfo),
          };
        }
        return out;
      };

      const resolveFirstRoundPickSalaryDollarsAcq = (pickInRound) => {
        const slot = safeInt(pickInRound, 0);
        if (slot <= 0) return 10000;
        return Math.max(5000, 15000 - ((slot - 1) * 1000));
      };

      const resolveRookieSalaryDollarsAcq = (season, round, pickInRound, rookieArtifactData) => {
        const roundNum = safeInt(round, 0);
        const pickNum = safeInt(pickInRound, 0);
        const artifactRows = asArray(rookieArtifactData?.history_rows);
        const explicit = artifactRows.find((row) =>
          safeInt(row?.season, 0) === safeInt(season, 0) &&
          safeInt(row?.draft_round, 0) === roundNum &&
          safeInt(row?.pick_in_round, 0) === pickNum &&
          safeInt(row?.salary, 0) > 0
        );
        const explicitSalary = safeInt(explicit?.salary, 0);
        if (explicitSalary > 0) return { salary: explicitSalary, source: "explicit_schedule" };
        if (roundNum === 1) return { salary: resolveFirstRoundPickSalaryDollarsAcq(pickNum), source: "round_1_fallback" };
        return { salary: 5000, source: "flat_rookie_fallback" };
      };

      const buildRookieHistorySummariesAcq = (rows) => {
        const list = asArray(rows);
        const topHits = list
          .slice()
          .sort((a, b) =>
            safeFloat(b?.rookie_value_score, 0) - safeFloat(a?.rookie_value_score, 0) ||
            safeFloat(b?.points_rookiecontract, 0) - safeFloat(a?.points_rookiecontract, 0)
          )
          .slice(0, 50);
        const ownerMap = {};
        const pickMap = {};
        const bucketMap = {};
        for (const row of list) {
          const ownerKey = `${safeStr(row?.season)}|${padFranchiseId(row?.franchise_id)}`;
          if (!ownerMap[ownerKey]) {
            ownerMap[ownerKey] = {
              season: safeInt(row?.season, 0),
              franchise_id: padFranchiseId(row?.franchise_id),
              franchise_name: safeStr(row?.franchise_name),
              owner_name: safeStr(row?.owner_name),
              picks_made: 0,
              points_total_3yr: 0,
              rookie_value_total: 0,
              hit_count: 0,
              best_pick: "",
              best_score: -1,
            };
          }
          ownerMap[ownerKey].picks_made += 1;
          ownerMap[ownerKey].points_total_3yr += safeFloat(row?.points_rookiecontract, 0);
          ownerMap[ownerKey].rookie_value_total += safeFloat(row?.rookie_value_score, 0);
          ownerMap[ownerKey].hit_count += safeInt(row?.hit_flag, 0);
          if (safeFloat(row?.rookie_value_score, 0) > safeFloat(ownerMap[ownerKey].best_score, -1)) {
            ownerMap[ownerKey].best_score = safeFloat(row?.rookie_value_score, 0);
            ownerMap[ownerKey].best_pick = [safeStr(row?.pick_label), safeStr(row?.player_name)].filter(Boolean).join(" / ");
          }

          const pickKey = `${safeInt(row?.draft_round, 0)}|${safeInt(row?.pick_in_round, 0)}`;
          if (!pickMap[pickKey]) {
            pickMap[pickKey] = {
              draft_round: safeInt(row?.draft_round, 0),
              pick_in_round: safeInt(row?.pick_in_round, 0),
              pick_label: safeStr(row?.pick_label),
              round_segment: safeStr(row?.round_segment),
              sample_size: 0,
              points_total_3yr: 0,
              rookie_value_total: 0,
              hit_count: 0,
            };
          }
          pickMap[pickKey].sample_size += 1;
          pickMap[pickKey].points_total_3yr += safeFloat(row?.points_rookiecontract, 0);
          pickMap[pickKey].rookie_value_total += safeFloat(row?.rookie_value_score, 0);
          pickMap[pickKey].hit_count += safeInt(row?.hit_flag, 0);

          const bucket = safeStr(row?.pick_bucket);
          if (bucket) {
            if (!bucketMap[bucket]) {
              bucketMap[bucket] = {
                pick_bucket: bucket,
                expected_points_3yr: safeFloat(row?.expected_points_3yr, 0),
                avg_points_3yr_total: 0,
                avg_rookie_value_score_total: 0,
                sample_size: 0,
              };
            }
            bucketMap[bucket].avg_points_3yr_total += safeFloat(row?.points_rookiecontract, 0);
            bucketMap[bucket].avg_rookie_value_score_total += safeFloat(row?.rookie_value_score, 0);
            bucketMap[bucket].sample_size += 1;
          }
        }
        const owner_summary_rows = Object.values(ownerMap).map((row) => {
          const picks = Math.max(1, safeInt(row?.picks_made, 1));
          return {
            season: safeInt(row?.season, 0),
            franchise_id: row.franchise_id,
            franchise_name: row.franchise_name,
            owner_name: row.owner_name,
            picks_made: safeInt(row?.picks_made, 0),
            avg_points_3yr: round2Acq(row.points_total_3yr / picks),
            avg_rookie_value_score: round2Acq(row.rookie_value_total / picks),
            hit_count: safeInt(row?.hit_count, 0),
            hit_rate: round2Acq(safeInt(row?.hit_count, 0) / picks),
            best_pick: safeStr(row?.best_pick),
          };
        }).sort((a, b) =>
          safeFloat(b?.avg_rookie_value_score, 0) - safeFloat(a?.avg_rookie_value_score, 0) ||
          safeFloat(b?.avg_points_3yr, 0) - safeFloat(a?.avg_points_3yr, 0)
        );
        const pick_summary_rows = Object.values(pickMap).map((row) => {
          const sampleSize = Math.max(1, safeInt(row?.sample_size, 1));
          return {
            draft_round: safeInt(row?.draft_round, 0),
            pick_in_round: safeInt(row?.pick_in_round, 0),
            pick_label: safeStr(row?.pick_label),
            round_segment: safeStr(row?.round_segment),
            sample_size: safeInt(row?.sample_size, 0),
            avg_points_3yr: round2Acq(row.points_total_3yr / sampleSize),
            avg_rookie_value_score: round2Acq(row.rookie_value_total / sampleSize),
            hit_count: safeInt(row?.hit_count, 0),
            hit_rate: round2Acq(safeInt(row?.hit_count, 0) / sampleSize),
          };
        }).sort((a, b) =>
          safeInt(a?.draft_round, 0) - safeInt(b?.draft_round, 0) ||
          safeInt(a?.pick_in_round, 0) - safeInt(b?.pick_in_round, 0)
        );
        const value_summary = Object.values(bucketMap).map((row) => ({
          pick_bucket: row.pick_bucket,
          expected_points_3yr: round2Acq(row.expected_points_3yr),
          avg_points_3yr: round2Acq(row.avg_points_3yr_total / Math.max(1, row.sample_size)),
          avg_rookie_value_score: round2Acq(row.avg_rookie_value_score_total / Math.max(1, row.sample_size)),
          sample_size: safeInt(row?.sample_size, 0),
        })).sort((a, b) => safeStr(a?.pick_bucket).localeCompare(safeStr(b?.pick_bucket)));
        return { owner_summary_rows, pick_summary_rows, top_hits: topHits, value_summary };
      };

      const filterRookieHistoryArtifactAcq = (artifactData, seasonContext) => {
        const selected = safeStr(seasonContext).toLowerCase();
        const allRows = asArray(artifactData?.history_rows);
        const filteredRows = !selected || selected === "all"
          ? allRows
          : allRows.filter((row) => safeStr(row?.season) === selected);
        const summaries = buildRookieHistorySummariesAcq(filteredRows);
        return {
          ...artifactData,
          season_context: selected || "all",
          history_rows: filteredRows,
          owner_summary_rows: summaries.owner_summary_rows,
          pick_summary_rows: summaries.pick_summary_rows,
          top_hits: summaries.top_hits,
          value_summary: summaries.value_summary,
        };
      };

      const overlayFranchiseBrandingAcq = (rows, franchiseMap) => asArray(rows).map((row) => {
        const fid = padFranchiseId(row?.franchise_id);
        const meta = franchiseMap[fid] || {};
        return {
          ...row,
          franchise_id: fid || safeStr(row?.franchise_id),
          franchise_name: safeStr(row?.franchise_name || meta.franchise_name || fid),
          franchise_abbrev: safeStr(row?.franchise_abbrev || meta.franchise_abbrev || fid),
          icon_url: safeStr(row?.icon_url || meta.icon_url || ""),
        };
      });

      const buildRookieContractPlanAcq = ({ season, round, pickInRound, position, rookieArtifactData }) => {
        const salaryPlan = resolveRookieSalaryDollarsAcq(season, round, pickInRound, rookieArtifactData);
        const optionState = buildRookieOptionStateAcq({
          season,
          round,
          position,
          baseSalary: salaryPlan.salary,
        });
        return {
          season: safeInt(season, 0),
          round: safeInt(round, 0),
          pick_in_round: safeInt(pickInRound, 0),
          salary: safeInt(salaryPlan.salary, 0),
          salary_source: safeStr(salaryPlan.source),
          contract_year: 3,
          contract_status: "R",
          contract_info: buildRookieContractInfoAcq({
            yearsRemaining: 3,
            baseSalary: salaryPlan.salary,
            optionState,
            mode: "eligible",
          }),
          rookie_option_state: optionState,
        };
      };

      const importContractUpdateAcq = async ({ leagueId, season, playerId, salary, contractYear, contractStatus, contractInfo }) => {
        const esc = (s) =>
          String(s == null ? "" : s)
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        const dataXml =
          `<salaries><leagueUnit unit="LEAGUE">` +
          `<player id="${esc(playerId)}" salary="${esc(salary)}" contractYear="${esc(contractYear)}" contractStatus="${esc(contractStatus)}" contractInfo="${esc(contractInfo)}" />` +
          `</leagueUnit></salaries>`;
        const importUrl =
          `https://api.myfantasyleague.com/${encodeURIComponent(String(season))}` +
          `/import?TYPE=salaries&L=${encodeURIComponent(leagueId)}&APPEND=1`;
        let targetImportUrl = importUrl;
        try {
          const probe = await fetch(importUrl, {
            method: "GET",
            redirect: "manual",
            headers: { Cookie: cookieHeader, "User-Agent": "upsmflproduction-worker" },
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          const loc = probe.headers.get("Location") || probe.headers.get("location");
          if (probe.status >= 300 && probe.status < 400 && loc) targetImportUrl = loc;
        } catch (_) {}
        const resp = await fetch(targetImportUrl, {
          method: "POST",
          headers: {
            Cookie: cookieHeader,
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "User-Agent": "upsmflproduction-worker",
          },
          body: `DATA=${encodeURIComponent(dataXml)}`,
          redirect: "manual",
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        const text = await resp.text();
        const lowered = safeStr(text).toLowerCase();
        const ok =
          resp.ok &&
          !lowered.includes("error") &&
          !lowered.includes("invalid") &&
          !lowered.includes("not authorized");
        return {
          ok,
          upstreamStatus: resp.status,
          upstreamPreview: safeStr(text).slice(0, 1200),
          targetImportUrl,
          dataXml,
        };
      };

      const buildRookieContractReconcileStatusAcq = (liveBoard, salaryRowsByPlayer) => {
        const missing = asArray(liveBoard).filter((row) => {
          const salaryRow = salaryRowsByPlayer[safeStr(row?.player_id)] || null;
          if (!salaryRow) return true;
          return !rookieContractStatusLikeAcq(salaryRow.contractStatus);
        });
        return {
          ok: missing.length === 0,
          missing_count: missing.length,
          label: missing.length ? `${missing.length} missing` : "Ready",
          summary: missing.length ? "Some confirmed rookie draft picks still need contracts applied." : "Live board and rookie contracts are in sync.",
          missing_player_ids: missing.map((row) => safeStr(row?.player_id)).filter(Boolean),
        };
      };

      const resolveViewerFranchiseIdForAcq = async (season, leagueId, requestedFranchiseId) => {
        const explicit = padFranchiseId(requestedFranchiseId);
        if (explicit) return explicit;
        const myFrRes = await mflExportJsonWithRetryAsViewer(season, leagueId, "myfranchise", {}, { useCookie: true });
        if (myFrRes.ok) {
          const parsed = parseMyFranchiseId(myFrRes.data);
          if (parsed) return parsed;
        }
        return "";
      };

      const buildFranchiseMap = (franchises) => {
        const out = {};
        for (const fr of franchises || []) out[padFranchiseId(fr.franchise_id)] = fr;
        return out;
      };

      const currentCapHitAcq = (salary, years, isTaxi, isIr) => {
        const amt = safeInt(salary, 0);
        const y = Math.max(0, safeInt(years, 0));
        if (isTaxi) return 0;
        if (y <= 0) return 0;
        if (isIr) return Math.round(amt * 0.5);
        return amt;
      };

      const computeLineupNeeds = (players) => {
        const counts = { QB: 0, RB: 0, WR: 0, TE: 0, PK: 0, PN: 0, DL: 0, LB: 0, DB: 0 };
        let rosterCount = 0;
        for (const player of players || []) {
          const pos = normalizeAcqPos(player?.position);
          const status = safeStr(player?.roster_status || player?.status).toUpperCase();
          const isTaxi = status.includes("TAXI");
          const isIr = status.includes("IR");
          if (!isTaxi) rosterCount += 1;
          if (isTaxi || isIr) continue;
          if (counts[pos] != null) counts[pos] += 1;
        }
        const base = {
          QB: Math.max(0, 1 - counts.QB),
          RB: Math.max(0, 2 - counts.RB),
          WR: Math.max(0, 2 - counts.WR),
          TE: Math.max(0, 1 - counts.TE),
          PK: Math.max(0, 1 - counts.PK),
          PN: Math.max(0, 1 - counts.PN),
          DL: Math.max(0, 2 - counts.DL),
          LB: Math.max(0, 2 - counts.LB),
          DB: Math.max(0, 2 - counts.DB),
        };
        const rbRemain = Math.max(0, counts.RB - 2);
        const wrRemain = Math.max(0, counts.WR - 2);
        const teRemain = Math.max(0, counts.TE - 1);
        const flexPool = rbRemain + wrRemain + teRemain;
        const flexNeed = Math.max(0, 2 - flexPool);
        const superflexPool = Math.max(0, counts.QB - 1) + Math.max(0, flexPool - 2);
        const superflexNeed = Math.max(0, 1 - superflexPool);
        const defenseFlexPool = Math.max(0, counts.DL - 2) + Math.max(0, counts.LB - 2) + Math.max(0, counts.DB - 2);
        const defenseFlexNeed = Math.max(0, 1 - defenseFlexPool);
        return {
          roster_count: rosterCount,
          counts,
          deficits: {
            ...base,
            FLEX: flexNeed,
            SUPERFLEX: superflexNeed,
            DFLEX: defenseFlexNeed,
          },
          total_deficit:
            Object.values(base).reduce((sum, value) => sum + safeInt(value, 0), 0) +
            flexNeed +
            superflexNeed +
            defenseFlexNeed,
        };
      };

      const reserveCostForScenario = (players, targetRosterCount) => {
        const needs = computeLineupNeeds(players);
        const openSlots = Math.max(0, safeInt(targetRosterCount, 0) - safeInt(needs.roster_count, 0));
        const reserveSlots = Math.max(openSlots, safeInt(needs.total_deficit, 0));
        return {
          roster_count: needs.roster_count,
          deficits: needs.deficits,
          reserve_slots: reserveSlots,
          reserve_cost: reserveSlots * 1000,
        };
      };

      const rosterCountsAfterHypothetical = (players, position) => {
        const list = Array.isArray(players) ? players.slice() : [];
        list.push({ position, roster_status: "ROSTER", status: "ROSTER" });
        return list;
      };

      const teamBudgetRowsFromLive = (teams, salaryCapDollars) => {
        const rows = [];
        for (const team of teams || []) {
          const players = Array.isArray(team.players) ? team.players : [];
          const capSpent = players.reduce((sum, player) => {
            const status = safeStr(player.roster_status || player.status).toUpperCase();
            return sum + currentCapHitAcq(player.salary, player.years, status.includes("TAXI"), status.includes("IR"));
          }, 0);
          const rawAvailable = safeMoneyInt(team?.available_salary_dollars, null);
          const availableFunds = rawAvailable != null ? rawAvailable : Math.max(0, safeInt(salaryCapDollars, 0) - capSpent);
          const reserve27 = reserveCostForScenario(players, 27);
          const reserve35 = reserveCostForScenario(players, 35);
          const maxBidByPosition = {};
          for (const pos of ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"]) {
            const after27 = reserveCostForScenario(rosterCountsAfterHypothetical(players, pos), 27);
            const after35 = reserveCostForScenario(rosterCountsAfterHypothetical(players, pos), 35);
            maxBidByPosition[pos] = {
              scenario_27: Math.max(0, availableFunds - safeInt(after27.reserve_cost, 0)),
              scenario_35: Math.max(0, availableFunds - safeInt(after35.reserve_cost, 0)),
            };
          }
          rows.push({
            franchise_id: team.franchise_id,
            franchise_name: team.franchise_name,
            icon_url: team.icon_url || "",
            cap_total_dollars: capSpent,
            available_funds_dollars: availableFunds,
            scenario_27_max_bid: Math.max(0, availableFunds - safeInt(reserve27.reserve_cost, 0)),
            scenario_35_max_bid: Math.max(0, availableFunds - safeInt(reserve35.reserve_cost, 0)),
            reserve_cost_27: safeInt(reserve27.reserve_cost, 0),
            reserve_cost_35: safeInt(reserve35.reserve_cost, 0),
            lineup_deficits: reserve27.deficits,
            roster_count: reserve27.roster_count,
            max_bid_by_position: maxBidByPosition,
          });
        }
        rows.sort((a, b) => safeStr(a.franchise_name).localeCompare(safeStr(b.franchise_name)));
        return rows;
      };

      const teamNeedRowsFromLive = (teams) => {
        const out = [];
        for (const team of teams || []) {
          const need = computeLineupNeeds(team.players || []);
          out.push({
            franchise_id: team.franchise_id,
            franchise_name: team.franchise_name,
            roster_count: need.roster_count,
            counts: need.counts,
            lineup_deficits: need.deficits,
            total_deficit: need.total_deficit,
          });
        }
        return out;
      };

      const buildLiveTeamsSnapshot = async (season, leagueId) => {
        const [leagueRes, rostersRes, myFrRes] = await Promise.all([
          mflExportJsonWithRetryAsViewer(season, leagueId, "league", {}, { useCookie: true }),
          mflExportJsonWithRetryAsViewer(season, leagueId, "rosters", {}, { useCookie: true }),
          mflExportJsonWithRetryAsViewer(season, leagueId, "myfranchise", {}, { useCookie: true }),
        ]);
        if (!leagueRes.ok || !rostersRes.ok) {
          return {
            ok: false,
            error: !leagueRes.ok ? "league_export_failed" : "rosters_export_failed",
            leagueRes,
            rostersRes,
            myFrRes,
          };
        }
        const franchises = parseLeagueFranchises(leagueRes.data);
        const franchiseMap = buildFranchiseMap(franchises);
        const { rosterAssetsByFranchise, allPlayerIds } = parseRostersExport(rostersRes.data);
        const playersById = await fetchPlayersByIdsChunked(season, leagueId, allPlayerIds);
        const teams = franchises.map((fr) => {
          const rawPlayers = asArray(rosterAssetsByFranchise[fr.franchise_id]).filter(Boolean);
          const players = rawPlayers.map((asset) => {
            const meta = playersById[String(asset.player_id || "")] || {};
            return {
              id: String(asset.player_id || ""),
              player_id: String(asset.player_id || ""),
              player_name: safeStr(meta.player_name || asset.player_name || asset.player_id),
              position: normalizeAcqPos(meta.position || asset.position || ""),
              nfl_team: safeStr(meta.nfl_team || ""),
              salary: safeInt(asset.salary, 0),
              years: safeInt(asset.years, 0),
              contract_type: safeStr(asset.contract_type || ""),
              roster_status: safeStr(asset.roster_status || ""),
              contract_info: safeStr(asset.contract_info || ""),
              status: safeStr(asset.roster_status || ""),
            };
          });
          return {
            franchise_id: fr.franchise_id,
            franchise_name: fr.franchise_name,
            franchise_abbrev: fr.franchise_abbrev,
            icon_url: fr.icon_url,
            available_salary_dollars: fr.available_salary_dollars,
            players,
          };
        });
        const viewerFranchiseId = myFrRes.ok ? parseMyFranchiseId(myFrRes.data) : "";
        const leagueRoot = leagueRes.data?.league || leagueRes.data || {};
        const salaryCapDollars = safeMoneyInt(
          firstTruthy(
            leagueRoot?.auctionStartAmount,
            leagueRoot?.salaryCapAmount,
            leagueRoot?.salary_cap_amount
          ),
          0
        );
        return {
          ok: true,
          franchises,
          franchiseMap,
          teams,
          viewerFranchiseId,
          salaryCapDollars,
          leagueRes,
          rostersRes,
          myFrRes,
        };
      };

      const buildAvailablePlayerBoard = (seedRows, rosteredPlayerIds, activeAuctionPlayerIds, limit) => {
        const rostered = new Set(asArray(rosteredPlayerIds).map((v) => String(v || "")));
        const active = new Set(asArray(activeAuctionPlayerIds).map((v) => String(v || "")));
        return asArray(seedRows)
          .filter((row) => {
            const playerId = String(row?.player_id || "");
            return playerId && !rostered.has(playerId) && !active.has(playerId);
          })
          .sort((a, b) => safeFloat(b?.upcoming_auction_value, 0) - safeFloat(a?.upcoming_auction_value, 0))
          .slice(0, Math.max(1, safeInt(limit, 60)));
      };

      const rookieLikeAcq = (raw) => {
        const s = safeStr(raw).toLowerCase();
        return s === "r" || s.startsWith("r-") || s.indexOf("rookie") !== -1;
      };

      const parseExtensionOwnersFromContractInfoAcq = (contractInfo) => {
        const src = safeStr(contractInfo);
        const extMatch = src.match(/(?:^|\|)\s*Ext:\s*([^|]+)/i);
        if (!extMatch) return [];
        const tokens = safeStr(extMatch[1])
          .split(/[,/;&]|\band\b/gi)
          .map((x) => safeStr(x).toLowerCase().replace(/[^a-z0-9]/g, ""))
          .filter(Boolean);
        const EXT_OWNER_BY_NICKNAME = {
          uw: "0001",
          lh: "0006",
          cbp: "0002",
          cleon: "0011",
          sex: "0007",
          gride: "0003",
          hammer: "0005",
          bb: "0010",
          ctown: "0009",
          chivalry: "0009",
          pg: "0004",
          creel: "0008",
          hawks: "0012",
          hood: "0099",
          mafia: "0099",
          blake: "0010",
        };
        const out = [];
        for (const token of tokens) {
          const fid = padFranchiseId(EXT_OWNER_BY_NICKNAME[token] || "");
          if (fid && out.indexOf(fid) === -1) out.push(fid);
        }
        return out;
      };

      const buildExpiredRookieEligiblePool = (teamsSnapshot, expiredArtifact, activeAuctions) => {
        const currentWinnerIds = new Set(asArray(expiredArtifact?.current_winner_player_ids).map((v) => String(v || "")));
        const extensionRows = asArray(expiredArtifact?.extension_rows);
        const extensionPlayerIds = new Set(extensionRows.map((row) => String(row?.player_id || "")).filter(Boolean));
        const activeAuctionIds = new Set(asArray(activeAuctions).map((row) => String(row?.player_id || "")).filter(Boolean));
        const out = [];
        for (const team of teamsSnapshot?.teams || []) {
          for (const player of team.players || []) {
            const playerId = String(player?.player_id || "");
            if (!playerId) continue;
            const status = safeStr(player?.contract_type || "");
            const years = safeInt(player?.years, 0);
            const extOwners = parseExtensionOwnersFromContractInfoAcq(player?.contract_info);
            if (!rookieLikeAcq(status)) continue;
            if (years > 0) continue;
            if (safeStr(player?.contract_info).toLowerCase().indexOf("tag") !== -1) continue;
            if (extOwners.indexOf(padFranchiseId(team.franchise_id)) !== -1) continue;
            if (extensionPlayerIds.has(playerId)) continue;
            if (currentWinnerIds.has(playerId)) continue;
            out.push({
              player_id: playerId,
              player_name: player.player_name,
              position: player.position,
              nfl_team: player.nfl_team,
              franchise_id: team.franchise_id,
              franchise_name: team.franchise_name,
              contract_info: player.contract_info,
              active_auction: activeAuctionIds.has(playerId),
            });
          }
        }
        out.sort((a, b) => safeStr(a.player_name).localeCompare(safeStr(b.player_name)));
        return out;
      };

      const fetchRookieDraftXml = async (season, leagueId, fileName) => {
        const cacheKey = `acq:rookiexml:${season}:${leagueId}:${fileName}`;
        const cached = acqCacheGet(cacheKey, 5000);
        if (cached) return cached;
        const base = safeStr(env.MFL_DYNAMIC_BASE_URL || "https://www48.myfantasyleague.com").replace(/\/+$/, "");
        const targetUrl = `${base}/${encodeURIComponent(String(season))}/fflnetdynamic${encodeURIComponent(String(season))}/${encodeURIComponent(String(leagueId))}_LEAGUE_${fileName}`;
        try {
          const res = await fetch(targetUrl, {
            headers: { "Cache-Control": "no-store", "User-Agent": "upsmflproduction-worker" },
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          const value = {
            ok: res.ok,
            status: res.status,
            url: targetUrl,
            text: res.ok ? await res.text() : "",
          };
          return acqCacheSet(cacheKey, value);
        } catch (e) {
          return {
            ok: false,
            status: 0,
            url: targetUrl,
            text: "",
            error: `fetch_failed: ${e?.message || String(e)}`,
          };
        }
      };

      const buildRookieDraftLivePayload = async (season, leagueId) => {
        const [teamsSnapshot, rookieArtifact, draftResultsRes, draftStatusRes, draftChatRes, salariesRes, calendarRes] = await Promise.all([
          buildLiveTeamsSnapshot(season, leagueId),
          fetchArtifactJson("rookie_draft_history"),
          fetchRookieDraftXml(season, leagueId, "draft_results.xml"),
          fetchRookieDraftXml(season, leagueId, "draft_status.xml"),
          fetchRookieDraftXml(season, leagueId, "chat.xml"),
          mflExportJsonWithRetryAsViewer(season, leagueId, "salaries", {}, { useCookie: true }),
          fetchLeagueCalendarAcq(season, leagueId),
        ]);
        const franchiseMap = teamsSnapshot.ok ? teamsSnapshot.franchiseMap : {};
        const rookieArtifactData = rookieArtifact.ok ? (rookieArtifact.data || {}) : {};
        const rookieSeedByPlayer = {};
        for (const row of asArray(rookieArtifactData?.draftable_rookies_seed || rookieArtifactData?.adp_board)) {
          const playerId = safeStr(row?.player_id);
          if (!playerId) continue;
          rookieSeedByPlayer[playerId] = row;
        }
        const liveBoardRaw = draftResultsRes.ok ? parseRookieDraftResultsXml(draftResultsRes.text, franchiseMap) : [];
        const liveBoard = overlayFranchiseBrandingAcq(liveBoardRaw.map((row) => {
          const seed = rookieSeedByPlayer[safeStr(row?.player_id)] || {};
          return {
            ...row,
            position: safeStr(row?.position || seed?.position),
            nfl_team: safeStr(row?.nfl_team || seed?.nfl_team),
          };
        }), franchiseMap);
        const statusInfo = draftStatusRes.ok ? parseRookieDraftStatusXml(draftStatusRes.text) : { message: "", current_pick: null, timer_text: "", timer_seconds: null };
        const chat = draftChatRes.ok ? parseRookieDraftChatXml(draftChatRes.text) : [];
        const salaryRowsByPlayer = salariesRes.ok ? parseSalaryExportRowsAcq(salariesRes.data) : {};
        const draftedIds = new Set(liveBoard.map((row) => safeStr(row?.player_id)).filter(Boolean));
        const draftableRookies = asArray(rookieArtifactData?.draftable_rookies_seed).filter((row) => {
          const playerId = safeStr(row?.player_id);
          return playerId && !draftedIds.has(playerId);
        });
        const currentPickFranchiseId = padFranchiseId(statusInfo?.current_pick?.franchise_id);
        const currentPickMeta = currentPickFranchiseId ? (franchiseMap[currentPickFranchiseId] || {}) : {};
        const rookieDraftEvent = teamsSnapshot.ok
          ? findRookieDraftCalendarEventAcq(calendarRes.ok ? calendarRes.data : {}, teamsSnapshot.leagueRes?.data || {})
          : null;
        const refreshPlan = deriveRookieDraftRefreshPlanAcq(rookieDraftEvent, statusInfo);
        const stale = !draftResultsRes.ok && !draftStatusRes.ok;
        const payload = {
          ok: true,
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          live_board: liveBoard,
          draft_status: {
            message: safeStr(statusInfo.message),
            timer_text: safeStr(statusInfo.timer_text),
            timer_seconds: statusInfo.timer_seconds == null ? null : safeInt(statusInfo.timer_seconds, 0),
            current_pick_team_name: safeStr(currentPickMeta?.franchise_name),
            current_pick_icon_url: safeStr(currentPickMeta?.icon_url),
          },
          chat,
          current_pick: statusInfo.current_pick
            ? {
                ...statusInfo.current_pick,
                franchise_name: safeStr(currentPickMeta?.franchise_name),
                franchise_abbrev: safeStr(currentPickMeta?.franchise_abbrev),
                icon_url: safeStr(currentPickMeta?.icon_url),
              }
            : null,
          draft_order: overlayFranchiseBrandingAcq(
            asArray(rookieArtifactData?.current_order).slice(0, 72),
            franchiseMap
          ),
          draftable_rookies: draftableRookies,
          contract_reconcile_status: buildRookieContractReconcileStatusAcq(liveBoard, salaryRowsByPlayer),
          refresh_mode: safeStr(refreshPlan.refresh_mode),
          draft_event: refreshPlan.draft_event,
          fetched_at: new Date().toISOString(),
          source_age_seconds: 0,
          stale,
          next_refresh_recommended_ms: safeInt(refreshPlan.next_refresh_recommended_ms, 60000),
          hidden_refresh_recommended_ms: safeInt(refreshPlan.hidden_refresh_recommended_ms, 300000),
          native_link: `https://www48.myfantasyleague.com/${encodeURIComponent(String(season))}/live_draft?L=${encodeURIComponent(leagueId)}`,
          upstream: {
            draft_results: { ok: draftResultsRes.ok, status: draftResultsRes.status, url: draftResultsRes.url },
            draft_status: { ok: draftStatusRes.ok, status: draftStatusRes.status, url: draftStatusRes.url },
            chat: { ok: draftChatRes.ok, status: draftChatRes.status, url: draftChatRes.url },
            artifact: { ok: rookieArtifact.ok, status: rookieArtifact.status, url: rookieArtifact.url },
            calendar: { ok: calendarRes.ok, status: calendarRes.status, url: calendarRes.url },
          },
        };
        if ((!payload.draft_order || !payload.draft_order.length) && rookieArtifact.ok) {
          payload.draft_order = overlayFranchiseBrandingAcq(asArray(rookieArtifact.data?.current_order).slice(0, 48), franchiseMap);
        }
        return payload;
      };

      const buildAuctionLivePayload = async (season, leagueId, requestedFranchiseId, auctionKind) => {
        const [teamsSnapshot, auctionArtifact, expiredArtifact] = await Promise.all([
          buildLiveTeamsSnapshot(season, leagueId),
          fetchArtifactJson("free_agent_auction_history"),
          fetchArtifactJson("expired_rookie_history"),
        ]);
        if (!teamsSnapshot.ok) {
          return {
            ok: false,
            error: teamsSnapshot.error || "teams_snapshot_failed",
            fetched_at: new Date().toISOString(),
            source_age_seconds: 0,
            stale: true,
            next_refresh_recommended_ms: auctionKind === "expired-rookie" ? 30000 : 20000,
          };
        }
        const viewerFranchiseId = await resolveViewerFranchiseIdForAcq(season, leagueId, requestedFranchiseId || teamsSnapshot.viewerFranchiseId);
        const auctionPageRes = await fetchAuctionPageForCookie(viewerCookieHeader || cookieHeader, season, leagueId, viewerFranchiseId);
        const parsedPage = auctionPageRes.ok ? parseAuctionPage(auctionPageRes.html, auctionPageRes.url || auctionPageRes.pageUrl) : { active_auctions: [], forms: [], available_funds_hint: null };
        const budgetRows = teamBudgetRowsFromLive(teamsSnapshot.teams, teamsSnapshot.salaryCapDollars);
        const needRows = teamNeedRowsFromLive(teamsSnapshot.teams);
        const rosteredIds = [];
        for (const team of teamsSnapshot.teams) {
          for (const player of team.players || []) rosteredIds.push(String(player.player_id || ""));
        }
        let activeAuctions = asArray(parsedPage.active_auctions);
        if (safeStr(auctionKind).toLowerCase() === "expired-rookie") {
          const eligiblePool = buildExpiredRookieEligiblePool(teamsSnapshot, expiredArtifact.ok ? expiredArtifact.data : {}, activeAuctions);
          const eligibleIds = new Set(eligiblePool.map((row) => String(row.player_id || "")));
          activeAuctions = activeAuctions.filter((row) => !row.player_id || eligibleIds.has(String(row.player_id)));
          return {
            ok: true,
            league_id: leagueId,
            season: safeInt(season, Number(season) || 0),
            auction_kind: "expired-rookie",
            eligible_players: eligiblePool,
            active_auctions: activeAuctions,
            extension_markers: expiredArtifact.ok ? asArray(expiredArtifact.data?.extension_rows) : [],
            fetched_at: new Date().toISOString(),
            source_age_seconds: 0,
            stale: !auctionPageRes.ok,
            next_refresh_recommended_ms: 30000,
            native_link: auctionPageRes.pageUrl || `https://www48.myfantasyleague.com/${encodeURIComponent(String(season))}/options?L=${encodeURIComponent(leagueId)}&O=43`,
            upstream: {
              auction_page: { ok: auctionPageRes.ok, status: auctionPageRes.status, url: auctionPageRes.pageUrl || "" },
              expired_artifact: { ok: expiredArtifact.ok, status: expiredArtifact.status, url: expiredArtifact.url || "" },
            },
          };
        }
        const availablePlayers = buildAvailablePlayerBoard(
          auctionArtifact.ok ? auctionArtifact.data?.available_players_seed : [],
          rosteredIds,
          activeAuctions.map((row) => row.player_id),
          75
        );
        return {
          ok: true,
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          auction_kind: "free-agent",
          active_auctions: activeAuctions,
          team_budget_rows: budgetRows,
          team_need_rows: needRows,
          available_players: availablePlayers,
          fetched_at: new Date().toISOString(),
          source_age_seconds: 0,
          stale: !auctionPageRes.ok,
          next_refresh_recommended_ms: 20000,
          native_link: auctionPageRes.pageUrl || `https://www48.myfantasyleague.com/${encodeURIComponent(String(season))}/options?L=${encodeURIComponent(leagueId)}&O=43`,
          viewer_franchise_id: viewerFranchiseId,
          upstream: {
            auction_page: { ok: auctionPageRes.ok, status: auctionPageRes.status, url: auctionPageRes.pageUrl || "" },
            auction_artifact: { ok: auctionArtifact.ok, status: auctionArtifact.status, url: auctionArtifact.url || "" },
          },
        };
      };

      const performRookieDraftAction = async (season, leagueId, body) => {
        const action = safeStr(body?.action).toLowerCase();
        const playerId = String(body?.player_id || body?.playerId || "").replace(/\D/g, "");
        const cmdMap = {
          draft: "DRAFT",
          pause: "PAUSE",
          resume: "RESUME",
          skip: "SKIP",
          undo: "UNDO",
        };
        const cmd = cmdMap[action] || "";
        if (!cmd) {
          return { ok: false, status: 400, error: "unsupported_draft_action" };
        }
        if (cmd === "DRAFT" && !playerId) {
          return { ok: false, status: 400, error: "player_id_required" };
        }
        const base = safeStr(env.MFL_DYNAMIC_BASE_URL || "https://www48.myfantasyleague.com").replace(/\/+$/, "");
        const qs = new URLSearchParams({
          L: String(leagueId || ""),
          JSON: "1",
          CMD: cmd,
        });
        if (playerId) qs.set("PLAYER_PICK", playerId);
        if (safeStr(body?.round)) qs.set("ROUND", safeStr(body.round));
        if (safeStr(body?.pick)) qs.set("PICK", safeStr(body.pick));
        if (safeStr(body?.franchise_pick)) qs.set("FRANCHISE_PICK", safeStr(body.franchise_pick));
        const targetUrl = `${base}/${encodeURIComponent(String(season || YEAR))}/live_draft?${qs.toString()}`;
        let res;
        let text = "";
        try {
          res = await fetch(targetUrl, {
            headers: {
              Cookie: viewerCookieHeader || cookieHeader,
              "User-Agent": "upsmflproduction-worker",
              "Cache-Control": "no-store",
            },
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          text = await res.text();
        } catch (e) {
          return {
            ok: false,
            status: 0,
            error: `draft_action_fetch_failed: ${e?.message || String(e)}`,
            preview: "",
            url: targetUrl,
          };
        }
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch (_) {
          parsed = null;
        }
        const payloadErr = parsed ? mflErrorFromJsonPayload(parsed) : "";
        return {
          ok: res.ok && !payloadErr,
          status: res.status,
          error: payloadErr || (!res.ok ? `draft_action_http_${res.status}` : ""),
          preview: safeStr(text).slice(0, 1200),
          url: targetUrl,
          data: parsed,
        };
      };

      const fetchSalaryRowsByPlayerForAcq = async (season, leagueId) => {
        const salariesRes = await mflExportJsonWithRetryAsViewer(season, leagueId, "salaries", {}, { useCookie: true });
        return {
          ok: salariesRes.ok,
          rowsByPlayer: salariesRes.ok ? parseSalaryExportRowsAcq(salariesRes.data) : {},
          status: salariesRes.status,
          url: salariesRes.url,
          error: salariesRes.error || "",
        };
      };

      const applyRookieContractForDraftPickAcq = async ({
        season,
        leagueId,
        liveRow,
        fallbackRound,
        fallbackPick,
        rookieArtifactData,
        existingSalaryRowsByPlayer,
      }) => {
        const playerId = safeStr(liveRow?.player_id);
        if (!playerId) {
          return {
            ok: false,
            skipped: true,
            reason: "player_id_missing",
            status_label: "Missing player id for rookie contract import.",
          };
        }
        const currentSalaryRowsByPlayer = existingSalaryRowsByPlayer || (await fetchSalaryRowsByPlayerForAcq(season, leagueId)).rowsByPlayer || {};
        const current = currentSalaryRowsByPlayer[playerId] || null;
        if (
          current &&
          rookieContractStatusLikeAcq(current.contractStatus) &&
          safeInt(current.contractYear, 0) > 0 &&
          safeInt(current.salary, 0) > 0
        ) {
          return {
            ok: true,
            skipped: true,
            reason: "rookie_contract_already_present",
            status_label: "Rookie contract already present.",
            current_contract: current,
          };
        }
        let artifactData = rookieArtifactData || null;
        if (!artifactData) {
          const rookieArtifact = await fetchArtifactJson("rookie_draft_history");
          artifactData = rookieArtifact.ok ? rookieArtifact.data || {} : {};
        }
        const plan = buildRookieContractPlanAcq({
          season,
          round: safeInt(liveRow?.round, fallbackRound),
          pickInRound: safeInt(liveRow?.pick_in_round, fallbackPick),
          position: safeStr(liveRow?.position),
          rookieArtifactData: artifactData,
        });
        const importRes = await importContractUpdateAcq({
          leagueId,
          season,
          playerId,
          salary: plan.salary,
          contractYear: plan.contract_year,
          contractStatus: plan.contract_status,
          contractInfo: plan.contract_info,
        });
        if (!importRes.ok) {
          return {
            ok: false,
            skipped: false,
            reason: "contract_import_failed",
            status_label: "Rookie contract import failed.",
            plan,
            upstreamStatus: importRes.upstreamStatus,
            upstreamPreview: importRes.upstreamPreview,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        const verifyRes = await fetchSalaryRowsByPlayerForAcq(season, leagueId);
        const verified = verifyRes.rowsByPlayer[playerId] || null;
        const verifiedOk =
          !!verified &&
          rookieContractStatusLikeAcq(verified.contractStatus) &&
          safeInt(verified.contractYear, 0) === safeInt(plan.contract_year, 0);
        return {
          ok: verifiedOk,
          skipped: false,
          reason: verifiedOk ? "" : "contract_verification_failed",
          status_label: verifiedOk ? "Rookie contract applied." : "Rookie contract import submitted; verification pending.",
          plan,
          verify_row: verified,
          upstreamStatus: importRes.upstreamStatus,
          upstreamPreview: importRes.upstreamPreview,
        };
      };

      const reconcileRookieDraftContractsAcq = async (season, leagueId) => {
        const [live, rookieArtifact, salaryRes] = await Promise.all([
          buildRookieDraftLivePayload(season, leagueId),
          fetchArtifactJson("rookie_draft_history"),
          fetchSalaryRowsByPlayerForAcq(season, leagueId),
        ]);
        const liveBoard = asArray(live?.live_board);
        const rookieArtifactData = rookieArtifact.ok ? rookieArtifact.data || {} : {};
        const rowsByPlayer = salaryRes.rowsByPlayer || {};
        const missingRows = liveBoard.filter((row) => {
          const current = rowsByPlayer[safeStr(row?.player_id)] || null;
          return !(current && rookieContractStatusLikeAcq(current.contractStatus) && safeInt(current.contractYear, 0) > 0);
        });
        const results = [];
        for (const row of missingRows) {
          const result = await applyRookieContractForDraftPickAcq({
            season,
            leagueId,
            liveRow: row,
            rookieArtifactData,
            existingSalaryRowsByPlayer: rowsByPlayer,
          });
          results.push({
            player_id: safeStr(row?.player_id),
            player_name: safeStr(row?.player_name),
            pick_label: `${safeInt(row?.round, 0)}.${String(safeInt(row?.pick_in_round, 0)).padStart(2, "0")}`,
            ...result,
          });
          if (result && result.ok && !result.skipped) {
            rowsByPlayer[safeStr(row?.player_id)] = {
              player_id: safeStr(row?.player_id),
              salary: safeInt(result?.plan?.salary, 0),
              contractYear: safeInt(result?.plan?.contract_year, 0),
              contractStatus: safeStr(result?.plan?.contract_status),
              contractInfo: safeStr(result?.plan?.contract_info),
            };
          }
        }
        return {
          ok: results.every((row) => !!row.ok || !!row.skipped),
          attempted_count: missingRows.length,
          applied_count: results.filter((row) => !!row.ok && !row.skipped).length,
          skipped_count: results.filter((row) => !!row.skipped).length,
          results,
          live,
        };
      };

      const performAuctionAction = async (season, leagueId, body, fallbackKind) => {
        const normalized = normalizeAuctionActionRequest(body, fallbackKind);
        if (normalized.action !== "bid" && normalized.action !== "nominate") {
          return { ok: false, status: 400, error: "unsupported_auction_action" };
        }
        if (!normalized.player_id) return { ok: false, status: 400, error: "player_id_required" };
        if (safeInt(normalized.amount, 0) <= 0) return { ok: false, status: 400, error: "amount_required" };
        const viewerFranchiseId = await resolveViewerFranchiseIdForAcq(season, leagueId, normalized.franchise_id);
        const pageRes = await fetchAuctionPageForCookie(viewerCookieHeader || cookieHeader, season, leagueId, viewerFranchiseId);
        if (!pageRes.ok) {
          return {
            ok: false,
            status: 502,
            error: pageRes.unauthorized ? "auction_auth_required" : "auction_page_unavailable",
            preview: safeStr(pageRes.html).slice(0, 800),
            native_link: pageRes.pageUrl,
          };
        }
        const parsedPage = parseAuctionPage(pageRes.html, pageRes.url || pageRes.pageUrl);
        const preparedForm = auctionActionFormFromPage(parsedPage, normalized);
        if (!preparedForm) {
          return {
            ok: false,
            status: 422,
            error: "auction_form_contract_not_found",
            preview: safeStr(pageRes.html).slice(0, 800),
            native_link: pageRes.pageUrl,
          };
        }
        const postRes = await postAuctionActionForCookie(viewerCookieHeader || cookieHeader, preparedForm);
        return {
          ...postRes,
          native_link: pageRes.pageUrl,
        };
      };

      const githubRepoOwner = String(env.GITHUB_REPO_OWNER || "keithcreelman").trim();
      const githubRepoName = String(env.GITHUB_REPO_NAME || "upsmflproduction").trim();
      const githubPat = String(env.GITHUB_PAT || "").trim();
      const githubApiBase =
        `https://api.github.com/repos/${encodeURIComponent(githubRepoOwner)}` +
        `/${encodeURIComponent(githubRepoName)}`;

      const utf8ToBase64 = (text) => {
        const bytes = new TextEncoder().encode(String(text || ""));
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
      };

      const base64ToUtf8 = (b64) => {
        const clean = String(b64 || "").replace(/\s/g, "");
        const binary = atob(clean);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return new TextDecoder().decode(bytes);
      };

      const githubApiRequest = async (method, apiPath, body) => {
        if (!githubPat) {
          return { ok: false, status: 0, error: "Missing GITHUB_PAT worker secret", data: null, textPreview: "" };
        }
        const target = apiPath.startsWith("http") ? apiPath : `${githubApiBase}${apiPath}`;
        let res;
        let text = "";
        try {
          res = await fetch(target, {
            method,
            headers: {
              Authorization: `Bearer ${githubPat}`,
              Accept: "application/vnd.github+json",
              "Content-Type": "application/json",
              "User-Agent": "upsmflproduction-worker",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            body: body == null ? undefined : JSON.stringify(body),
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          text = await res.text();
        } catch (e) {
          return {
            ok: false,
            status: 0,
            error: `fetch_failed: ${e?.message || String(e)}`,
            data: null,
            textPreview: "",
            url: target,
          };
        }
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (_) {
          data = null;
        }
        const textPreview = String(text || "").slice(0, 600);
        const textLine = textPreview
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 180);
        return {
          ok: !!res.ok,
          status: res.status,
          data,
          textPreview,
          url: target,
          error: res.ok
            ? ""
            : (data?.message || (textLine ? `HTTP ${res.status}: ${textLine}` : `HTTP ${res.status}`)),
        };
      };

      const tradeOffersFilePath = (leagueId, season) =>
        `site/trades/trade_offers_${encodeURIComponent(String(leagueId || ""))}_${encodeURIComponent(
          String(season || "")
        )}.json`;

      const emptyTradeOffersDoc = (leagueId, season) => ({
        meta: {
          schema_version: 1,
          league_id: String(leagueId || ""),
          season: Number(season || 0) || 0,
          updated_at: new Date().toISOString(),
          row_count: 0,
          source: "worker-trade-offers",
        },
        offers: [],
      });

      const normalizeTradeOffersDoc = (raw, leagueId, season) => {
        const doc = raw && typeof raw === "object" ? raw : {};
        const out = emptyTradeOffersDoc(leagueId, season);
        out.meta = {
          ...out.meta,
          ...(doc.meta && typeof doc.meta === "object" ? doc.meta : {}),
          league_id: String(leagueId || ""),
          season: Number(season || 0) || 0,
        };
        out.offers = Array.isArray(doc.offers) ? doc.offers.filter(Boolean) : [];
        out.meta.row_count = out.offers.length;
        return out;
      };

      const readTradeOffersDoc = async (leagueId, season) => {
        const filePath = tradeOffersFilePath(leagueId, season);
        if (!githubPat) {
          const publicUrl = `https://cdn.jsdelivr.net/gh/${encodeURIComponent(githubRepoOwner)}/${encodeURIComponent(
            githubRepoName
          )}@main/${filePath}`;
          try {
            const res = await fetch(publicUrl, {
              headers: { "Cache-Control": "no-store" },
              cf: { cacheTtl: 0, cacheEverything: false },
            });
            if (!res.ok) {
              if (res.status === 404) {
                return { ok: true, exists: false, sha: "", filePath, doc: emptyTradeOffersDoc(leagueId, season) };
              }
              return { ok: false, exists: false, sha: "", filePath, error: `HTTP ${res.status}` };
            }
            const payload = await res.json();
            return {
              ok: true,
              exists: true,
              sha: "",
              filePath,
              doc: normalizeTradeOffersDoc(payload, leagueId, season),
            };
          } catch (e) {
            return { ok: false, exists: false, sha: "", filePath, error: `fetch_failed: ${e?.message || String(e)}` };
          }
        }

        const apiRes = await githubApiRequest(
          "GET",
          `/contents/${filePath}?ref=${encodeURIComponent(String(env.GITHUB_REPO_BRANCH || "main").trim() || "main")}`
        );
        if (!apiRes.ok && apiRes.status === 404) {
          return { ok: true, exists: false, sha: "", filePath, doc: emptyTradeOffersDoc(leagueId, season) };
        }
        if (!apiRes.ok) {
          return {
            ok: false,
            exists: false,
            sha: "",
            filePath,
            error: apiRes.error || "GitHub contents GET failed",
            upstreamStatus: apiRes.status,
            upstreamPreview: apiRes.textPreview,
          };
        }
        try {
          const rawContent = base64ToUtf8(apiRes.data?.content || "");
          const parsed = rawContent ? JSON.parse(rawContent) : {};
          return {
            ok: true,
            exists: true,
            sha: String(apiRes.data?.sha || ""),
            filePath,
            doc: normalizeTradeOffersDoc(parsed, leagueId, season),
          };
        } catch (e) {
          return { ok: false, exists: true, sha: "", filePath, error: `parse_failed: ${e?.message || String(e)}` };
        }
      };

      const writeTradeOffersDoc = async (leagueId, season, doc, prevSha, message) => {
        const filePath = tradeOffersFilePath(leagueId, season);
        if (!githubPat) {
          return { ok: false, error: "Missing GITHUB_PAT worker secret", filePath };
        }
        const normalized = normalizeTradeOffersDoc(doc, leagueId, season);
        normalized.meta.updated_at = new Date().toISOString();
        normalized.meta.row_count = Array.isArray(normalized.offers) ? normalized.offers.length : 0;
        const body = {
          message: String(message || "Update trade offers queue"),
          content: utf8ToBase64(JSON.stringify(normalized, null, 2) + "\n"),
          branch: String(env.GITHUB_REPO_BRANCH || "main").trim() || "main",
        };
        if (prevSha) body.sha = String(prevSha);
        const apiRes = await githubApiRequest("PUT", `/contents/${filePath}`, body);
        if (!apiRes.ok) {
          return {
            ok: false,
            error: apiRes.error || "GitHub contents PUT failed",
            upstreamStatus: apiRes.status,
            upstreamPreview: apiRes.textPreview,
            filePath,
          };
        }
        return {
          ok: true,
          filePath,
          commitSha: String(apiRes.data?.commit?.sha || ""),
          contentSha: String(apiRes.data?.content?.sha || ""),
          doc: normalized,
        };
      };

      const tradeOutboxFilePath = (leagueId, season) =>
        `site/trades/trade_outbox_${encodeURIComponent(String(leagueId || ""))}_${encodeURIComponent(
          String(season || "")
        )}.json`;

      const emptyTradeOutboxDoc = (leagueId, season) => ({
        meta: {
          schema_version: 1,
          league_id: String(leagueId || ""),
          season: Number(season || 0) || 0,
          updated_at: new Date().toISOString(),
          row_count: 0,
          source: "worker-trade-outbox",
        },
        rows: [],
      });

      const normalizeTradeOutboxDoc = (raw, leagueId, season) => {
        const doc = raw && typeof raw === "object" ? raw : {};
        const out = emptyTradeOutboxDoc(leagueId, season);
        out.meta = {
          ...out.meta,
          ...(doc.meta && typeof doc.meta === "object" ? doc.meta : {}),
          league_id: String(leagueId || ""),
          season: Number(season || 0) || 0,
        };
        out.rows = Array.isArray(doc.rows) ? doc.rows.filter(Boolean) : [];
        out.meta.row_count = out.rows.length;
        return out;
      };

      const readTradeOutboxDoc = async (leagueId, season) => {
        const filePath = tradeOutboxFilePath(leagueId, season);
        if (!githubPat) {
          const publicUrl = `https://cdn.jsdelivr.net/gh/${encodeURIComponent(githubRepoOwner)}/${encodeURIComponent(
            githubRepoName
          )}@main/${filePath}`;
          try {
            const res = await fetch(publicUrl, {
              headers: { "Cache-Control": "no-store" },
              cf: { cacheTtl: 0, cacheEverything: false },
            });
            if (!res.ok) {
              if (res.status === 404) {
                return { ok: true, exists: false, sha: "", filePath, doc: emptyTradeOutboxDoc(leagueId, season) };
              }
              return { ok: false, exists: false, sha: "", filePath, error: `HTTP ${res.status}` };
            }
            const payload = await res.json();
            return {
              ok: true,
              exists: true,
              sha: "",
              filePath,
              doc: normalizeTradeOutboxDoc(payload, leagueId, season),
            };
          } catch (e) {
            return { ok: false, exists: false, sha: "", filePath, error: `fetch_failed: ${e?.message || String(e)}` };
          }
        }

        const apiRes = await githubApiRequest(
          "GET",
          `/contents/${filePath}?ref=${encodeURIComponent(String(env.GITHUB_REPO_BRANCH || "main").trim() || "main")}`
        );
        if (!apiRes.ok && apiRes.status === 404) {
          return { ok: true, exists: false, sha: "", filePath, doc: emptyTradeOutboxDoc(leagueId, season) };
        }
        if (!apiRes.ok) {
          return {
            ok: false,
            exists: false,
            sha: "",
            filePath,
            error: apiRes.error || "GitHub contents GET failed",
            upstreamStatus: apiRes.status,
            upstreamPreview: apiRes.textPreview,
          };
        }
        try {
          const rawContent = base64ToUtf8(apiRes.data?.content || "");
          const parsed = rawContent ? JSON.parse(rawContent) : {};
          return {
            ok: true,
            exists: true,
            sha: String(apiRes.data?.sha || ""),
            filePath,
            doc: normalizeTradeOutboxDoc(parsed, leagueId, season),
          };
        } catch (e) {
          return { ok: false, exists: true, sha: "", filePath, error: `parse_failed: ${e?.message || String(e)}` };
        }
      };

      const writeTradeOutboxDoc = async (leagueId, season, doc, prevSha, message) => {
        const filePath = tradeOutboxFilePath(leagueId, season);
        if (!githubPat) {
          return { ok: false, error: "Missing GITHUB_PAT worker secret", filePath };
        }
        const normalized = normalizeTradeOutboxDoc(doc, leagueId, season);
        normalized.meta.updated_at = new Date().toISOString();
        normalized.meta.row_count = Array.isArray(normalized.rows) ? normalized.rows.length : 0;
        const body = {
          message: String(message || "Update trade outbox"),
          content: utf8ToBase64(JSON.stringify(normalized, null, 2) + "\n"),
          branch: String(env.GITHUB_REPO_BRANCH || "main").trim() || "main",
        };
        if (prevSha) body.sha = String(prevSha);
        const apiRes = await githubApiRequest("PUT", `/contents/${filePath}`, body);
        if (!apiRes.ok) {
          return {
            ok: false,
            error: apiRes.error || "GitHub contents PUT failed",
            upstreamStatus: apiRes.status,
            upstreamPreview: apiRes.textPreview,
            filePath,
          };
        }
        return {
          ok: true,
          filePath,
          commitSha: String(apiRes.data?.commit?.sha || ""),
          contentSha: String(apiRes.data?.content?.sha || ""),
          doc: normalized,
        };
      };

      const bugReportsFilePath = (leagueId, season) =>
        `site/reports/bug_reports_${encodeURIComponent(String(leagueId || ""))}_${encodeURIComponent(
          String(season || "")
        )}.json`;

      const emptyBugReportsDoc = (leagueId, season) => ({
        meta: {
          schema_version: 1,
          league_id: String(leagueId || ""),
          season: Number(season || 0) || 0,
          updated_at: new Date().toISOString(),
          row_count: 0,
          source: "worker-bug-reports",
        },
        reports: [],
      });

      const BUG_STATUS_VALUES = new Set([
        "OPEN",
        "INVESTIGATING",
        "WAITING_ON_COMMISH",
        "APPROVED_TO_FIX",
        "DECLINED",
        "CLOSED_RESOLVED",
      ]);

      const normalizeBugStatus = (value, fallback = "OPEN") => {
        const normalized = safeStr(value || fallback).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
        if (BUG_STATUS_VALUES.has(normalized)) return normalized;
        return BUG_STATUS_VALUES.has(fallback) ? fallback : "OPEN";
      };

      const normalizeBugReportRow = (raw, leagueId, season) => {
        const row = raw && typeof raw === "object" ? raw : {};
        return {
          ...row,
          bug_id: safeStr(row.bug_id || row.report_id || ""),
          league_id: safeStr(row.league_id || leagueId || ""),
          season: safeStr(row.season || season || ""),
          franchise_id: safeStr(row.franchise_id || ""),
          franchise_name: safeStr(row.franchise_name || ""),
          mfl_user_id: safeStr(row.mfl_user_id || ""),
          module: safeStr(row.module || ""),
          issue_type: safeStr(row.issue_type || ""),
          request_kind: safeStr(row.request_kind || row.requestKind || "bug-report"),
          commish_enhancement: !!safeInt(
            row.commish_enhancement || row.commishEnhancement || row.is_commish_enhancement || 0
          ),
          submitted_by_label: safeStr(row.submitted_by_label || row.submitter_label || ""),
          submitted_by_mfl_user_id: safeStr(row.submitted_by_mfl_user_id || row.mfl_user_id || ""),
          details: safeStr(row.details || ""),
          steps_to_reproduce: safeStr(row.steps_to_reproduce || ""),
          expected_vs_actual: safeStr(row.expected_vs_actual || ""),
          attachments: Array.isArray(row.attachments) ? row.attachments.filter(Boolean) : [],
          source: safeStr(row.source || ""),
          status: normalizeBugStatus(row.status || "OPEN"),
          issue_sequence: Math.max(0, safeInt(row.issue_sequence || row.issueSequence, 0)),
          thread_id: safeStr(row.thread_id || row.discord_thread_id || ""),
          thread_root_message_id: safeStr(row.thread_root_message_id || row.message_id || ""),
          thread_name: safeStr(row.thread_name || ""),
          status_updated_at_utc: safeStr(row.status_updated_at_utc || ""),
          status_updated_by: safeStr(row.status_updated_by || ""),
          triage_summary: safeStr(row.triage_summary || ""),
          triage_updated_at_utc: safeStr(row.triage_updated_at_utc || ""),
          triage_updated_by: safeStr(row.triage_updated_by || ""),
          approval_state: safeStr(row.approval_state || ""),
          approval_requested_at_utc: safeStr(row.approval_requested_at_utc || ""),
          approval_received_at_utc: safeStr(row.approval_received_at_utc || ""),
          approval_decision_by: safeStr(row.approval_decision_by || ""),
          last_discord_sync_error: safeStr(row.last_discord_sync_error || ""),
          last_discord_sync_at_utc: safeStr(row.last_discord_sync_at_utc || ""),
          context: row.context && typeof row.context === "object" ? row.context : {},
          created_at_utc: safeStr(row.created_at_utc || ""),
        };
      };

      const normalizeBugReportsDoc = (raw, leagueId, season) => {
        const doc = raw && typeof raw === "object" ? raw : {};
        const out = emptyBugReportsDoc(leagueId, season);
        out.meta = {
          ...out.meta,
          ...(doc.meta && typeof doc.meta === "object" ? doc.meta : {}),
          league_id: String(leagueId || ""),
          season: Number(season || 0) || 0,
        };
        const seqByKey = new Map();
        out.reports = Array.isArray(doc.reports)
          ? doc.reports
              .filter(Boolean)
              .map((row) => normalizeBugReportRow(row, leagueId, season))
              .map((row) => {
                const key = [
                  safeStr(row.season || season || ""),
                  safeStr(row.module || ""),
                  safeStr(row.issue_type || ""),
                ].join("|");
                const seen = Math.max(0, safeInt(seqByKey.get(key), 0));
                const provided = Math.max(0, safeInt(row.issue_sequence, 0));
                const next = provided > 0 ? provided : seen + 1;
                seqByKey.set(key, Math.max(seen, next));
                return {
                  ...row,
                  issue_sequence: next,
                  status_updated_at_utc: safeStr(row.status_updated_at_utc || row.created_at_utc || ""),
                };
              })
          : [];
        out.meta.row_count = out.reports.length;
        return out;
      };

      const readBugReportsDoc = async (leagueId, season) => {
        const filePath = bugReportsFilePath(leagueId, season);
        if (!githubPat) {
          const publicUrl = `https://cdn.jsdelivr.net/gh/${encodeURIComponent(githubRepoOwner)}/${encodeURIComponent(
            githubRepoName
          )}@main/${filePath}`;
          try {
            const res = await fetch(publicUrl, {
              headers: { "Cache-Control": "no-store" },
              cf: { cacheTtl: 0, cacheEverything: false },
            });
            if (!res.ok) {
              if (res.status === 404) {
                return { ok: true, exists: false, sha: "", filePath, doc: emptyBugReportsDoc(leagueId, season) };
              }
              return { ok: false, exists: false, sha: "", filePath, error: `HTTP ${res.status}` };
            }
            const payload = await res.json();
            return {
              ok: true,
              exists: true,
              sha: "",
              filePath,
              doc: normalizeBugReportsDoc(payload, leagueId, season),
            };
          } catch (e) {
            return { ok: false, exists: false, sha: "", filePath, error: `fetch_failed: ${e?.message || String(e)}` };
          }
        }

        const apiRes = await githubApiRequest(
          "GET",
          `/contents/${filePath}?ref=${encodeURIComponent(String(env.GITHUB_REPO_BRANCH || "main").trim() || "main")}`
        );
        if (!apiRes.ok && apiRes.status === 404) {
          return { ok: true, exists: false, sha: "", filePath, doc: emptyBugReportsDoc(leagueId, season) };
        }
        if (!apiRes.ok) {
          return {
            ok: false,
            exists: false,
            sha: "",
            filePath,
            error: apiRes.error || "GitHub contents GET failed",
            upstreamStatus: apiRes.status,
            upstreamPreview: apiRes.textPreview,
          };
        }
        try {
          const rawContent = base64ToUtf8(apiRes.data?.content || "");
          const parsed = rawContent ? JSON.parse(rawContent) : {};
          return {
            ok: true,
            exists: true,
            sha: String(apiRes.data?.sha || ""),
            filePath,
            doc: normalizeBugReportsDoc(parsed, leagueId, season),
          };
        } catch (e) {
          return { ok: false, exists: true, sha: "", filePath, error: `parse_failed: ${e?.message || String(e)}` };
        }
      };

      const writeBugReportsDoc = async (leagueId, season, doc, prevSha, message) => {
        const filePath = bugReportsFilePath(leagueId, season);
        if (!githubPat) {
          return { ok: false, error: "Missing GITHUB_PAT worker secret", filePath };
        }
        const normalized = normalizeBugReportsDoc(doc, leagueId, season);
        normalized.meta.updated_at = new Date().toISOString();
        normalized.meta.row_count = Array.isArray(normalized.reports) ? normalized.reports.length : 0;
        const body = {
          message: String(message || "Append bug report"),
          content: utf8ToBase64(JSON.stringify(normalized, null, 2) + "\n"),
          branch: String(env.GITHUB_REPO_BRANCH || "main").trim() || "main",
        };
        if (prevSha) body.sha = String(prevSha);
        const apiRes = await githubApiRequest("PUT", `/contents/${filePath}`, body);
        if (!apiRes.ok) {
          return {
            ok: false,
            error: apiRes.error || "GitHub contents PUT failed",
            upstreamStatus: apiRes.status,
            upstreamPreview: apiRes.textPreview,
            filePath,
          };
        }
        return {
          ok: true,
          filePath,
          commitSha: String(apiRes.data?.commit?.sha || ""),
          contentSha: String(apiRes.data?.content?.sha || ""),
          doc: normalized,
        };
      };

      const deadlineReminderFilePath = (season) =>
        `site/rosters/contract_submissions/deadline_reminders_${encodeURIComponent(
          String(season || "")
        )}.json`;

      const emptyDeadlineRemindersDoc = (season) => ({
        meta: {
          schema_version: 1,
          season: Number(season || 0) || 0,
          updated_at: new Date().toISOString(),
          row_count: 0,
          source: "worker-deadline-reminders",
        },
        reminders: [],
      });

      const normalizeDeadlineRemindersDoc = (raw, season) => {
        const doc = raw && typeof raw === "object" ? raw : {};
        const out = emptyDeadlineRemindersDoc(season);
        out.meta = {
          ...out.meta,
          ...(doc.meta && typeof doc.meta === "object" ? doc.meta : {}),
          season: Number(season || 0) || 0,
        };
        out.reminders = Array.isArray(doc.reminders)
          ? doc.reminders.filter((row) => row && typeof row === "object")
          : [];
        out.meta.row_count = out.reminders.length;
        return out;
      };

      const readDeadlineRemindersDoc = async (season) => {
        const filePath = deadlineReminderFilePath(season);
        if (!githubPat) {
          const publicUrl = `https://cdn.jsdelivr.net/gh/${encodeURIComponent(githubRepoOwner)}/${encodeURIComponent(
            githubRepoName
          )}@main/${filePath}`;
          try {
            const res = await fetch(publicUrl, {
              headers: { "Cache-Control": "no-store" },
              cf: { cacheTtl: 0, cacheEverything: false },
            });
            if (!res.ok) {
              if (res.status === 404) {
                return { ok: true, exists: false, sha: "", filePath, doc: emptyDeadlineRemindersDoc(season) };
              }
              return { ok: false, exists: false, sha: "", filePath, error: `HTTP ${res.status}` };
            }
            const payload = await res.json();
            return {
              ok: true,
              exists: true,
              sha: "",
              filePath,
              doc: normalizeDeadlineRemindersDoc(payload, season),
            };
          } catch (e) {
            return { ok: false, exists: false, sha: "", filePath, error: `fetch_failed: ${e?.message || String(e)}` };
          }
        }

        const apiRes = await githubApiRequest(
          "GET",
          `/contents/${filePath}?ref=${encodeURIComponent(String(env.GITHUB_REPO_BRANCH || "main").trim() || "main")}`
        );
        if (!apiRes.ok && apiRes.status === 404) {
          return { ok: true, exists: false, sha: "", filePath, doc: emptyDeadlineRemindersDoc(season) };
        }
        if (!apiRes.ok) {
          return {
            ok: false,
            exists: false,
            sha: "",
            filePath,
            error: apiRes.error || "GitHub contents GET failed",
            upstreamStatus: apiRes.status,
            upstreamPreview: apiRes.textPreview,
          };
        }
        try {
          const rawContent = base64ToUtf8(apiRes.data?.content || "");
          const parsed = rawContent ? JSON.parse(rawContent) : {};
          return {
            ok: true,
            exists: true,
            sha: String(apiRes.data?.sha || ""),
            filePath,
            doc: normalizeDeadlineRemindersDoc(parsed, season),
          };
        } catch (e) {
          return { ok: false, exists: true, sha: "", filePath, error: `parse_failed: ${e?.message || String(e)}` };
        }
      };

      const writeDeadlineRemindersDoc = async (season, doc, prevSha, message) => {
        const filePath = deadlineReminderFilePath(season);
        if (!githubPat) {
          return { ok: false, error: "Missing GITHUB_PAT worker secret", filePath };
        }
        const normalized = normalizeDeadlineRemindersDoc(doc, season);
        normalized.meta.updated_at = new Date().toISOString();
        normalized.meta.row_count = Array.isArray(normalized.reminders) ? normalized.reminders.length : 0;
        const body = {
          message: String(message || "Log deadline reminder"),
          content: utf8ToBase64(JSON.stringify(normalized, null, 2) + "\n"),
          branch: String(env.GITHUB_REPO_BRANCH || "main").trim() || "main",
        };
        if (prevSha) body.sha = String(prevSha);
        const apiRes = await githubApiRequest("PUT", `/contents/${filePath}`, body);
        if (!apiRes.ok) {
          return {
            ok: false,
            error: apiRes.error || "GitHub contents PUT failed",
            upstreamStatus: apiRes.status,
            upstreamPreview: apiRes.textPreview,
            filePath,
          };
        }
        return {
          ok: true,
          filePath,
          commitSha: String(apiRes.data?.commit?.sha || ""),
          contentSha: String(apiRes.data?.content?.sha || ""),
          doc: normalized,
        };
      };

      const humanizeBugToken = (value, fallback = "Other") => {
        const raw = safeStr(value || "");
        if (!raw) return fallback;
        const words = raw
          .replace(/[_-]+/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .split(" ")
          .filter(Boolean)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1));
        return words.length ? words.join(" ") : fallback;
      };

      const formatBugSubmittedAt = (value) => {
        const raw = safeStr(value || "");
        if (!raw) return "Unknown";
        try {
          const dt = new Date(raw);
          if (!Number.isFinite(dt.getTime())) return raw;
          return dt.toLocaleString("en-US", {
            timeZone: "America/New_York",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
          });
        } catch (_) {
          return raw;
        }
      };

      const formatBugSubmitterLabel = (reportRow) => {
        const row = reportRow && typeof reportRow === "object" ? reportRow : {};
        const franchiseName = safeStr(row.franchise_name || (row.context && row.context.franchise_name) || "");
        const franchiseId = safeStr(row.franchise_id || "");
        const submittedByLabel = safeStr(row.submitted_by_label || (row.context && row.context.submitted_by_label) || "");
        const cleanedSubmittedByLabel = submittedByLabel
          .split("|")
          .map((part) => safeStr(part))
          .filter((part) => part && !/commish enhancement/i.test(part))
          .join(" | ");
        const primary =
          franchiseName && !/^unknown$/i.test(franchiseName)
            ? franchiseName
            : cleanedSubmittedByLabel
              ? cleanedSubmittedByLabel
              : franchiseId
                ? `Franchise ${franchiseId}`
                : "Unknown";
        return `${primary}${row.commish_enhancement ? " - Commish" : ""}`;
      };

      const bugThreadStatusLabel = (status) => {
        const normalized = normalizeBugStatus(status || "OPEN");
        if (normalized === "CLOSED_RESOLVED") return "Closed Resolved";
        if (normalized === "WAITING_ON_COMMISH") return "Waiting On Commish";
        if (normalized === "APPROVED_TO_FIX") return "Approved To Fix";
        if (normalized === "INVESTIGATING") return "Investigating";
        if (normalized === "DECLINED") return "Declined";
        return "Open Issue";
      };

      const formatBugDiscordMessage = (reportRow) => {
        const row = reportRow && typeof reportRow === "object" ? reportRow : {};
        const details = safeStr(row.details || "").replace(/\s+/g, " ").slice(0, 1200);
        const moduleName = humanizeBugToken(row.module, "Other");
        const issueType = humanizeBugToken(row.issue_type, "Other");
        const submittedBy = formatBugSubmitterLabel(row);
        const submittedAt = formatBugSubmittedAt(row.created_at_utc || row.status_updated_at_utc || "");
        const lines = [
          `**Submitted By:** ${submittedBy}`,
          "",
          `**Date Submitted:** ${submittedAt}`,
          "",
          `**Module:** ${moduleName} | **Type:** ${issueType}`,
          "",
          `**Details:** ${details || "No details provided."}`,
        ].filter(Boolean);
        let content = lines.join("\n");
        if (content.length > 1900) content = content.slice(0, 1897) + "...";
        return content;
      };

      const buildBugThreadName = (reportRow, statusOverride = "") => {
        const row = reportRow && typeof reportRow === "object" ? reportRow : {};
        const moduleLabel = humanizeBugToken(row.module, "Other");
        const issueLabel = humanizeBugToken(row.issue_type, "Other");
        const statusLabel = bugThreadStatusLabel(statusOverride || row.status || "OPEN");
        let name = `Bug Module ${moduleLabel} Issue ${issueLabel} ${statusLabel}`;
        if (name.length > 100) name = name.slice(0, 100);
        return name;
      };

      const decodeDataUrlAttachment = (row, idx) => {
        const dataUrl = safeStr(row && row.data_url);
        const m = dataUrl.match(/^data:([^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/i);
        if (!m) return null;
        const mime = safeStr(m[1] || row.type || "image/jpeg");
        const b64 = safeStr(m[2]).replace(/\s+/g, "");
        if (!b64) return null;
        let bin = "";
        try {
          bin = atob(b64);
        } catch (_) {
          return null;
        }
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
        const fallbackName = `screenshot-${idx + 1}.${ext}`;
        const name = safeStr(row && row.name).slice(0, 120) || fallbackName;
        return {
          name,
          mime: mime || "application/octet-stream",
          bytes,
        };
      };

      const buildDiscordAttachmentFiles = (reportRow) => {
        const rows = Array.isArray(reportRow && reportRow.attachments) ? reportRow.attachments : [];
        const out = [];
        for (let i = 0; i < rows.length; i += 1) {
          const decoded = decodeDataUrlAttachment(rows[i], i);
          if (!decoded) continue;
          out.push(decoded);
          if (out.length >= 6) break;
        }
        return out;
      };

      const bugDiscordBotToken = () =>
        safeStr(env.DISCORD_BOT_TOKEN || env.DISCORD_BOT || env.Discord_bot || "");

      const bugDiscordPrimaryChannelId = () => safeStr(env.DISCORD_BUG_CHANNEL_ID || "").replace(/\D/g, "");

      const bugDiscordTestChannelId = () => safeStr(env.DISCORD_BUG_TEST_CHANNEL_ID || "").replace(/\D/g, "");

      const bugDiscordChannelTarget = (reportRow) => {
        const row = reportRow && typeof reportRow === "object" ? reportRow : {};
        const deliveryTarget = safeStr(row.delivery_target || row.deliveryTarget || "").toLowerCase();
        if (deliveryTarget === "test") {
          const channelId = bugDiscordTestChannelId();
          return {
            channelId,
            deliveryTarget: "test",
            missingError: channelId ? "" : "missing_discord_bug_test_channel_config",
          };
        }
        const channelId = bugDiscordPrimaryChannelId();
        return {
          channelId,
          deliveryTarget: "primary",
          missingError: channelId ? "" : "missing_discord_bug_thread_config",
        };
      };

      const discordBotRequest = async (botToken, method, apiPath, body) => {
        const target = `https://discord.com/api/v10${apiPath}`;
        try {
          const res = await fetch(target, {
            method,
            headers: {
              Authorization: `Bot ${botToken}`,
              "Content-Type": "application/json",
            },
            body: body == null ? undefined : JSON.stringify(body),
          });
          const text = await res.text();
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (_) {
            data = null;
          }
          return { ok: res.ok, status: res.status, data, text };
        } catch (e) {
          return { ok: false, status: 0, data: null, text: `fetch_failed: ${e?.message || String(e)}` };
        }
      };

      const discordBotRequestWithFiles = async (botToken, apiPath, content, files) => {
        if (!Array.isArray(files) || !files.length) {
          return discordBotRequest(botToken, "POST", apiPath, {
            content,
            allowed_mentions: { parse: [] },
          });
        }
        const target = `https://discord.com/api/v10${apiPath}`;
        try {
          const form = new FormData();
          form.append(
            "payload_json",
            JSON.stringify({
              content,
              allowed_mentions: { parse: [] },
            })
          );
          for (let i = 0; i < files.length; i += 1) {
            const f = files[i];
            form.append(
              `files[${i}]`,
              new Blob([f.bytes], { type: f.mime || "application/octet-stream" }),
              f.name || `screenshot-${i + 1}.jpg`
            );
          }
          const res = await fetch(target, {
            method: "POST",
            headers: { Authorization: `Bot ${botToken}` },
            body: form,
          });
          const text = await res.text();
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (_) {
            data = null;
          }
          return { ok: res.ok, status: res.status, data, text };
        } catch (e) {
          return { ok: false, status: 0, data: null, text: `fetch_failed: ${e?.message || String(e)}` };
        }
      };

      const openDiscordDmChannel = async (botToken, userId) => {
        const targetUserId = safeStr(userId).replace(/\D/g, "");
        if (!botToken || !targetUserId) {
          return {
            ok: false,
            status: 0,
            channel_id: "",
            error: !botToken ? "missing_discord_bot_token" : "missing_discord_user_id",
          };
        }
        const res = await discordBotRequest(botToken, "POST", "/users/@me/channels", {
          recipient_id: targetUserId,
        });
        return {
          ok: !!res.ok,
          status: safeInt(res.status, 0),
          channel_id: safeStr(res.data?.id || ""),
          error: res.ok ? "" : safeStr(res.text || "discord_dm_channel_open_failed").slice(0, 600),
        };
      };

      const sendDiscordDmEmbed = async ({ userId, content, embeds }) => {
        const botToken = contractDiscordBotToken();
        const targetUserId = safeStr(userId).replace(/\D/g, "");
        if (!botToken || !targetUserId) {
          return {
            ok: false,
            status: 0,
            user_id: targetUserId,
            channel_id: "",
            message_id: "",
            error: !botToken ? "missing_discord_contract_bot_token" : "missing_discord_user_id",
          };
        }
        const openRes = await openDiscordDmChannel(botToken, targetUserId);
        if (!openRes.ok || !openRes.channel_id) {
          return {
            ok: false,
            status: safeInt(openRes.status, 0),
            user_id: targetUserId,
            channel_id: safeStr(openRes.channel_id || ""),
            message_id: "",
            error: safeStr(openRes.error || "discord_dm_channel_open_failed"),
          };
        }
        const sendRes = await discordBotRequest(
          botToken,
          "POST",
          `/channels/${encodeURIComponent(openRes.channel_id)}/messages`,
          {
            content: safeStr(content || ""),
            embeds: Array.isArray(embeds) ? embeds : [],
            allowed_mentions: { parse: [] },
          }
        );
        return {
          ok: !!sendRes.ok,
          status: safeInt(sendRes.status, 0),
          user_id: targetUserId,
          channel_id: safeStr(openRes.channel_id || ""),
          message_id: safeStr(sendRes.data?.id || ""),
          error: sendRes.ok ? "" : safeStr(sendRes.text || "discord_dm_send_failed").slice(0, 600),
        };
      };

      const sendDiscordDmEmbedsToUsers = async ({ userIds, content, embeds }) => {
        const ids = Array.isArray(userIds) ? userIds.map((value) => safeStr(value).replace(/\D/g, "")).filter(Boolean) : [];
        const results = [];
        for (const userId of ids) {
          results.push(await sendDiscordDmEmbed({ userId, content, embeds }));
        }
        return results;
      };

      const syncBugThreadStatus = async (reportRow, statusOverride = "") => {
        const botToken = bugDiscordBotToken();
        const threadId = safeStr(reportRow && reportRow.thread_id);
        const threadName = buildBugThreadName(reportRow, statusOverride);
        if (!botToken) {
          return {
            ok: false,
            skipped: true,
            status: 0,
            error: "missing_discord_bot_token",
            thread_id: threadId,
            thread_name: threadName,
          };
        }
        if (!threadId) {
          return {
            ok: false,
            skipped: true,
            status: 0,
            error: "missing_bug_thread_id",
            thread_id: "",
            thread_name: threadName,
          };
        }
        const res = await discordBotRequest(
          botToken,
          "PATCH",
          `/channels/${encodeURIComponent(threadId)}`,
          {
            name: threadName,
            archived: false,
            locked: false,
          }
        );
        return {
          ok: !!res.ok,
          skipped: false,
          status: safeInt(res.status, 0),
          error: res.ok ? "" : safeStr(res.text || "discord_thread_patch_failed").slice(0, 600),
          thread_id: threadId,
          thread_name: threadName,
        };
      };

      const postBugThreadNote = async (reportRow, noteText) => {
        const botToken = bugDiscordBotToken();
        const threadId = safeStr(reportRow && reportRow.thread_id);
        const content = safeStr(noteText).slice(0, 1900);
        if (!botToken) {
          return { ok: false, skipped: true, status: 0, error: "missing_discord_bot_token", thread_id: threadId };
        }
        if (!threadId) {
          return { ok: false, skipped: true, status: 0, error: "missing_bug_thread_id", thread_id: "" };
        }
        if (!content) {
          return { ok: false, skipped: true, status: 0, error: "missing_note_content", thread_id: threadId };
        }
        const res = await discordBotRequest(botToken, "POST", `/channels/${encodeURIComponent(threadId)}/messages`, {
          content,
          allowed_mentions: { parse: [] },
        });
        return {
          ok: !!res.ok,
          skipped: false,
          status: safeInt(res.status, 0),
          error: res.ok ? "" : safeStr(res.text || "discord_thread_note_failed").slice(0, 600),
          thread_id: threadId,
          message_id: safeStr(res.data && res.data.id),
        };
      };

      const sendDiscordNotificationForBug = async (reportRow, filePath) => {
        const botToken = bugDiscordBotToken();
        const target = bugDiscordChannelTarget(reportRow);
        const channelId = target.channelId;
        const content = formatBugDiscordMessage(reportRow, filePath);
        const rawAttachmentRows = Array.isArray(reportRow && reportRow.attachments) ? reportRow.attachments : [];
        const attachmentsExpected = Math.min(6, rawAttachmentRows.length);
        const files = buildDiscordAttachmentFiles(reportRow);
        const attachmentsDecoded = files.length;
        const attachmentMeta = (attachmentsSent) => ({
          attachments_expected: attachmentsExpected,
          attachments_decoded: attachmentsDecoded,
          attachments_sent: Math.max(0, safeInt(attachmentsSent)),
        });
        const responseAttachmentCount = (discordResponse) => {
          const rows = Array.isArray(discordResponse && discordResponse.data && discordResponse.data.attachments)
            ? discordResponse.data.attachments
            : null;
          if (rows) return rows.length;
          return files.length ? files.length : 0;
        };

        if (!botToken || !channelId) {
          return {
            ok: false,
            mode: "none",
            status: 0,
            error: !botToken ? "missing_discord_bug_thread_config" : safeStr(target.missingError || "missing_discord_bug_thread_config"),
            delivery_target: safeStr(target.deliveryTarget || "primary"),
            ...attachmentMeta(0),
          };
        }

        if (channelId) {
          const sendChannel = await discordBotRequestWithFiles(
            botToken,
            `/channels/${encodeURIComponent(channelId)}/messages`,
            content,
            files
          );
          if (!sendChannel.ok) {
            return {
              ok: false,
              mode: "bot-channel-thread",
              status: sendChannel.status,
              error: safeStr(sendChannel.text || "send_channel_failed").slice(0, 600),
              delivery_target: safeStr(target.deliveryTarget || "primary"),
              ...attachmentMeta(0),
            };
          }
          const rootMessageId = safeStr(sendChannel.data && sendChannel.data.id);
          if (!rootMessageId) {
            return {
              ok: false,
              mode: "bot-channel-thread",
              status: sendChannel.status,
              error: "missing_root_message_id",
              channel_id: channelId,
              delivery_target: safeStr(target.deliveryTarget || "primary"),
              ...attachmentMeta(0),
            };
          }
          const threadName = buildBugThreadName(reportRow);
          const createThread = await discordBotRequest(
            botToken,
            "POST",
            `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(rootMessageId)}/threads`,
            {
              name: threadName,
              auto_archive_duration: 10080,
              rate_limit_per_user: 0,
            }
          );
          if (!createThread.ok) {
            return {
              ok: false,
              mode: "bot-channel-thread",
              status: createThread.status,
              error: safeStr(createThread.text || "create_thread_failed").slice(0, 600),
              channel_id: channelId,
              delivery_target: safeStr(target.deliveryTarget || "primary"),
              message_id: rootMessageId,
              thread_root_message_id: rootMessageId,
              thread_name: threadName,
              ...attachmentMeta(responseAttachmentCount(sendChannel)),
            };
          }
          const sentCount = responseAttachmentCount(sendChannel);
          return {
            ok: true,
            mode: "bot-channel-thread",
            channel_id: channelId,
            delivery_target: safeStr(target.deliveryTarget || "primary"),
            message_id: rootMessageId,
            thread_root_message_id: rootMessageId,
            thread_id: safeStr(createThread.data && createThread.data.id),
            thread_name: threadName,
            ...attachmentMeta(sentCount),
          };
        }
        return {
          ok: false,
          mode: "none",
          status: 0,
          error: safeStr(target.missingError || "missing_discord_bug_thread_config"),
          delivery_target: safeStr(target.deliveryTarget || "primary"),
          ...attachmentMeta(0),
        };
      };

      const base64UrlFromUtf8 = (text) =>
        utf8ToBase64(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

      const decodeBase64UrlUtf8 = (value) => {
        const raw = safeStr(value).replace(/-/g, "+").replace(/_/g, "/");
        if (!raw) return "";
        const padded = raw + "===".slice((raw.length + 3) % 4);
        try {
          return base64ToUtf8(padded);
        } catch (_) {
          return "";
        }
      };

      const OUTBOX_TRAILER_BEGIN = "[UPS_TWB_INTENT_BEGIN]";
      const OUTBOX_TRAILER_END = "[UPS_TWB_INTENT_END]";

      const buildOutboxTrailerText = ({
        outboxId,
        payloadHash,
        payloadXmlExtensions,
        payloadXmlSalaryAdj,
        payloadXmlSalaryTrade,
      }) => {
        const lines = [
          OUTBOX_TRAILER_BEGIN,
          `UPS_OUTBOX_ID:${safeStr(outboxId)}`,
          `UPS_PAYLOAD_HASH:${safeStr(payloadHash)}`,
        ];
        const appendEncodedLineIfSmallEnough = (key, xmlText, maxEncodedLen = 360) => {
          const xml = safeStr(xmlText);
          if (!xml) return;
          const encoded = base64UrlFromUtf8(xml);
          if (encoded.length > maxEncodedLen) return;
          lines.push(`${key}:${encoded}`);
        };
        appendEncodedLineIfSmallEnough("UPS_XML_EXT", payloadXmlExtensions);
        appendEncodedLineIfSmallEnough("UPS_XML_SALADJ", payloadXmlSalaryAdj);
        appendEncodedLineIfSmallEnough("UPS_XML_SALTR", payloadXmlSalaryTrade);
        lines.push(OUTBOX_TRAILER_END);
        return lines.join("\n");
      };

      const parseOutboxTrailerFromComment = (commentText) => {
        const text = safeStr(commentText);
        if (!text) return null;
        const re = /\[UPS_TWB_INTENT_BEGIN\]([\s\S]*?)\[UPS_TWB_INTENT_END\]/i;
        const m = text.match(re);
        if (!m || !m[1]) return null;
        const body = safeStr(m[1]);
        const lines = body
          .split(/\r?\n/)
          .map((v) => safeStr(v))
          .filter(Boolean);
        const map = {};
        for (const line of lines) {
          const idx = line.indexOf(":");
          if (idx <= 0) continue;
          const key = safeStr(line.slice(0, idx)).toUpperCase();
          const value = safeStr(line.slice(idx + 1));
          if (!key) continue;
          map[key] = value;
        }
        return {
          outbox_id: safeStr(map.UPS_OUTBOX_ID),
          payload_hash: safeStr(map.UPS_PAYLOAD_HASH),
          payload_xml_extensions: decodeBase64UrlUtf8(map.UPS_XML_EXT),
          payload_xml_salary_adj: decodeBase64UrlUtf8(map.UPS_XML_SALADJ),
          payload_xml_salary_trade: decodeBase64UrlUtf8(map.UPS_XML_SALTR),
          raw_block: m[0],
        };
      };

      const outboxDbBinding = () => {
        const db = env.TWB_OUTBOX_DB || env.TWB_DB || env.DB || null;
        if (!db || typeof db.prepare !== "function") return null;
        return db;
      };

      const ensureOutboxTable = async (db) => {
        if (!db) return { ok: false, error: "no_db_binding" };
        try {
          await db.exec(`
            CREATE TABLE IF NOT EXISTS twb_trade_outbox (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              created_ts TEXT NOT NULL,
              updated_ts TEXT NOT NULL,
              league_id TEXT NOT NULL,
              season TEXT NOT NULL,
              trade_id TEXT,
              action_type TEXT NOT NULL,
              from_franchise_id TEXT,
              to_franchise_id TEXT,
              payload_xml_extensions TEXT,
              payload_xml_salary_adj TEXT,
              payload_xml_salary_trade TEXT,
              payload_json TEXT,
              comment_trailer TEXT,
              payload_hash TEXT,
              status TEXT NOT NULL DEFAULT 'PENDING',
              mfl_post_response_snip TEXT,
              mfl_verify_response_snip TEXT
            );
          `);
          await db.exec(
            "CREATE INDEX IF NOT EXISTS idx_twb_trade_outbox_lookup ON twb_trade_outbox(league_id, season, trade_id, payload_hash, status);"
          );
          return { ok: true };
        } catch (e) {
          return { ok: false, error: `d1_schema_failed: ${e?.message || String(e)}` };
        }
      };

      const normalizeOutboxRow = (row) => {
        const item = row && typeof row === "object" ? { ...row } : {};
        item.id = String(item.id == null ? "" : item.id);
        item.payload_hash = safeStr(item.payload_hash);
        item.trade_id = safeStr(item.trade_id).replace(/\D/g, "");
        item.status = offerStatusNormalized(item.status, "PENDING");
        item.action_type = safeStr(item.action_type || "SUBMIT").toUpperCase();
        item.payload_xml_extensions = safeStr(item.payload_xml_extensions);
        item.payload_xml_salary_adj = safeStr(item.payload_xml_salary_adj);
        item.payload_xml_salary_trade = safeStr(item.payload_xml_salary_trade);
        item.comment_trailer = safeStr(item.comment_trailer);
        item.mfl_post_response_snip = safeStr(item.mfl_post_response_snip);
        item.mfl_verify_response_snip = safeStr(item.mfl_verify_response_snip);
        if (typeof item.payload_json === "string") {
          try {
            item.payload_json = item.payload_json ? JSON.parse(item.payload_json) : null;
          } catch (_) {
            item.payload_json = null;
          }
        } else if (!item.payload_json || typeof item.payload_json !== "object") {
          item.payload_json = null;
        }
        return item;
      };

      const writeOutboxRow = async ({
        mode,
        leagueId,
        season,
        row,
        where,
      }) => {
        const db = outboxDbBinding();
        const nowIso = new Date().toISOString();
        const normalizedRow = normalizeOutboxRow({
          ...row,
          league_id: safeStr(leagueId),
          season: safeStr(season),
          updated_ts: nowIso,
        });

        if (db) {
          const schema = await ensureOutboxTable(db);
          if (!schema.ok) return { ok: false, backend: "sqlite", error: schema.error };
          try {
            if (mode === "insert") {
              const createdTs = safeStr(normalizedRow.created_ts || nowIso);
              const stmt = db.prepare(`
                INSERT INTO twb_trade_outbox
                (created_ts, updated_ts, league_id, season, trade_id, action_type, from_franchise_id, to_franchise_id,
                 payload_xml_extensions, payload_xml_salary_adj, payload_xml_salary_trade, payload_json, comment_trailer,
                 payload_hash, status, mfl_post_response_snip, mfl_verify_response_snip)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `);
              const run = await stmt
                .bind(
                  createdTs,
                  nowIso,
                  safeStr(leagueId),
                  safeStr(season),
                  safeStr(normalizedRow.trade_id),
                  safeStr(normalizedRow.action_type || "SUBMIT"),
                  safeStr(normalizedRow.from_franchise_id),
                  safeStr(normalizedRow.to_franchise_id),
                  safeStr(normalizedRow.payload_xml_extensions),
                  safeStr(normalizedRow.payload_xml_salary_adj),
                  safeStr(normalizedRow.payload_xml_salary_trade),
                  normalizedRow.payload_json ? JSON.stringify(normalizedRow.payload_json) : "",
                  safeStr(normalizedRow.comment_trailer),
                  safeStr(normalizedRow.payload_hash),
                  safeStr(normalizedRow.status || "PENDING"),
                  safeStr(normalizedRow.mfl_post_response_snip).slice(0, 1000),
                  safeStr(normalizedRow.mfl_verify_response_snip).slice(0, 1000)
                )
                .run();
              const newId = String(run?.meta?.last_row_id || "");
              return { ok: true, backend: "sqlite", id: newId || "", row: { ...normalizedRow, id: newId || "" } };
            }

            const targetId = safeStr(where && where.id);
            if (!targetId) return { ok: false, backend: "sqlite", error: "missing_outbox_id_for_update" };
            const stmt = db.prepare(`
              UPDATE twb_trade_outbox
              SET updated_ts=?, trade_id=?, action_type=?, from_franchise_id=?, to_franchise_id=?,
                  payload_xml_extensions=?, payload_xml_salary_adj=?, payload_xml_salary_trade=?,
                  payload_json=?, comment_trailer=?, payload_hash=?, status=?, mfl_post_response_snip=?, mfl_verify_response_snip=?
              WHERE id=?
            `);
            await stmt
              .bind(
                nowIso,
                safeStr(normalizedRow.trade_id),
                safeStr(normalizedRow.action_type || "SUBMIT"),
                safeStr(normalizedRow.from_franchise_id),
                safeStr(normalizedRow.to_franchise_id),
                safeStr(normalizedRow.payload_xml_extensions),
                safeStr(normalizedRow.payload_xml_salary_adj),
                safeStr(normalizedRow.payload_xml_salary_trade),
                normalizedRow.payload_json ? JSON.stringify(normalizedRow.payload_json) : "",
                safeStr(normalizedRow.comment_trailer),
                safeStr(normalizedRow.payload_hash),
                safeStr(normalizedRow.status || "PENDING"),
                safeStr(normalizedRow.mfl_post_response_snip).slice(0, 1000),
                safeStr(normalizedRow.mfl_verify_response_snip).slice(0, 1000),
                targetId
              )
              .run();
            return { ok: true, backend: "sqlite", id: targetId, row: { ...normalizedRow, id: targetId } };
          } catch (e) {
            return { ok: false, backend: "sqlite", error: `d1_write_failed: ${e?.message || String(e)}` };
          }
        }

        const loaded = await readTradeOutboxDoc(leagueId, season);
        if (!loaded.ok) return { ok: false, backend: "file", error: loaded.error || "outbox_read_failed" };
        const doc = normalizeTradeOutboxDoc(loaded.doc, leagueId, season);
        const rows = Array.isArray(doc.rows) ? doc.rows : [];
        if (mode === "insert") {
          const maxId = rows.reduce((max, r) => {
            const n = Number(String(r && r.id || "").replace(/\D/g, ""));
            return Number.isFinite(n) && n > max ? n : max;
          }, 0);
          const newId = String(maxId + 1);
          rows.push({
            ...normalizedRow,
            id: newId,
            created_ts: safeStr(normalizedRow.created_ts || nowIso),
          });
          const save = await writeTradeOutboxDoc(
            leagueId,
            season,
            doc,
            loaded.sha,
            `feat(trades): append outbox row ${newId}`
          );
          if (!save.ok) return { ok: false, backend: "file", error: save.error || "outbox_write_failed" };
          return { ok: true, backend: "file", id: newId, row: rows[rows.length - 1] };
        }
        const targetId = safeStr(where && where.id);
        if (!targetId) return { ok: false, backend: "file", error: "missing_outbox_id_for_update" };
        const idx = rows.findIndex((r) => safeStr(r && r.id) === targetId);
        if (idx < 0) return { ok: false, backend: "file", error: "outbox_row_not_found" };
        rows[idx] = {
          ...(rows[idx] || {}),
          ...normalizedRow,
          id: targetId,
          created_ts: safeStr((rows[idx] || {}).created_ts || normalizedRow.created_ts || nowIso),
        };
        const save = await writeTradeOutboxDoc(
          leagueId,
          season,
          doc,
          loaded.sha,
          `feat(trades): update outbox row ${targetId}`
        );
        if (!save.ok) return { ok: false, backend: "file", error: save.error || "outbox_write_failed" };
        return { ok: true, backend: "file", id: targetId, row: rows[idx] };
      };

      const findOutboxRow = async ({
        leagueId,
        season,
        id,
        tradeId,
        payloadHash,
      }) => {
        const cleanId = safeStr(id);
        const cleanTradeId = safeStr(tradeId).replace(/\D/g, "");
        const cleanHash = safeStr(payloadHash);

        const db = outboxDbBinding();
        if (db) {
          const schema = await ensureOutboxTable(db);
          if (!schema.ok) return { ok: false, backend: "sqlite", error: schema.error, row: null };
          try {
            let row = null;
            if (cleanId) {
              row = await db.prepare("SELECT * FROM twb_trade_outbox WHERE id = ?").bind(cleanId).first();
            }
            if (!row && cleanTradeId) {
              row = await db
                .prepare("SELECT * FROM twb_trade_outbox WHERE league_id=? AND season=? AND trade_id=? ORDER BY id DESC LIMIT 1")
                .bind(safeStr(leagueId), safeStr(season), cleanTradeId)
                .first();
            }
            if (!row && cleanHash) {
              row = await db
                .prepare("SELECT * FROM twb_trade_outbox WHERE league_id=? AND season=? AND payload_hash=? ORDER BY id DESC LIMIT 1")
                .bind(safeStr(leagueId), safeStr(season), cleanHash)
                .first();
            }
            return { ok: true, backend: "sqlite", row: row ? normalizeOutboxRow(row) : null };
          } catch (e) {
            return { ok: false, backend: "sqlite", error: `d1_read_failed: ${e?.message || String(e)}`, row: null };
          }
        }

        const loaded = await readTradeOutboxDoc(leagueId, season);
        if (!loaded.ok) return { ok: false, backend: "file", error: loaded.error || "outbox_read_failed", row: null };
        const doc = normalizeTradeOutboxDoc(loaded.doc, leagueId, season);
        const rows = (Array.isArray(doc.rows) ? doc.rows : []).map((r) => normalizeOutboxRow(r));
        let row = null;
        if (cleanId) row = rows.find((r) => safeStr(r.id) === cleanId) || null;
        if (!row && cleanTradeId) {
          row =
            rows
              .filter((r) => safeStr(r.trade_id).replace(/\D/g, "") === cleanTradeId)
              .sort((a, b) => safeStr(b.updated_ts).localeCompare(safeStr(a.updated_ts)))[0] || null;
        }
        if (!row && cleanHash) {
          row =
            rows
              .filter((r) => safeStr(r.payload_hash) === cleanHash)
              .sort((a, b) => safeStr(b.updated_ts).localeCompare(safeStr(a.updated_ts)))[0] || null;
        }
        return { ok: true, backend: "file", row: row || null };
      };

      const listOutboxRows = async ({
        leagueId,
        season,
        limit = 200,
      }) => {
        const cappedLimit = Math.max(1, Math.min(1000, safeInt(limit, 200)));
        const db = outboxDbBinding();
        if (db) {
          const schema = await ensureOutboxTable(db);
          if (!schema.ok) return { ok: false, backend: "sqlite", error: schema.error, rows: [] };
          try {
            const rows = await db
              .prepare(
                "SELECT * FROM twb_trade_outbox WHERE league_id=? AND season=? ORDER BY id DESC LIMIT ?"
              )
              .bind(safeStr(leagueId), safeStr(season), cappedLimit)
              .all();
            const list = Array.isArray(rows?.results)
              ? rows.results.map((r) => normalizeOutboxRow(r))
              : [];
            return { ok: true, backend: "sqlite", rows: list };
          } catch (e) {
            return { ok: false, backend: "sqlite", error: `d1_read_failed: ${e?.message || String(e)}`, rows: [] };
          }
        }

        const loaded = await readTradeOutboxDoc(leagueId, season);
        if (!loaded.ok) return { ok: false, backend: "file", error: loaded.error || "outbox_read_failed", rows: [] };
        const doc = normalizeTradeOutboxDoc(loaded.doc, leagueId, season);
        const rows = (Array.isArray(doc.rows) ? doc.rows : [])
          .map((r) => normalizeOutboxRow(r))
          .sort((a, b) => safeStr(b.updated_ts).localeCompare(safeStr(a.updated_ts)))
          .slice(0, cappedLimit);
        return { ok: true, backend: "file", rows };
      };

      const summarizeOfferPayload = (payload) => {
        const teams = Array.isArray(payload?.teams) ? payload.teams : [];
        const left = teams.find((t) => safeStr(t?.role).toLowerCase() === "left") || teams[0] || {};
        const right = teams.find((t) => safeStr(t?.role).toLowerCase() === "right") || teams[1] || {};
        const leftAssets = Array.isArray(left?.selected_assets) ? left.selected_assets : [];
        const rightAssets = Array.isArray(right?.selected_assets) ? right.selected_assets : [];
        const extReqs = Array.isArray(payload?.extension_requests) ? payload.extension_requests : [];
        return {
          from_asset_count: leftAssets.length,
          to_asset_count: rightAssets.length,
          from_trade_salary_k: safeInt(left?.traded_salary_adjustment_k, 0),
          to_trade_salary_k: safeInt(right?.traded_salary_adjustment_k, 0),
          extension_request_count: extReqs.length,
        };
      };

      const offerStatusNormalized = (v, fallback = "") => {
        const s = safeStr(v);
        if (s) return s.toUpperCase();
        const fb = safeStr(fallback);
        return fb ? fb.toUpperCase() : "";
      };

      const sanitizeOfferForList = (offer, includePayload) => {
        const out = { ...(offer || {}) };
        out.status = offerStatusNormalized(out.status, "PENDING");
        if (!includePayload) delete out.payload;
        return out;
      };

      const parseBoolFlag = (v) => {
        const s = safeStr(v).toLowerCase();
        return s === "1" || s === "true" || s === "yes" || s === "on";
      };

      const xmlAttrEscape = (s) =>
        String(s == null ? "" : s)
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");

      const looksLikeMflImportError = (text) => {
        const lowered = safeStr(text).toLowerCase();
        if (!lowered) return false;
        return (
          lowered.includes("error") ||
          lowered.includes("invalid") ||
          lowered.includes("not authorized") ||
          lowered.includes("authorization failed") ||
          lowered.includes("access denied")
        );
      };

      const mflErrorFromJsonPayload = (payload) => {
        if (!payload || typeof payload !== "object") return "";
        const err = payload.error;
        if (!err) return "";
        if (typeof err === "string") return err;
        if (typeof err === "object") {
          const keys = ["$t", "message", "reason", "error", "detail", "details"];
          for (const k of keys) {
            const v = err[k];
            if (v != null && String(v).trim()) return String(v).trim();
          }
          return JSON.stringify(err);
        }
        return String(err);
      };

      const isLikelyMflImportSuccess = (res, text) =>
        !!res?.ok && !looksLikeMflImportError(text);

      const isImpersonationLockoutImportError = (importRes) => {
        const preview = safeStr(
          importRes?.upstreamPreview ||
            importRes?.text ||
            importRes?.error
        ).toLowerCase();
        if (!preview) return false;
        return preview.includes("impersonate") && preview.includes("lockout");
      };

      const isImpersonationLockoutExportError = (exportRes) => {
        const preview = safeStr(
          exportRes?.textPreview ||
            exportRes?.error ||
            exportRes?.data?.error?.$t ||
            exportRes?.data?.error
        ).toLowerCase();
        if (!preview) return false;
        return preview.includes("impersonate") && preview.includes("lockout");
      };

      const loadPendingTradesExportAsViewer = async (seasonValue, leagueIdValue, franchiseIdValue = "") => {
        const fid = padFranchiseId(franchiseIdValue);
        const first = await mflExportJsonAsViewer(
          seasonValue,
          leagueIdValue,
          "pendingTrades",
          fid ? { FRANCHISE_ID: fid } : {},
          { useCookie: true }
        );
        if (first.ok) {
          return {
            ...first,
            retriedWithoutFranchiseId: false,
            usedFranchiseId: !!fid,
          };
        }

        const canRetryWithoutFranchiseId =
          !!browserCookieHeader &&
          !!fid &&
          isImpersonationLockoutExportError(first);
        if (!canRetryWithoutFranchiseId) {
          return {
            ...first,
            retriedWithoutFranchiseId: false,
            usedFranchiseId: !!fid,
          };
        }

        const retry = await mflExportJsonAsViewer(
          seasonValue,
          leagueIdValue,
          "pendingTrades",
          {},
          { useCookie: true }
        );
        return {
          ...retry,
          retriedWithoutFranchiseId: true,
          usedFranchiseId: false,
          firstAttempt: {
            status: safeInt(first.status, 0),
            url: safeStr(first.url),
            error: safeStr(first.error),
            preview: safeStr(first.textPreview),
          },
        };
      };

      const resolveMflImportTargetUrl = async (season, probeFields) => {
        const baseImportUrl =
          `https://api.myfantasyleague.com/${encodeURIComponent(String(season || YEAR || new Date().getUTCFullYear()))}` +
          "/import";
        const probeQs = new URLSearchParams();
        for (const [k, v] of Object.entries(probeFields || {})) {
          if (v == null) continue;
          const s = String(v).trim();
          if (!s) continue;
          probeQs.set(k, s);
        }
        const probeUrl = probeQs.toString()
          ? `${baseImportUrl}?${probeQs.toString()}`
          : baseImportUrl;

        let targetImportUrl = probeUrl;
        try {
          const probeRes = await fetch(probeUrl, {
            method: "GET",
            redirect: "manual",
            headers: {
              Cookie: cookieHeader,
              "User-Agent": "upsmflproduction-worker",
            },
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          const loc = probeRes.headers.get("Location") || probeRes.headers.get("location");
          if (probeRes.status >= 300 && probeRes.status < 400 && loc) {
            targetImportUrl = new URL(loc, probeUrl).toString();
          }
        } catch (_) {
          // Fall back to default API shard URL.
        }
        return targetImportUrl;
      };

      const postMflImportForm = async (season, formFields, probeFields, requestOptions = {}) => {
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries(formFields || {})) {
          if (v == null) continue;
          const s = String(v).trim();
          if (!s) continue;
          form.set(k, s);
        }
        const targetImportUrl = await resolveMflImportTargetUrl(season, probeFields || formFields);
        const method = safeStr(requestOptions.method || "POST").toUpperCase() === "GET" ? "GET" : "POST";
        let requestUrl = targetImportUrl;
        if (method === "GET") {
          try {
            const u = new URL(targetImportUrl);
            for (const [k, v] of form.entries()) u.searchParams.set(k, v);
            requestUrl = u.toString();
          } catch (_) {
            requestUrl = targetImportUrl;
          }
        }
        let res;
        let text = "";
        try {
          res = await fetch(requestUrl, {
            method,
            headers: {
              Cookie: cookieHeader,
              "User-Agent": "upsmflproduction-worker",
              ...(method === "POST"
                ? { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }
                : {}),
            },
            body: method === "POST" ? form.toString() : undefined,
            redirect: "manual",
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          text = await res.text();
        } catch (e) {
          return {
            ok: false,
            requestOk: false,
            status: 0,
            text: "",
            upstreamPreview: "",
            targetImportUrl: requestUrl,
            formFields: Object.fromEntries(form.entries()),
            error: `fetch_failed: ${e?.message || String(e)}`,
          };
        }
        let parsedJson = null;
        try {
          parsedJson = text ? JSON.parse(text) : null;
        } catch (_) {
          parsedJson = null;
        }
        const payloadErr = parsedJson ? mflErrorFromJsonPayload(parsedJson) : "";
        const requestOk = isLikelyMflImportSuccess(res, text) && !payloadErr;
        return {
          ok: requestOk,
          requestOk,
          status: res.status,
          text,
          upstreamPreview: String(text || "").slice(0, 1200),
          targetImportUrl: requestUrl,
          formFields: Object.fromEntries(form.entries()),
          error: requestOk ? "" : (payloadErr || `MFL import failed (HTTP ${res.status})`),
        };
      };

      const resolveMflImportTargetUrlForCookie = async (cookieHeaderOverride, season, probeFields) => {
        const baseImportUrl =
          `https://api.myfantasyleague.com/${encodeURIComponent(String(season || YEAR || new Date().getUTCFullYear()))}` +
          "/import";
        const probeQs = new URLSearchParams();
        for (const [k, v] of Object.entries(probeFields || {})) {
          if (v == null) continue;
          const s = String(v).trim();
          if (!s) continue;
          probeQs.set(k, s);
        }
        const probeUrl = probeQs.toString() ? `${baseImportUrl}?${probeQs.toString()}` : baseImportUrl;
        let targetImportUrl = probeUrl;
        try {
          const probeRes = await fetch(probeUrl, {
            method: "GET",
            redirect: "manual",
            headers: {
              Cookie: cookieHeaderOverride,
              "User-Agent": "upsmflproduction-worker",
            },
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          const loc = probeRes.headers.get("Location") || probeRes.headers.get("location");
          if (probeRes.status >= 300 && probeRes.status < 400 && loc) {
            targetImportUrl = new URL(loc, probeUrl).toString();
          }
        } catch (_) {}
        return targetImportUrl;
      };

      const postMflImportFormForCookie = async (cookieHeaderOverride, season, formFields, probeFields, requestOptions = {}) => {
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries(formFields || {})) {
          if (v == null) continue;
          const s = String(v).trim();
          if (!s) continue;
          form.set(k, s);
        }
        const targetImportUrl = await resolveMflImportTargetUrlForCookie(
          cookieHeaderOverride,
          season,
          probeFields || formFields
        );
        const method = safeStr(requestOptions.method || "POST").toUpperCase() === "GET" ? "GET" : "POST";
        let requestUrl = targetImportUrl;
        if (method === "GET") {
          try {
            const u = new URL(targetImportUrl);
            for (const [k, v] of form.entries()) u.searchParams.set(k, v);
            requestUrl = u.toString();
          } catch (_) {
            requestUrl = targetImportUrl;
          }
        }
        let res;
        let text = "";
        try {
          res = await fetch(requestUrl, {
            method,
            headers: {
              Cookie: cookieHeaderOverride,
              "User-Agent": "upsmflproduction-worker",
              ...(method === "POST"
                ? { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }
                : {}),
            },
            body: method === "POST" ? form.toString() : undefined,
            redirect: "manual",
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          text = await res.text();
        } catch (e) {
          return {
            ok: false,
            requestOk: false,
            status: 0,
            text: "",
            upstreamPreview: "",
            targetImportUrl: requestUrl,
            formFields: Object.fromEntries(form.entries()),
            error: `fetch_failed: ${e?.message || String(e)}`,
          };
        }
        let parsedJson = null;
        try {
          parsedJson = text ? JSON.parse(text) : null;
        } catch (_) {
          parsedJson = null;
        }
        const payloadErr = parsedJson ? mflErrorFromJsonPayload(parsedJson) : "";
        const requestOk = isLikelyMflImportSuccess(res, text) && !payloadErr;
        return {
          ok: requestOk,
          requestOk,
          status: res.status,
          text,
          upstreamPreview: String(text || "").slice(0, 1200),
          targetImportUrl: requestUrl,
          formFields: Object.fromEntries(form.entries()),
          error: requestOk ? "" : (payloadErr || `MFL import failed (HTTP ${res.status})`),
        };
      };

      const fetchTextWithCookie = async (targetUrl, cookieHeaderOverride, options = {}) => {
        const res = await fetch(targetUrl, {
          method: safeStr(options.method || "GET").toUpperCase() || "GET",
          headers: {
            Cookie: cookieHeaderOverride,
            "User-Agent": "upsmflproduction-worker",
            ...(options.contentType ? { "Content-Type": options.contentType } : {}),
          },
          body: options.body,
          redirect: safeStr(options.redirect || "follow").toLowerCase() === "manual" ? "manual" : "follow",
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        return { status: res.status, url: res.url, text: await res.text(), headers: res.headers };
      };

      const parseCookieHeaderMap = (rawHeader) => {
        const out = new Map();
        for (const part of String(rawHeader || "").split(";")) {
          const idx = part.indexOf("=");
          if (idx <= 0) continue;
          const key = part.slice(0, idx).trim();
          const value = part.slice(idx + 1).trim();
          if (!key) continue;
          out.set(key, value);
        }
        return out;
      };

      const parseSetCookiePairs = (headers) => {
        const rawValues = typeof headers?.getSetCookie === "function"
          ? headers.getSetCookie()
          : [headers?.get("set-cookie")].filter(Boolean);
        const out = [];
        for (const raw of rawValues) {
          const pieces = String(raw || "").split(/,(?=[^;,]+=)/g);
          for (const piece of pieces) {
            const first = String(piece || "").split(";")[0];
            const idx = first.indexOf("=");
            if (idx <= 0) continue;
            const key = first.slice(0, idx).trim();
            const value = first.slice(idx + 1).trim();
            if (!key) continue;
            out.push([key, value]);
          }
        }
        return out;
      };

      const mergeCookieHeaders = (...cookieHeaders) => {
        const merged = new Map();
        for (const header of cookieHeaders) {
          const map = parseCookieHeaderMap(header);
          for (const [key, value] of map.entries()) merged.set(key, value);
        }
        return Array.from(merged.entries()).map(([key, value]) => `${key}=${value}`).join("; ");
      };

      const establishCommishCookieHeader = async (cookieHeaderOverride, season, leagueId) => {
        const becomeUrl =
          `https://www48.myfantasyleague.com/${encodeURIComponent(String(season))}` +
          `/logout?L=${encodeURIComponent(leagueId)}&BECOME=0000`;
        let mergedCookieHeader = safeStr(cookieHeaderOverride);
        try {
          const res = await fetch(becomeUrl, {
            method: "GET",
            redirect: "manual",
            headers: {
              Cookie: mergedCookieHeader,
              "User-Agent": "upsmflproduction-worker",
            },
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          const setPairs = parseSetCookiePairs(res.headers);
          if (setPairs.length) {
            mergedCookieHeader = mergeCookieHeaders(
              mergedCookieHeader,
              setPairs.map(([key, value]) => `${key}=${value}`).join("; ")
            );
          }
          const loc = res.headers.get("Location") || res.headers.get("location");
          if (loc) {
            const follow = await fetch(new URL(loc, becomeUrl).toString(), {
              method: "GET",
              redirect: "manual",
              headers: {
                Cookie: mergedCookieHeader,
                "User-Agent": "upsmflproduction-worker",
              },
              cf: { cacheTtl: 0, cacheEverything: false },
            });
            const followPairs = parseSetCookiePairs(follow.headers);
            if (followPairs.length) {
              mergedCookieHeader = mergeCookieHeaders(
                mergedCookieHeader,
                followPairs.map(([key, value]) => `${key}=${value}`).join("; ")
              );
            }
          }
        } catch (_) {}
        return mergedCookieHeader;
      };

      const parseHtmlAttributes = (tagText) => {
        const attrs = {};
        const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
        let m;
        while ((m = re.exec(String(tagText || "")))) {
          attrs[String(m[1] || "").toLowerCase()] = m[3] != null ? m[3] : (m[4] != null ? m[4] : (m[5] || ""));
        }
        return attrs;
      };

      const parseLoadRostForm = (html, pageUrl) => {
        const text = String(html || "");
        const formMatch = text.match(/<form\b[^>]*action\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/i);
        if (!formMatch) return null;
        const actionRaw = formMatch[2] || formMatch[3] || formMatch[4] || "";
        const actionUrl = new URL(actionRaw, pageUrl).toString();
        const baseFields = [];
        const seen = new Set();
        const inputRe = /<input\b[^>]*>/gi;
        let inputMatch;
        while ((inputMatch = inputRe.exec(text))) {
          const attrs = parseHtmlAttributes(inputMatch[0]);
          const type = safeStr(attrs.type).toLowerCase();
          const name = safeStr(attrs.name);
          if (!name || type === "button" || type === "submit" || type === "checkbox") continue;
          if (name === "sel_pid" || name === "picker_filt_name") continue;
          if (seen.has(name)) continue;
          seen.add(name);
          baseFields.push([name, safeStr(attrs.value)]);
        }
        if (!seen.has("PLAYER_NAMES")) baseFields.push(["PLAYER_NAMES", ""]);
        const selectMatch = text.match(/<select\b[^>]*name\s*=\s*("ROSTER"|'ROSTER'|ROSTER)[^>]*>([\s\S]*?)<\/select>/i);
        const rosterIds = [];
        if (selectMatch) {
          const optionRe = /<option\b[^>]*value\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
          let optionMatch;
          while ((optionMatch = optionRe.exec(selectMatch[2] || ""))) {
            const value = String(optionMatch[2] || optionMatch[3] || optionMatch[4] || "").replace(/\D/g, "");
            if (value) rosterIds.push(value);
          }
        }
        return { actionUrl, baseFields, currentRosterIds: rosterIds };
      };

      const fetchLoadRostFormForCookie = async (cookieHeaderOverride, season, leagueId, franchiseId) => {
        const urlBase = `https://www48.myfantasyleague.com/${encodeURIComponent(String(season))}`;
        const pageUrl =
          `${urlBase}/csetup?LEAGUE_ID=${encodeURIComponent(leagueId)}` +
          `&FRANCHISE=${encodeURIComponent(franchiseId)}&C=LOADROST`;
        const resp = await fetchTextWithCookie(pageUrl, cookieHeaderOverride);
        if (resp.status < 200 || resp.status >= 400) {
          return { ok: false, status: resp.status, error: "load_roster_page_failed", pageUrl, preview: resp.text.slice(0, 800) };
        }
        if (String(resp.text || "").includes("Commissioner Access Required")) {
          return { ok: false, status: resp.status, error: "commissioner_access_required", pageUrl, preview: resp.text.slice(0, 800) };
        }
        const parsed = parseLoadRostForm(resp.text, resp.url || pageUrl);
        if (!parsed) {
          return { ok: false, status: resp.status, error: "load_roster_form_not_found", pageUrl, preview: resp.text.slice(0, 800) };
        }
        return { ok: true, status: resp.status, pageUrl, ...parsed };
      };

      const postLoadRostFormForCookie = async (cookieHeaderOverride, form, desiredRosterIds) => {
        const params = new URLSearchParams();
        for (const [k, v] of form.baseFields || []) {
          if (!safeStr(k)) continue;
          params.append(k, safeStr(v));
        }
        for (const playerId of desiredRosterIds || []) {
          const pid = String(playerId || "").replace(/\D/g, "");
          if (pid) params.append("ROSTER", pid);
        }
        const resp = await fetchTextWithCookie(form.actionUrl, cookieHeaderOverride, {
          method: "POST",
          contentType: "application/x-www-form-urlencoded;charset=UTF-8",
          body: params.toString(),
        });
        const lowered = String(resp.text || "").toLowerCase();
        const ok =
          resp.status >= 200 &&
          resp.status < 400 &&
          !lowered.includes("commissioner access required") &&
          !lowered.includes("not authorized");
        return {
          ok,
          status: resp.status,
          preview: String(resp.text || "").slice(0, 1200),
          url: resp.url || form.actionUrl,
        };
      };

      const rosterRowsByFranchiseFromRostersPayload = (rostersPayload) => {
        const out = {};
        const franchiseRows = asArray(rostersPayload?.rosters?.franchise || rostersPayload?.rosters?.franchises).filter(Boolean);
        for (const fr of franchiseRows) {
          const franchiseId = padFranchiseId(fr?.id || fr?.franchise_id);
          if (!franchiseId) continue;
          const playerRows = asArray(fr?.player || fr?.players).filter(Boolean).map((player) => ({
            player_id: String(player?.id || player?.player_id || "").replace(/\D/g, ""),
            status: safeStr(player?.status || "ROSTER").toUpperCase(),
            salary: safeStr(player?.salary || ""),
            contract_year: safeStr(player?.contractYear || player?.contractyear || ""),
            contract_status: safeStr(player?.contractStatus || player?.contractstatus || ""),
            contract_info: safeStr(player?.contractInfo || player?.contractinfo || ""),
          })).filter((row) => row.player_id);
          out[franchiseId] = playerRows;
        }
        return out;
      };

      const TAG_OFFENSE_POSITIONS = new Set(["QB", "RB", "WR", "TE"]);

      const normalizeTagSideForCompare = (value) => {
        const raw = safeStr(value).toUpperCase();
        if (raw === "OFFENSE" || raw === "OFF") return "OFFENSE";
        if (raw === "DEFENSE" || raw === "DEF" || raw === "IDP" || raw === "IDP_K") return "DEFENSE";
        return "";
      };

      const tagSideFromPosition = (position) => {
        const pos = safeStr(position).toUpperCase();
        if (!pos) return "";
        return TAG_OFFENSE_POSITIONS.has(pos) ? "OFFENSE" : "DEFENSE";
      };

      const tagSideLabelForRule = (side) => {
        const normalized = normalizeTagSideForCompare(side);
        if (normalized === "OFFENSE") return "Offense";
        if (normalized === "DEFENSE") return "Defense";
        return "Unknown";
      };

      const contractStatusLooksTagged = (value) =>
        safeStr(value).toUpperCase().includes("TAG");

      const TAG_TRACKING_FALLBACK_URL =
        "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/ccc/tag_tracking.json";

      const parseTagTrackingRowsForValidation = (payload, season, leagueId) => {
        const rows = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.rows)
          ? payload.rows
          : Array.isArray(payload?.tag_tracking)
          ? payload.tag_tracking
          : [];
        return rows
          .map((row) => ({
            season: safeStr(row?.season || row?.year),
            league_id: safeStr(row?.league_id || row?.leagueId || row?.L),
            franchise_id: padFranchiseId(row?.franchise_id || row?.franchiseId || ""),
            player_id: safeStr(row?.player_id || row?.playerId || row?.id).replace(/\D/g, ""),
            player_name: safeStr(row?.player_name || row?.playerName || row?.name),
            position: safeStr(row?.position || row?.pos).toUpperCase(),
            positional_grouping: safeStr(
              row?.positional_grouping || row?.positionalGrouping || row?.pos_group
            ).toUpperCase(),
            tag_side: normalizeTagSideForCompare(row?.tag_side || row?.side),
            contract_status: safeStr(row?.contract_status || row?.contractStatus),
          }))
          .filter((row) => {
            if (!row.player_id || !row.franchise_id) return false;
            if (safeStr(season) && row.season && row.season !== safeStr(season)) return false;
            if (safeStr(leagueId) && row.league_id && row.league_id !== safeStr(leagueId)) return false;
            return true;
          });
      };

      const fetchFranchiseTaggedPlayersBySide = async (cookieHeaderOverride, season, leagueId, franchiseId) => {
        const [rostersRes, salariesRes, trackingPayload] = await Promise.all([
          mflExportJsonForCookie(
            cookieHeaderOverride,
            season,
            leagueId,
            "rosters",
            {},
            { useCookie: true }
          ),
          mflExportJsonForCookie(
            cookieHeaderOverride,
            season,
            leagueId,
            "salaries",
            {},
            { useCookie: true }
          ),
          fetchJson(TAG_TRACKING_FALLBACK_URL, {}),
        ]);
        if (!rostersRes.ok) {
          return {
            ok: false,
            error: "existing_tag_rosters_export_failed",
            details: rostersRes,
          };
        }
        if (!salariesRes.ok) {
          return {
            ok: false,
            error: "existing_tag_salaries_export_failed",
            details: salariesRes,
          };
        }

        const byFranchise = rosterRowsByFranchiseFromRostersPayload(rostersRes.data);
        const rosterPlayerFranchise = {};
        for (const [fid, rows] of Object.entries(byFranchise)) {
          for (const row of rows || []) {
            const pid = String(row?.player_id || "").replace(/\D/g, "");
            if (!pid) continue;
            rosterPlayerFranchise[pid] = fid;
          }
        }

        const trackingRows = parseTagTrackingRowsForValidation(trackingPayload, season, leagueId);
        const trackingByPlayerId = {};
        for (const row of trackingRows) {
          if (!row.player_id || trackingByPlayerId[row.player_id]) continue;
          trackingByPlayerId[row.player_id] = row;
        }

        const salaryPlayers = Array.isArray(salariesRes.data?.salaries?.leagueUnit?.player)
          ? salariesRes.data.salaries.leagueUnit.player
          : [];
        const taggedSalaryRows = salaryPlayers.filter((row) =>
          contractStatusLooksTagged(row?.contractStatus || row?.contract_status) &&
          safeInt(row?.contractYear || row?.contract_year, 0) > 0
        );
        if (!taggedSalaryRows.length) {
          return {
            ok: true,
            bySide: { OFFENSE: [], DEFENSE: [] },
            unresolved: [],
          };
        }

        const taggedIds = Array.from(
          new Set(
            taggedSalaryRows
              .map((row) => String(row?.id || row?.player_id || "").replace(/\D/g, ""))
              .filter(Boolean)
          )
        );
        let playersById = {};
        if (taggedIds.length) {
          const playersRes = await mflExportJsonForCookie(
            cookieHeaderOverride,
            season,
            leagueId,
            "players",
            { P: taggedIds.join(",") },
            { useCookie: true }
          );
          if (playersRes.ok) {
            playersById = parsePlayersExport(playersRes.data);
          }
        }

        const bySide = { OFFENSE: [], DEFENSE: [] };
        const unresolved = [];
        for (const salaryRow of taggedSalaryRows) {
          const playerId = String(salaryRow?.id || salaryRow?.player_id || "").replace(/\D/g, "");
          if (!playerId) continue;
          const trackingRow = trackingByPlayerId[playerId] || {};
          const resolvedFranchiseId = rosterPlayerFranchise[playerId] || trackingRow.franchise_id || "";
          if (resolvedFranchiseId !== franchiseId) continue;

          const playerInfo = playersById[playerId] || {};
          const position = safeStr(
            playerInfo.position || trackingRow.position || trackingRow.positional_grouping
          ).toUpperCase();
          const side =
            normalizeTagSideForCompare(trackingRow.tag_side) ||
            tagSideFromPosition(position);
          const item = {
            player_id: playerId,
            player_name: safeStr(playerInfo.player_name || trackingRow.player_name),
            position,
            contract_status: safeStr(
              salaryRow?.contractStatus || salaryRow?.contract_status || trackingRow.contract_status
            ),
            franchise_id: resolvedFranchiseId,
          };
          if (!side) {
            unresolved.push(item);
            continue;
          }
          bySide[side].push({ ...item, side });
        }

        return {
          ok: true,
          bySide,
          unresolved,
        };
      };

      const buildSalaryImportXmlFromRows = (rows) => {
        const parts = ["<salaries>", '  <leagueUnit unit="LEAGUE">'];
        for (const row of rows || []) {
          const pid = String(row?.player_id || "").replace(/\D/g, "");
          if (!pid) continue;
          parts.push(
            `    <player id="${xmlAttrEscape(pid)}" salary="${xmlAttrEscape(safeStr(row?.salary || "0"))}" contractStatus="${xmlAttrEscape(
              safeStr(row?.contract_status || "")
            )}" contractYear="${xmlAttrEscape(safeStr(row?.contract_year || "0"))}" contractInfo="${xmlAttrEscape(
              safeStr(row?.contract_info || "")
            )}" />`
          );
        }
        parts.push("  </leagueUnit>");
        parts.push("</salaries>");
        return parts.join("\n");
      };

      const compareRosterState = (sourceByFranchise, targetByFranchise) => {
        const mismatches = [];
        const franchiseIds = Array.from(new Set([...Object.keys(sourceByFranchise || {}), ...Object.keys(targetByFranchise || {})])).sort();
        for (const franchiseId of franchiseIds) {
          const sourceRows = sourceByFranchise[franchiseId] || [];
          const targetRows = targetByFranchise[franchiseId] || [];
          const sourceKeyed = new Map(sourceRows.map((row) => [row.player_id, row]));
          const targetKeyed = new Map(targetRows.map((row) => [row.player_id, row]));
          const playerIds = Array.from(new Set([...sourceKeyed.keys(), ...targetKeyed.keys()])).sort();
          for (const playerId of playerIds) {
            const src = sourceKeyed.get(playerId);
            const tgt = targetKeyed.get(playerId);
            if (!src || !tgt) {
              mismatches.push({ franchise_id: franchiseId, player_id: playerId, issue: !src ? "target_only" : "missing_in_target" });
              continue;
            }
            if (safeStr(src.status) !== safeStr(tgt.status)) {
              mismatches.push({
                franchise_id: franchiseId,
                player_id: playerId,
                issue: "status_mismatch",
                source_status: src.status,
                target_status: tgt.status,
              });
            }
            if (
              safeStr(src.salary) !== safeStr(tgt.salary) ||
              safeStr(src.contract_year) !== safeStr(tgt.contract_year) ||
              safeStr(src.contract_status) !== safeStr(tgt.contract_status) ||
              safeStr(src.contract_info) !== safeStr(tgt.contract_info)
            ) {
              mismatches.push({
                franchise_id: franchiseId,
                player_id: playerId,
                issue: "contract_mismatch",
                source_salary: src.salary,
                target_salary: tgt.salary,
                source_contract_year: src.contract_year,
                target_contract_year: tgt.contract_year,
                source_contract_status: src.contract_status,
                target_contract_status: tgt.contract_status,
              });
            }
          }
        }
        return mismatches;
      };

      const postTradeProposalImportWithFallback = async (
        season,
        importFields,
        cookieHeaderOverride = ""
      ) => {
        const postImport = safeStr(cookieHeaderOverride)
          ? (fields, probe, requestOptions = {}) =>
              postMflImportFormForCookie(
                cookieHeaderOverride,
                season,
                fields,
                probe,
                requestOptions
              )
          : (fields, probe, requestOptions = {}) =>
              postMflImportForm(season, fields, probe, requestOptions);
        const initialFields = { ...(importFields || {}) };
        const firstRes = await postImport(
          initialFields,
          initialFields,
          { method: "GET" }
        );
        if (firstRes.requestOk) {
          return {
            ok: true,
            importRes: firstRes,
            firstRes,
            retriedWithoutFranchiseId: false,
            usedFranchiseId: !!safeStr(initialFields.FRANCHISE_ID),
          };
        }

        const canRetryWithoutFranchiseId =
          !!safeStr(initialFields.FRANCHISE_ID) &&
          isImpersonationLockoutImportError(firstRes);
        if (!canRetryWithoutFranchiseId) {
          return {
            ok: false,
            importRes: firstRes,
            firstRes,
            retriedWithoutFranchiseId: false,
            usedFranchiseId: !!safeStr(initialFields.FRANCHISE_ID),
          };
        }

        const retryFields = { ...initialFields };
        delete retryFields.FRANCHISE_ID;
        const retryRes = await postImport(
          retryFields,
          retryFields,
          { method: "GET" }
        );
        return {
          ok: !!retryRes.requestOk,
          importRes: retryRes,
          firstRes,
          retryRes,
          retriedWithoutFranchiseId: true,
          usedFranchiseId: false,
        };
      };

      const trimDiagText = (value, maxLen = 50000) => {
        const raw = String(value == null ? "" : value);
        if (!raw) return "";
        return raw.length > maxLen ? raw.slice(0, maxLen) : raw;
      };

      const extractMflReasonSnippet = (value) => {
        const text = safeStr(value)
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (!text) return "";
        const m = text.match(
          /(error[^.]*|invalid[^.]*|not authorized[^.]*|not allowed[^.]*|cannot[^.]*|failed[^.]*)/i
        );
        return safeStr(m && m[0] ? m[0] : text).slice(0, 320);
      };

      const buildTradeProposalFailureDiagnostics = ({
        errorType,
        leagueId,
        season,
        actingFranchiseId,
        counterpartyFranchiseId,
        tradeProposalPayload,
        importRes,
        firstRes,
        retriedWithoutFranchiseId,
      }) => {
        const nowIso = new Date().toISOString();
        const primary = importRes || {};
        const first = firstRes || null;
        return {
          error_type: safeStr(errorType || "trade_proposal_import_failed"),
          timestamp_utc: nowIso,
          acting_franchise_id: safeStr(actingFranchiseId),
          counterparty_franchise_id: safeStr(counterpartyFranchiseId),
          league_id: safeStr(leagueId),
          season: safeStr(season),
          trade_proposal_payload:
            tradeProposalPayload && typeof tradeProposalPayload === "object"
              ? tradeProposalPayload
              : {},
          mfl_response: {
            http_status: safeInt(primary.status, 0),
            body_text: trimDiagText(primary.text || primary.upstreamPreview || primary.error || ""),
            reason_snippet: extractMflReasonSnippet(
              primary.text || primary.upstreamPreview || primary.error || ""
            ),
            target_import_url: safeStr(primary.targetImportUrl),
            form_fields: primary.formFields || {},
          },
          initial_attempt_response:
            retriedWithoutFranchiseId && first
              ? {
                  http_status: safeInt(first.status, 0),
                  body_text: trimDiagText(first.text || first.upstreamPreview || first.error || ""),
                  reason_snippet: extractMflReasonSnippet(
                    first.text || first.upstreamPreview || first.error || ""
                  ),
                  target_import_url: safeStr(first.targetImportUrl),
                  form_fields: first.formFields || {},
                }
              : null,
          retried_without_franchise_id: !!retriedWithoutFranchiseId,
        };
      };

      const buildValidationFailureDiagnostics = ({
        reason,
        leagueId,
        season,
        actingFranchiseId,
        counterpartyFranchiseId,
        tradeProposalPayload,
      }) => ({
        error_type: "validation_pre_post",
        timestamp_utc: new Date().toISOString(),
        reason: safeStr(reason || "validation_failed_before_post"),
        acting_franchise_id: safeStr(actingFranchiseId),
        counterparty_franchise_id: safeStr(counterpartyFranchiseId),
        league_id: safeStr(leagueId),
        season: safeStr(season),
        trade_proposal_payload:
          tradeProposalPayload && typeof tradeProposalPayload === "object"
            ? tradeProposalPayload
            : {},
      });

      const buildSalaryContractImportFailureDiagnostics = ({
        leagueId,
        season,
        actingFranchiseId,
        counterpartyFranchiseId,
        action,
        tradeId,
        payload,
        salaryAdjustments,
        extensions,
        taxiSync,
      }) => ({
        error_type: "salary_contract_import_failure",
        timestamp_utc: new Date().toISOString(),
        action: safeStr(action),
        trade_id: safeStr(tradeId),
        acting_franchise_id: safeStr(actingFranchiseId),
        counterparty_franchise_id: safeStr(counterpartyFranchiseId),
        league_id: safeStr(leagueId),
        season: safeStr(season),
        trade_payload:
          payload && typeof payload === "object"
            ? payload
            : {},
        salary_adjustments: salaryAdjustments || {},
        extensions: extensions || {},
        taxi_sync: taxiSync || {},
      });

      const hostFromUrl = (urlValue) => {
        const raw = safeStr(urlValue);
        if (!raw) return "";
        try {
          return safeStr(new URL(raw).host);
        } catch (_) {
          return "";
        }
      };

      const buildImportAttemptDebug = ({
        step,
        endpointUrl,
        httpStatus,
        responseText,
        parsedError,
        payloadXml,
      }) => ({
        step: safeStr(step),
        endpoint_url: safeStr(endpointUrl),
        endpoint_host: hostFromUrl(endpointUrl),
        http_status: safeInt(httpStatus, 0),
        response_excerpt: safeStr(responseText).slice(0, 500),
        parsed_error: safeStr(parsedError),
        payload_xml: payloadXml == null ? null : safeStr(payloadXml),
      });

      const logTradeProposalFailure = (details) => {
        try {
          console.error("[TWB][tradeProposal][error]", JSON.stringify(details || {}));
        } catch (_) {
          console.error("[TWB][tradeProposal][error]", details || {});
        }
      };

      const extractTradeIdFromImportText = (text) => {
        const raw = String(text || "");
        if (!raw) return "";

        try {
          const parsed = JSON.parse(raw);
          const candidates = [
            parsed?.trade_id,
            parsed?.tradeId,
            parsed?.trade?.id,
            parsed?.id,
            parsed?.result?.trade_id,
          ];
          for (const c of candidates) {
            const id = String(c == null ? "" : c).replace(/\D/g, "");
            if (id) return id;
          }
        } catch (_) {
          // non-JSON is expected in MFL import responses
        }

        const regexes = [
          /\bTRADE[_\s-]*ID\b[^0-9]{0,16}([0-9]+)/i,
          /\btrade[_\s-]*id\b[^0-9]{0,16}([0-9]+)/i,
          /<trade[^>]*\bid=["']?([0-9]+)/i,
          /<pending_trade[^>]*\bid=["']?([0-9]+)/i,
          /\bid=["']([0-9]{4,})["']/i,
        ];
        for (const re of regexes) {
          const m = raw.match(re);
          if (m && m[1]) return String(m[1]).replace(/\D/g, "");
        }
        return "";
      };

      const pickTokenFromAsset = (asset) => {
        const candidates = [
          safeStr(asset?.pick_key),
          safeStr(asset?.token),
          safeStr(asset?.pick),
          safeStr(asset?.asset_id).replace(/^pick:/i, ""),
          safeStr(asset?.description),
        ].filter(Boolean);
        for (const c of candidates) {
          const up = c.toUpperCase();
          const m = up.match(/\b(DP_[0-9]{2}_[0-9]{2}|FP_[0-9]{4}_[0-9]{4}_[0-9]+|BB_[0-9]+(?:\.[0-9]+)?)\b/);
          if (m && m[1]) return m[1];
          if (/^(DP_|FP_|BB_)/.test(up)) return up;
        }
        return "";
      };

      const parsePickSlotMeta = (value) => {
        const raw = safeStr(value).toUpperCase();
        const out = { round: 0, pick: 0 };
        if (!raw) return out;

        let m = raw.match(/(?:^|[^0-9])([1-9]\d?)\.(\d{1,2})(?:[^0-9]|$)/);
        if (m) {
          out.round = safeInt(m[1], 0);
          out.pick = safeInt(m[2], 0);
          return out;
        }

        m = raw.match(/ROUND\s*([1-9]\d?).*?PICK\s*0*([1-9]\d?)/i);
        if (m) {
          out.round = safeInt(m[1], 0);
          out.pick = safeInt(m[2], 0);
          return out;
        }

        m = raw.match(/^R(?:OUND)?\s*([1-9]\d?)$/i);
        if (m) {
          out.round = safeInt(m[1], 0);
        }
        return out;
      };

      const pickMetaFromAsset = (asset) => {
        const token = pickTokenFromAsset(asset);
        const description = safeStr(asset?.description || asset?.label || "");
        const slotText = safeStr(asset?.pick_slot || asset?.slot || asset?.pick);
        const slotMeta = parsePickSlotMeta(slotText);
        let round = safeInt(asset?.pick_round || asset?.round, 0) || safeInt(slotMeta.round, 0);
        let pick = safeInt(slotMeta.pick, 0);
        if (!pick) pick = safeInt(asset?.pick_slot || asset?.slot || asset?.pick, 0);
        let year = safeInt(asset?.pick_season || asset?.season || asset?.year, 0);

        if ((!round || !pick || !year) && token.startsWith("DP_")) {
          const dp = token.match(/^DP_(\d+)_(\d+)$/i);
          if (dp) {
            round = round || (safeInt(dp[1], 0) + 1);
            pick = pick || (safeInt(dp[2], 0) + 1);
            year = year || safeInt((description.match(/(\d{4})/) || [])[1], 0);
          }
        }

        if ((!round || !year) && token.startsWith("FP_")) {
          const fp = token.match(/^FP_[A-Z0-9]+_(\d{4})_(\d+)$/i);
          if (fp) {
            year = year || safeInt(fp[1], 0);
            round = round || safeInt(fp[2], 0);
          }
        }

        if (!round || !pick || !year) {
          const yearDraft = description.match(/Year\s*(\d{4})\s*Draft Pick\s*(\d+)\.(\d+)/i);
          if (yearDraft) {
            year = year || safeInt(yearDraft[1], 0);
            round = round || safeInt(yearDraft[2], 0);
            pick = pick || safeInt(yearDraft[3], 0);
          }
        }

        if (!round || !pick || !year) {
          const dottedPick = description.match(/(\d{4}).*?(\d+)\.(\d+)/i);
          if (dottedPick) {
            year = year || safeInt(dottedPick[1], 0);
            round = round || safeInt(dottedPick[2], 0);
            pick = pick || safeInt(dottedPick[3], 0);
          }
        }

        if (!round || !pick || !year) {
          const roundPick = description.match(/(\d{4}).*?(?:Round|Rookie)\s*(\d+).*?(?:Pick|\.)(?:\s*|0*)(\d+)/i);
          if (roundPick) {
            year = year || safeInt(roundPick[1], 0);
            round = round || safeInt(roundPick[2], 0);
            pick = pick || safeInt(roundPick[3], 0);
          }
        }

        if (!round || !year) {
          const rookieRound = description.match(/(\d{4}).*?Rookie\s*Round\s*(\d+)/i);
          if (rookieRound) {
            year = year || safeInt(rookieRound[1], 0);
            round = round || safeInt(rookieRound[2], 0);
          }
        }

        return {
          token,
          year,
          round,
          pick,
        };
      };

      const isUntradeableSixthRoundPickAsset = (asset) =>
        safeStr(asset?.type).toUpperCase() === "PICK" &&
        safeInt(pickMetaFromAsset(asset).round, 0) === 6;

      const isTaggedTradeIneligibleAsset = (asset) => {
        if (safeStr(asset?.type).toUpperCase() !== "PLAYER") return false;
        if (hasTagDeadlinePassed(YEAR)) return false;
        const contractType = safeStr(asset?.contract_type).toLowerCase();
        const contractInfo = safeStr(asset?.contract_info).toLowerCase();
        return contractType.includes("tag") || contractInfo.includes("tag");
      };

      const playerTokenFromAsset = (asset) => {
        const direct = String(asset?.player_id || "").replace(/\D/g, "");
        if (direct) return direct;
        const viaAssetId = safeStr(asset?.asset_id).match(/player:([0-9]+)/i);
        if (viaAssetId && viaAssetId[1]) return String(viaAssetId[1]).replace(/\D/g, "");
        const generic = safeStr(asset?.asset_id).replace(/\D/g, "");
        return generic || "";
      };

      const tradeTokenFromAsset = (asset) => {
        const type = safeStr(asset?.type).toUpperCase();
        if (type === "PICK") return pickTokenFromAsset(asset);
        return playerTokenFromAsset(asset);
      };

      const teamSelectedTradeTokens = (side) => {
        const selected = Array.isArray(side?.selected_assets) ? side.selected_assets : [];
        const out = [];
        const invalid = [];
        const seen = new Set();
        for (const asset of selected) {
          if (isTaggedTradeIneligibleAsset(asset)) {
            invalid.push({
              asset_id: safeStr(asset?.asset_id),
              type: safeStr(asset?.type),
              description: safeStr(asset?.description || asset?.player_name || asset?.asset_id),
              reason: "tagged players cannot be traded",
            });
            continue;
          }
          if (isUntradeableSixthRoundPickAsset(asset)) {
            invalid.push({
              asset_id: safeStr(asset?.asset_id),
              type: safeStr(asset?.type),
              description: safeStr(asset?.description || asset?.player_name || asset?.asset_id),
              reason: "6th-round picks cannot be traded",
            });
            continue;
          }
          const token = tradeTokenFromAsset(asset);
          if (!token) {
            invalid.push({
              asset_id: safeStr(asset?.asset_id),
              type: safeStr(asset?.type),
              description: safeStr(asset?.description || asset?.player_name),
            });
            continue;
          }
          if (seen.has(token)) continue;
          seen.add(token);
          out.push(token);
        }
        return { tokens: out, invalid };
      };

      const tradeSidesFromPayload = (payload) => {
        const teams = Array.isArray(payload?.teams) ? payload.teams : [];
        const left =
          teams.find((t) => safeStr(t?.role).toLowerCase() === "left") ||
          teams[0] ||
          {};
        const right =
          teams.find((t) => safeStr(t?.role).toLowerCase() === "right") ||
          teams[1] ||
          {};
        return { left, right };
      };

      const salaryNetBySideK = (leftSide, rightSide) => {
        const leftEntered = safeInt(leftSide?.traded_salary_adjustment_k, 0);
        const rightEntered = safeInt(rightSide?.traded_salary_adjustment_k, 0);
        return {
          left_net_k: leftEntered - rightEntered,
          right_net_k: rightEntered - leftEntered,
        };
      };

      const blindBidTokenFromDollars = (amountDollars) => {
        const n = Number(amountDollars);
        if (!Number.isFinite(n) || n <= 0) return "";
        const rounded = Math.round(n * 100) / 100;
        const text = rounded.toFixed(2).replace(/\.00$/, "").replace(/(\.[0-9])0$/, "$1");
        return `BB_${text}`;
      };

      const parseTradeTokenList = (raw) => {
        const text = safeStr(raw);
        if (!text) return [];
        return text
          .split(/\s*,\s*/)
          .map((s) => safeStr(s).toUpperCase())
          .filter(Boolean);
      };

      const parseBlindBidKFromToken = (token) => {
        const raw = safeStr(token).toUpperCase();
        if (!raw || !raw.startsWith("BB_")) return 0;
        const n = Number(raw.slice(3));
        if (!Number.isFinite(n) || n <= 0) return 0;
        return Math.round(n);
      };

      const pickDescriptionFromToken = (token, season) => {
        const up = safeStr(token).toUpperCase();
        if (!up) return "Rookie Pick";
        const dp = up.match(/^DP_(\d+)_(\d+)$/);
        if (dp) {
          const round = safeInt(dp[1], 0) + 1;
          const pick = safeInt(dp[2], 0) + 1;
          const yearText = safeStr(season) || "";
          return `${yearText} Rookie ${round}.${String(pick).padStart(2, "0")}`.trim();
        }
        const fp = up.match(/^FP_[A-Z0-9]+_(\d{4})_(\d+)$/);
        if (fp) {
          const year = safeStr(fp[1]);
          const round = safeInt(fp[2], 0);
          return `${year} Rookie Round ${round}`.trim();
        }
        return up;
      };

      const buildRosterStatusLookup = (rostersPayload) => {
        const franchiseRows = asArray(
          rostersPayload?.rosters?.franchise ||
            rostersPayload?.rosters?.franchises ||
            rostersPayload?.rosters?.teams
        ).filter(Boolean);
        const out = {};
        for (const franchise of franchiseRows) {
          const franchiseId = padFranchiseId(franchise?.id || franchise?.franchise_id);
          if (!franchiseId) continue;
          const playerRows = asArray(franchise?.player || franchise?.players).filter(Boolean);
          for (const playerRow of playerRows) {
            const playerId = String(playerRow?.id || playerRow?.player_id || "").replace(/\D/g, "");
            if (!playerId) continue;
            const status = safeStr(playerRow?.status).toUpperCase();
            out[`${franchiseId}|${playerId}`] = {
              status,
              is_taxi: status.includes("TAXI"),
            };
          }
        }
        return out;
      };

      const buildSelectedAssetsFromTokens = (tokens, season, franchiseId, rosterStatusLookup) => {
        const selectedAssets = [];
        let tradedSalaryK = 0;
        const seen = new Set();
        const list = Array.isArray(tokens) ? tokens : [];
        const cleanFranchiseId = padFranchiseId(franchiseId);
        for (const tokenRaw of list) {
          const token = safeStr(tokenRaw).toUpperCase();
          if (!token || seen.has(token)) continue;
          seen.add(token);
          if (token.startsWith("BB_")) {
            tradedSalaryK += parseBlindBidKFromToken(token);
            continue;
          }
          if (token.startsWith("DP_") || token.startsWith("FP_")) {
            selectedAssets.push({
              asset_id: `pick:${token}`,
              type: "PICK",
              description: pickDescriptionFromToken(token, season),
            });
            continue;
          }
          if (/^[0-9]+$/.test(token)) {
            const rosterStatus =
              rosterStatusLookup && cleanFranchiseId
                ? rosterStatusLookup[`${cleanFranchiseId}|${token}`] || null
                : null;
            selectedAssets.push({
              asset_id: `player:${token}`,
              type: "PLAYER",
              player_id: token,
              player_name: "",
              salary: 0,
              years: 0,
              contract_type: "",
              contract_info: "",
              taxi: !!(rosterStatus && rosterStatus.is_taxi),
            });
          }
        }
        return {
          selected_assets: selectedAssets,
          traded_salary_adjustment_k: tradedSalaryK,
          traded_salary_adjustment_dollars: tradedSalaryK * 1000,
        };
      };

      const buildPayloadFromOfferTokens = ({
        leagueId,
        season,
        fromFranchiseId,
        toFranchiseId,
        willGiveUp,
        willReceive,
        comment,
        rosterStatusLookup,
      }) => {
        const fromId = padFranchiseId(fromFranchiseId);
        const toId = padFranchiseId(toFranchiseId);
        if (!fromId || !toId || fromId === toId) return null;
        const leftTokens = parseTradeTokenList(willGiveUp);
        const rightTokens = parseTradeTokenList(willReceive);
        const left = buildSelectedAssetsFromTokens(leftTokens, season, fromId, rosterStatusLookup);
        const right = buildSelectedAssetsFromTokens(rightTokens, season, toId, rosterStatusLookup);
        if (!leftTokens.length || !rightTokens.length) return null;
        return {
          schema_version: 1,
          generated_at: new Date().toISOString(),
          source: "trade_action_offer_token_rebuild",
          league_id: safeStr(leagueId),
          season: safeInt(season, Number(season) || 0),
          comment: safeStr(comment),
          teams: [
            {
              role: "left",
              franchise_id: fromId,
              franchise_name: fromId,
              selected_assets: left.selected_assets,
              traded_salary_adjustment_k: left.traded_salary_adjustment_k,
              traded_salary_adjustment_dollars: left.traded_salary_adjustment_dollars,
              selected_non_taxi_salary_dollars: 0,
            },
            {
              role: "right",
              franchise_id: toId,
              franchise_name: toId,
              selected_assets: right.selected_assets,
              traded_salary_adjustment_k: right.traded_salary_adjustment_k,
              traded_salary_adjustment_dollars: right.traded_salary_adjustment_dollars,
              selected_non_taxi_salary_dollars: 0,
            },
          ],
          extension_requests: [],
          ui: {
            left_team_id: fromId,
            right_team_id: toId,
          },
        };
      };

      const buildTradeMetaTag = (payload, fromFranchiseId, toFranchiseId) => {
        const { left, right } = tradeSidesFromPayload(payload);
        const nets = salaryNetBySideK(left, right);
        const extReqs = Array.isArray(payload?.extension_requests) ? payload.extension_requests : [];
        const compact = {
          v: 1,
          ts: new Date().toISOString(),
          league_id: safeStr(payload?.league_id),
          season: safeInt(payload?.season, Number(payload?.season) || 0),
          from: padFranchiseId(fromFranchiseId || left?.franchise_id),
          to: padFranchiseId(toFranchiseId || right?.franchise_id),
          salary_net_k: {
            left: nets.left_net_k,
            right: nets.right_net_k,
          },
          ext: extReqs.map((r) => ({
            player_id: String(r?.player_id || "").replace(/\D/g, ""),
            player_name: safeStr(r?.player_name),
            from_franchise_id: padFranchiseId(r?.from_franchise_id),
            to_franchise_id: padFranchiseId(r?.to_franchise_id),
            option_key: safeStr(r?.option_key),
            extension_term: safeStr(r?.extension_term),
            new_contract_status: safeStr(r?.new_contract_status),
            new_contract_length: safeInt(r?.new_contract_length, 0),
            new_TCV: safeInt(r?.new_TCV, 0),
            new_aav_future: safeInt(r?.new_aav_future, 0),
          })),
        };
        return `[UPS_TWB_META:${base64UrlFromUtf8(JSON.stringify(compact))}]`;
      };

      const appendTradeMetaTagToComments = (
        comments,
        payload,
        fromFranchiseId,
        toFranchiseId,
        outboxTrailerText = ""
      ) => {
        const base = safeStr(comments);
        const includeCommentMeta = safeStr(env?.TWB_INCLUDE_COMMENT_META || "0") === "1";
        if (!includeCommentMeta) return base.slice(0, 2000);
        const tag = buildTradeMetaTag(payload, fromFranchiseId, toFranchiseId);
        const trailer = safeStr(outboxTrailerText);
        if (!trailer) {
          if (!base) return tag.slice(0, 2000);
          const roomForBase = 2000 - tag.length - 1;
          if (roomForBase <= 0) return tag.slice(0, 2000);
          return `${tag} ${base.slice(0, roomForBase)}`;
        }
        const trailerBlock = `\n\n${trailer}`;
        const roomForBody = 2000 - tag.length - trailerBlock.length - 1;
        if (roomForBody <= 0) return `${tag}${trailerBlock}`.slice(0, 2000);
        return `${tag} ${base.slice(0, roomForBody)}${trailerBlock}`;
      };

      const buildTradeIntentBundleFromPayload = async ({
        leagueId,
        season,
        tradeId,
        actionType,
        fromFranchiseId,
        toFranchiseId,
        payload,
        commentTrailerHint,
      }) => {
        const normalizedPayload =
          payload && typeof payload === "object"
            ? JSON.parse(JSON.stringify(payload))
            : {};
        const salaryAdjRows = buildSalaryAdjRowsFromPayload(normalizedPayload, tradeId, season);
        const salaryAdjXml = salaryAdjRows.length ? buildSalaryAdjXml(salaryAdjRows) : "";

        let extensionXml = "";
        let extensionApplied = [];
        let extensionSkipped = [];
        let salariesSource = {
          ok: false,
          status: 0,
          error: "",
          url: "",
        };
        const extReqs = Array.isArray(normalizedPayload?.extension_requests)
          ? normalizedPayload.extension_requests
          : [];
        if (extReqs.length) {
          const salariesRes = await mflExportJson(season, leagueId, "salaries");
          salariesSource = {
            ok: !!salariesRes.ok,
            status: safeInt(salariesRes.status, 0),
            error: safeStr(salariesRes.error),
            url: safeStr(salariesRes.url),
          };
          if (salariesRes.ok) {
            const salariesByPlayer = parseSalariesExportByPlayer(salariesRes.data);
            const plan = buildExtensionSalariesXmlFromPayload(normalizedPayload, salariesByPlayer);
            extensionXml = safeStr(plan.xml);
            extensionApplied = Array.isArray(plan.applied) ? plan.applied : [];
            extensionSkipped = Array.isArray(plan.skipped) ? plan.skipped : [];
          } else {
            extensionSkipped = extReqs.map((row) => ({
              reason: "failed_to_load_salaries_export",
              player_id: safeStr(row?.player_id).replace(/\D/g, ""),
              player_name: safeStr(row?.player_name),
            }));
          }
        }

        const canonical = {
          v: 1,
          league_id: safeStr(leagueId),
          season: safeStr(season),
          trade_id: safeStr(tradeId),
          action_type: safeStr(actionType || "SUBMIT").toUpperCase(),
          from_franchise_id: safeStr(fromFranchiseId),
          to_franchise_id: safeStr(toFranchiseId),
          payload_xml_extensions: extensionXml,
          payload_xml_salary_adj: salaryAdjXml,
          payload_xml_salary_trade: "",
        };
        const payloadHash = await sha256Hex(JSON.stringify(canonical));
        const trailer = buildOutboxTrailerText({
          outboxId: "",
          payloadHash,
          payloadXmlExtensions: extensionXml,
          payloadXmlSalaryAdj: salaryAdjXml,
          payloadXmlSalaryTrade: "",
        });
        return {
          canonical,
          payload_hash: payloadHash,
          payload_xml_extensions: extensionXml,
          payload_xml_salary_adj: salaryAdjXml,
          payload_xml_salary_trade: "",
          extension_applied: extensionApplied,
          extension_skipped: extensionSkipped,
          salaries_source: salariesSource,
          comment_trailer: safeStr(commentTrailerHint || trailer),
        };
      };

      const normalizeNameKey = (value) =>
        safeStr(value)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "");

      const nameVariants = (value) => {
        const raw = safeStr(value);
        if (!raw) return [];
        const out = new Set();
        out.add(normalizeNameKey(raw));
        const comma = raw.split(",");
        if (comma.length >= 2) {
          const last = safeStr(comma[0]);
          const first = safeStr(comma.slice(1).join(" "));
          if (first && last) out.add(normalizeNameKey(`${first} ${last}`));
        }
        return Array.from(out).filter(Boolean);
      };

      const parsePreTradeExtensionLines = (commentText) => {
        const text = safeStr(commentText);
        if (!text) return { entries: [], triggerCount: 0, parseFailedCount: 0 };
        const normalizedText = text.replace(/\r/g, "\n");
        const triggerMatches = normalizedText.match(/pre[\s-]*trade\s*extension\s*:/gi) || [];
        const triggerCount = triggerMatches.length;
        const out = [];
        const re = /pre[\s-]*trade\s*extension\s*:\s*extend\s+(.+?)\s+([0-9]{1,2})\s*(?:-|–|—|‑|\s)?\s*year(?:s)?\b([^.\n\r]*)/gi;
        let match;
        while ((match = re.exec(normalizedText))) {
          const rawLine = safeStr(match[0]);
          const playerName = safeStr(match[1]);
          const years = safeInt(match[2], 0);
          const rest = safeStr(match[3]);
          const newLength = safeInt((rest.match(/new\s+length\s+([0-9]+)/i) || [])[1], 0);
          const newAavK = safeInt((rest.match(/new\s+aav\s+([0-9]+)/i) || [])[1], 0);
          const newTcvK = safeInt((rest.match(/new\s+tcv\s+([0-9]+)/i) || [])[1], 0);
          out.push({
            raw_line: rawLine,
            player_name: playerName,
            extension_term: years > 0 ? `${years}YR` : "",
            new_contract_length: newLength > 0 ? newLength : null,
            new_aav_future: newAavK > 0 ? newAavK * 1000 : null,
            new_TCV: newTcvK > 0 ? newTcvK * 1000 : null,
            parse_error: years > 0 && playerName ? "" : "term_not_parsed",
          });
        }
        const parseFailedCount = Math.max(0, triggerCount - out.length);
        return {
          entries: out,
          triggerCount,
          parseFailedCount,
        };
      };

      const parseMoneyKFromText = (text, label) => {
        const re = new RegExp(`${label}\\s*([0-9][0-9,.]*)\\s*K`, "i");
        const m = safeStr(text).match(re);
        if (!m || !m[1]) return null;
        const n = Number(String(m[1]).replace(/,/g, ""));
        if (!Number.isFinite(n) || n <= 0) return null;
        return Math.round(n * 1000);
      };

      const buildPlayerSelectionIndexes = (payload) => {
        const byId = {};
        const byNameKey = {};
        const sides = tradeSidesFromPayload(payload);
        const teams = [sides.left, sides.right];
        for (const side of teams) {
          const sideId = padFranchiseId(side?.franchise_id);
          const selected = Array.isArray(side?.selected_assets) ? side.selected_assets : [];
          for (const a of selected) {
            if (safeStr(a?.type).toUpperCase() !== "PLAYER") continue;
            const playerId = String(a?.player_id || "").replace(/\D/g, "");
            if (!playerId) continue;
            const row = {
              player_id: playerId,
              player_name: safeStr(a?.player_name),
              from_franchise_id: sideId,
              asset: a,
            };
            byId[playerId] = row;
            for (const key of nameVariants(row.player_name)) {
              if (!byNameKey[key]) byNameKey[key] = row;
            }
          }
        }
        return { byId, byNameKey, leftId: padFranchiseId(sides.left?.franchise_id), rightId: padFranchiseId(sides.right?.franchise_id) };
      };

      const resolveOpposingTeamId = (fromFranchiseId, leftId, rightId) => {
        if (fromFranchiseId && leftId && rightId) {
          if (fromFranchiseId === leftId) return rightId;
          if (fromFranchiseId === rightId) return leftId;
        }
        return fromFranchiseId === leftId ? rightId : leftId;
      };

      const pickExtensionPreviewByTerm = (rows, playerId, term) => {
        const pid = String(playerId || "").replace(/\D/g, "");
        const t = safeStr(term).toUpperCase();
        if (!pid || !Array.isArray(rows) || !rows.length || !t) return null;
        const matches = rows.filter((r) => String(r?.player_id || "").replace(/\D/g, "") === pid);
        if (!matches.length) return null;
        const termMatches = matches.filter((r) => safeStr(r?.extension_term).toUpperCase() === t);
        const candidateList = termMatches.length ? termMatches : matches;
        const preferredNone = candidateList.find(
          (r) => safeStr(r?.loaded_indicator || "NONE").toUpperCase() === "NONE"
        );
        return preferredNone || candidateList[0] || null;
      };

      const buildExtensionRequestFromPreview = (seed, selection, preview, leftId, rightId) => {
        const fromFranchiseId = padFranchiseId(seed?.from_franchise_id || selection?.from_franchise_id);
        const toFranchiseId = padFranchiseId(seed?.to_franchise_id || resolveOpposingTeamId(fromFranchiseId, leftId, rightId));
        const extensionTerm = safeStr(seed?.extension_term || preview?.extension_term).toUpperCase();
        const previewInfo = safeStr(
          seed?.preview_contract_info_string ||
          preview?.preview_contract_info_string ||
          preview?.new_contract_info ||
          preview?.contract_info
        );
        const optionKey = safeStr(seed?.option_key || preview?.option_key);
        const loadedIndicator = safeStr(
          preview?.loaded_indicator ||
          (optionKey.split("|")[1] || "NONE")
        ).toUpperCase();
        const parsedTcv = parseMoneyKFromText(previewInfo, "TCV");
        return {
          player_id: String(selection?.player_id || "").replace(/\D/g, ""),
          player_name: safeStr(seed?.player_name || selection?.player_name),
          from_franchise_id: fromFranchiseId,
          to_franchise_id: toFranchiseId,
          applies_to_acquirer: true,
          option_key: optionKey || (extensionTerm ? `${extensionTerm}|${loadedIndicator || "NONE"}` : ""),
          extension_term: extensionTerm,
          loaded_indicator: loadedIndicator || "NONE",
          preview_id: preview?.preview_id == null ? null : safeInt(preview.preview_id, 0),
          preview_contract_info_string: previewInfo,
          new_contract_status: safeStr(seed?.new_contract_status || preview?.new_contract_status),
          new_contract_length:
            seed?.new_contract_length != null && safeInt(seed.new_contract_length, 0) > 0
              ? safeInt(seed.new_contract_length, 0)
              : (safeInt(preview?.new_contract_length, 0) > 0
                  ? safeInt(preview.new_contract_length, 0)
                  : contractLengthFromInfo(previewInfo)),
          new_TCV:
            seed?.new_TCV != null && safeInt(seed.new_TCV, 0) > 0
              ? safeInt(seed.new_TCV, 0)
              : (safeInt(preview?.new_TCV, 0) > 0
                  ? safeInt(preview.new_TCV, 0)
                  : parsedTcv),
          new_aav_future:
            seed?.new_aav_future != null && safeInt(seed.new_aav_future, 0) > 0
              ? safeInt(seed.new_aav_future, 0)
              : (safeInt(preview?.new_aav_future, 0) > 0 ? safeInt(preview.new_aav_future, 0) : null),
        };
      };

      const prepareExtensionRequestsFromOfferContext = async ({
        payload,
        season,
        queryParams,
        offerComment,
        offerMeta,
        tradeId,
      }) => {
        const out = {
          expected_extension_count: 0,
          prepared_count: 0,
          source: "existing_payload",
          comment_field_used: "",
          raw_comment_excerpt: "",
          extension_trigger_found: false,
          parse_rows: [],
          skipped_rows: [],
        };
        const inputPayload =
          payload && typeof payload === "object"
            ? JSON.parse(JSON.stringify(payload))
            : {};
        const commentSources = [
          { field: "offer_comment", text: safeStr(offerComment) },
          { field: "payload.comment", text: safeStr(inputPayload.comment) },
          { field: "payload.comments", text: safeStr(inputPayload.comments) },
          { field: "payload.notes", text: safeStr(inputPayload.notes) },
          { field: "payload.message", text: safeStr(inputPayload.message) },
          { field: "payload.raw_comment", text: safeStr(inputPayload.raw_comment) },
        ].filter((row) => !!row.text);
        const primaryComment = commentSources[0] || { field: "", text: "" };
        const combinedComment = commentSources.map((row) => row.text).join("\n");
        out.comment_field_used = primaryComment.field || "none";
        out.raw_comment_excerpt = safeStr(primaryComment.text || combinedComment).slice(0, 500);
        const existing = Array.isArray(inputPayload.extension_requests) ? inputPayload.extension_requests : [];
        const indexes = buildPlayerSelectionIndexes(inputPayload);
        const meta =
          (offerMeta && typeof offerMeta === "object" ? offerMeta : null) ||
          parseTradeMetaTagFromComments(combinedComment || "");
        const metaExt = Array.isArray(meta?.ext) ? meta.ext : [];
        const prepared = [];
        const preparedByPlayerId = {};
        if (existing.length) {
          out.expected_extension_count = existing.length;
          out.extension_trigger_found = true;
          for (const row of existing) {
            const playerId = String(row?.player_id || "").replace(/\D/g, "");
            const hasPreview = !!safeStr(row?.preview_contract_info_string);
            if (playerId && hasPreview) {
              prepared.push(JSON.parse(JSON.stringify(row)));
              preparedByPlayerId[playerId] = true;
              out.parse_rows.push({
                source: "payload.extension_requests",
                parsed_player_name: safeStr(row?.player_name),
                parsed_term: safeStr(row?.extension_term),
                resolved_player_id: playerId,
                eligibility: "eligible",
                reason: "",
              });
              continue;
            }
            out.skipped_rows.push({
              reason: hasPreview ? "no_player_id" : "missing_preview_contract_info_string",
              player_id: playerId,
              player_name: safeStr(row?.player_name),
            });
            out.parse_rows.push({
              source: "payload.extension_requests",
              parsed_player_name: safeStr(row?.player_name),
              parsed_term: safeStr(row?.extension_term),
              resolved_player_id: playerId,
              eligibility: hasPreview ? "unknown" : "eligible",
              reason: hasPreview ? "no_player_id" : "payload_incomplete",
            });
          }
          if (prepared.length === existing.length) {
            out.prepared_count = prepared.length;
            out.payload = inputPayload;
            try {
              console.log(
                "[TWB][extensions][context]",
                JSON.stringify({
                  trade_id: safeStr(tradeId),
                  timestamp_utc: new Date().toISOString(),
                  extension_trigger_found: true,
                  source: "payload.extension_requests",
                  comment_sources_count: commentSources.length,
                  prepared_extension_count: prepared.length,
                })
              );
            } catch (_) {
              // noop
            }
            return out;
          }
        }
        const parsedLinesBundle = parsePreTradeExtensionLines(combinedComment || "");
        const parsedLines = Array.isArray(parsedLinesBundle.entries) ? parsedLinesBundle.entries : [];
        const triggerCount = safeInt(parsedLinesBundle.triggerCount, 0);
        const parseFailedCount = safeInt(parsedLinesBundle.parseFailedCount, 0);
        out.extension_trigger_found = triggerCount > 0 || metaExt.length > 0;

        const attemptFromComments = async (sourceLabel) => {
          const validLines = parsedLines.filter((line) => !line.parse_error);
          out.source = sourceLabel;
          out.expected_extension_count = Math.max(out.expected_extension_count, triggerCount || validLines.length);
          if (!triggerCount && !validLines.length) return;

          if (parseFailedCount > 0 && !validLines.length) {
            out.skipped_rows.push({
              reason: "extension_parse_failed",
              trigger_count: triggerCount,
              parse_failed_count: parseFailedCount,
              raw_comment_excerpt: safeStr(combinedComment).slice(0, 500),
            });
            out.parse_rows.push({
              source: sourceLabel,
              parsed_player_name: "",
              parsed_term: "",
              resolved_player_id: "",
              eligibility: "unknown",
              reason: "extension_parse_failed",
            });
          }

          var i;
          for (i = 0; i < parsedLines.length; i += 1) {
            if (!parsedLines[i].parse_error) continue;
            out.skipped_rows.push({
              reason: "term_not_parsed",
              raw_line: parsedLines[i].raw_line,
              player_name: parsedLines[i].player_name,
            });
            out.parse_rows.push({
              source: sourceLabel,
              parsed_player_name: safeStr(parsedLines[i].player_name),
              parsed_term: safeStr(parsedLines[i].extension_term),
              resolved_player_id: "",
              eligibility: "unknown",
              reason: "term_not_parsed",
            });
          }

          if (!validLines.length) return;
          const previewRes = await fetchExtensionPreviewRows(season, queryParams || new URLSearchParams());
          const previewRows = previewRes.ok && Array.isArray(previewRes.rows) ? previewRes.rows : [];
          if (!previewRows.length) {
            for (const line of validLines) {
              out.skipped_rows.push({
                reason: "extension_previews_unavailable",
                player_name: line.player_name,
                extension_term: line.extension_term,
              });
              out.parse_rows.push({
                source: sourceLabel,
                parsed_player_name: safeStr(line.player_name),
                parsed_term: safeStr(line.extension_term),
                resolved_player_id: "",
                eligibility: "unknown",
                reason: "extension_previews_unavailable",
              });
            }
            return;
          }

          for (const line of validLines) {
            const keys = nameVariants(line.player_name);
            let selection = null;
            for (const key of keys) {
              if (indexes.byNameKey[key]) {
                selection = indexes.byNameKey[key];
                break;
              }
            }
            if (!selection) {
              out.skipped_rows.push({
                reason: "player_not_resolved",
                player_name: line.player_name,
                extension_term: line.extension_term,
              });
              out.parse_rows.push({
                source: sourceLabel,
                parsed_player_name: safeStr(line.player_name),
                parsed_term: safeStr(line.extension_term),
                resolved_player_id: "",
                eligibility: "unknown",
                reason: "player_not_resolved",
              });
              continue;
            }
            const preview = pickExtensionPreviewByTerm(
              previewRows,
              selection.player_id,
              line.extension_term
            );
            if (!preview) {
              out.skipped_rows.push({
                reason: "not_eligible",
                player_id: selection.player_id,
                player_name: selection.player_name,
                extension_term: line.extension_term,
              });
              out.parse_rows.push({
                source: sourceLabel,
                parsed_player_name: safeStr(line.player_name),
                parsed_term: safeStr(line.extension_term),
                resolved_player_id: safeStr(selection.player_id),
                eligibility: "not_eligible",
                reason: "not_eligible",
              });
              continue;
            }
            const req = buildExtensionRequestFromPreview(
              line,
              selection,
              preview,
              indexes.leftId,
              indexes.rightId
            );
            if (!safeStr(req.preview_contract_info_string)) {
              out.skipped_rows.push({
                reason: "payload_invalid",
                player_id: selection.player_id,
                player_name: selection.player_name,
                extension_term: line.extension_term,
              });
              out.parse_rows.push({
                source: sourceLabel,
                parsed_player_name: safeStr(line.player_name),
                parsed_term: safeStr(line.extension_term),
                resolved_player_id: safeStr(selection.player_id),
                eligibility: "eligible",
                reason: "payload_invalid",
              });
              continue;
            }
            if (preparedByPlayerId[String(selection.player_id || "").replace(/\D/g, "")]) continue;
            out.parse_rows.push({
              source: sourceLabel,
              parsed_player_name: safeStr(line.player_name),
              parsed_term: safeStr(line.extension_term),
              resolved_player_id: safeStr(selection.player_id),
              eligibility: "eligible",
              reason: "",
            });
            prepared.push(req);
            preparedByPlayerId[String(selection.player_id || "").replace(/\D/g, "")] = true;
          }
        };

        if (metaExt.length) {
          out.source = "twb_meta";
          out.expected_extension_count = Math.max(out.expected_extension_count, metaExt.length);
          for (const item of metaExt) {
            const playerId = String(item?.player_id || "").replace(/\D/g, "");
            if (!playerId) {
              out.skipped_rows.push({ reason: "no_player_id", item });
              out.parse_rows.push({
                source: "twb_meta",
                parsed_player_name: safeStr(item?.player_name),
                parsed_term: safeStr(item?.extension_term),
                resolved_player_id: "",
                eligibility: "unknown",
                reason: "no_player_id",
              });
              continue;
            }
            const selection = indexes.byId[playerId];
            if (!selection) {
              out.skipped_rows.push({ reason: "player_not_in_selected_assets", player_id: playerId, item });
              out.parse_rows.push({
                source: "twb_meta",
                parsed_player_name: safeStr(item?.player_name),
                parsed_term: safeStr(item?.extension_term),
                resolved_player_id: safeStr(playerId),
                eligibility: "unknown",
                reason: "player_not_in_selected_assets",
              });
              continue;
            }
            const req = buildExtensionRequestFromPreview(item, selection, item, indexes.leftId, indexes.rightId);
            if (!safeStr(req.preview_contract_info_string)) {
              out.skipped_rows.push({ reason: "missing_preview_contract_info_string", player_id: playerId, item });
              out.parse_rows.push({
                source: "twb_meta",
                parsed_player_name: safeStr(item?.player_name || selection?.player_name),
                parsed_term: safeStr(item?.extension_term),
                resolved_player_id: safeStr(playerId),
                eligibility: "eligible",
                reason: "payload_invalid",
              });
              continue;
            }
            if (preparedByPlayerId[playerId]) continue;
            out.parse_rows.push({
              source: "twb_meta",
              parsed_player_name: safeStr(item?.player_name || selection?.player_name),
              parsed_term: safeStr(item?.extension_term),
              resolved_player_id: safeStr(playerId),
              eligibility: "eligible",
              reason: "",
            });
            prepared.push(req);
            preparedByPlayerId[playerId] = true;
          }
          if (!prepared.length) {
            await attemptFromComments("twb_meta+comment_fallback");
          }
        } else {
          await attemptFromComments(triggerCount > 0 ? "comment_lines" : "none");
        }

        inputPayload.extension_requests = prepared;
        out.prepared_count = prepared.length;
        out.payload = inputPayload;
        try {
          console.log(
            "[TWB][extensions][context]",
            JSON.stringify({
              trade_id: safeStr(tradeId),
              timestamp_utc: new Date().toISOString(),
              raw_comment_text: safeStr(combinedComment).slice(0, 500),
              extension_trigger_found: triggerCount > 0 || metaExt.length > 0,
              parsed_trigger_count: triggerCount,
              parsed_extension_count: parsedLines.length,
              prepared_extension_count: out.prepared_count,
              source: out.source,
              skip_reason: (out.skipped_rows[0] && (out.skipped_rows[0].reason || out.skipped_rows[0].parse_error)) || "",
            })
          );
        } catch (_) {
          // noop
        }
        return out;
      };

      const buildTradeProposalAssetLists = (payload) => {
        const { left, right } = tradeSidesFromPayload(payload);
        const leftTokensOut = teamSelectedTradeTokens(left);
        const rightTokensOut = teamSelectedTradeTokens(right);
        const salaryNets = salaryNetBySideK(left, right);
        const leftBb = blindBidTokenFromDollars(Math.max(0, salaryNets.left_net_k) * 1000);
        const rightBb = blindBidTokenFromDollars(Math.max(0, salaryNets.right_net_k) * 1000);
        if (leftBb) leftTokensOut.tokens.push(leftBb);
        if (rightBb) rightTokensOut.tokens.push(rightBb);

        const willGiveUp = Array.from(new Set(leftTokensOut.tokens.filter(Boolean)));
        const willReceive = Array.from(new Set(rightTokensOut.tokens.filter(Boolean)));
        return {
          left,
          right,
          leftTokensOut,
          rightTokensOut,
          willGiveUp,
          willReceive,
          salaryNets,
          isValid:
            !!willGiveUp.length &&
            !!willReceive.length &&
            !leftTokensOut.invalid.length &&
            !rightTokensOut.invalid.length,
        };
      };

      const pendingTradesRows = (pendingTradesPayload) => {
        const root = pendingTradesPayload?.pendingTrades || pendingTradesPayload?.pendingtrades || {};
        return asArray(
          root?.pendingTrade ||
            root?.pendingtrade ||
            root?.trade ||
            root?.trades
        ).filter(Boolean);
      };

      const readPendingTradeField = (row, candidateKeys) => {
        if (!row || typeof row !== "object") return "";
        const directKeys = Array.isArray(candidateKeys) ? candidateKeys : [];
        for (const key of directKeys) {
          const value = safeStr(row?.[key]);
          if (value) return value;
        }
        const lowered = {};
        for (const [k, v] of Object.entries(row || {})) {
          lowered[String(k || "").toLowerCase()] = v;
        }
        for (const key of directKeys) {
          const value = safeStr(lowered[String(key || "").toLowerCase()]);
          if (value) return value;
        }
        return "";
      };

      const extractPendingTradeComment = (row) => {
        const direct = readPendingTradeField(row, [
          "comments",
          "comment",
          "notes",
          "note",
          "message",
          "msg",
          "trade_comment",
          "trade_comments",
          "offer_comment",
          "offer_comments",
          "comments_text",
          "comment_text",
        ]);
        if (direct) return direct;
        const allStringValues = [];
        const seen = new Set();
        const visit = (node, depth = 0) => {
          if (node == null || depth > 6) return;
          if (typeof node === "string") {
            const text = safeStr(node);
            if (text) allStringValues.push(text);
            return;
          }
          if (typeof node !== "object") return;
          if (seen.has(node)) return;
          seen.add(node);
          if (Array.isArray(node)) {
            for (const item of node) visit(item, depth + 1);
            return;
          }
          for (const value of Object.values(node)) visit(value, depth + 1);
        };
        visit(row, 0);
        if (allStringValues.length) {
          const withMeta = allStringValues.find((v) => /\[UPS_TWB_META:/i.test(v));
          if (withMeta) return withMeta;
          const withTrigger = allStringValues.find((v) => /pre[\s-]*trade\s*extension\s*:/i.test(v));
          if (withTrigger) return withTrigger;
          const likelyTradeMessage = allStringValues.find(
            (v) =>
              /extend/i.test(v) &&
              /year/i.test(v) &&
              !/^(DP_|FP_|BB_)/i.test(v)
          );
          if (likelyTradeMessage) return likelyTradeMessage;
        }
        const fallbackEntries = Object.entries(row || {}).filter(([k, v]) => {
          if (!safeStr(v)) return false;
          return /(comment|message|note)/i.test(String(k || ""));
        });
        if (!fallbackEntries.length) return "";
        fallbackEntries.sort((a, b) => safeStr(b[1]).length - safeStr(a[1]).length);
        return safeStr(fallbackEntries[0][1]);
      };

      const normalizePendingTradeRow = (row) => {
        const tradeId = String(
          readPendingTradeField(row, [
            "trade_id",
            "tradeId",
            "TRADE_ID",
            "tradeid",
            "id",
            "proposal_id",
            "proposalId",
            "pending_trade_id",
            "pendingTradeId",
          ])
        ).replace(/\D/g, "");
        const fromId = padFranchiseId(
          readPendingTradeField(row, [
            "offeringteam",
            "offering_team",
            "offeringteamid",
            "offering_team_id",
            "offeredfrom",
            "from_franchise_id",
            "fromfranchiseid",
            "franchise_id",
            "franchise",
            "from",
            "from_team_id",
            "fromteamid",
          ])
        );
        const toId = padFranchiseId(
          readPendingTradeField(row, [
            "offeredto",
            "offered_to",
            "to_franchise_id",
            "tofranchiseid",
            "target_franchise_id",
            "targetfranchiseid",
            "to",
            "to_team_id",
            "toteamid",
          ])
        );
        const ts = safeInt(
          readPendingTradeField(row, [
            "timestamp",
            "created",
            "created_at",
            "create_time",
            "createdAt",
            "offerTime",
          ]),
          0
        );
        const commentsRaw = extractPendingTradeComment(row);
        return {
          trade_id: tradeId,
          from_franchise_id: fromId,
          to_franchise_id: toId,
          timestamp: ts,
          comments: commentsRaw,
          raw_comment: commentsRaw,
          will_give_up: readPendingTradeField(row, [
            "will_give_up",
            "willGiveUp",
            "WILL_GIVE_UP",
            "offer_from",
            "offered_from",
            "offering_assets",
            "offeringPlayers",
          ]),
          will_receive: readPendingTradeField(row, [
            "will_receive",
            "willReceive",
            "WILL_RECEIVE",
            "offer_to",
            "offered_to",
            "requested_assets",
            "requestedPlayers",
          ]),
          raw: row,
        };
      };

      const parseTradeMetaTagFromComments = (comments) => {
        const text = safeStr(comments);
        if (!text) return null;
        const m = text.match(/\[UPS_TWB_META:([A-Za-z0-9_-]+)\]/);
        if (!m || !m[1]) return null;
        const decoded = decodeBase64UrlUtf8(m[1]);
        if (!decoded) return null;
        try {
          const parsed = JSON.parse(decoded);
          return parsed && typeof parsed === "object" ? parsed : null;
        } catch (_) {
          return null;
        }
      };

      const stripTradeMetaTagFromComments = (comments) =>
        safeStr(comments)
          .replace(/\[UPS_TWB_INTENT_BEGIN\][\s\S]*?\[UPS_TWB_INTENT_END\]/gi, " ")
          .replace(/\s*\[UPS_TWB_META:[A-Za-z0-9_-]+\]\s*/g, " ")
          .replace(/\s+/g, " ")
          .trim();

      const timestampToIso = (value) => {
        const ts = safeInt(value, 0);
        if (!ts) return "";
        const ms = ts > 1000000000000 ? ts : ts * 1000;
        const d = new Date(ms);
        return Number.isFinite(d.getTime()) ? d.toISOString() : "";
      };

      const parseLeagueFranchiseNameMap = (leaguePayload) => {
        const leagueRoot = leaguePayload?.league || leaguePayload || {};
        const rows = asArray(
          leagueRoot?.franchise ||
            leagueRoot?.franchises ||
            leagueRoot?.teams ||
            leagueRoot?.franchiseunit
        ).filter(Boolean);
        const out = {};
        for (const row of rows) {
          const id = padFranchiseId(row?.id || row?.franchise_id || row?.franchise);
          if (!id) continue;
          const name = safeStr(
            row?.name ||
              row?.franchise_name ||
              row?.franchiseName ||
              row?.team_name
          );
          if (name) out[id] = name;
        }
        return out;
      };

      const pendingMatchKeyFromOffer = (offer) =>
        [padFranchiseId(offer?.from_franchise_id), padFranchiseId(offer?.to_franchise_id)].join("|");

      const buildStoredOfferIndexes = (offers) => {
        const byTradeId = new Map();
        const byPair = new Map();
        const list = Array.isArray(offers) ? offers : [];
        for (const raw of list) {
          const o = raw && typeof raw === "object" ? raw : {};
          const tradeId = String(o?.mfl_trade_id || o?.trade_id || "").replace(/\D/g, "");
          if (tradeId && !byTradeId.has(tradeId)) byTradeId.set(tradeId, o);
          const pairKey = pendingMatchKeyFromOffer(o);
          if (!pairKey || pairKey === "|") continue;
          if (!byPair.has(pairKey)) byPair.set(pairKey, []);
          byPair.get(pairKey).push(o);
        }
        return { byTradeId, byPair };
      };

      const matchStoredOfferForPendingRow = (row, storedIndexes) => {
        const tradeId = safeStr(row?.trade_id).replace(/\D/g, "");
        if (tradeId && storedIndexes.byTradeId.has(tradeId)) {
          return storedIndexes.byTradeId.get(tradeId);
        }
        const pairKey = [padFranchiseId(row?.from_franchise_id), padFranchiseId(row?.to_franchise_id)].join("|");
        const candidates = storedIndexes.byPair.get(pairKey) || [];
        if (!candidates.length) return null;
        if (candidates.length === 1) return candidates[0];

        const rowComment = stripTradeMetaTagFromComments(row?.raw_comment || row?.comments);
        const rowCommentLower = rowComment.toLowerCase();
        if (rowCommentLower) {
          for (const c of candidates) {
            const cMessage = safeStr(c?.message || c?.comment || c?.action_message || "").toLowerCase();
            if (!cMessage) continue;
            if (cMessage === rowCommentLower) return c;
          }
        }

        const rowTs = safeInt(row?.timestamp, 0);
        if (rowTs) {
          let best = candidates[0];
          let bestDelta = Number.POSITIVE_INFINITY;
          for (const c of candidates) {
            const cTsMs = Date.parse(String(c?.created_at || c?.updated_at || ""));
            const cTs = Number.isFinite(cTsMs) ? Math.round(cTsMs / 1000) : 0;
            if (!cTs) continue;
            const delta = Math.abs(cTs - rowTs);
            if (delta < bestDelta) {
              best = c;
              bestDelta = delta;
            }
          }
          return best;
        }

        return candidates[0];
      };

      const normalizePendingProposal = (row, franchiseNames, includePayload, storedOffer) => {
        const fromId = padFranchiseId(row?.from_franchise_id);
        const toId = padFranchiseId(row?.to_franchise_id);
        const tradeId = safeStr(row?.trade_id).replace(/\D/g, "");
        const createdAt = timestampToIso(row?.timestamp);
        const stored = storedOffer && typeof storedOffer === "object" ? storedOffer : {};
        const storedCommentsRaw = safeStr(
          stored.raw_comment ||
            stored.comments ||
            stored.comment ||
            stored.message
        );
        const commentsRaw = safeStr(row?.raw_comment || row?.comments || storedCommentsRaw);
        const commentsClean = stripTradeMetaTagFromComments(commentsRaw);
        const meta =
          parseTradeMetaTagFromComments(commentsRaw) ||
          (stored.twb_meta && typeof stored.twb_meta === "object" ? stored.twb_meta : null);
        const fromName =
          safeStr(
            (franchiseNames && franchiseNames[fromId]) ||
              row?.raw?.offeringteamname ||
              row?.raw?.offering_team_name ||
              row?.raw?.from_franchise_name
          ) || fromId;
        const toName =
          safeStr(
            (franchiseNames && franchiseNames[toId]) ||
              row?.raw?.offeredtoname ||
              row?.raw?.to_franchise_name
          ) || toId;
        const out = {
          id: safeStr(stored.id) || (tradeId ? `MFL-${tradeId}` : `MFL-${fromId}-${toId}-${safeInt(row?.timestamp, 0)}`),
          proposal_id: tradeId || "",
          mfl_trade_id: tradeId || null,
          trade_id: tradeId || null,
          status: "PENDING",
          mfl_present: true,
          mfl_status: "PENDING",
          from_franchise_id: fromId,
          to_franchise_id: toId,
          from_franchise_name: fromName,
          to_franchise_name: toName,
          created_ts: safeInt(row?.timestamp, 0),
          created_at: createdAt || null,
          comment: commentsClean || commentsRaw || "",
          raw_comment: commentsRaw || "",
          message: commentsClean || commentsRaw || "",
          will_give_up: safeStr(row?.will_give_up || stored.will_give_up),
          will_receive: safeStr(row?.will_receive || stored.will_receive),
          twb_meta: meta,
          source: safeStr(stored.source || "mfl_pendingTrades"),
          summary: stored && typeof stored.summary === "object" ? stored.summary : null,
        };
        if (includePayload && stored && stored.payload && typeof stored.payload === "object") {
          out.payload = stored.payload;
        }
        return out;
      };

      const loadLivePendingProposals = async ({
        leagueId,
        season,
        franchiseId,
        includePayload,
        statusFilter,
        limit,
      }) => {
        if (!viewerCookieHeader) {
          return {
            ok: false,
            status: 500,
            error: "Missing MFL owner session for pending trade lookup",
            pendingLookup: {
              ok: false,
              rows_count: 0,
              upstream_status: 0,
              error: "Missing MFL owner session for pending trade lookup",
            },
            proposals: [],
            incoming: [],
            outgoing: [],
            related: [],
          };
        }

        const pendingRes = await loadPendingTradesExportAsViewer(
          season,
          leagueId,
          franchiseId
        );
        if (!pendingRes.ok) {
          return {
            ok: false,
            status: 502,
            error: "Failed to load pendingTrades from MFL",
            pendingLookup: {
              ok: false,
              rows_count: 0,
              upstream_status: pendingRes.status || 0,
              error: safeStr(pendingRes.error || "pendingTrades lookup failed"),
            },
            upstream: {
              status: pendingRes.status || 0,
              url: pendingRes.url || "",
              error: pendingRes.error || "",
              preview: pendingRes.textPreview || "",
            },
            proposals: [],
            incoming: [],
            outgoing: [],
            related: [],
          };
        }

        let franchiseNames = {};
        try {
          const leagueRes = await mflExportJson(season, leagueId, "league");
          if (leagueRes.ok) franchiseNames = parseLeagueFranchiseNameMap(leagueRes.data);
        } catch (_) {
          franchiseNames = {};
        }

        let storedOffers = [];
        try {
          const loaded = await readTradeOffersDoc(leagueId, season);
          if (loaded.ok) storedOffers = Array.isArray(loaded.doc?.offers) ? loaded.doc.offers : [];
        } catch (_) {
          storedOffers = [];
        }
        const storedIndexes = buildStoredOfferIndexes(storedOffers);

        const pendingRowsAll = pendingTradesRows(pendingRes.data)
          .map(normalizePendingTradeRow)
          .filter((r) => !!safeStr(r.trade_id || r.from_franchise_id || r.to_franchise_id));
        const dedupe = new Set();
        const normalized = [];
        for (const row of pendingRowsAll) {
          const key = safeStr(row.trade_id) || [row.from_franchise_id, row.to_franchise_id, row.timestamp, row.raw_comment || row.comments].join("|");
          if (dedupe.has(key)) continue;
          dedupe.add(key);
          const stored = matchStoredOfferForPendingRow(row, storedIndexes);
          normalized.push(normalizePendingProposal(row, franchiseNames, includePayload, stored));
        }
        normalized.sort((a, b) => {
          const aTs = safeInt(a.created_ts, 0);
          const bTs = safeInt(b.created_ts, 0);
          if (aTs !== bTs) return bTs - aTs;
          return safeStr(b.proposal_id).localeCompare(safeStr(a.proposal_id));
        });

        const related = franchiseId
          ? normalized.filter(
              (o) =>
                padFranchiseId(o.from_franchise_id) === franchiseId ||
                padFranchiseId(o.to_franchise_id) === franchiseId
            )
          : normalized.slice();
        const incoming = franchiseId
          ? normalized.filter((o) => padFranchiseId(o.to_franchise_id) === franchiseId)
          : [];
        const outgoing = franchiseId
          ? normalized.filter((o) => padFranchiseId(o.from_franchise_id) === franchiseId)
          : [];

        const filterByStatus = (rows) => {
          const normalizedStatus = offerStatusNormalized(statusFilter, "");
          if (!normalizedStatus) return rows;
          if (normalizedStatus !== "PENDING") return [];
          return rows;
        };
        const maxRows = Math.max(1, Math.min(300, safeInt(limit, 50)));

        return {
          ok: true,
          status: 200,
          pendingLookup: {
            ok: true,
            rows_count: normalized.length,
            upstream_status: pendingRes.status || 0,
            error: "",
          },
          proposals: filterByStatus(related).slice(0, maxRows),
          incoming: filterByStatus(incoming).slice(0, maxRows),
          outgoing: filterByStatus(outgoing).slice(0, maxRows),
          related: filterByStatus(related).slice(0, maxRows),
          counts: {
            total: normalized.length,
            related_total: related.length,
            incoming_total: incoming.length,
            outgoing_total: outgoing.length,
            incoming_pending: incoming.length,
            outgoing_pending: outgoing.length,
            incoming_mfl_present_pending: incoming.length,
            outgoing_mfl_present_pending: outgoing.length,
          },
          generatedAt: new Date().toISOString(),
        };
      };

      const findStoredOfferForDirectAction = (offers, lookup = {}) => {
        const list = Array.isArray(offers) ? offers : [];
        if (!list.length) return null;
        const tradeId = safeStr(lookup?.tradeId).replace(/\D/g, "");
        const offerId = safeStr(lookup?.offerId);
        const fromId = padFranchiseId(lookup?.fromFranchiseId);
        const toId = padFranchiseId(lookup?.toFranchiseId);
        const actingId = padFranchiseId(lookup?.actingFranchiseId);

        if (tradeId) {
          const byTrade = list.find(
            (o) =>
              String(o?.mfl_trade_id || o?.trade_id || "").replace(/\D/g, "") === tradeId
          );
          if (byTrade) return byTrade;
        }
        if (offerId) {
          const byId = list.find((o) => safeStr(o?.id) === offerId);
          if (byId) return byId;
        }
        if (fromId && toId) {
          const pendingPair = list.filter(
            (o) =>
              padFranchiseId(o?.from_franchise_id) === fromId &&
              padFranchiseId(o?.to_franchise_id) === toId &&
              offerStatusNormalized(o?.status, "PENDING") === "PENDING"
          );
          if (pendingPair.length === 1) return pendingPair[0];
          if (pendingPair.length > 1) {
            pendingPair.sort((a, b) =>
              safeStr(b?.updated_at || b?.created_at).localeCompare(
                safeStr(a?.updated_at || a?.created_at)
              )
            );
            return pendingPair[0];
          }
        }
        if (actingId) {
          const relatedPending = list.filter((o) => {
            const status = offerStatusNormalized(o?.status, "PENDING");
            if (status !== "PENDING") return false;
            return (
              padFranchiseId(o?.from_franchise_id) === actingId ||
              padFranchiseId(o?.to_franchise_id) === actingId
            );
          });
          if (relatedPending.length === 1) return relatedPending[0];
        }
        return null;
      };

      const syncDirectMflOfferToStorage = async ({
        leagueId,
        season,
        offerId,
        resolvedTradeId,
        fromFranchiseId,
        toFranchiseId,
        fromFranchiseName,
        toFranchiseName,
        message,
        commentsOut,
        willGiveUp,
        willReceive,
        payload,
        source,
      }) => {
        if (!githubPat) {
          return {
            storedOffer: null,
            storageSync: {
              ok: false,
              skipped: true,
              reason: "missing_github_pat",
            },
          };
        }

        let attempts = 0;
        let storedOffer = null;
        let storageSync = {
          ok: false,
          skipped: true,
          reason: "not_attempted",
        };
        while (attempts < 2) {
          attempts += 1;
          const loaded = await readTradeOffersDoc(leagueId, season);
          if (!loaded.ok) {
            storageSync = {
              ok: false,
              skipped: true,
              reason: loaded.error || "storage_read_failed",
            };
            break;
          }
          const doc = normalizeTradeOffersDoc(loaded.doc, leagueId, season);
          const offers = Array.isArray(doc.offers) ? doc.offers : [];
          const existing = findStoredOfferForDirectAction(offers, {
            tradeId: resolvedTradeId,
            offerId,
            fromFranchiseId,
            toFranchiseId,
          });
          const idx = existing ? offers.indexOf(existing) : -1;

          const nowIso = new Date().toISOString();
          const normalizedId =
            safeStr(existing?.id) ||
            (resolvedTradeId
              ? `MFL-${resolvedTradeId}`
              : `TWB-${(crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).toString()}`);
          const rawComment = safeStr(commentsOut);
          const cleanComment = stripTradeMetaTagFromComments(rawComment);
          const twbMeta = parseTradeMetaTagFromComments(rawComment);
          const giveUpCsv = Array.isArray(willGiveUp)
            ? willGiveUp.filter(Boolean).join(",")
            : safeStr(willGiveUp);
          const receiveCsv = Array.isArray(willReceive)
            ? willReceive.filter(Boolean).join(",")
            : safeStr(willReceive);

          const nextOffer = {
            ...(existing || {}),
            id: normalizedId,
            league_id: leagueId,
            season: safeInt(season, Number(season) || 0),
            status: "PENDING",
            created_at: safeStr(existing?.created_at) || nowIso,
            updated_at: nowIso,
            from_franchise_id: fromFranchiseId,
            to_franchise_id: toFranchiseId,
            from_franchise_name: fromFranchiseName || fromFranchiseId,
            to_franchise_name: toFranchiseName || toFranchiseId,
            message: message || cleanComment || rawComment,
            comment: cleanComment || rawComment,
            comments: cleanComment || rawComment,
            raw_comment: rawComment,
            will_give_up: giveUpCsv,
            will_receive: receiveCsv,
            source: safeStr(source || "trade-workbench-ui"),
            summary: summarizeOfferPayload(payload),
            payload,
            twb_meta: twbMeta,
            mfl_trade_id: resolvedTradeId || null,
            trade_id: resolvedTradeId || null,
            mfl_present: true,
            mfl_status: "PENDING",
          };

          if (idx >= 0) offers[idx] = nextOffer;
          else offers.push(nextOffer);

          const saveOut = await writeTradeOffersDoc(
            leagueId,
            season,
            doc,
            loaded.sha,
            `feat(trades): sync direct mfl offer ${normalizedId}`
          );
          if (saveOut.ok) {
            storedOffer = nextOffer;
            storageSync = {
              ok: true,
              skipped: false,
              reason: "",
              storage_path: saveOut.filePath,
              storage_commit_sha: saveOut.commitSha || "",
            };
            break;
          }
          storageSync = {
            ok: false,
            skipped: false,
            reason: saveOut.error || "storage_write_failed",
            upstream_status: saveOut.upstreamStatus || 0,
          };
        }

        return { storedOffer, storageSync };
      };

      const buildTradeAdjustmentRef = (season, tradeId) => {
        const seasonText = safeStr(season).replace(/\D/g, "");
        const tradeDigits = safeStr(tradeId).replace(/\D/g, "");
        if (seasonText && tradeDigits) return `trade_${seasonText}${tradeDigits}`;
        if (tradeDigits) return `trade_${tradeDigits}`;
        if (seasonText) return `trade_${seasonText}`;
        return "trade_unknown";
      };

      const formatDollarsAsMflImportK = (dollars, precision = 3) => {
        const n = Number(dollars);
        if (!Number.isFinite(n)) return "0";
        const rounded = Math.round(n);
        if (Math.abs(n - rounded) < 1e-9) return String(rounded);
        let text = n.toFixed(Math.max(0, safeInt(precision, 3)));
        text = text.replace(/\.?0+$/, "");
        if (!text || text === "-0") text = "0";
        return text;
      };

      const buildSalaryAdjRowsFromPayload = (payload, tradeId, season) => {
        const { left, right } = tradeSidesFromPayload(payload);
        const leftId = padFranchiseId(left?.franchise_id);
        const rightId = padFranchiseId(right?.franchise_id);
        if (!leftId || !rightId) return [];
        const nets = salaryNetBySideK(left, right);
        if (!nets.left_net_k) return [];
        const amount = nets.left_net_k * 1000;
        const txRef = buildTradeAdjustmentRef(season, tradeId);
        return [
          {
            franchise_id: leftId,
            amount,
            explanation: `UPS traded salary settlement (${txRef}): net ${nets.left_net_k > 0 ? "+" : ""}${nets.left_net_k}K`,
          },
          {
            franchise_id: rightId,
            amount: -amount,
            explanation: `UPS traded salary settlement (${txRef}): net ${nets.right_net_k > 0 ? "+" : ""}${nets.right_net_k}K`,
          },
        ];
      };

      const buildTaxiDemotionRowsFromPayload = (payload) => {
        const { left, right } = tradeSidesFromPayload(payload);
        const leftId = padFranchiseId(left?.franchise_id);
        const rightId = padFranchiseId(right?.franchise_id);
        const rows = [];
        const seen = new Set();
        const pushRows = (fromSide, toFranchiseId) => {
          const fromFranchiseId = padFranchiseId(fromSide?.franchise_id);
          for (const asset of asArray(fromSide?.selected_assets).filter(Boolean)) {
            if (safeStr(asset?.type).toUpperCase() !== "PLAYER") continue;
            if (!parseBoolFlag(asset?.taxi)) continue;
            const playerId = String(asset?.player_id || "").replace(/\D/g, "");
            if (!playerId || !toFranchiseId) continue;
            const key = `${toFranchiseId}|${playerId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            rows.push({
              player_id: playerId,
              player_name: safeStr(asset?.player_name || ""),
              from_franchise_id: fromFranchiseId,
              to_franchise_id: toFranchiseId,
            });
          }
        };
        if (leftId && rightId) {
          pushRows(left, rightId);
          pushRows(right, leftId);
        }
        return rows;
      };

      const verifyTaxiDemotionsInRosters = (rows, rostersPayload) => {
        const franchiseRows = asArray(
          rostersPayload?.rosters?.franchise ||
            rostersPayload?.rosters?.franchises ||
            rostersPayload?.rosters?.teams
        ).filter(Boolean);
        const locatedByPlayer = {};
        for (const franchise of franchiseRows) {
          const franchiseId = padFranchiseId(franchise?.id || franchise?.franchise_id);
          const playerRows = asArray(franchise?.player || franchise?.players).filter(Boolean);
          for (const playerRow of playerRows) {
            const playerId = String(playerRow?.id || playerRow?.player_id || "").replace(/\D/g, "");
            if (!playerId || locatedByPlayer[playerId]) continue;
            locatedByPlayer[playerId] = {
              franchise_id: franchiseId,
              status: safeStr(playerRow?.status).toUpperCase(),
            };
          }
        }

        const resultRows = [];
        let matched = 0;
        for (const row of rows) {
          const located = locatedByPlayer[String(row?.player_id || "").replace(/\D/g, "")] || null;
          const actualFranchiseId = padFranchiseId(located?.franchise_id);
          const actualStatus = safeStr(located?.status).toUpperCase();
          const onExpectedTeam = !!actualFranchiseId && actualFranchiseId === padFranchiseId(row?.to_franchise_id);
          const onTaxi = actualStatus.includes("TAXI");
          const isMatch = onExpectedTeam && onTaxi;
          if (isMatch) matched += 1;
          resultRows.push({
            ...row,
            matched: isMatch,
            actual_franchise_id: actualFranchiseId,
            actual_status: actualStatus,
            reason: isMatch
              ? ""
              : (!located
                  ? "player_not_found_in_post_trade_rosters"
                  : (!onExpectedTeam ? "player_on_unexpected_franchise" : "player_not_on_taxi")),
          });
        }

        return {
          ok: rows.length > 0 ? matched === rows.length : true,
          expected_count: rows.length,
          matched_count: matched,
          mismatched_count: Math.max(0, rows.length - matched),
          rows: resultRows,
        };
      };

      const postTaxiSquadDemotionGroup = async (season, leagueId, franchiseId, playerIds) => {
        const cleanFranchiseId = padFranchiseId(franchiseId);
        const players = Array.from(
          new Set(
            asArray(playerIds)
              .map((playerId) => String(playerId || "").replace(/\D/g, ""))
              .filter(Boolean)
          )
        );
        const importFields = {
          TYPE: "taxi_squad",
          L: leagueId,
          DEMOTE: players.join(","),
        };
        if (cleanFranchiseId) importFields.FRANCHISE_ID = cleanFranchiseId;

        let importRes = await postMflImportForm(season, importFields, importFields);
        if (!importRes.requestOk) {
          const getRes = await postMflImportForm(season, importFields, importFields, { method: "GET" });
          if (getRes.requestOk) importRes = getRes;
        }

        let usedFranchiseId = !!safeStr(importFields.FRANCHISE_ID);
        if (!importRes.requestOk && usedFranchiseId) {
          const retryFields = { ...importFields };
          delete retryFields.FRANCHISE_ID;
          let retryRes = await postMflImportForm(season, retryFields, retryFields);
          if (!retryRes.requestOk) {
            const retryGetRes = await postMflImportForm(season, retryFields, retryFields, { method: "GET" });
            if (retryGetRes.requestOk) retryRes = retryGetRes;
          }
          if (retryRes.requestOk) {
            importRes = retryRes;
            usedFranchiseId = false;
          }
        }

        return {
          request_ok: !!importRes.requestOk,
          franchise_id: cleanFranchiseId,
          player_ids: players,
          used_franchise_id: usedFranchiseId,
          upstream_status: importRes.status,
          upstream_preview: importRes.upstreamPreview,
          target_import_url: importRes.targetImportUrl,
          form_fields: importRes.formFields,
          error: importRes.error || "",
        };
      };

      const applyTaxiDemotionsFromPayload = async (leagueId, season, payload, options = {}) => {
        const tradeId = safeStr(options?.trade_id);
        const rows = buildTaxiDemotionRowsFromPayload(payload);
        if (!rows.length) {
          return {
            ok: true,
            skipped: true,
            reason: "no_traded_taxi_players",
            rows: [],
          };
        }

        const grouped = {};
        for (const row of rows) {
          const franchiseId = padFranchiseId(row?.to_franchise_id);
          if (!franchiseId) continue;
          if (!grouped[franchiseId]) grouped[franchiseId] = [];
          grouped[franchiseId].push(row);
        }

        try {
          console.log(
            "[TWB][taxiSync][prepare]",
            JSON.stringify({
              timestamp_utc: new Date().toISOString(),
              league_id: safeStr(leagueId),
              season: safeStr(season),
              trade_id: tradeId,
              rows,
            })
          );
        } catch (_) {
          // noop
        }

        const imports = [];
        const franchiseIds = Object.keys(grouped);
        for (const franchiseId of franchiseIds) {
          const playerIds = grouped[franchiseId].map((row) => row.player_id);
          imports.push(await postTaxiSquadDemotionGroup(season, leagueId, franchiseId, playerIds));
        }

        const requestOk = imports.every((entry) => !!entry.request_ok);
        let verification = {
          ok: requestOk,
          reason: requestOk ? "verification_not_run" : "import_failed",
          expected_count: rows.length,
          matched_count: 0,
          mismatched_count: rows.length,
          rows: rows.map((row) => ({ ...row, matched: false })),
        };
        let verifyRostersRes = null;

        if (requestOk) {
          const verifyDelays = [0, 1300, 2600];
          const sleepMs = (ms) =>
            new Promise((resolve) => {
              setTimeout(resolve, Math.max(0, safeInt(ms, 0)));
            });
          for (let i = 0; i < verifyDelays.length; i += 1) {
            if (verifyDelays[i] > 0) {
              await sleepMs(verifyDelays[i]);
            }
            verifyRostersRes = await mflExportJson(season, leagueId, "rosters", {}, { useCookie: true });
            if (!verifyRostersRes.ok) {
              verification = {
                ok: false,
                reason: "failed_post_import_rosters_export",
                expected_count: rows.length,
                matched_count: 0,
                mismatched_count: rows.length,
                rows: rows.map((row) => ({ ...row, matched: false })),
                attempt: i + 1,
                upstream: {
                  status: verifyRostersRes.status,
                  error: verifyRostersRes.error,
                  url: verifyRostersRes.url,
                  preview: verifyRostersRes.textPreview,
                },
              };
              continue;
            }
            verification = verifyTaxiDemotionsInRosters(rows, verifyRostersRes.data);
            verification.reason = verification.ok ? "" : "expected_taxi_status_missing_from_rosters_export";
            verification.attempt = i + 1;
            if (verification.ok) break;
          }
        }

        try {
          console.log(
            "[TWB][taxiSync][verify]",
            JSON.stringify({
              timestamp_utc: new Date().toISOString(),
              league_id: safeStr(leagueId),
              season: safeStr(season),
              trade_id: tradeId,
              imports,
              verification,
            })
          );
        } catch (_) {
          // noop
        }

        return {
          ok: requestOk && !!verification.ok,
          request_ok: requestOk,
          verification_ok: !!verification.ok,
          skipped: false,
          reason: requestOk
            ? (verification.ok ? "" : "taxi_sync_verification_failed")
            : "taxi_sync_import_failed",
          error: requestOk ? "" : "taxi_squad import failed",
          rows,
          imports,
          verification,
          post_import_rosters_export: verifyRostersRes
            ? {
                ok: !!verifyRostersRes.ok,
                status: verifyRostersRes.status,
                url: verifyRostersRes.url,
                error: verifyRostersRes.error,
                preview: verifyRostersRes.textPreview,
              }
            : null,
        };
      };

      const buildSalaryAdjXml = (rows) => {
        const validRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
        if (!validRows.length) return "";
        const itemXml = validRows
          .map((row) => {
            const amountText = formatDollarsAsMflImportK(row.amount, 3);
            return (
              `<salary_adjustment franchise_id="${xmlAttrEscape(padFranchiseId(row.franchise_id))}" ` +
              `amount="${xmlAttrEscape(amountText)}" explanation="${xmlAttrEscape(row.explanation || "")}"/>`
            );
          })
          .join("");
        return `<salary_adjustments>${itemXml}</salary_adjustments>`;
      };

      const parseSalariesExportByPlayer = (salariesPayload) => {
        const salariesRoot = salariesPayload?.salaries || salariesPayload || {};
        const leagueUnit = salariesRoot?.leagueUnit || salariesRoot?.leagueunit || {};
        const players = asArray(leagueUnit?.player || leagueUnit?.players).filter(Boolean);
        const byId = {};
        for (const p of players) {
          const playerId = String(p?.id || "").replace(/\D/g, "");
          if (!playerId) continue;
          byId[playerId] = {
            salary: safeStr(p?.salary),
            contractYear: safeStr(p?.contractYear || p?.contractyear),
            contractInfo: safeStr(p?.contractInfo || p?.contractinfo),
            contractStatus: safeStr(p?.contractStatus || p?.contractstatus),
          };
        }
        return byId;
      };

      const normalizeSalarySnapshotRow = (row) => {
        const src = row || {};
        return {
          salary: safeStr(src.salary),
          contractYear: safeStr(src.contractYear || src.contractyear),
          contractInfo: safeStr(src.contractInfo || src.contractinfo),
          contractStatus: safeStr(src.contractStatus || src.contractstatus),
        };
      };

      const normalizeContractInfoForCompare = (value) =>
        safeStr(value)
          .toUpperCase()
          .replace(/\s+/g, "")
          .replace(/[|]+/g, "|");

      const normalizeStatusForCompare = (value) => safeStr(value).toUpperCase();

      const normalizeMoneyForCompare = (value) => {
        // MFL imports commonly use "K" unit semantics with bare values (e.g. 11 = 11K),
        // while exports often return whole dollars (e.g. 11000). Normalize both to dollars.
        const n = parseMoneyTokenToDollars(value, { assumeKIfNoUnit: true });
        if (n == null || !Number.isFinite(n)) return null;
        return safeInt(n, 0);
      };

      const xmlAttrUnescape = (value) =>
        safeStr(value)
          .replace(/&quot;/g, "\"")
          .replace(/&apos;/g, "'")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&");

      const parseXmlAttrs = (chunk) => {
        const out = {};
        const re = /([A-Za-z0-9_:-]+)\s*=\s*"([^"]*)"/g;
        let m;
        while ((m = re.exec(safeStr(chunk)))) {
          out[String(m[1] || "").toLowerCase()] = xmlAttrUnescape(m[2]);
        }
        return out;
      };

      const parseExpectedExtensionRowsFromXml = (xmlText) => {
        const rows = [];
        const text = safeStr(xmlText);
        if (!text) return rows;
        const re = /<player\b([^>]*?)\/?>/gi;
        let m;
        while ((m = re.exec(text))) {
          const attrs = parseXmlAttrs(m[1]);
          const id = String(attrs.id || "").replace(/\D/g, "");
          if (!id) continue;
          const salaryRaw = safeStr(attrs.salary);
          const salaryDollars = parseMoneyTokenToDollars(salaryRaw, { assumeKIfNoUnit: true });
          rows.push({
            player_id: id,
            salary: Number.isFinite(salaryDollars) ? String(Math.round(salaryDollars)) : salaryRaw,
            contractYear: safeStr(attrs.contractyear || attrs.contractYear),
            contractInfo: safeStr(attrs.contractinfo || attrs.contractInfo),
            contractStatus: safeStr(attrs.contractstatus || attrs.contractStatus),
          });
        }
        return rows;
      };

      const parseExpectedSalaryAdjRowsFromXml = (xmlText) => {
        const rows = [];
        const text = safeStr(xmlText);
        if (!text) return rows;
        const re = /<salary_adjustment\b([^>]*?)\/?>/gi;
        let m;
        while ((m = re.exec(text))) {
          const attrs = parseXmlAttrs(m[1]);
          const franchiseId = padFranchiseId(attrs.franchise_id || attrs.franchiseid || attrs.franchise || attrs.id || "");
          const amount = safeInt(parseMoneyTokenToDollars(attrs.amount, { assumeKIfNoUnit: true }), NaN);
          if (!franchiseId || !Number.isFinite(amount)) continue;
          rows.push({
            franchise_id: franchiseId,
            amount,
            explanation: safeStr(attrs.explanation),
          });
        }
        return rows;
      };

      const salaryAdjustmentExportRowFromNode = (node) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return null;
        const hasFranchiseField =
          node.franchise_id != null ||
          node.franchiseId != null ||
          node.franchise != null ||
          node.franchiseid != null;
        const hasAmountField =
          node.amount != null ||
          node.value != null ||
          node.adjustment != null;
        if (!hasFranchiseField || !hasAmountField) return null;

        const rawFranchiseId =
          node.franchise_id ??
          node.franchiseId ??
          node.franchise ??
          node.franchiseid ??
          "";
        const rawAmount = node.amount ?? node.value ?? node.adjustment ?? "";
        const explanation = safeStr(node.description || node.explanation || node.note || node.notes || node.reason || "");
        const franchiseId = padFranchiseId(rawFranchiseId);
        const amount = safeInt(parseMoneyTokenToDollars(rawAmount, { assumeKIfNoUnit: true }), NaN);
        if (!franchiseId || !Number.isFinite(amount)) return null;
        return {
          franchise_id: franchiseId,
          amount,
          explanation,
        };
      };

      const collectSalaryAdjustmentExportRows = (node, out = []) => {
        if (!node) return out;
        if (Array.isArray(node)) {
          for (const item of node) collectSalaryAdjustmentExportRows(item, out);
          return out;
        }
        if (typeof node !== "object") return out;

        const direct = salaryAdjustmentExportRowFromNode(node);
        if (direct) {
          out.push(direct);
          return out;
        }

        const candidates = [
          node.salary_adjustment,
          node.salaryAdjustment,
          node.salary_adjustments,
          node.salaryAdjustments,
          node.leagueUnit,
          node.franchise,
          node.franchises,
        ];
        for (const v of candidates) {
          if (v != null) collectSalaryAdjustmentExportRows(v, out);
        }
        return out;
      };

      const emptySalaryAdjustmentBreakdown = () => ({
        cut_players_dollars: 0,
        traded_salary_dollars: 0,
        other_dollars: 0,
      });

      const salaryAdjustmentCategory = (explanation) => {
        const text = safeStr(explanation).toLowerCase();
        if (!text) return "other_dollars";
        if (
          text.includes("tradedsalary") ||
          text.includes("traded salary") ||
          text.includes("trade salary") ||
          text.includes("trade settlement") ||
          text.includes("trade")
        ) {
          return "traded_salary_dollars";
        }
        if (
          text.includes("cap_penalt") ||
          text.includes("cap penalty") ||
          text.includes("dead cap") ||
          text.includes("cut") ||
          text.includes("drop")
        ) {
          return "cut_players_dollars";
        }
        return "other_dollars";
      };

      const verifyExpectedSalaryAdjustmentsInRows = (expectedRows, actualRowsInput) => {
        const expected = Array.isArray(expectedRows) ? expectedRows : [];
        if (!expected.length) {
          return {
            ok: true,
            expected_count: 0,
            matched_count: 0,
            mismatched_count: 0,
            rows: [],
          };
        }
        const actualRows = Array.isArray(actualRowsInput) ? actualRowsInput : [];
        const matchByRow = expected.map((row) => {
          const matched = actualRows.some((act) => {
            if (padFranchiseId(act.franchise_id) !== padFranchiseId(row.franchise_id)) return false;
            if (safeInt(act.amount, NaN) !== safeInt(row.amount, NaN)) return false;
            // Explanation text can be rewritten by MFL; franchise+amount is the stable match key.
            return true;
          });
          return {
            ...row,
            matched,
          };
        });
        const matchedCount = matchByRow.filter((r) => r.matched).length;
        return {
          ok: matchedCount === expected.length,
          expected_count: expected.length,
          matched_count: matchedCount,
          mismatched_count: Math.max(0, expected.length - matchedCount),
          rows: matchByRow,
        };
      };

      const verifyExpectedSalaryAdjustmentsInExport = (expectedRows, exportPayload) => {
        const actualRows = collectSalaryAdjustmentExportRows(
          exportPayload?.salaryAdjustments || exportPayload?.salaryadjustments || exportPayload || {}
        );
        return verifyExpectedSalaryAdjustmentsInRows(expectedRows, actualRows);
      };

      const buildExtensionPostImportVerification = (beforeMap, expectedRows, afterMap) => {
        const expectedByPlayer = {};
        for (const row of expectedRows || []) {
          const id = String(row?.player_id || "").replace(/\D/g, "");
          if (!id) continue;
          expectedByPlayer[id] = {
            salary: safeStr(row?.salary),
            contractYear: safeStr(row?.contractYear),
            contractInfo: safeStr(row?.contractInfo),
            contractStatus: safeStr(row?.contractStatus),
          };
        }

        const rows = [];
        let matched = 0;
        let mismatched = 0;
        for (const [playerId, expected] of Object.entries(expectedByPlayer)) {
          const before = normalizeSalarySnapshotRow(beforeMap?.[playerId]);
          const after = normalizeSalarySnapshotRow(afterMap?.[playerId]);
          const expectedSalaryN = normalizeMoneyForCompare(expected.salary);
          const afterSalaryN = normalizeMoneyForCompare(after.salary);
          const expectedYearN = safeInt(expected.contractYear, NaN);
          const afterYearN = safeInt(after.contractYear, NaN);
          const expectedInfoN = normalizeContractInfoForCompare(expected.contractInfo);
          const afterInfoN = normalizeContractInfoForCompare(after.contractInfo);
          const expectedStatusN = normalizeStatusForCompare(expected.contractStatus);
          const afterStatusN = normalizeStatusForCompare(after.contractStatus);
          const cmp = {
            salary:
              expectedSalaryN == null || afterSalaryN == null
                ? safeStr(after.salary) === safeStr(expected.salary)
                : expectedSalaryN === afterSalaryN,
            contractYear:
              Number.isFinite(expectedYearN) && Number.isFinite(afterYearN)
                ? expectedYearN === afterYearN
                : safeStr(after.contractYear) === safeStr(expected.contractYear),
            contractInfo:
              expectedInfoN && afterInfoN
                ? expectedInfoN === afterInfoN
                : safeStr(after.contractInfo) === safeStr(expected.contractInfo),
            contractStatus:
              expectedStatusN && afterStatusN
                ? expectedStatusN === afterStatusN
                : safeStr(after.contractStatus) === safeStr(expected.contractStatus),
          };
          const allMatch = !!(cmp.salary && cmp.contractYear && cmp.contractInfo && cmp.contractStatus);
          if (allMatch) matched += 1;
          else mismatched += 1;
          rows.push({
            player_id: playerId,
            before,
            expected,
            after,
            matches: cmp,
            all_match: allMatch,
          });
        }
        return {
          checked_players: rows.length,
          matched_players: matched,
          mismatched_players: mismatched,
          rows,
          ok: mismatched === 0,
        };
      };

      const parseMoneyTokenToDollars = (raw, options = {}) => {
        if (raw == null) return null;
        if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw);
        const text = safeStr(raw);
        if (!text) return null;
        const upper = text.toUpperCase().replace(/\s+/g, "");
        const match = upper.match(/^(-?\d+(?:\.\d+)?)([KM]?)$/);
        if (!match) {
          const fallback = safeMoneyInt(text, null);
          return fallback == null ? null : Math.round(fallback);
        }
        const base = Number.parseFloat(match[1]);
        if (!Number.isFinite(base)) return null;
        const unit = match[2];
        if (unit === "K") return Math.round(base * 1000);
        if (unit === "M") return Math.round(base * 1000000);
        if (options.assumeKIfNoUnit && Math.abs(base) < 1000) return Math.round(base * 1000);
        return Math.round(base);
      };

      const parseSalaryByYearMapInput = (rawMap) => {
        const out = {};
        const push = (yearRaw, salaryRaw) => {
          const yearNum = safeInt(yearRaw, NaN);
          if (!Number.isFinite(yearNum) || yearNum <= 0) return;
          const salaryNum = parseMoneyTokenToDollars(salaryRaw, { assumeKIfNoUnit: false });
          if (!Number.isFinite(salaryNum) || salaryNum < 0) return;
          out[String(yearNum)] = Math.round(salaryNum);
        };
        if (!rawMap) return out;
        if (Array.isArray(rawMap)) {
          for (let i = 0; i < rawMap.length; i += 1) {
            const item = rawMap[i];
            if (item == null) continue;
            if (typeof item === "object" && !Array.isArray(item)) {
              const year = item.year ?? item.contractYear ?? item.contract_year ?? item.y ?? i + 1;
              const salary = item.salary ?? item.amount ?? item.value ?? item.dollars;
              push(year, salary);
            } else {
              push(i + 1, item);
            }
          }
          return out;
        }
        if (typeof rawMap === "object") {
          for (const [k, v] of Object.entries(rawMap)) {
            if (v && typeof v === "object" && !Array.isArray(v)) {
              const year = v.year ?? v.contractYear ?? v.contract_year ?? k;
              const salary = v.salary ?? v.amount ?? v.value ?? v.dollars;
              push(year, salary);
              continue;
            }
            push(k, v);
          }
        }
        return out;
      };

      const parseContractInfoYearSalaries = (contractInfo) => {
        const byYear = {};
        const text = safeStr(contractInfo);
        if (!text) return byYear;
        const re = /\bY\s*([0-9]{1,2})\s*[-:]\s*(\$?[0-9][0-9,.\s]*[KkMm]?)/g;
        let match;
        while ((match = re.exec(text))) {
          const yearNum = safeInt(match[1], NaN);
          if (!Number.isFinite(yearNum) || yearNum <= 0) continue;
          const salaryNum = parseMoneyTokenToDollars(match[2], { assumeKIfNoUnit: true });
          if (!Number.isFinite(salaryNum) || salaryNum < 0) continue;
          byYear[String(yearNum)] = Math.round(salaryNum);
        }
        return byYear;
      };

      const parseContractGuaranteeValue = (contractInfo) => {
        const text = safeStr(contractInfo);
        if (!text) return 0;
        const match = text.match(/(?:^|\|)\s*GTD\s*:?\s*([^|]+)/i);
        if (!match || !safeStr(match[1])) return 0;
        const amount = parseMoneyTokenToDollars(match[1], { assumeKIfNoUnit: true });
        return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : 0;
      };

      const parseContractInfoRawValue = (contractInfo, label) => {
        const text = safeStr(contractInfo);
        const target = safeStr(label);
        if (!text || !target) return "";
        const match = text.match(new RegExp(`(?:^|\\|)\\s*${target}\\s*:?\\s*([^|]+)`, "i"));
        return match && safeStr(match[1]) ? safeStr(match[1]) : "";
      };

      const parseContractLengthValue = (contractInfo) => {
        const text = safeStr(contractInfo);
        if (!text) return 0;
        const match = text.match(/(?:^|\|)\s*CL\s*:?\s*(\d+)/i);
        return match && safeStr(match[1]) ? Math.max(0, safeInt(match[1], 0)) : 0;
      };

      const parseContractInfoValues = (contractInfo) => ({
        contract_length: parseContractLengthValue(contractInfo),
        tcv: (() => {
          const text = safeStr(contractInfo);
          if (!text) return 0;
          const match = text.match(/(?:^|\|)\s*TCV\s*:?\s*([^|]+)/i);
          if (!match || !safeStr(match[1])) return 0;
          const amount = parseMoneyTokenToDollars(match[1], { assumeKIfNoUnit: true });
          return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : 0;
        })(),
        aav: (() => {
          const text = safeStr(contractInfo);
          if (!text) return 0;
          const match = text.match(/(?:^|\|)\s*AAV\s*:?\s*([^|]+)/i);
          if (!match || !safeStr(match[1])) return 0;
          const amount = parseMoneyTokenToDollars(match[1], { assumeKIfNoUnit: true });
          return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : 0;
        })(),
        guaranteed: parseContractGuaranteeValue(contractInfo),
      });

      const maxYearInSalaryByYear = (salaryByYear) => {
        const years = Object.keys(salaryByYear || {})
          .map((k) => safeInt(k, NaN))
          .filter((n) => Number.isFinite(n) && n > 0);
        if (!years.length) return null;
        return Math.max(...years);
      };

      const levelLoadSalaryByYear = (contractLength, perYearSalary, totalSalary) => {
        const len = safeInt(contractLength, NaN);
        if (!Number.isFinite(len) || len <= 0) return {};
        const out = {};
        const perYear = parseMoneyTokenToDollars(perYearSalary, { assumeKIfNoUnit: false });
        if (Number.isFinite(perYear) && perYear >= 0) {
          for (let y = 1; y <= len; y += 1) out[String(y)] = Math.round(perYear);
          return out;
        }
        const total = parseMoneyTokenToDollars(totalSalary, { assumeKIfNoUnit: false });
        if (!Number.isFinite(total) || total < 0) return {};
        const base = Math.floor(total / len);
        let remainder = total - base * len;
        for (let y = 1; y <= len; y += 1) {
          const bump = remainder > 0 ? 1 : 0;
          out[String(y)] = base + bump;
          if (remainder > 0) remainder -= 1;
        }
        return out;
      };

      const salaryByYearToSortedPairs = (salaryByYear) =>
        Object.keys(salaryByYear || {})
          .map((k) => safeInt(k, NaN))
          .filter((n) => Number.isFinite(n) && n > 0)
          .sort((a, b) => a - b)
          .map((yearNum) => ({
            year: yearNum,
            salary: safeInt(salaryByYear[String(yearNum)], 0),
          }));

      const computeSalaryByYearTotals = (pairsInput) => {
        const pairs = Array.isArray(pairsInput)
          ? pairsInput
              .map((p) => ({
                year: safeInt(p?.year, NaN),
                salary: safeInt(p?.salary, NaN),
              }))
              .filter((p) => Number.isFinite(p.year) && p.year > 0 && Number.isFinite(p.salary) && p.salary >= 0)
          : [];
        if (!pairs.length) {
          return {
            contract_length: 0,
            tcv: 0,
            aav: 0,
          };
        }
        const sorted = pairs.slice().sort((a, b) => a.year - b.year);
        const total = sorted.reduce((sum, p) => sum + safeInt(p.salary, 0), 0);
        return {
          contract_length: sorted.length,
          tcv: total,
          aav: sorted.length ? Math.round(total / sorted.length) : 0,
        };
      };

      const formatContractK = (amount) => {
        const dollars = safeMoneyInt(amount, 0);
        if (dollars <= 0) return "0K";
        const text = Math.round((dollars / 1000) * 10) / 10;
        return `${String(text).replace(/\.0$/, "")}K`;
      };

      const contractDiscordBotToken = () =>
        safeStr(
          env.DISCORD_CONTRACT_BOT_TOKEN ||
          env.DISCORD_BOT_TOKEN ||
          env.DISCORD_BOT ||
          env.Discord_bot ||
          ""
        );

      const contractDiscordPrimaryChannelId = () =>
        safeStr(env.DISCORD_CONTRACT_CHANNEL_ID || "").replace(/\D/g, "");

      const contractDiscordTestChannelId = () =>
        safeStr(env.DISCORD_CONTRACT_TEST_CHANNEL_ID || env.DISCORD_BUG_TEST_CHANNEL_ID || "").replace(/\D/g, "");

      const contractDiscordChannelTarget = (forceTestOnly = false, forcePrimaryOnly = false) => {
        if (forcePrimaryOnly) {
          const primaryChannelId = contractDiscordPrimaryChannelId();
          return {
            channelId: primaryChannelId,
            deliveryTarget: "primary",
            missingError: primaryChannelId ? "" : "missing_discord_contract_channel_config",
          };
        }
        const testChannelId = contractDiscordTestChannelId();
        if (testChannelId) {
          return {
            channelId: testChannelId,
            deliveryTarget: "test",
            missingError: "",
          };
        }
        if (forceTestOnly) {
          return {
            channelId: "",
            deliveryTarget: "test",
            missingError: "missing_discord_contract_test_channel_config",
          };
        }
        const primaryChannelId = contractDiscordPrimaryChannelId();
        return {
          channelId: primaryChannelId,
          deliveryTarget: "primary",
          missingError: primaryChannelId ? "" : "missing_discord_contract_channel_config",
        };
      };

      const contractDiscordSpacingMs = () => {
        const seconds = Math.max(0, safeInt(env.DISCORD_CONTRACT_SPACING_SECONDS || 30, 30));
        return seconds * 1000;
      };

      const sleepMs = (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, Math.max(0, safeInt(ms, 0)));
        });

      const withContractDiscordSendSlot = async (channelId, fn) => {
        const normalizedChannelId = safeStr(channelId).replace(/\D/g, "");
        if (!normalizedChannelId) return await fn();
        const prior = contractDiscordChannelQueues.get(normalizedChannelId) || Promise.resolve();
        const run = (async () => {
          await prior.catch(() => {});
          const spacingMs = contractDiscordSpacingMs();
          const lastSentMs = safeInt(contractDiscordChannelLastSendMs.get(normalizedChannelId), 0);
          const waitMs = Math.max(0, spacingMs - (Date.now() - lastSentMs));
          if (waitMs > 0) await sleepMs(waitMs);
          const result = await fn();
          if (result && result.ok) {
            contractDiscordChannelLastSendMs.set(normalizedChannelId, Date.now());
          }
          return result;
        })();
        contractDiscordChannelQueues.set(normalizedChannelId, run);
        try {
          return await run;
        } finally {
          if (contractDiscordChannelQueues.get(normalizedChannelId) === run) {
            contractDiscordChannelQueues.delete(normalizedChannelId);
          }
        }
      };

      const isRetryableContractDiscordFailure = (res) => {
        const status = safeInt(res?.status, 0);
        const errorText = safeStr(res?.text || res?.error || "").toLowerCase();
        if ([429, 500, 502, 503, 504].includes(status)) return true;
        return errorText.includes("overflow") || errorText.includes("disconnect/reset") || errorText.includes("upstream connect error");
      };

      const contractDiscordFranchiseMetaCache = new Map();

      const loadContractDiscordFranchiseMeta = async ({ season, leagueId, franchiseId }) => {
        const seasonText = safeStr(season);
        const leagueText = safeStr(leagueId);
        const franchiseKey = padFranchiseId(franchiseId);
        if (!seasonText || !leagueText || !franchiseKey) {
          return { franchise_id: franchiseKey, franchise_name: "", icon_url: "" };
        }
        const cacheKey = `${seasonText}:${leagueText}`;
        if (!contractDiscordFranchiseMetaCache.has(cacheKey)) {
          let franchiseMap = {};
          try {
            const leagueRes = await mflExportJsonWithRetryAsViewer(seasonText, leagueText, "league", {}, { useCookie: true });
            if (leagueRes.ok) {
              const franchises = parseLeagueFranchises(leagueRes.data);
              for (const fr of franchises) {
                const id = padFranchiseId(fr?.franchise_id);
                if (!id) continue;
                franchiseMap[id] = fr;
              }
            }
          } catch (_) {
            franchiseMap = {};
          }
          contractDiscordFranchiseMetaCache.set(cacheKey, franchiseMap);
        }
        const franchiseMap = contractDiscordFranchiseMetaCache.get(cacheKey) || {};
        const franchiseMeta = franchiseMap[franchiseKey] || {};
        return {
          franchise_id: franchiseKey,
          franchise_name: safeStr(franchiseMeta?.franchise_name || ""),
          icon_url: safeStr(franchiseMeta?.icon_url || ""),
        };
      };

      const getMemorialDayUtc = (season) => {
        const year = safeInt(season, 0);
        if (year <= 0) return null;
        const d = new Date(Date.UTC(year, 4, 31));
        const weekday = d.getUTCDay();
        const offset = (weekday + 6) % 7;
        d.setUTCDate(d.getUTCDate() - offset);
        return d;
      };

      const getTagDeadlineUtc = (season) => {
        const memorial = getMemorialDayUtc(season);
        if (!memorial) return null;
        const tagDeadline = new Date(memorial.getTime());
        tagDeadline.setUTCDate(tagDeadline.getUTCDate() - 4);
        tagDeadline.setUTCHours(23, 59, 59, 999);
        return tagDeadline;
      };

      const hasTagDeadlinePassed = (season) => {
        const deadline = getTagDeadlineUtc(season);
        if (!deadline) return false;
        return Date.now() > deadline.getTime();
      };

      const formatContractSubmissionDate = (rawValue) => {
        const raw = safeStr(rawValue);
        if (!raw) return "";
        const parsed = new Date(raw);
        if (Number.isNaN(parsed.getTime())) return raw;
        return parsed.toLocaleString("en-US", {
          timeZone: "America/New_York",
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
      };

      const contractBreakdownFromMutation = ({ contractInfo, contractYear, season, salary }) => {
        const map = parseContractInfoYearSalaries(contractInfo);
        if (!Object.keys(map).length) {
          const currentYear = safeInt(contractYear, NaN);
          const currentSalary = safeMoneyInt(salary, null);
          if (Number.isFinite(currentYear) && currentYear > 0 && currentSalary != null && currentSalary >= 0) {
            map[String(currentYear)] = currentSalary;
          }
        }
        const pairs = salaryByYearToSortedPairs(map);
        const seasonNum = safeInt(season, NaN);
        const currentContractYear = safeInt(contractYear, NaN);
        const normalizedPairs = pairs.map((pair) => {
          const relativeYear = safeInt(pair?.year, NaN);
          const seasonYear =
            Number.isFinite(seasonNum) &&
            seasonNum > 0 &&
            Number.isFinite(currentContractYear) &&
            currentContractYear > 0 &&
            Number.isFinite(relativeYear) &&
            relativeYear > 0
              ? seasonNum - currentContractYear + relativeYear
              : null;
          return {
            year: relativeYear,
            salary: safeInt(pair?.salary, 0),
            season_year: seasonYear,
          };
        });
        return {
          pairs: normalizedPairs,
          totals: computeSalaryByYearTotals(normalizedPairs),
        };
      };

      const deriveContractActivityType = ({
        isExtensionSubmission,
        isRestructure,
        contractStatus,
      }) => {
        const status = safeStr(contractStatus).toUpperCase();
        if (status === "TAG") return "Tag";
        if (isExtensionSubmission) return "Extension";
        if (isRestructure) return "Restructure";
        return "FA Contract";
      };

      const normalizeContractActivityKind = (activityType, contractStatus) => {
        const activity = safeStr(activityType).toLowerCase();
        const status = safeStr(contractStatus).toLowerCase();
        if (status === "tag" || activity.includes("tag")) return "tag";
        if (activity.includes("restructure")) return "restructure";
        if (activity.includes("mym")) return "mym";
        if (activity.includes("extension")) return "extension";
        return "other";
      };

      const shouldAnnounceContractActivity = ({ activityType, season }) => {
        return { ok: true, skipped: false, reason: "" };
      };

      const normalizePlayerNameForGif = (name) => {
        // Handle both "Last, First" and "First Last" formats.
        // Returns {full, last, variants[]}
        let cleaned = safeStr(name).replace(/\s+/g, " ").trim();
        if (!cleaned) return { full: "", last: "", variants: [] };
        let first = "", last = "";
        if (cleaned.includes(",")) {
          const parts = cleaned.split(",").map((s) => s.trim());
          last = parts[0] || "";
          first = parts[1] || "";
        } else {
          const parts = cleaned.split(" ");
          first = parts[0] || "";
          last = parts.slice(1).join(" ") || "";
        }
        const stripSuffix = (s) => s.replace(/\s+(jr|sr|ii|iii|iv|v)\.?$/i, "").trim();
        const full = [first, last].filter(Boolean).join(" ").trim();
        const fullNoSuffix = stripSuffix(full);
        const lastNoSuffix = stripSuffix(last);
        const variants = Array.from(new Set([full, fullNoSuffix, `${first} ${lastNoSuffix}`.trim(), lastNoSuffix, last].filter(Boolean)));
        return { full, last, variants };
      };

      const contractGifQueries = ({ activityType, playerName }) => {
        const parsed = normalizePlayerNameForGif(playerName);
        const kind = normalizeContractActivityKind(activityType, "");
        const queries = [];
        // Primary: player name variants (most specific first)
        for (const v of parsed.variants) {
          if (v) queries.push(v);
        }
        // Also try player + "nfl" / "football" to get game footage
        if (parsed.full) {
          queries.push(`${parsed.full} touchdown`);
          queries.push(`${parsed.full} nfl`);
        }
        // Generic fallbacks by activity type
        if (kind === "extension") {
          queries.push("nfl celebration");
          queries.push("football contract signing");
        } else if (kind === "restructure") {
          queries.push("football money celebration");
          queries.push("nfl celebration");
        } else if (kind === "tag") {
          queries.push("football franchise celebration");
          queries.push("nfl celebration");
        } else {
          queries.push("nfl signing");
          queries.push("football celebration");
        }
        queries.push("nfl celebration");
        return queries.filter(Boolean);
      };

      // Normalize text for matching (lowercase, strip punctuation/diacritics).
      const normalizeForMatch = (s) => safeStr(s).toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

      const pickContractActivityGifUrl = async ({ activityType, playerName }) => {
        const apiKey = safeStr(env.GIPHY_API_KEY || "");
        if (!apiKey) {
          return { ok: false, gif_url: "", reason: "missing_giphy_api_key", query: "" };
        }
        const parsedName = normalizePlayerNameForGif(playerName);
        const playerLastNorm = normalizeForMatch(parsedName.last).replace(/\s+(jr|sr|ii|iii|iv|v)$/, "").trim();
        const playerFullNorm = normalizeForMatch(parsedName.full).replace(/\s+(jr|sr|ii|iii|iv|v)$/, "").trim();
        const queries = contractGifQueries({ activityType, playerName });
        const isPlayerSpecificQuery = (q) => {
          const qn = normalizeForMatch(q);
          return !!playerLastNorm && qn.includes(playerLastNorm);
        };
        // Pass 1: require FULL NAME match (e.g. "kenneth walker" in title).
        // This dramatically reduces false-positives from common surnames.
        // Pass 2 (fallback): last-name-only strict match.
        // Pass 3 (last resort): no player-specific match — skip rather than
        // return a wrong GIF, per commissioner preference.
        const tryPass = async (requireFullName) => {
          for (const query of queries) {
            if (!isPlayerSpecificQuery(query)) continue;
            const searchUrl = new URL("https://api.giphy.com/v1/gifs/search");
            searchUrl.searchParams.set("api_key", apiKey);
            searchUrl.searchParams.set("q", query);
            searchUrl.searchParams.set("limit", "25");
            searchUrl.searchParams.set("offset", "0");
            searchUrl.searchParams.set("lang", "en");
            try {
              const res = await fetch(searchUrl.toString(), {
                headers: { "User-Agent": "upsmflproduction-worker" },
                cf: { cacheTtl: 300, cacheEverything: false },
              });
              if (!res.ok) continue;
              const data = await res.json();
              const rows = Array.isArray(data?.data) ? data.data : [];
              if (!rows.length) continue;
              const matches = rows.filter((row) => {
                const title = normalizeForMatch(row?.title || "");
                const slug = normalizeForMatch(row?.slug || "");
                if (requireFullName && playerFullNorm) {
                  return title.includes(playerFullNorm) || slug.includes(playerFullNorm);
                }
                return title.includes(playerLastNorm) || slug.includes(playerLastNorm);
              });
              if (!matches.length) continue;
              const pick = matches[Math.floor(Math.random() * matches.length)];
              const gifUrl =
                safeStr(pick?.images?.original?.url) ||
                safeStr(pick?.images?.downsized_large?.url) ||
                safeStr(pick?.images?.fixed_height?.url) ||
                safeStr(pick?.url);
              if (gifUrl) {
                return {
                  ok: true,
                  gif_url: gifUrl,
                  reason: "",
                  query,
                  strict_match: true,
                  full_name_match: !!requireFullName,
                };
              }
            } catch (_) {
              continue;
            }
          }
          return null;
        };
        const pass1 = await tryPass(true);
        if (pass1) return pass1;
        const pass2 = await tryPass(false);
        if (pass2) return pass2;
        // Per commissioner: no GIF is better than a wrong one. Only fall back
        // to a generic celebration GIF if we have NO player at all.
        if (!playerLastNorm) {
          for (const query of queries) {
            const searchUrl = new URL("https://api.giphy.com/v1/gifs/search");
            searchUrl.searchParams.set("api_key", apiKey);
            searchUrl.searchParams.set("q", query);
            searchUrl.searchParams.set("limit", "25");
            searchUrl.searchParams.set("lang", "en");
            try {
              const res = await fetch(searchUrl.toString(), {
                headers: { "User-Agent": "upsmflproduction-worker" },
                cf: { cacheTtl: 300, cacheEverything: false },
              });
              if (!res.ok) continue;
              const data = await res.json();
              const rows = Array.isArray(data?.data) ? data.data : [];
              if (!rows.length) continue;
              const pick = rows[Math.floor(Math.random() * rows.length)];
              const gifUrl = safeStr(pick?.images?.original?.url) || safeStr(pick?.images?.downsized_large?.url) || safeStr(pick?.images?.fixed_height?.url) || safeStr(pick?.url);
              if (gifUrl) return { ok: true, gif_url: gifUrl, reason: "", query };
            } catch (_) {}
          }
        }
        return { ok: false, gif_url: "", reason: "gif_not_found_strict", query: queries[0] || "" };
      };

      const buildContractActivityDiscordMessage = ({
        activityType,
        franchiseName,
        playerName,
        contractInfo,
        contractYear,
        season,
        salary,
        submittedAtUtc,
      }) => {
        const summary = contractBreakdownFromMutation({
          contractInfo,
          contractYear,
          season,
          salary,
        });
        const totals = summary.totals || { contract_length: 0, tcv: 0, aav: 0 };
        const yearlyBreakdown = summary.pairs.length
          ? summary.pairs
              .map((pair) => {
                const yearLabel = Number.isFinite(pair.season_year) && pair.season_year > 0
                  ? String(pair.season_year)
                  : `Y${pair.year}`;
                return `${yearLabel} ${formatContractK(pair.salary)}`;
              })
              .join(" | ")
          : "Unavailable";
        const yearsLabel = totals.contract_length === 1 ? "1 Year" : `${Math.max(0, totals.contract_length)} Years`;
        const lines = [
          `**Contract Activity:** ${safeStr(activityType || "Contract Update")}`,
          `**Team:** ${safeStr(franchiseName || "Unknown Franchise")}`,
          `**Player:** ${safeStr(playerName || "Unknown Player")}`,
          `**Total Years:** ${yearsLabel}`,
          `**TCV:** ${formatContractK(totals.tcv)}`,
          `**AAV:** ${formatContractK(totals.aav)}`,
          `**Yearly Breakdown:** ${yearlyBreakdown}`,
        ];
        const submittedLabel = formatContractSubmissionDate(submittedAtUtc);
        if (submittedLabel) lines.push(`**Submitted:** ${submittedLabel}`);
        return lines.join("\n");
      };

      const buildContractActivityDiscordEmbed = ({
        activityType,
        franchiseName,
        creditedFranchiseName,
        playerName,
        contractInfo,
        contractYear,
        contractStatus,
        season,
        salary,
        submittedAtUtc,
        franchiseIconUrl,
        gifUrl,
        usageLabel,
        noteText,
        tradePartnerName,
      }) => {
        const summary = contractBreakdownFromMutation({
          contractInfo,
          contractYear,
          season,
          salary,
        });
        const totals = summary.totals || { contract_length: 0, tcv: 0, aav: 0 };
        const parsedInfo = parseContractInfoValues(contractInfo);
        const kind = normalizeContractActivityKind(activityType, contractStatus);
        const isPreseasonTradeExtension = /\bpre[\s-]*season\s+trade\s+extension\b|\bpre[\s-]*trade\s+extension\b/i.test(
          safeStr(activityType)
        );
        const yearlyBreakdown = summary.pairs.length
          ? summary.pairs
              .map((pair) => {
                const yearLabel = Number.isFinite(pair.season_year) && pair.season_year > 0
                  ? String(pair.season_year)
                  : `Y${pair.year}`;
                return `${yearLabel} ${formatContractK(pair.salary)}`;
              })
              .join(" | ")
          : "Unavailable";
        const resolvedLength =
          totals.contract_length > 0
            ? totals.contract_length
            : Math.max(1, safeInt(parsedInfo.contract_length || (kind === "tag" ? 1 : 0), 0));
        const resolvedTcv = totals.tcv > 0 ? totals.tcv : safeInt(parsedInfo.tcv, 0);
        const resolvedAav =
          totals.aav > 0
            ? totals.aav
            : (safeInt(parsedInfo.aav, 0) > 0 ? safeInt(parsedInfo.aav, 0) : safeInt(salary, 0));
        const yearsLabel = resolvedLength === 1 ? "1 Year" : `${Math.max(0, resolvedLength)} Years`;
        const teamLabel = safeStr(creditedFranchiseName || franchiseName || "Unknown Franchise");
        const playerLabel = safeStr(playerName || "Unknown Player");
        const rawAavLabel = parseContractInfoRawValue(contractInfo, "AAV");
        const gtd = kind === "tag"
          ? Math.round(Math.max(0, resolvedAav) * 0.75)
          : parseContractGuaranteeValue(contractInfo);
        const termsParts = isPreseasonTradeExtension
          ? [
              yearsLabel,
              `${formatContractK(resolvedTcv)} TCV`,
            ]
          : [
              yearsLabel,
              `${formatContractK(salary)} Salary`,
              `${formatContractK(resolvedAav)} AAV`,
              `${formatContractK(resolvedTcv)} TCV`,
            ];
        if (gtd > 0) termsParts.push(`${formatContractK(gtd)} GTD`);
        const termsLabel = termsParts.join(" | ");
        const finalNote =
          safeStr(noteText) ||
          (kind === "tag"
            ? "Player may be cut prior to the FA Auction Cut Deadline without any cap penalty."
            : "");
        const embedColor =
          kind === "mym"
            ? 0xc8a24d
            : kind === "restructure"
              ? 0x103a71
              : 0x103a71;
        const embed = {
          title: `${safeStr(activityType || "Contract Update")}: ${playerLabel}`,
          color: embedColor,
          description: termsLabel,
          fields: [],
        };
        if (safeStr(usageLabel)) {
          embed.fields.push({
            name: "Usage",
            value: "```text\n" + safeStr(usageLabel) + "\n```",
            inline: false,
          });
        }
        if (isPreseasonTradeExtension && rawAavLabel) {
          embed.fields.push({
            name: "AAV",
            value: rawAavLabel,
            inline: false,
          });
        }
        if (isPreseasonTradeExtension && safeStr(tradePartnerName)) {
          embed.fields.push({
            name: "Trade Partner",
            value: safeStr(tradePartnerName),
            inline: false,
          });
        }
        if (kind !== "tag") {
          embed.fields.push({ name: "Breakdown", value: yearlyBreakdown, inline: false });
        }
        if (finalNote) {
          embed.fields.push({ name: "Note", value: finalNote, inline: false });
        }
        embed.author = { name: teamLabel };
        const submittedLabel = formatContractSubmissionDate(submittedAtUtc);
        if (submittedLabel) {
          embed.footer = { text: `Submitted ${submittedLabel}` };
        }
        if (safeStr(franchiseIconUrl)) {
          embed.thumbnail = { url: safeStr(franchiseIconUrl) };
        }
        if (safeStr(gifUrl)) {
          embed.image = { url: safeStr(gifUrl) };
        }
        return embed;
      };

      // =================================================================
      // Trade notification Discord embed + sender (RULE-WORKFLOW-003)
      // Separate from contract-activity because trades use a different
      // format: "Team A receives X | Team B receives Y" layout.
      // =================================================================

      const formatTradeDateTime = (iso) => {
        const text = safeStr(iso);
        if (!text) return "";
        try {
          const d = new Date(text);
          if (isNaN(d.getTime())) return text;
          const fmt = d.toLocaleString("en-US", {
            timeZone: "America/New_York",
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          });
          return `${fmt} ET`;
        } catch (_) {
          return text;
        }
      };

      // Parse MFL DP token (DP_R_S, both zero-indexed) or FP token
      // (FP_FID_YYYY_R) into a human-friendly draft pick label.
      // franchiseNameLookup: optional object mapping franchise_id (padded) to name
      const parseDraftPickToken = (token, currentSeason, franchiseNameLookup) => {
        const t = safeStr(token).toUpperCase();
        const nameLookup = franchiseNameLookup || {};
        // MFL convention (confirmed via league draftPick XML 2026-04-17):
        //   DP_R_S — both R (round) and S (slot) are 0-indexed. Add 1 to each.
        //   Slot is zero-padded to 2 digits to match MFL description format.
        //   Examples:  DP_0_0 = "Pick 1.01"   DP_3_9 = "Pick 4.10"   DP_5_0 = "Pick 6.01"
        const dpMatch = t.match(/^DP_(\d+)_(\d+)$/);
        if (dpMatch) {
          const round = safeInt(dpMatch[1], 0) + 1;
          const slot = safeInt(dpMatch[2], 0) + 1;
          const slotLabel = slot < 10 ? `0${slot}` : String(slot);
          const year = safeStr(currentSeason) || "";
          return `${year} Rookie Pick ${round}.${slotLabel}`.trim();
        }
        // Future pick: FP_FID_YYYY_R (round only). FID is the ORIGINAL owner
        // franchise — must be preserved so "Hammer's 1st" stays attributed.
        const fpMatch = t.match(/^FP_(\d+)_(\d{4})_(\d+)$/);
        if (fpMatch) {
          const fid = padFranchiseId(fpMatch[1]);
          const year = fpMatch[2];
          const round = safeInt(fpMatch[3], 0);
          const ord = round === 1 ? "1st" : round === 2 ? "2nd" : round === 3 ? "3rd" : `${round}th`;
          const originalOwner = safeStr(nameLookup[fid] || "");
          return originalOwner ? `${originalOwner}'s ${year} ${ord}` : `${year} ${ord} round pick`;
        }
        // Trade cap-transfer token: BB_X. "Traded Salary" per league terminology.
        const bbMatch = t.match(/^BB_(\d+)$/);
        if (bbMatch) {
          const amt = safeInt(bbMatch[1], 0);
          return `$${amt.toLocaleString("en-US")} Traded Salary`;
        }
        return safeStr(token);
      };

      const describeTradeAsset = (asset, currentSeason, franchiseNameLookup) => {
        if (!asset || typeof asset !== "object") return "";
        const kind = safeStr(asset.kind || asset.type || "").toLowerCase();
        const label = safeStr(asset.label || "");
        if (label) {
          const parsed = parseDraftPickToken(label, currentSeason, franchiseNameLookup);
          return parsed !== label ? parsed : label;
        }
        const name = safeStr(asset.name || asset.player_name || "");
        const contract = safeStr(asset.contract_summary || asset.contract_info || "");
        if (kind === "player") {
          return contract ? `${name} (${contract})` : name;
        }
        if (kind === "pick") {
          const token = safeStr(asset.token || "");
          if (token) {
            const parsed = parseDraftPickToken(token, currentSeason, franchiseNameLookup);
            if (parsed !== token) return parsed;
          }
          const year = safeStr(asset.year || asset.season || "");
          const round = safeStr(asset.round || "");
          const slot = safeStr(asset.slot || asset.pick || "");
          if (year && round && slot) return `${year} Rookie Pick ${round}.${slot}`;
          if (year && round) {
            const r = safeInt(round, 0);
            const ord = r === 1 ? "1st" : r === 2 ? "2nd" : r === 3 ? "3rd" : (r ? `${r}th` : round);
            return `${year} ${ord} round pick`;
          }
          return year ? `${year} pick` : "Draft pick";
        }
        if (kind === "cap" || kind === "bbid" || kind === "cash" || kind === "traded_salary") {
          // Default label is "Traded Salary" per league terminology
          // (BBID is a separate thing; trade-time cap transfers are called
          // Traded Salary in this league).
          const amt = safeInt(asset.amount, 0);
          const amtText = amt ? `$${amt.toLocaleString("en-US")}` : "";
          return amtText ? `${amtText} Traded Salary` : "Traded Salary";
        }
        return name || kind || "Unknown asset";
      };

      const buildTradeNotificationEmbed = ({
        tradeDateIso,
        tradeId,
        season,
        leftFranchiseName,
        rightFranchiseName,
        leftReceives,
        rightReceives,
        capAdjustments,
        noteText,
        gifUrl,
        leftIconUrl,
        rightIconUrl,
        franchiseIconUrl, // legacy alias (left only)
        franchiseNameLookup,
      }) => {
        const resolvedLeftIcon = safeStr(leftIconUrl || franchiseIconUrl || "");
        const resolvedRightIcon = safeStr(rightIconUrl || "");
        const whenLabel = formatTradeDateTime(tradeDateIso);
        const leftReceivesList = Array.isArray(leftReceives) ? leftReceives : [];
        const rightReceivesList = Array.isArray(rightReceives) ? rightReceives : [];
        const leftLines = leftReceivesList.map((a) => `• ${describeTradeAsset(a, season, franchiseNameLookup)}`).filter(Boolean);
        const rightLines = rightReceivesList.map((a) => `• ${describeTradeAsset(a, season, franchiseNameLookup)}`).filter(Boolean);
        const leftTeam = safeStr(leftFranchiseName) || "Team A";
        const rightTeam = safeStr(rightFranchiseName) || "Team B";

        const embed = {
          title: "TRADE NOTIFICATION",
          color: 0xc8a24d,
          description: whenLabel ? `${whenLabel}${tradeId ? ` · ${tradeId}` : ""}` : (tradeId || ""),
          fields: [],
        };
        embed.fields.push({
          name: `${leftTeam} receives`,
          value: leftLines.length ? leftLines.join("\n") : "(nothing)",
          inline: false,
        });
        embed.fields.push({
          name: `${rightTeam} receives`,
          value: rightLines.length ? rightLines.join("\n") : "(nothing)",
          inline: false,
        });
        if (Array.isArray(capAdjustments) && capAdjustments.length) {
          const capLines = capAdjustments.map((c) => {
            const team = safeStr(c.franchise_name || "");
            const amt = safeInt(c.amount, 0);
            const sign = amt > 0 ? "+" : (amt < 0 ? "−" : "");
            return `• ${team}: ${sign}$${Math.abs(amt).toLocaleString("en-US")}`;
          });
          embed.fields.push({
            name: "Cap Adjustments",
            value: capLines.join("\n"),
            inline: false,
          });
        }
        // Analysis deliberately omitted — trade grades/roasts will populate this
        // as a follow-up reply (existing trade_grader Discord bot integration).
        //
        // Both team icons: left goes in author.icon_url (next to the TRADE
        // NOTIFICATION title), right goes in thumbnail (top-right corner).
        // This way both teams are visually represented in the embed header.
        if (resolvedLeftIcon) {
          embed.author = { name: safeStr(leftFranchiseName || "") + "  ↔  " + safeStr(rightFranchiseName || ""), icon_url: resolvedLeftIcon };
        } else {
          embed.author = { name: safeStr(leftFranchiseName || "") + "  ↔  " + safeStr(rightFranchiseName || "") };
        }
        if (resolvedRightIcon) {
          embed.thumbnail = { url: resolvedRightIcon };
        } else if (resolvedLeftIcon) {
          // Fallback to left icon thumbnail if right missing
          embed.thumbnail = { url: resolvedLeftIcon };
        }
        if (safeStr(gifUrl)) {
          embed.image = { url: safeStr(gifUrl) };
        }
        return embed;
      };

      const sendDiscordTradeNotification = async ({
        leagueId,
        season,
        tradeDateIso,
        tradeId,
        leftFranchiseId,
        leftFranchiseName,
        rightFranchiseId,
        rightFranchiseName,
        leftReceives,
        rightReceives,
        capAdjustments,
        noteText,
        featuredPlayerName,
        forceTestOnly,
        forcePrimaryOnly,
        channelIdOverride,
      }) => {
        const botToken = contractDiscordBotToken();
        const overrideChannelId = safeStr(channelIdOverride).replace(/\D/g, "");
        const target = overrideChannelId
          ? {
              channelId: overrideChannelId,
              deliveryTarget: safeStr(forceTestOnly ? "test" : (forcePrimaryOnly ? "primary" : "override")),
              missingError: "",
            }
          : contractDiscordChannelTarget(!!forceTestOnly, !!forcePrimaryOnly);
        if (!botToken || !target.channelId) {
          return {
            ok: false,
            skipped: false,
            status: 0,
            error: !botToken ? "missing_discord_contract_bot_token" : safeStr(target.missingError || "missing_discord_contract_channel_config"),
            delivery_target: safeStr(target.deliveryTarget || ""),
          };
        }
        const franchiseMeta = await loadContractDiscordFranchiseMeta({
          season,
          leagueId,
          franchiseId: padFranchiseId(leftFranchiseId),
        });
        const rightFranchiseMeta = await loadContractDiscordFranchiseMeta({
          season,
          leagueId,
          franchiseId: padFranchiseId(rightFranchiseId),
        });
        // Load all franchise names so FP_XXXX_YYYY_R tokens can be
        // rendered with the original owner attribution.
        let franchiseNameLookup = {};
        try {
          const leagueRes = await mflExportJson(season, leagueId, "league", {}, { includeApiKey: true, useCookie: true });
          if (leagueRes.ok) {
            const frList = leagueRes.data?.league?.franchises?.franchise;
            const frArr = Array.isArray(frList) ? frList : (frList ? [frList] : []);
            for (const f of frArr) {
              const fid = padFranchiseId(f?.id);
              if (fid) franchiseNameLookup[fid] = safeStr(f?.name || "");
            }
          }
        } catch (_) {}
        // Use the featured player for GIF search (most often the marquee player moving)
        const gif = featuredPlayerName
          ? await pickContractActivityGifUrl({ activityType: "trade", playerName: featuredPlayerName })
          : { gif_url: "", query: "" };
        const embed = buildTradeNotificationEmbed({
          tradeDateIso,
          tradeId,
          season,
          leftFranchiseName: leftFranchiseName || franchiseMeta.franchise_name,
          rightFranchiseName: rightFranchiseName || rightFranchiseMeta.franchise_name,
          leftReceives,
          rightReceives,
          capAdjustments,
          noteText,
          gifUrl: safeStr(gif.gif_url || ""),
          leftIconUrl: safeStr(franchiseMeta.icon_url || ""),
          rightIconUrl: safeStr(rightFranchiseMeta.icon_url || ""),
          franchiseNameLookup,
        });
        const res = await withContractDiscordSendSlot(target.channelId, async () => {
          return await discordBotRequest(
            botToken,
            "POST",
            `/channels/${encodeURIComponent(target.channelId)}/messages`,
            {
              content: "",
              embeds: [embed],
              allowed_mentions: { parse: [] },
            }
          );
        });
        return {
          ok: !!res.ok,
          skipped: false,
          status: safeInt(res.status, 0),
          error: res.ok ? "" : safeStr(res.text || "discord_trade_post_failed").slice(0, 600),
          channel_id: safeStr(target.channelId),
          delivery_target: safeStr(target.deliveryTarget || ""),
          message_id: safeStr(res.data?.id || ""),
          gif_url: safeStr(gif.gif_url || ""),
          gif_query: safeStr(gif.query || ""),
          franchise_icon_url: safeStr(franchiseMeta.icon_url || ""),
        };
      };

      // =================================================================
      // Restructure Alert Discord embed + sender
      // Dedicated format per commissioner 2026-04-17 — AAV is NEVER
      // recomputed; it is passed through from the caller exactly as-is.
      // =================================================================

      const buildRestructureAlertEmbed = ({
        franchiseName,
        franchiseIconUrl,
        playerName,
        yearsRemaining,
        tcvLabel,
        guaranteedLabel,
        aavLabel,
        yearlyBreakdown,  // e.g. "2026: $26K, 2027: $103K"
        usageText,
        gifUrl,
      }) => {
        const team = safeStr(franchiseName) || "Unknown Team";
        const player = safeStr(playerName) || "Unknown Player";
        const yrs = safeInt(yearsRemaining, 0);
        const yrLabel = yrs === 1 ? "1 Year Remaining" : `${yrs} Years Remaining`;
        const descParts = [yrLabel];
        if (safeStr(tcvLabel)) descParts.push(`TCV ${safeStr(tcvLabel)}`);
        if (safeStr(guaranteedLabel)) descParts.push(`${safeStr(guaranteedLabel)} Guaranteed`);
        if (safeStr(aavLabel)) descParts.push(`with ${safeStr(aavLabel)} AAV`);
        const embed = {
          title: "Restructure Alert",
          color: 0x103a71,
          description: descParts.join(", "),
          fields: [
            { name: "Team", value: team, inline: true },
            { name: "Player", value: player, inline: true },
          ],
        };
        if (safeStr(yearlyBreakdown)) {
          embed.fields.push({ name: "Yearly Breakdown", value: safeStr(yearlyBreakdown), inline: false });
        }
        if (safeStr(usageText)) {
          embed.fields.push({ name: "Usage", value: safeStr(usageText), inline: false });
        }
        if (safeStr(franchiseIconUrl)) embed.thumbnail = { url: safeStr(franchiseIconUrl) };
        if (safeStr(gifUrl)) embed.image = { url: safeStr(gifUrl) };
        return embed;
      };

      const sendDiscordRestructureAlert = async ({
        leagueId,
        season,
        franchiseId,
        franchiseName,
        playerName,
        yearsRemaining,
        tcvLabel,
        guaranteedLabel,
        aavLabel,
        yearlyBreakdown,
        usageText,
        gifUrlOverride,
        forceTestOnly,
        forcePrimaryOnly,
        channelIdOverride,
      }) => {
        const botToken = contractDiscordBotToken();
        const overrideChannelId = safeStr(channelIdOverride).replace(/\D/g, "");
        const target = overrideChannelId
          ? {
              channelId: overrideChannelId,
              deliveryTarget: safeStr(forceTestOnly ? "test" : (forcePrimaryOnly ? "primary" : "override")),
              missingError: "",
            }
          : contractDiscordChannelTarget(!!forceTestOnly, !!forcePrimaryOnly);
        if (!botToken || !target.channelId) {
          return {
            ok: false,
            skipped: false,
            status: 0,
            error: !botToken ? "missing_discord_contract_bot_token" : safeStr(target.missingError || "missing_discord_contract_channel_config"),
          };
        }
        const franchiseMeta = await loadContractDiscordFranchiseMeta({
          season,
          leagueId,
          franchiseId: padFranchiseId(franchiseId),
        });
        const gif = safeStr(gifUrlOverride)
          ? { gif_url: safeStr(gifUrlOverride), query: "override" }
          : await pickContractActivityGifUrl({ activityType: "restructure", playerName });
        const embed = buildRestructureAlertEmbed({
          franchiseName: franchiseName || franchiseMeta.franchise_name,
          franchiseIconUrl: franchiseMeta.icon_url,
          playerName,
          yearsRemaining,
          tcvLabel,
          guaranteedLabel,
          aavLabel,
          yearlyBreakdown,
          usageText,
          gifUrl: safeStr(gif.gif_url || ""),
        });
        const res = await withContractDiscordSendSlot(target.channelId, async () => {
          return await discordBotRequest(
            botToken,
            "POST",
            `/channels/${encodeURIComponent(target.channelId)}/messages`,
            { content: "", embeds: [embed], allowed_mentions: { parse: [] } }
          );
        });
        return {
          ok: !!res.ok,
          skipped: false,
          status: safeInt(res.status, 0),
          error: res.ok ? "" : safeStr(res.text || "discord_restructure_alert_post_failed").slice(0, 600),
          channel_id: safeStr(target.channelId),
          delivery_target: safeStr(target.deliveryTarget || ""),
          message_id: safeStr(res.data?.id || ""),
          gif_url: safeStr(gif.gif_url || ""),
          gif_query: safeStr(gif.query || ""),
        };
      };

      // =================================================================
      // Cap Penalty Announcement Discord embed + sender
      // Per-team grouped drop penalties narrated in full sentences.
      // Uses fail/money/shock GIF queries (not player-specific).
      // =================================================================

      const capPenaltyGifQueries = () => [
        "money disappear",
        "expensive fail",
        "football money gone",
        "regret face",
        "shocked money",
        "football fail",
        "contract fail",
        "nfl frustration",
        "disappointed celebration",
      ];

      const pickCapPenaltyGifUrl = async () => {
        const apiKey = safeStr(env.GIPHY_API_KEY || "");
        if (!apiKey) return { ok: false, gif_url: "", query: "" };
        const queries = capPenaltyGifQueries();
        for (const q of queries) {
          const searchUrl = new URL("https://api.giphy.com/v1/gifs/search");
          searchUrl.searchParams.set("api_key", apiKey);
          searchUrl.searchParams.set("q", q);
          searchUrl.searchParams.set("limit", "25");
          searchUrl.searchParams.set("lang", "en");
          try {
            const res = await fetch(searchUrl.toString(), {
              headers: { "User-Agent": "upsmflproduction-worker" },
              cf: { cacheTtl: 300, cacheEverything: false },
            });
            if (!res.ok) continue;
            const data = await res.json();
            const rows = Array.isArray(data?.data) ? data.data : [];
            if (!rows.length) continue;
            const pick = rows[Math.floor(Math.random() * rows.length)];
            const gifUrl =
              safeStr(pick?.images?.original?.url) ||
              safeStr(pick?.images?.downsized_large?.url) ||
              safeStr(pick?.images?.fixed_height?.url) ||
              safeStr(pick?.url);
            if (gifUrl) return { ok: true, gif_url: gifUrl, query: q };
          } catch (_) {
            continue;
          }
        }
        return { ok: false, gif_url: "", query: queries[0] };
      };

      const buildCapPenaltyAnnouncementEmbed = ({
        franchiseName,
        franchiseIconUrl,
        teamTotalDollars,
        penaltyCount,
        capPenaltyLines, // array of pre-formatted narrative strings
        gifUrl,
        activityYearLabel, // e.g. "2025 Activity"
      }) => {
        const team = safeStr(franchiseName) || "Unknown Team";
        const lines = Array.isArray(capPenaltyLines) ? capPenaltyLines : [];
        const title = "Cap Penalty Announcement";
        // RULE-CAP-002: team-level rounding is dynamic until auction lock.
        // Show raw total + rounded total + delta note in the subtitle.
        const rawTotal = Math.abs(safeInt(teamTotalDollars, 0));
        const roundedTotal = Math.round(rawTotal / 1000) * 1000;
        const subtitle = [];
        if (activityYearLabel) subtitle.push(safeStr(activityYearLabel));
        if (penaltyCount > 0) subtitle.push(`${penaltyCount} drop${penaltyCount !== 1 ? "s" : ""}`);
        if (rawTotal) {
          if (roundedTotal !== rawTotal) {
            subtitle.push(`$${rawTotal.toLocaleString("en-US")} raw → **$${roundedTotal.toLocaleString("en-US")}** rounded`);
          } else {
            subtitle.push(`$${rawTotal.toLocaleString("en-US")} total`);
          }
        }

        const embed = {
          title,
          color: 0xaa2e2e, // dark red for penalties
          description: subtitle.join(" · "),
          fields: [],
        };
        if (rawTotal && roundedTotal !== rawTotal) {
          embed.fields.push({
            name: "Team Rounding (dynamic)",
            value: `Raw: $${rawTotal.toLocaleString("en-US")}  ·  Rounded: $${roundedTotal.toLocaleString("en-US")}  ·  Δ ${roundedTotal - rawTotal >= 0 ? "+" : "−"}$${Math.abs(roundedTotal - rawTotal).toLocaleString("en-US")}\n_Rounding is dynamic and will lock at the Auction._`,
            inline: false,
          });
        }
        if (lines.length) {
          // Discord field value limit is ~1024 chars; split across multiple fields if needed
          let chunk = [];
          let chunkLen = 0;
          let idx = 1;
          const flush = () => {
            if (!chunk.length) return;
            embed.fields.push({
              name: idx === 1 ? "Drops" : `Drops (cont.)`,
              value: chunk.join("\n\n"),
              inline: false,
            });
            idx += 1;
            chunk = [];
            chunkLen = 0;
          };
          for (const line of lines) {
            const l = safeStr(line);
            if (chunkLen + l.length + 2 > 1000) flush();
            chunk.push(l);
            chunkLen += l.length + 2;
          }
          flush();
        }
        embed.author = { name: team };
        if (safeStr(franchiseIconUrl)) embed.thumbnail = { url: safeStr(franchiseIconUrl) };
        if (safeStr(gifUrl)) embed.image = { url: safeStr(gifUrl) };
        return embed;
      };

      const sendDiscordCapPenaltyAnnouncement = async ({
        leagueId,
        season,
        franchiseId,
        franchiseName,
        teamTotalDollars,
        capPenaltyLines,
        activityYearLabel,
        forceTestOnly,
        forcePrimaryOnly,
        channelIdOverride,
      }) => {
        const botToken = contractDiscordBotToken();
        const overrideChannelId = safeStr(channelIdOverride).replace(/\D/g, "");
        const target = overrideChannelId
          ? {
              channelId: overrideChannelId,
              deliveryTarget: safeStr(forceTestOnly ? "test" : (forcePrimaryOnly ? "primary" : "override")),
              missingError: "",
            }
          : contractDiscordChannelTarget(!!forceTestOnly, !!forcePrimaryOnly);
        if (!botToken || !target.channelId) {
          return {
            ok: false,
            skipped: false,
            status: 0,
            error: !botToken ? "missing_discord_contract_bot_token" : safeStr(target.missingError || "missing_discord_contract_channel_config"),
            delivery_target: safeStr(target.deliveryTarget || ""),
          };
        }
        const franchiseMeta = await loadContractDiscordFranchiseMeta({
          season,
          leagueId,
          franchiseId: padFranchiseId(franchiseId),
        });
        const gif = await pickCapPenaltyGifUrl();
        const penaltyCount = Array.isArray(capPenaltyLines) ? capPenaltyLines.length : 0;
        const embed = buildCapPenaltyAnnouncementEmbed({
          franchiseName: franchiseName || franchiseMeta.franchise_name,
          franchiseIconUrl: franchiseMeta.icon_url,
          teamTotalDollars,
          penaltyCount,
          capPenaltyLines,
          gifUrl: safeStr(gif.gif_url || ""),
          activityYearLabel,
        });
        const res = await withContractDiscordSendSlot(target.channelId, async () => {
          return await discordBotRequest(
            botToken,
            "POST",
            `/channels/${encodeURIComponent(target.channelId)}/messages`,
            {
              content: "",
              embeds: [embed],
              allowed_mentions: { parse: [] },
            }
          );
        });
        return {
          ok: !!res.ok,
          skipped: false,
          status: safeInt(res.status, 0),
          error: res.ok ? "" : safeStr(res.text || "discord_cap_penalty_post_failed").slice(0, 600),
          channel_id: safeStr(target.channelId),
          delivery_target: safeStr(target.deliveryTarget || ""),
          message_id: safeStr(res.data?.id || ""),
          gif_url: safeStr(gif.gif_url || ""),
          gif_query: safeStr(gif.query || ""),
        };
      };

      const pinDiscordMessage = async ({ botToken, channelId, messageId }) => {
        const token = safeStr(botToken);
        const channel = safeStr(channelId).replace(/\D/g, "");
        const message = safeStr(messageId).replace(/\D/g, "");
        if (!token || !channel || !message) {
          return {
            ok: false,
            status: 0,
            error: "missing_pin_parameters",
          };
        }
        const res = await discordBotRequest(
          token,
          "PUT",
          `/channels/${encodeURIComponent(channel)}/pins/${encodeURIComponent(message)}`,
          null
        );
        return {
          ok: !!res.ok,
          status: safeInt(res.status, 0),
          error: res.ok ? "" : safeStr(res.text || "discord_pin_failed").slice(0, 600),
        };
      };

      const sendDiscordContractActivity = async ({
        activityType,
        leagueId,
        franchiseId,
        franchiseName,
        creditedFranchiseId,
        creditedFranchiseName,
        playerName,
        contractInfo,
        contractYear,
        contractStatus,
        season,
        salary,
        submittedAtUtc,
        forceTestOnly,
        forcePrimaryOnly,
        channelIdOverride,
        pinMessage,
        bypassAnnouncementRules,
        usageLabel,
        noteText,
        tradePartnerName,
      }) => {
        const allow = bypassAnnouncementRules
          ? { ok: true, skipped: false, reason: "" }
          : shouldAnnounceContractActivity({ activityType, season });
        if (!allow.ok) {
          return {
            ok: false,
            skipped: true,
            status: 0,
            error: safeStr(allow.reason || "announcement_skipped"),
            delivery_target: "",
            gif_url: "",
            gif_query: "",
          };
        }
        const kind = normalizeContractActivityKind(activityType, contractStatus);
        const preDeadlineTagDmOnly =
          kind === "tag" &&
          !forceTestOnly &&
          !forcePrimaryOnly &&
          !safeStr(channelIdOverride) &&
          !hasTagDeadlinePassed(season);
        if (preDeadlineTagDmOnly) {
          return await sendDiscordContractActivityDm({
            activityType,
            leagueId,
            franchiseId,
            franchiseName,
            creditedFranchiseId,
            creditedFranchiseName,
            playerName,
            contractInfo,
            contractYear,
            contractStatus,
            season,
            salary,
            submittedAtUtc,
            usageLabel,
            noteText,
            tradePartnerName,
          });
        }
        const botToken = contractDiscordBotToken();
        const overrideChannelId = safeStr(channelIdOverride).replace(/\D/g, "");
        const target = overrideChannelId
          ? {
              channelId: overrideChannelId,
              deliveryTarget: safeStr(forceTestOnly ? "test" : (forcePrimaryOnly ? "primary" : "override")),
              missingError: "",
            }
          : contractDiscordChannelTarget(!!forceTestOnly, !!forcePrimaryOnly);
        if (!botToken || !target.channelId) {
          return {
            ok: false,
            skipped: false,
            status: 0,
            error: !botToken ? "missing_discord_contract_bot_token" : safeStr(target.missingError || "missing_discord_contract_channel_config"),
            delivery_target: safeStr(target.deliveryTarget || ""),
            gif_url: "",
            gif_query: "",
          };
        }
        const franchiseMeta = await loadContractDiscordFranchiseMeta({
          season,
          leagueId,
          franchiseId: padFranchiseId(creditedFranchiseId || franchiseId),
        });
        const gif = await pickContractActivityGifUrl({ activityType, playerName });
        const embed = buildContractActivityDiscordEmbed({
          activityType,
          franchiseName: safeStr(franchiseName || franchiseMeta.franchise_name),
          creditedFranchiseName,
          playerName,
          contractInfo,
          contractYear,
          contractStatus,
          season,
          salary,
          submittedAtUtc,
          franchiseIconUrl: safeStr(franchiseMeta.icon_url),
          gifUrl: safeStr(gif.gif_url || ""),
          usageLabel,
          noteText,
          tradePartnerName,
        });
        const sendMessageOnce = async () =>
          await discordBotRequest(
            botToken,
            "POST",
            `/channels/${encodeURIComponent(target.channelId)}/messages`,
            {
              content: "",
              embeds: [embed],
              allowed_mentions: { parse: [] },
            }
          );
        const res = await withContractDiscordSendSlot(target.channelId, async () => {
          let attempt = 0;
          let current = await sendMessageOnce();
          while (attempt < 2 && !current.ok && isRetryableContractDiscordFailure(current)) {
            attempt += 1;
            await sleepMs(1500 * attempt);
            current = await sendMessageOnce();
          }
          return current;
        });
        const messageId = safeStr(res.data?.id || "");
        let pinResult = {
          ok: false,
          skipped: !pinMessage,
          status: 0,
          error: pinMessage ? "pin_not_attempted" : "",
        };
        if (res.ok && pinMessage && messageId) {
          pinResult = await pinDiscordMessage({
            botToken,
            channelId: target.channelId,
            messageId,
          });
        }
        return {
          ok: !!res.ok,
          skipped: false,
          status: safeInt(res.status, 0),
          error: res.ok ? "" : safeStr(res.text || "discord_contract_post_failed").slice(0, 600),
          channel_id: safeStr(target.channelId),
          delivery_target: safeStr(target.deliveryTarget || ""),
          message_id: messageId,
          gif_url: safeStr(gif.gif_url || ""),
          gif_query: safeStr(gif.query || ""),
          franchise_icon_url: safeStr(franchiseMeta.icon_url || ""),
          pin: pinResult,
        };
      };

      const sendDiscordContractActivityDm = async ({
        activityType,
        leagueId,
        franchiseId,
        franchiseName,
        creditedFranchiseId,
        creditedFranchiseName,
        playerName,
        contractInfo,
        contractYear,
        contractStatus,
        season,
        salary,
        submittedAtUtc,
        usageLabel,
        noteText,
        tradePartnerName,
        dmUserIds,
      }) => {
        const ids = Array.isArray(dmUserIds)
          ? dmUserIds.map((value) => safeStr(value).replace(/\D/g, "")).filter(Boolean)
          : parseDiscordUserIds(dmUserIds || env.DISCORD_DM_USER_IDS || "");
        if (!ids.length) {
          return {
            ok: false,
            skipped: false,
            status: 0,
            error: "missing_discord_dm_user_ids",
            delivery_target: "dm",
            dm_results: [],
            channel_id: "",
            message_id: "",
          };
        }

        const franchiseMeta = await loadContractDiscordFranchiseMeta({
          season,
          leagueId,
          franchiseId: padFranchiseId(creditedFranchiseId || franchiseId),
        });
        const gif = await pickContractActivityGifUrl({ activityType, playerName });
        const embed = buildContractActivityDiscordEmbed({
          activityType,
          franchiseName: safeStr(franchiseName || franchiseMeta.franchise_name),
          creditedFranchiseName,
          playerName,
          contractInfo,
          contractYear,
          contractStatus,
          season,
          salary,
          submittedAtUtc,
          franchiseIconUrl: safeStr(franchiseMeta.icon_url),
          gifUrl: safeStr(gif.gif_url || ""),
          usageLabel,
          noteText,
          tradePartnerName,
        });
        const dmResults = await sendDiscordDmEmbedsToUsers({
          userIds: ids,
          content: "",
          embeds: [embed],
        });
        const first = dmResults[0] || {};
        const allOk = dmResults.length > 0 && dmResults.every((row) => !!row.ok);
        return {
          ok: allOk,
          skipped: false,
          status: safeInt(first.status, allOk ? 200 : 0),
          error: allOk
            ? ""
            : dmResults
                .map((row) => safeStr(row && row.error))
                .filter(Boolean)
                .join("; ")
                .slice(0, 600),
          delivery_target: "dm",
          channel_id: safeStr(first.channel_id || ""),
          message_id: safeStr(first.message_id || ""),
          gif_url: safeStr(gif.gif_url || ""),
          gif_query: safeStr(gif.query || ""),
          franchise_icon_url: safeStr(franchiseMeta.icon_url || ""),
          dm_results: dmResults,
        };
      };

      const editDiscordContractActivity = async ({
        activityType,
        leagueId,
        franchiseId,
        franchiseName,
        creditedFranchiseId,
        creditedFranchiseName,
        playerName,
        contractInfo,
        contractYear,
        contractStatus,
        season,
        salary,
        submittedAtUtc,
        channelId,
        messageId,
        gifUrl,
        usageLabel,
        noteText,
        tradePartnerName,
      }) => {
        const botToken = contractDiscordBotToken();
        const targetChannelId = safeStr(channelId).replace(/\D/g, "");
        const targetMessageId = safeStr(messageId).replace(/\D/g, "");
        if (!botToken || !targetChannelId || !targetMessageId) {
          return {
            ok: false,
            status: 0,
            error: !botToken
              ? "missing_discord_contract_bot_token"
              : (!targetChannelId ? "missing_channel_id" : "missing_message_id"),
            channel_id: targetChannelId,
            message_id: targetMessageId,
          };
        }
        const franchiseMeta = await loadContractDiscordFranchiseMeta({
          season,
          leagueId,
          franchiseId: padFranchiseId(creditedFranchiseId || franchiseId),
        });
        const embed = buildContractActivityDiscordEmbed({
          activityType,
          franchiseName: safeStr(franchiseName || franchiseMeta.franchise_name),
          creditedFranchiseName,
          playerName,
          contractInfo,
          contractYear,
          contractStatus,
          season,
          salary,
          submittedAtUtc,
          franchiseIconUrl: safeStr(franchiseMeta.icon_url),
          gifUrl: safeStr(gifUrl || ""),
          usageLabel,
          noteText,
          tradePartnerName,
        });
        const res = await discordBotRequest(
          botToken,
          "PATCH",
          `/channels/${encodeURIComponent(targetChannelId)}/messages/${encodeURIComponent(targetMessageId)}`,
          {
            content: "",
            embeds: [embed],
            allowed_mentions: { parse: [] },
          }
        );
        return {
          ok: !!res.ok,
          status: safeInt(res.status, 0),
          error: res.ok ? "" : safeStr(res.text || "discord_contract_edit_failed").slice(0, 600),
          channel_id: targetChannelId,
          message_id: targetMessageId,
          franchise_icon_url: safeStr(franchiseMeta.icon_url || ""),
          gif_url: safeStr(gifUrl || ""),
        };
      };

      const parseContractActivityRequestFields = (body, defaults = {}) => {
        const franchiseId = padFranchiseId(body.franchise_id || body.franchiseId || defaults.franchiseId || "");
        const franchiseName = safeStr(body.franchise_name || body.franchiseName || defaults.franchiseName || "");
        const contractStatus = safeStr(body.contract_status || body.contractStatus || defaults.contractStatus || "");
        return {
          playerName: safeStr(body.player_name || body.playerName || defaults.playerName || ""),
          franchiseId,
          franchiseName,
          creditedFranchiseId: padFranchiseId(
            body.credited_franchise_id || body.creditedFranchiseId || defaults.creditedFranchiseId || franchiseId
          ),
          creditedFranchiseName: safeStr(
            body.credited_franchise_name || body.creditedFranchiseName || defaults.creditedFranchiseName || franchiseName
          ),
          tradePartnerName: safeStr(body.trade_partner_name || body.tradePartnerName || defaults.tradePartnerName || ""),
          contractInfo: safeStr(body.contract_info || body.contractInfo || defaults.contractInfo || ""),
          contractYear: safeStr(body.contract_year || body.contractYear || defaults.contractYear || ""),
          salary: safeStr(body.salary || defaults.salary || ""),
          submittedAtUtc: safeStr(body.submitted_at_utc || body.submittedAtUtc || defaults.submittedAtUtc || new Date().toISOString()),
          contractStatus,
          usageLabel: safeStr(body.usage_label || body.usageLabel || defaults.usageLabel || ""),
          noteText: safeStr(body.note_text || body.noteText || defaults.noteText || ""),
          activityType:
            safeStr(body.activity_type || body.activityType || defaults.activityType || "") ||
            deriveContractActivityType({
              isExtensionSubmission: /\bext/i.test(contractStatus),
              isRestructure: /\brestructure\b/i.test(contractStatus),
              contractStatus,
          }),
        };
      };

      const reminderDiscordPrimaryChannelId = () =>
        safeStr(env.DISCORD_REMINDER_CHANNEL_ID || "1087157907419840644").replace(/\D/g, "");

      const reminderDiscordTestChannelId = () =>
        safeStr(
          env.DISCORD_REMINDER_TEST_CHANNEL_ID ||
          env.DISCORD_CONTRACT_TEST_CHANNEL_ID ||
          env.DISCORD_BUG_TEST_CHANNEL_ID ||
          "1089538054236160010"
        ).replace(/\D/g, "");

      const reminderDiscordChannelTarget = (forceTestOnly = false, forcePrimaryOnly = false) => {
        if (forcePrimaryOnly) {
          const primaryChannelId = reminderDiscordPrimaryChannelId();
          return {
            channelId: primaryChannelId,
            deliveryTarget: "primary",
            missingError: primaryChannelId ? "" : "missing_discord_reminder_channel_config",
          };
        }
        const testChannelId = reminderDiscordTestChannelId();
        if (testChannelId) {
          return {
            channelId: testChannelId,
            deliveryTarget: "test",
            missingError: "",
          };
        }
        if (forceTestOnly) {
          return {
            channelId: "",
            deliveryTarget: "test",
            missingError: "missing_discord_reminder_test_channel_config",
          };
        }
        const primaryChannelId = reminderDiscordPrimaryChannelId();
        return {
          channelId: primaryChannelId,
          deliveryTarget: "primary",
          missingError: primaryChannelId ? "" : "missing_discord_reminder_channel_config",
        };
      };

      const etDateKeyFromDate = (value) => {
        const date = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(date.getTime())) return "";
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(date);
        const year = parts.find((part) => part.type === "year")?.value || "";
        const month = parts.find((part) => part.type === "month")?.value || "";
        const day = parts.find((part) => part.type === "day")?.value || "";
        return year && month && day ? `${year}-${month}-${day}` : "";
      };

      const shiftPlainDateKey = (dateKey, deltaDays) => {
        const raw = safeStr(dateKey);
        if (!raw) return "";
        const parsed = new Date(`${raw}T12:00:00Z`);
        if (Number.isNaN(parsed.getTime())) return "";
        parsed.setUTCDate(parsed.getUTCDate() + safeInt(deltaDays, 0));
        return parsed.toISOString().slice(0, 10);
      };

      const formatPlainDateLabelEt = (dateKey) => {
        const raw = safeStr(dateKey);
        if (!raw) return "";
        const parsed = new Date(`${raw}T12:00:00Z`);
        if (Number.isNaN(parsed.getTime())) return raw;
        return parsed.toLocaleDateString("en-US", {
          timeZone: "America/New_York",
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
        });
      };

      const parseEtTimeParts = (rawTime, fallbackHour = 9, fallbackMinute = 0) => {
        const match = safeStr(rawTime).match(/^(\d{1,2}):(\d{2})$/);
        if (!match) {
          return { hour: fallbackHour, minute: fallbackMinute };
        }
        const hour = Math.max(0, Math.min(23, safeInt(match[1], fallbackHour)));
        const minute = Math.max(0, Math.min(59, safeInt(match[2], fallbackMinute)));
        return { hour, minute };
      };

      const formatTimeLabelEt = (rawTime) => {
        const { hour, minute } = parseEtTimeParts(rawTime, 9, 0);
        const meridiem = hour >= 12 ? "PM" : "AM";
        const hour12 = hour % 12 || 12;
        return `${hour12}:${String(minute).padStart(2, "0")} ${meridiem} ET`;
      };

      const formatPlainDateTimeLabelEt = (dateKey, rawTime) => {
        const dateLabel = formatPlainDateLabelEt(dateKey);
        if (!dateLabel) return "";
        return `${dateLabel} at ${formatTimeLabelEt(rawTime)}`;
      };

      const currentEtParts = (value = new Date()) => {
        const date = value instanceof Date ? value : new Date(value);
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).formatToParts(date);
        const take = (type) => safeStr(parts.find((part) => part.type === type)?.value || "");
        return {
          date_key: `${take("year")}-${take("month")}-${take("day")}`,
          hour: safeInt(take("hour"), 0),
          minute: safeInt(take("minute"), 0),
        };
      };

      const thanksgivingDateKey = (season) => {
        const year = safeInt(season, 0);
        if (year <= 0) return "";
        const firstUtc = new Date(Date.UTC(year, 10, 1, 12, 0, 0));
        const firstWeekday = firstUtc.getUTCDay();
        const firstThursdayOffset = (4 - firstWeekday + 7) % 7;
        const thanksgivingDay = 1 + firstThursdayOffset + 21;
        return `${String(year).padStart(4, "0")}-11-${String(thanksgivingDay).padStart(2, "0")}`;
      };

      const etDateTimeFromIso = (rawValue) => {
        const date = new Date(rawValue);
        if (Number.isNaN(date.getTime())) return { date_key: "", time_et: "" };
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).formatToParts(date);
        const take = (type) => safeStr(parts.find((part) => part.type === type)?.value || "");
        return {
          date_key: `${take("year")}-${take("month")}-${take("day")}`,
          time_et: `${take("hour")}:${take("minute")}`,
        };
      };

      const parseDiscordUserIds = (rawValue) =>
        Array.from(
          new Set(
            safeStr(rawValue)
              .split(/[\s,]+/)
              .map((part) => part.replace(/\D/g, ""))
              .filter(Boolean)
          )
        );

      const resolveTradeDeadlineKickoffEt = async (season) => {
        const seasonKey = safeStr(season);
        const configured =
          ((DEADLINE_REMINDER_CALENDAR[seasonKey] || {}).trade_deadline && typeof (DEADLINE_REMINDER_CALENDAR[seasonKey] || {}).trade_deadline === "object")
            ? (DEADLINE_REMINDER_CALENDAR[seasonKey] || {}).trade_deadline
            : {};
        const thanksgivingDate = thanksgivingDateKey(seasonKey) || safeStr(configured.deadline_date_et);
        const fallbackTimeEt = safeStr(configured.deadline_time_et || "13:00");
        const checkedAtUtc = new Date().toISOString();
        const datesParam = thanksgivingDate ? thanksgivingDate.replace(/-/g, "") : "";
        const sourceUrl = datesParam
          ? `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${encodeURIComponent(datesParam)}`
          : "";
        const fallback = {
          season: safeInt(seasonKey, 0),
          deadline_date_et: thanksgivingDate,
          deadline_time_et: fallbackTimeEt,
          fallback_used: true,
          source: "configured_fallback",
          source_url: sourceUrl,
          checked_at_utc: checkedAtUtc,
          event_name: "",
          event_id: "",
          event_date_utc: "",
          upstream_status: 0,
          upstream_error: "",
        };
        if (!sourceUrl) return fallback;
        try {
          const res = await fetch(sourceUrl, {
            headers: {
              "User-Agent": "upsmflproduction-worker",
              "Cache-Control": "no-store",
            },
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          fallback.upstream_status = safeInt(res.status, 0);
          if (!res.ok) {
            fallback.upstream_error = `http_${res.status}`;
            return fallback;
          }
          const data = await res.json();
          const events = Array.isArray(data?.events) ? data.events : [];
          if (!events.length) {
            fallback.upstream_error = "no_events";
            return fallback;
          }
          const first = events
            .filter((row) => safeStr(row?.date))
            .sort((a, b) => String(a?.date || "").localeCompare(String(b?.date || "")))[0];
          if (!first) {
            fallback.upstream_error = "no_event_dates";
            return fallback;
          }
          const resolved = etDateTimeFromIso(first.date);
          if (!safeStr(resolved.date_key) || !safeStr(resolved.time_et)) {
            fallback.upstream_error = "unresolved_event_time";
            return fallback;
          }
          return {
            season: safeInt(seasonKey, 0),
            deadline_date_et: safeStr(resolved.date_key),
            deadline_time_et: safeStr(resolved.time_et),
            fallback_used: false,
            source: "espn_scoreboard",
            source_url: sourceUrl,
            checked_at_utc: checkedAtUtc,
            event_name: safeStr(first?.name || ""),
            event_id: safeStr(first?.id || ""),
            event_date_utc: safeStr(first?.date || ""),
            upstream_status: safeInt(res.status, 0),
            upstream_error: "",
          };
        } catch (e) {
          fallback.upstream_error = `fetch_failed: ${e?.message || String(e)}`;
          return fallback;
        }
      };

      const tradeDeadlineResolutionChanged = (previous, next) => {
        const prev = previous && typeof previous === "object" ? previous : {};
        const current = next && typeof next === "object" ? next : {};
        return (
          safeStr(prev.deadline_date_et) !== safeStr(current.deadline_date_et) ||
          safeStr(prev.deadline_time_et) !== safeStr(current.deadline_time_et) ||
          safeStr(prev.source) !== safeStr(current.source) ||
          safeInt(prev.fallback_used, 1) !== safeInt(current.fallback_used, 1) ||
          safeStr(prev.event_name) !== safeStr(current.event_name)
        );
      };

      const shouldNotifyTradeDeadlineResolution = (previous, next) => {
        const prev = previous && typeof previous === "object" ? previous : {};
        const current = next && typeof next === "object" ? next : {};
        if (!tradeDeadlineResolutionChanged(prev, current)) return false;
        if (safeInt(current.fallback_used, 1)) return false;
        return (
          safeInt(prev.fallback_used, 1) === 1 ||
          safeStr(prev.deadline_date_et) !== safeStr(current.deadline_date_et) ||
          safeStr(prev.deadline_time_et) !== safeStr(current.deadline_time_et)
        );
      };

      const buildTradeDeadlineResolutionDmEmbed = ({ season, previous, current }) => {
        const prev = previous && typeof previous === "object" ? previous : {};
        const next = current && typeof current === "object" ? current : {};
        return {
          title: `Trade Deadline Auto-Updated for ${safeStr(season)}`,
          color: 0x103a71,
          description: "Thanksgiving kickoff is official, so the trade deadline reminder schedule has been updated automatically.",
          fields: [
            {
              name: "Previous Deadline",
              value: formatPlainDateTimeLabelEt(
                safeStr(prev.deadline_date_et || thanksgivingDateKey(season)),
                safeStr(prev.deadline_time_et || "13:00")
              ),
              inline: false,
            },
            {
              name: "Updated Deadline",
              value: formatPlainDateTimeLabelEt(safeStr(next.deadline_date_et), safeStr(next.deadline_time_et)),
              inline: false,
            },
            {
              name: "Source",
              value: safeStr(next.event_name || next.source || "Auto-resolved kickoff"),
              inline: false,
            },
          ],
          footer: {
            text: `Checked ${formatBugSubmittedAt(safeStr(next.checked_at_utc || new Date().toISOString()))}`,
          },
        };
      };

      const minutesOfDayEt = (hour, minute) =>
        (Math.max(0, Math.min(23, safeInt(hour, 0))) * 60) + Math.max(0, Math.min(59, safeInt(minute, 0)));

      const shiftDateTimeEt = (dateKey, rawTime, deltaMinutes) => {
        const raw = safeStr(dateKey);
        if (!raw) return { date_key: "", time_et: "" };
        const [year, month, day] = raw.split("-").map((part) => safeInt(part, 0));
        if (!year || !month || !day) return { date_key: "", time_et: "" };
        const { hour, minute } = parseEtTimeParts(rawTime, 9, 0);
        const base = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
        if (Number.isNaN(base.getTime())) return { date_key: "", time_et: "" };
        base.setUTCMinutes(base.getUTCMinutes() + safeInt(deltaMinutes, 0));
        return {
          date_key: base.toISOString().slice(0, 10),
          time_et: `${String(base.getUTCHours()).padStart(2, "0")}:${String(base.getUTCMinutes()).padStart(2, "0")}`,
        };
      };

      const DEADLINE_REMINDER_CALENDAR = {
        "2026": {
          rookie_extensions_and_tags: {
            title: "Expiring Rookie Extensions + Tag Deadline",
            deadline_date_et: "2026-05-21",
            deadline_time_et: "21:00",
            reminder_send_time_et: "09:00",
            summary: "Finalize expiring rookie extensions and franchise tags before the window closes.",
            reminder_offsets_days: [7, 2, 1],
            reminder_offsets_hours: [],
          },
          rookie_draft: {
            title: "Rookie Draft",
            deadline_date_et: "2026-05-24",
            deadline_time_et: "18:30",
            reminder_send_time_et: "09:00",
            summary: "Set your board, queue your picks, and be ready for trade chaos on draft night.",
            reminder_offsets_days: [7, 3],
            reminder_offsets_hours: [1],
          },
          cut_deadline: {
            title: "Auction Cut Deadline",
            deadline_date_et: "2026-07-22",
            deadline_time_et: "21:00",
            reminder_send_time_et: "09:00",
            summary: "Cut decisions have to be final before the free agent auction roster lock hits.",
            reminder_offsets_days: [7, 1],
            reminder_offsets_hours: [],
          },
          free_agent_auction: {
            title: "Free Agent Auction Opens",
            deadline_date_et: "2026-07-25",
            deadline_time_et: "12:00",
            reminder_send_time_et: "09:00",
            summary: "Get cap space, roster spots, and nomination plans sorted before the auction opens.",
            reminder_offsets_days: [7, 1],
            reminder_offsets_hours: [],
          },
          contract_deadline: {
            title: "Contract Deadline",
            deadline_date_et: "2026-09-06",
            deadline_time_et: "21:00",
            reminder_send_time_et: "09:00",
            summary: "Extensions, auction multis, and option decisions need to be locked before kickoff week closes the door.",
            reminder_offsets_days: [7, 1],
            reminder_offsets_hours: [],
          },
          trade_deadline: {
            title: "Trade Deadline",
            deadline_date_et: "2026-11-26",
            deadline_time_et: "13:00",
            reminder_send_time_et: "09:00",
            summary: "Finish the last deals before Thanksgiving kickoff shuts the market down.",
            reminder_offsets_days: [7, 1],
            reminder_offsets_hours: [1],
          },
        },
      };

      const reminderCodeFromDays = (daysBefore) => {
        const days = safeInt(daysBefore, 0);
        if (days === 7) return "one_week";
        if (days === 3) return "72_hours";
        if (days === 2) return "48_hours";
        if (days === 1) return "24_hours";
        return `${days}_days`;
      };

      const reminderLabelFromDays = (daysBefore) => {
        const days = safeInt(daysBefore, 0);
        if (days === 7) return "1 Week";
        if (days === 3) return "72 Hours";
        if (days === 2) return "48 Hours";
        if (days === 1) return "24 Hours";
        return `${days} Days`;
      };

      const reminderCodeFromHours = (hoursBefore) => {
        const hours = safeInt(hoursBefore, 0);
        if (hours === 1) return "1_hour";
        return `${hours}_hours`;
      };

      const reminderLabelFromHours = (hoursBefore) => {
        const hours = safeInt(hoursBefore, 0);
        if (hours === 1) return "1 Hour";
        return `${hours} Hours`;
      };

      const deadlineReminderCatalogForSeason = (season, overrides = {}) => {
        const seasonKey = safeStr(season);
        const raw = DEADLINE_REMINDER_CALENDAR[seasonKey] || {};
        return Object.entries(raw).map(([eventKey, event]) => ({
          event_key: eventKey,
          title: safeStr((overrides[eventKey] && overrides[eventKey].title) || event.title),
          deadline_date_et: safeStr((overrides[eventKey] && overrides[eventKey].deadline_date_et) || event.deadline_date_et),
          deadline_time_et: safeStr((overrides[eventKey] && overrides[eventKey].deadline_time_et) || event.deadline_time_et || "23:59"),
          reminder_send_time_et: safeStr((overrides[eventKey] && overrides[eventKey].reminder_send_time_et) || event.reminder_send_time_et || "09:00"),
          summary: safeStr((overrides[eventKey] && overrides[eventKey].summary) || event.summary),
          reminder_offsets_days: Array.isArray((overrides[eventKey] && overrides[eventKey].reminder_offsets_days) || null)
            ? overrides[eventKey].reminder_offsets_days.map((v) => safeInt(v, 0)).filter((v) => v > 0)
            : Array.isArray(event.reminder_offsets_days)
            ? event.reminder_offsets_days.map((v) => safeInt(v, 0)).filter((v) => v > 0)
            : [],
          reminder_offsets_hours: Array.isArray((overrides[eventKey] && overrides[eventKey].reminder_offsets_hours) || null)
            ? overrides[eventKey].reminder_offsets_hours.map((v) => safeInt(v, 0)).filter((v) => v > 0)
            : Array.isArray(event.reminder_offsets_hours)
            ? event.reminder_offsets_hours.map((v) => safeInt(v, 0)).filter((v) => v > 0)
            : [],
        }));
      };

      const buildDeadlineReminderKey = ({ season, eventKey, reminderCode, deliveryTarget }) =>
        [safeStr(season), safeStr(eventKey), safeStr(reminderCode), safeStr(deliveryTarget || "primary")].join("|");

      const sentDeadlineReminderKey = (row) =>
        safeStr(row?.reminder_key) ||
        buildDeadlineReminderKey({
          season: safeStr(row?.season),
          eventKey: safeStr(row?.event_key),
          reminderCode: safeStr(row?.reminder_code),
          deliveryTarget: safeStr(row?.delivery_target || (safeInt(row?.test_flag, 0) ? "test" : "primary")),
        });

      const buildDueDeadlineReminders = ({
        season,
        catalog,
        currentEt,
        deliveryTarget,
        sentKeys,
        eventKeyFilter,
        reminderCodeFilter,
      }) => {
        const nowEt = currentEt && typeof currentEt === "object" ? currentEt : currentEtParts();
        const targetDate = safeStr(nowEt.date_key);
        const targetDelivery = safeStr(deliveryTarget || "primary");
        const sent = sentKeys instanceof Set ? sentKeys : new Set();
        const rows = [];
        const eventCatalog = Array.isArray(catalog) ? catalog : deadlineReminderCatalogForSeason(season);
        for (const event of eventCatalog) {
          if (eventKeyFilter && safeStr(event.event_key) !== safeStr(eventKeyFilter)) continue;
          for (const daysBefore of event.reminder_offsets_days) {
            const reminderCode = reminderCodeFromDays(daysBefore);
            if (reminderCodeFilter && safeStr(reminderCode) !== safeStr(reminderCodeFilter)) continue;
            const triggerDateEt = shiftPlainDateKey(event.deadline_date_et, -daysBefore);
            const sendTimeEt = safeStr(event.reminder_send_time_et || "09:00");
            const sendParts = parseEtTimeParts(sendTimeEt, 9, 0);
            if (triggerDateEt !== targetDate) continue;
            if (minutesOfDayEt(nowEt.hour, nowEt.minute) < minutesOfDayEt(sendParts.hour, sendParts.minute)) continue;
            const reminderKey = buildDeadlineReminderKey({
              season,
              eventKey: event.event_key,
              reminderCode,
              deliveryTarget: targetDelivery,
            });
            if (sent.has(reminderKey)) continue;
            rows.push({
              season: safeStr(season),
              event_key: safeStr(event.event_key),
              title: safeStr(event.title),
              deadline_date_et: safeStr(event.deadline_date_et),
              deadline_time_et: safeStr(event.deadline_time_et || "23:59"),
              summary: safeStr(event.summary),
              reminder_days_before: daysBefore,
              reminder_code: reminderCode,
              reminder_label: reminderLabelFromDays(daysBefore),
              trigger_date_et: triggerDateEt,
              trigger_time_et: sendTimeEt,
              reminder_key: reminderKey,
            });
          }
          for (const hoursBefore of event.reminder_offsets_hours || []) {
            const reminderCode = reminderCodeFromHours(hoursBefore);
            if (reminderCodeFilter && safeStr(reminderCode) !== safeStr(reminderCodeFilter)) continue;
            const shifted = shiftDateTimeEt(event.deadline_date_et, event.deadline_time_et, -hoursBefore * 60);
            const triggerDateEt = safeStr(shifted.date_key);
            const sendTimeEt = safeStr(shifted.time_et || event.reminder_send_time_et || "09:00");
            const sendParts = parseEtTimeParts(sendTimeEt, 9, 0);
            if (triggerDateEt !== targetDate) continue;
            if (minutesOfDayEt(nowEt.hour, nowEt.minute) < minutesOfDayEt(sendParts.hour, sendParts.minute)) continue;
            const reminderKey = buildDeadlineReminderKey({
              season,
              eventKey: event.event_key,
              reminderCode,
              deliveryTarget: targetDelivery,
            });
            if (sent.has(reminderKey)) continue;
            rows.push({
              season: safeStr(season),
              event_key: safeStr(event.event_key),
              title: safeStr(event.title),
              deadline_date_et: safeStr(event.deadline_date_et),
              deadline_time_et: safeStr(event.deadline_time_et || "23:59"),
              summary: safeStr(event.summary),
              reminder_days_before: 0,
              reminder_hours_before: hoursBefore,
              reminder_code: reminderCode,
              reminder_label: reminderLabelFromHours(hoursBefore),
              trigger_date_et: triggerDateEt,
              trigger_time_et: sendTimeEt,
              reminder_key: reminderKey,
            });
          }
        }
        return rows;
      };

      const reminderGifQueries = ({ eventKey, reminderCode }) => {
        const event = safeStr(eventKey);
        const reminder = safeStr(reminderCode);
        const queries = [
          "deadline panic",
          "running late fail",
          "overslept alarm clock",
          "calendar reminder fail",
          "missed the deadline reaction",
          "late to meeting gif",
        ];
        if (reminder === "1_hour") {
          queries.unshift("men cheering sports");
          queries.unshift("guy freaking out excited");
          queries.unshift("sports fan losing his mind");
        } else if (reminder === "24_hours") {
          queries.unshift("last minute panic");
          queries.unshift("alarm clock panic");
        } else if (reminder === "48_hours" || reminder === "72_hours") {
          queries.unshift("running out of time");
        } else if (reminder === "one_week") {
          queries.unshift("calendar marked reminder");
        }
        if (event.includes("draft")) queries.unshift("draft day panic");
        if (event.includes("trade")) queries.unshift("trade deadline panic");
        if (event.includes("auction")) queries.unshift("auction panic");
        return Array.from(new Set(queries.filter(Boolean)));
      };

      const pickDeadlineReminderGifUrl = async ({ eventKey, reminderCode }) => {
        const apiKey = safeStr(env.GIPHY_API_KEY || "");
        if (!apiKey) {
          return { ok: false, gif_url: "", reason: "missing_giphy_api_key", query: "" };
        }
        const queries = reminderGifQueries({ eventKey, reminderCode });
        for (const query of queries) {
          const searchUrl = new URL("https://api.giphy.com/v1/gifs/search");
          searchUrl.searchParams.set("api_key", apiKey);
          searchUrl.searchParams.set("q", query);
          searchUrl.searchParams.set("limit", "15");
          searchUrl.searchParams.set("offset", "0");
          // GIF rating restriction removed per commissioner 2026-04-17 (RULE-WORKFLOW-003)
          searchUrl.searchParams.set("lang", "en");
          try {
            const res = await fetch(searchUrl.toString(), {
              headers: { "User-Agent": "upsmflproduction-worker" },
              cf: { cacheTtl: 300, cacheEverything: false },
            });
            if (!res.ok) continue;
            const data = await res.json();
            const rows = Array.isArray(data?.data) ? data.data : [];
            if (!rows.length) continue;
            const pick = rows[Math.floor(Math.random() * rows.length)] || rows[0];
            const gifUrl =
              safeStr(pick?.images?.original?.url) ||
              safeStr(pick?.images?.downsized_large?.url) ||
              safeStr(pick?.images?.fixed_height?.url) ||
              safeStr(pick?.url);
            if (gifUrl) return { ok: true, gif_url: gifUrl, reason: "", query };
          } catch (_) {
            continue;
          }
        }
        return { ok: false, gif_url: "", reason: "gif_not_found", query: queries[0] || "" };
      };

      const buildDeadlineReminderDiscordEmbed = ({ reminder, gifUrl }) => {
        const toneBank = {
          one_week: [
            "Enough time to be responsible. Not enough time to forget.",
            "Calendar warning issued before the panic becomes athletic.",
          ],
          "72_hours": [
            "Three-day warning. Coffee is officially strategy now.",
            "This is the stage where the to-do list starts staring back.",
          ],
          "48_hours": [
            "Two days left. The clock has stopped being polite.",
            "Forty-eight hours is plenty if denial is not the plan.",
          ],
          "24_hours": [
            "One day left. This is not a drill and probably not a nap window.",
            "Final warning before tomorrow turns into a very avoidable story.",
          ],
          "1_hour": [
            "One hour out. This is the part where group chats become scouting departments.",
            "Sixty minutes to go. Draft board up, caffeine in play, chaos expected.",
          ],
        };
        const reminderCode = safeStr(reminder?.reminder_code);
        const toneOptions = toneBank[reminderCode] || toneBank.one_week;
        const toneLine = toneOptions[Math.floor(Math.random() * toneOptions.length)] || toneOptions[0] || "";
        const urgencyHours = safeInt(reminder?.reminder_hours_before, 0);
        const daysBefore = safeInt(reminder?.reminder_days_before, 0);
        const embedColor =
          urgencyHours > 0 || daysBefore <= 1 ? 0xb45309 : (daysBefore <= 3 ? 0xc8a24d : 0x103a71);
        const embed = {
          title: `Reminder: ${safeStr(reminder?.title)} in ${safeStr(reminder?.reminder_label)}`,
          color: embedColor,
          description: `${formatPlainDateTimeLabelEt(reminder?.deadline_date_et, reminder?.deadline_time_et)}\n${toneLine}`,
          fields: [
            {
              name: "What This Covers",
              value:
                safeStr(reminder?.event_key) === "trade_deadline" && safeStr(reminder?.reminder_code) === "1_hour"
                  ? `${safeStr(reminder?.summary || "Deadline reminder")}\nHappy Thanksgiving.`
                  : safeStr(reminder?.summary || "Deadline reminder"),
              inline: false,
            },
            {
              name: "Reminder Time",
              value: formatPlainDateTimeLabelEt(reminder?.trigger_date_et, reminder?.trigger_time_et),
              inline: false,
            },
          ],
          footer: {
            text: `Scheduled reminder window starts ${formatTimeLabelEt(reminder?.trigger_time_et || "09:00")}`,
          },
        };
        if (safeStr(gifUrl)) {
          embed.image = { url: safeStr(gifUrl) };
        }
        return embed;
      };

      const sendDiscordDeadlineReminder = async ({
        reminder,
        forceTestOnly,
        forcePrimaryOnly,
        channelIdOverride,
      }) => {
        const botToken = contractDiscordBotToken();
        const overrideChannelId = safeStr(channelIdOverride).replace(/\D/g, "");
        const target = overrideChannelId
          ? {
              channelId: overrideChannelId,
              deliveryTarget: safeStr(forceTestOnly ? "test" : (forcePrimaryOnly ? "primary" : "override")),
              missingError: "",
            }
          : reminderDiscordChannelTarget(!!forceTestOnly, !!forcePrimaryOnly);
        if (!botToken || !target.channelId) {
          return {
            ok: false,
            status: 0,
            error: !botToken ? "missing_discord_contract_bot_token" : safeStr(target.missingError || "missing_discord_reminder_channel_config"),
            channel_id: safeStr(target.channelId || ""),
            delivery_target: safeStr(target.deliveryTarget || ""),
          };
        }
        const gif = await pickDeadlineReminderGifUrl({
          eventKey: safeStr(reminder?.event_key),
          reminderCode: safeStr(reminder?.reminder_code),
        });
        const embed = buildDeadlineReminderDiscordEmbed({ reminder, gifUrl: safeStr(gif.gif_url || "") });
        const sendMessageOnce = async () =>
          await discordBotRequest(
            botToken,
            "POST",
            `/channels/${encodeURIComponent(target.channelId)}/messages`,
            {
              content: "",
              embeds: [embed],
              allowed_mentions: { parse: [] },
            }
          );
        const res = await withContractDiscordSendSlot(target.channelId, async () => {
          let attempt = 0;
          let current = await sendMessageOnce();
          while (attempt < 2 && !current.ok && isRetryableContractDiscordFailure(current)) {
            attempt += 1;
            await sleepMs(1500 * attempt);
            current = await sendMessageOnce();
          }
          return current;
        });
        return {
          ok: !!res.ok,
          status: safeInt(res.status, 0),
          error: res.ok ? "" : safeStr(res.text || "discord_deadline_reminder_failed").slice(0, 600),
          channel_id: safeStr(target.channelId),
          delivery_target: safeStr(target.deliveryTarget || ""),
          message_id: safeStr(res.data?.id || ""),
          gif_url: safeStr(gif.gif_url || ""),
          gif_query: safeStr(gif.query || ""),
        };
      };

      const normalizeExtensionContractStatusForImport = (req, currentStatus) => {
        const requestedRaw = safeStr(
          req?.new_contract_status || req?.contract_status || req?.contractStatus || ""
        ).trim();
        const requested = requestedRaw.toUpperCase();
        if (/^EXT1$/.test(requested)) return "EXT1";
        if (/^EXT2$/.test(requested)) return "EXT2";
        if (/^EXT2-BL$/.test(requested)) return "EXT2-BL";
        if (/^EXT2-FL$/.test(requested)) return "EXT2-FL";

        const optionKey = safeStr(req?.option_key || req?.optionKey).toUpperCase();
        const termToken = safeStr(
          req?.extension_term || req?.extensionTerm || req?.term || ""
        ).toUpperCase();

        const term =
          termToken.startsWith("2") || optionKey.startsWith("2YR")
            ? 2
            : termToken.startsWith("1") || optionKey.startsWith("1YR")
              ? 1
              : 0;

        if (term === 1) return "EXT1";
        if (term === 2) {
          // Loaded 2-year extensions use explicit BL/FL suffixes.
          if (optionKey.includes("|BL")) return "EXT2-BL";
          if (optionKey.includes("|FL")) return "EXT2-FL";
          return "EXT2";
        }

        // Last resort for malformed input: keep explicit EXT* if present; otherwise map by current if possible.
        if (requested.startsWith("EXT")) return requestedRaw || requested;
        const current = safeStr(currentStatus).toUpperCase();
        if (current.includes("BL")) return "EXT2-BL";
        if (current.includes("FL")) return "EXT2-FL";
        return "EXT2";
      };

      const computeExtensionSalaryPlan = (req, current, payloadPlayer) => {
        const plan = {
          ok: false,
          confidence: "none",
          source: "",
          reason: "",
          warnings: [],
          diagnostics: {},
          salary_by_year: {},
          salary_to_send: null,
          contract_year: null,
          contract_length: null,
          contract_info: "",
          contract_status: "",
        };

        const contractYearText = safeStr(
          current?.contractYear || payloadPlayer?.contractYear || payloadPlayer?.contractyear || req?.contract_year || req?.contractYear
        );
        const contractYear = safeInt(contractYearText, NaN);
        if (!Number.isFinite(contractYear) || contractYear <= 0) {
          plan.reason = "invalid_contract_year";
          plan.diagnostics.contract_year_raw = contractYearText;
          return plan;
        }
        plan.contract_year = contractYear;

        const contractInfoText = safeStr(req?.preview_contract_info_string || current?.contractInfo);
        if (!contractInfoText) {
          plan.reason = "missing_contract_info";
          return plan;
        }
        plan.contract_info = contractInfoText;
        plan.contract_status = normalizeExtensionContractStatusForImport(req, current?.contractStatus);

        const contractLengthFromPreview = contractLengthFromInfo(contractInfoText);

        const structuredCandidates = [
          req?.salary_by_year,
          req?.salaryByYear,
          req?.new_salary_by_year,
          req?.newSalaryByYear,
          req?.yearly_salaries,
          req?.yearlySalaries,
          req?.year_salaries,
          req?.yearSalaries,
        ];
        let structuredMap = {};
        for (const candidate of structuredCandidates) {
          const parsed = parseSalaryByYearMapInput(candidate);
          if (Object.keys(parsed).length) {
            structuredMap = parsed;
            break;
          }
        }

        const contractInfoMap = parseContractInfoYearSalaries(contractInfoText);
        const fallbackMap = levelLoadSalaryByYear(
          contractLengthFromPreview || maxYearInSalaryByYear(contractInfoMap),
          req?.new_aav_future ?? req?.newAavFuture ?? null,
          req?.new_TCV ?? req?.newTcv ?? null
        );

        let salaryByYear = {};
        let source = "";
        let confidence = "none";
        if (Object.keys(structuredMap).length) {
          salaryByYear = { ...structuredMap };
          source = "extension_request_structured_map";
          confidence = "high";
        } else if (Object.keys(contractInfoMap).length) {
          salaryByYear = { ...contractInfoMap };
          source = "contract_info_y_fields";
          confidence = "high";
        } else if (Object.keys(fallbackMap).length) {
          salaryByYear = { ...fallbackMap };
          source = "fallback_level_load";
          confidence = "low";
        }
        if (!Object.keys(salaryByYear).length) {
          plan.reason = "missing_salary_by_year";
          return plan;
        }

        if (Object.keys(contractInfoMap).length) {
          for (const [yearText, contractInfoSalary] of Object.entries(contractInfoMap)) {
            const existing = salaryByYear[yearText];
            if (existing == null) {
              salaryByYear[yearText] = contractInfoSalary;
              continue;
            }
            if (safeInt(existing, -1) !== safeInt(contractInfoSalary, -2)) {
              plan.warnings.push(`salary_by_year_conflict_for_y${yearText}`);
              salaryByYear[yearText] = contractInfoSalary;
              source = source === "contract_info_y_fields" ? source : `${source}+contract_info_override`;
            }
          }
        }

        const contractLength =
          contractLengthFromPreview != null ? contractLengthFromPreview : maxYearInSalaryByYear(salaryByYear);
        plan.contract_length = contractLength;

        if (contractLength != null && contractYear > contractLength) {
          plan.reason = "contract_year_exceeds_contract_length";
          plan.source = source;
          plan.confidence = confidence;
          plan.salary_by_year = salaryByYear;
          return plan;
        }

        const salaryToSend = safeInt(salaryByYear[String(contractYear)], NaN);
        if (!Number.isFinite(salaryToSend) || salaryToSend < 0) {
          plan.reason = "missing_salary_for_contract_year";
          plan.source = source;
          plan.confidence = confidence;
          plan.salary_by_year = salaryByYear;
          return plan;
        }

        if (Object.keys(contractInfoMap).length) {
          const fromInfo = safeInt(contractInfoMap[String(contractYear)], NaN);
          if (Number.isFinite(fromInfo) && fromInfo >= 0 && fromInfo !== salaryToSend) {
            plan.warnings.push("salary_overridden_to_contract_info_year_value");
            salaryByYear[String(contractYear)] = fromInfo;
          }
        }

        const finalSalary = safeInt(salaryByYear[String(contractYear)], NaN);
        if (!Number.isFinite(finalSalary) || finalSalary < 0) {
          plan.reason = "invalid_final_salary_for_contract_year";
          plan.source = source;
          plan.confidence = confidence;
          plan.salary_by_year = salaryByYear;
          return plan;
        }

        plan.ok = true;
        plan.source = source;
        plan.confidence = confidence;
        plan.salary_by_year = salaryByYear;
        plan.salary_to_send = finalSalary;
        plan.diagnostics = {
          current_salary_export: safeStr(current?.salary),
          contract_year_raw: contractYearText,
          contract_status_requested: safeStr(req?.new_contract_status),
          contract_status_selected: safeStr(plan.contract_status),
          contract_status_current: safeStr(current?.contractStatus),
          option_key: safeStr(req?.option_key || req?.optionKey),
          extension_term: safeStr(req?.extension_term || req?.extensionTerm || req?.term),
          salary_by_year_pairs: salaryByYearToSortedPairs(salaryByYear),
          fallback_used: source === "fallback_level_load",
        };
        return plan;
      };

      const buildExtensionSalariesXmlFromRows = (rows, options = {}) => {
        const appliedRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
        if (!appliedRows.length) return "";
        const omitContractStatus = !!options.omit_contract_status;
        const playersXml = appliedRows
          .map((row) => {
            const attrs = [
              `id="${xmlAttrEscape(row.player_id)}"`,
              `salary="${xmlAttrEscape(formatDollarsAsMflImportK(row.salary, 3))}"`,
              `contractYear="${xmlAttrEscape(row.contractYear)}"`,
              `contractInfo="${xmlAttrEscape(row.contractInfo)}"`,
            ];
            if (!omitContractStatus && row.contractStatus) {
              attrs.push(`contractStatus="${xmlAttrEscape(row.contractStatus)}"`);
            }
            return `<player ${attrs.join(" ")} />`;
          })
          .join("");
        return `<salaries><leagueUnit unit="LEAGUE">${playersXml}</leagueUnit></salaries>`;
      };

      const buildExtensionSalariesXmlFromPayload = (payload, salariesByPlayer) => {
        const extReqs = Array.isArray(payload?.extension_requests) ? payload.extension_requests : [];
        const applied = [];
        const skipped = [];
        const strictConfidenceMode = safeStr(env?.STRICT_EXTENSION_SALARY_ALIGNMENT || "1") !== "0";
        for (const req of extReqs) {
          const playerId = String(req?.player_id || "").replace(/\D/g, "");
          if (!playerId) {
            skipped.push({ reason: "missing_player_id", req });
            continue;
          }
          const current = salariesByPlayer[playerId] || {};
          const payloadPlayer = findPlayerRowInPayload(payload, playerId) || {};
          const plan = computeExtensionSalaryPlan(req, current, payloadPlayer);
          if (!plan.ok) {
            skipped.push({
              player_id: playerId,
              player_name: safeStr(req?.player_name),
              reason: plan.reason || "unresolved_salary_alignment",
              diagnostics: plan.diagnostics,
              salary_by_year: plan.salary_by_year,
              source: plan.source,
              confidence: plan.confidence,
              warnings: plan.warnings,
            });
            continue;
          }
          if (strictConfidenceMode && plan.confidence !== "high") {
            skipped.push({
              player_id: playerId,
              player_name: safeStr(req?.player_name),
              reason: "low_confidence_salary_by_year",
              diagnostics: plan.diagnostics,
              salary_by_year: plan.salary_by_year,
              source: plan.source,
              confidence: plan.confidence,
              warnings: plan.warnings,
            });
            continue;
          }

          applied.push({
            player_id: playerId,
            player_name: safeStr(req?.player_name),
            salary: String(plan.salary_to_send),
            contractYear: String(plan.contract_year),
            contractInfo: plan.contract_info,
            contractStatus: plan.contract_status,
            extension_term: safeStr(req?.extension_term || req?.extensionTerm || req?.term),
            option_key: safeStr(req?.option_key || req?.optionKey),
            requested_new_contract_length: safeInt(
              req?.new_contract_length ?? req?.newContractLength ?? null,
              0
            ),
            requested_new_tcv: safeInt(
              req?.new_tcv ?? req?.new_TCV ?? req?.newTcv ?? null,
              0
            ),
            requested_new_aav_future: safeInt(
              req?.new_aav_future ?? req?.newAavFuture ?? null,
              0
            ),
            salary_by_year: plan.salary_by_year,
            salary_by_year_source: plan.source,
            confidence: plan.confidence,
            warnings: plan.warnings,
            diagnostics: plan.diagnostics,
          });
        }

        if (!applied.length) {
          return { xml: "", xml_without_status: "", applied, skipped };
        }

        return {
          xml: buildExtensionSalariesXmlFromRows(applied, { omit_contract_status: false }),
          xml_without_status: buildExtensionSalariesXmlFromRows(applied, { omit_contract_status: true }),
          applied,
          skipped,
        };
      };

      const findPlayerRowInPayload = (payload, playerId) => {
        const pid = String(playerId || "").replace(/\D/g, "");
        if (!pid) return null;
        const teams = Array.isArray(payload?.teams) ? payload.teams : [];
        for (const t of teams) {
          const selected = Array.isArray(t?.selected_assets) ? t.selected_assets : [];
          for (const a of selected) {
            const apid = String(a?.player_id || "").replace(/\D/g, "");
            if (apid && apid === pid) return a;
          }
        }
        return null;
      };

      const extensionRowAuditShape = (row) => {
        const salaryByYearPairs = Array.isArray(row?.diagnostics?.salary_by_year_pairs)
          ? row.diagnostics.salary_by_year_pairs
          : salaryByYearToSortedPairs(row?.salary_by_year || {});
        const derivedTotals = computeSalaryByYearTotals(salaryByYearPairs);
        const requestedLength = safeInt(
          row?.requested_new_contract_length ?? row?.new_contract_length ?? null,
          0
        );
        const requestedTcv = safeInt(
          row?.requested_new_tcv ?? row?.new_tcv ?? row?.new_TCV ?? null,
          0
        );
        const requestedAav = safeInt(
          row?.requested_new_aav_future ?? row?.new_aav_future ?? null,
          0
        );
        return {
          player_id: safeStr(row?.player_id),
          player_name: safeStr(row?.player_name),
          salary_to_send_dollars: safeInt(row?.salary, 0),
          salary_to_send_mfl: formatDollarsAsMflImportK(row?.salary, 3),
          contract_year: safeInt(row?.contractYear, 0),
          contract_status: safeStr(row?.contractStatus),
          contract_info: safeStr(row?.contractInfo),
          extension_term: safeStr(row?.extension_term),
          option_key: safeStr(row?.option_key),
          requested_preview: {
            contract_length: requestedLength > 0 ? requestedLength : null,
            tcv: requestedTcv > 0 ? requestedTcv : null,
            aav_future: requestedAav > 0 ? requestedAav : null,
          },
          derived_from_salary_by_year: {
            contract_length: derivedTotals.contract_length || null,
            tcv: derivedTotals.tcv || null,
            aav: derivedTotals.aav || null,
          },
          preview_match: {
            contract_length:
              requestedLength > 0 ? requestedLength === derivedTotals.contract_length : null,
            tcv: requestedTcv > 0 ? requestedTcv === derivedTotals.tcv : null,
            aav_future: requestedAav > 0 ? requestedAav === derivedTotals.aav : null,
          },
          salary_by_year_pairs: salaryByYearPairs,
        };
      };

      const applySalaryAdjFromPayload = async (leagueId, season, payload, tradeId) => {
        const rows = buildSalaryAdjRowsFromPayload(payload, tradeId, season);
        if (!rows.length) {
          return {
            ok: true,
            skipped: true,
            reason: "no_traded_salary_adjustments",
            rows: [],
          };
        }
        const dataXml = buildSalaryAdjXml(rows);
        try {
          console.log(
            "[TWB][salaryAdj][prepare]",
            JSON.stringify({
              timestamp_utc: new Date().toISOString(),
              league_id: safeStr(leagueId),
              season: safeStr(season),
              trade_id: safeStr(tradeId),
              rows,
              payload_xml: dataXml,
            })
          );
        } catch (_) {
          // noop
        }
        let importRes = await postMflImportForm(
          season,
          {
            TYPE: "salaryAdj",
            L: leagueId,
            DATA: dataXml,
          },
          { TYPE: "salaryAdj", L: leagueId }
        );
        try {
          console.log(
            "[TWB][salaryAdj][post]",
            JSON.stringify({
              timestamp_utc: new Date().toISOString(),
              league_id: safeStr(leagueId),
              season: safeStr(season),
              trade_id: safeStr(tradeId),
              post_url: importRes.targetImportUrl,
              post_status: safeInt(importRes.status, 0),
              post_response_excerpt: safeStr(importRes.upstreamPreview).slice(0, 600),
              ok: !!importRes.requestOk,
              rows,
            })
          );
        } catch (_) {
          // noop
        }
        let verification = {
          ok: !!importRes.requestOk,
          reason: importRes.requestOk ? "verification_not_run" : "import_failed",
          expected_count: rows.length,
          matched_count: 0,
          mismatched_count: rows.length,
          rows: rows.map((r) => ({ ...r, matched: false })),
        };
        let verifySalaryAdjRes = null;
        const runVerify = async () => {
          const verifyDelays = [0, 1300, 2600];
          const sleepMs = (ms) =>
            new Promise((resolve) => {
              setTimeout(resolve, Math.max(0, safeInt(ms, 0)));
            });
          let finalVerification = verification;
          let finalVerifyRes = verifySalaryAdjRes;
          for (let i = 0; i < verifyDelays.length; i += 1) {
            if (verifyDelays[i] > 0) {
              await sleepMs(verifyDelays[i]);
            }
            finalVerifyRes = await mflExportJson(season, leagueId, "salaryAdjustments", {}, { useCookie: true });
            if (!finalVerifyRes.ok) {
              finalVerification = {
                ok: false,
                reason: "failed_post_import_salary_adjustments_export",
                expected_count: rows.length,
                matched_count: 0,
                mismatched_count: rows.length,
                rows: rows.map((r) => ({ ...r, matched: false })),
                attempt: i + 1,
                upstream: {
                  status: finalVerifyRes.status,
                  error: finalVerifyRes.error,
                  url: finalVerifyRes.url,
                  preview: finalVerifyRes.textPreview,
                },
              };
              continue;
            }
            finalVerification = verifyExpectedSalaryAdjustmentsInExport(rows, finalVerifyRes.data);
            finalVerification.reason = finalVerification.ok ? "" : "expected_salary_adjustments_missing_from_export";
            finalVerification.attempt = i + 1;
            if (finalVerification.ok) break;
          }
          if (!finalVerification.ok) {
            const expectedFranchises = Array.from(
              new Set(rows.map((r) => padFranchiseId(r.franchise_id)).filter(Boolean))
            );
            const fallbackActualRows = [];
            for (const fid of expectedFranchises) {
              const variants = [{ FRANCHISE_ID: fid }, { FRANCHISE: fid }];
              for (const params of variants) {
                const byFrRes = await mflExportJson(
                  season,
                  leagueId,
                  "salaryAdjustments",
                  params,
                  { useCookie: true }
                );
                if (!byFrRes.ok) continue;
                const rowsFromPayload = collectSalaryAdjustmentExportRows(
                  byFrRes.data?.salaryAdjustments || byFrRes.data?.salaryadjustments || byFrRes.data || {}
                );
                fallbackActualRows.push(...rowsFromPayload);
              }
            }
            if (fallbackActualRows.length) {
              const fallbackVerification = verifyExpectedSalaryAdjustmentsInRows(rows, fallbackActualRows);
              fallbackVerification.reason = fallbackVerification.ok
                ? ""
                : "expected_salary_adjustments_missing_from_export";
              fallbackVerification.fallback_scope = "franchise_scoped_export";
              if (fallbackVerification.ok) {
                finalVerification = fallbackVerification;
              }
            }
          }
          return { finalVerification, finalVerifyRes };
        };
        if (importRes.requestOk) {
          const verifyOut = await runVerify();
          verification = verifyOut.finalVerification;
          verifySalaryAdjRes = verifyOut.finalVerifyRes;
          if (!verification.ok) {
            const retryGetRes = await postMflImportForm(
              season,
              {
                TYPE: "salaryAdj",
                L: leagueId,
                DATA: dataXml,
              },
              { TYPE: "salaryAdj", L: leagueId },
              { method: "GET" }
            );
            try {
              console.log(
                "[TWB][salaryAdj][retry_get]",
                JSON.stringify({
                  timestamp_utc: new Date().toISOString(),
                  league_id: safeStr(leagueId),
                  season: safeStr(season),
                  trade_id: safeStr(tradeId),
                  post_url: retryGetRes.targetImportUrl,
                  post_status: safeInt(retryGetRes.status, 0),
                  post_response_excerpt: safeStr(retryGetRes.upstreamPreview).slice(0, 600),
                  ok: !!retryGetRes.requestOk,
                })
              );
            } catch (_) {
              // noop
            }
            if (retryGetRes.requestOk) {
              importRes = retryGetRes;
              const verifyOutAfterRetry = await runVerify();
              verification = verifyOutAfterRetry.finalVerification;
              verifySalaryAdjRes = verifyOutAfterRetry.finalVerifyRes;
            }
          }
          try {
            console.log(
              "[TWB][salaryAdj][verify]",
              JSON.stringify({
                timestamp_utc: new Date().toISOString(),
                league_id: safeStr(leagueId),
                season: safeStr(season),
                trade_id: safeStr(tradeId),
                verification,
              })
            );
          } catch (_) {
            // noop
          }
        }
        const strictVerify = safeStr(env?.TWB_SALADJ_VERIFY_STRICT || "1") !== "0";
        const requestOk = !!importRes.requestOk;
        const finalOk = requestOk && (verification.ok || !strictVerify);
        return {
          ok: finalOk,
          request_ok: requestOk,
          verification_ok: !!verification.ok,
          verification_soft_failed: requestOk && !verification.ok,
          strict_verify: strictVerify,
          skipped: false,
          rows,
          upstreamStatus: importRes.status,
          upstreamPreview: importRes.upstreamPreview,
          targetImportUrl: importRes.targetImportUrl,
          formFields: importRes.formFields,
          dataXml,
          error: requestOk
            ? (verification.ok ? "" : strictVerify ? "salaryAdj import verification failed" : "")
            : importRes.error || "salaryAdj import failed",
          reason: requestOk
            ? (verification.ok ? "" : strictVerify ? "salary_adj_verification_failed" : "verification_pending")
            : "salary_adj_import_failed",
          verification,
          post_import_salary_adjustments_export: verifySalaryAdjRes
            ? {
                ok: !!verifySalaryAdjRes.ok,
                status: verifySalaryAdjRes.status,
                url: verifySalaryAdjRes.url,
                error: verifySalaryAdjRes.error,
                preview: verifySalaryAdjRes.textPreview,
              }
            : null,
        };
      };

      const applyExtensionsFromPayload = async (leagueId, season, payload, options = {}) => {
        const extReqs = Array.isArray(payload?.extension_requests) ? payload.extension_requests : [];
        const expectedExtensionCount = Math.max(0, safeInt(options?.expected_extension_count, 0));
        const extensionTriggerFound = !!options?.extension_trigger_found;
        const preparationSkipped = Array.isArray(options?.preparation_skipped_rows)
          ? options.preparation_skipped_rows
          : [];
        const tradeId = safeStr(options?.trade_id);
        if (!extReqs.length) {
          let reason = "no_extension_requests";
          let isFailure = false;
          if (extensionTriggerFound) {
            reason = "extension_trigger_found_but_unresolved";
            isFailure = true;
          } else if (expectedExtensionCount > 0) {
            reason = "expected_extensions_missing_from_payload";
            isFailure = true;
          }
          try {
            console.log(
              "[TWB][extensions][skip]",
              JSON.stringify({
                trade_id: tradeId,
                timestamp_utc: new Date().toISOString(),
                league_id: safeStr(leagueId),
                season: safeStr(season),
                expected_extension_count: expectedExtensionCount,
                extension_trigger_found: extensionTriggerFound,
                reason,
                skipped_rows: preparationSkipped,
              })
            );
          } catch (_) {
            // noop
          }
          return {
            ok: !isFailure,
            skipped: true,
            reason,
            applied: [],
            skipped_rows: preparationSkipped,
            expected_extension_count: expectedExtensionCount,
            extension_trigger_found: extensionTriggerFound,
          };
        }
        const salariesRes = await mflExportJson(season, leagueId, "salaries");
        if (!salariesRes.ok) {
          return {
            ok: false,
            skipped: false,
            reason: "failed_to_load_salaries_export",
            upstream: {
              status: salariesRes.status,
              url: salariesRes.url,
              error: salariesRes.error,
              preview: salariesRes.textPreview,
            },
          };
        }
        const salariesByPlayer = parseSalariesExportByPlayer(salariesRes.data);
        const plan = buildExtensionSalariesXmlFromPayload(payload, salariesByPlayer);
        const trackedPlayerIds = new Set(
          (plan.applied || [])
            .map((row) => String(row?.player_id || "").replace(/\D/g, ""))
            .filter(Boolean)
        );
        try {
          console.log(
            "[TWB][extensions][prepare]",
              JSON.stringify({
              trade_id: tradeId,
              timestamp_utc: new Date().toISOString(),
              league_id: safeStr(leagueId),
              season: safeStr(season),
              expected_extension_count: expectedExtensionCount,
              resolved_extension_count: (plan.applied || []).length,
              skipped_count: (plan.skipped || []).length + preparationSkipped.length,
              applied_rows: plan.applied,
              skipped_rows: (plan.skipped || []).concat(preparationSkipped),
              payload_xml: plan.xml,
            })
          );
        } catch (_) {
          // noop
        }
        const beforeSnapshot = {};
        for (const playerId of trackedPlayerIds.values()) {
          beforeSnapshot[playerId] = normalizeSalarySnapshotRow(salariesByPlayer[playerId]);
        }
        if (!plan.xml) {
          let reason = "no_valid_extension_rows";
          let isFailure = false;
          if (extensionTriggerFound) {
            reason = "extension_trigger_found_but_no_valid_rows";
            isFailure = true;
          } else if (expectedExtensionCount > 0) {
            reason = "expected_extensions_resolved_to_no_valid_rows";
            isFailure = true;
          }
          return {
            ok: !isFailure,
            skipped: true,
            reason,
            applied: plan.applied,
            skipped_rows: plan.skipped.concat(preparationSkipped),
            before_snapshot: beforeSnapshot,
            verification: {
              ok: !isFailure,
              checked_players: 0,
              matched_players: 0,
              mismatched_players: 0,
              rows: [],
              reason,
            },
            expected_extension_count: expectedExtensionCount,
            extension_trigger_found: extensionTriggerFound,
          };
        }
        let dataXmlUsed = plan.xml;
        let importRes = await postMflImportForm(
          season,
          {
            TYPE: "salaries",
            L: leagueId,
            APPEND: "1",
            DATA: plan.xml,
          },
          { TYPE: "salaries", L: leagueId, APPEND: "1" }
        );
        try {
          console.log(
            "[TWB][extensions][post]",
              JSON.stringify({
              trade_id: tradeId,
              timestamp_utc: new Date().toISOString(),
              league_id: safeStr(leagueId),
              season: safeStr(season),
              post_url: importRes.targetImportUrl,
              post_status: safeInt(importRes.status, 0),
              post_response_excerpt: safeStr(importRes.upstreamPreview).slice(0, 600),
              ok: !!importRes.requestOk,
            })
          );
        } catch (_) {
          // noop
        }
        const verifyExtensionRows = async () => {
          let postSalariesResLocal = null;
          let afterSnapshotLocal = {};
          let verificationLocal = {
            ok: !!importRes.requestOk,
            checked_players: 0,
            matched_players: 0,
            mismatched_players: 0,
            rows: [],
            reason: "verification_not_run",
          };
          if (importRes.requestOk) {
            const sleepMs = (ms) =>
              new Promise((resolve) => {
                setTimeout(resolve, Math.max(0, safeInt(ms, 0)));
              });
            const verifyDelays = [0, 1300, 2600];
            let verifyAttempt = 0;
            for (verifyAttempt = 0; verifyAttempt < verifyDelays.length; verifyAttempt += 1) {
              if (verifyDelays[verifyAttempt] > 0) {
                await sleepMs(verifyDelays[verifyAttempt]);
              }
              postSalariesResLocal = await mflExportJson(season, leagueId, "salaries");
              if (!postSalariesResLocal.ok) {
                verificationLocal = {
                  ok: false,
                  checked_players: 0,
                  matched_players: 0,
                  mismatched_players: 0,
                  rows: [],
                  reason: "failed_post_import_salaries_export",
                  attempt: verifyAttempt + 1,
                  upstream: {
                    status: postSalariesResLocal.status,
                    error: postSalariesResLocal.error,
                    url: postSalariesResLocal.url,
                    preview: postSalariesResLocal.textPreview,
                  },
                };
                continue;
              }
              const afterByPlayer = parseSalariesExportByPlayer(postSalariesResLocal.data);
              afterSnapshotLocal = {};
              for (const playerId of trackedPlayerIds.values()) {
                afterSnapshotLocal[playerId] = normalizeSalarySnapshotRow(afterByPlayer[playerId]);
              }
              verificationLocal = buildExtensionPostImportVerification(
                beforeSnapshot,
                plan.applied,
                afterByPlayer
              );
              verificationLocal.attempt = verifyAttempt + 1;
              if (verificationLocal.ok) break;
            }
          }
          return {
            postSalariesRes: postSalariesResLocal,
            afterSnapshot: afterSnapshotLocal,
            verification: verificationLocal,
          };
        };
        let postSalariesRes = null;
        let afterSnapshot = {};
        let verification = {
          ok: !!importRes.requestOk,
          checked_players: 0,
          matched_players: 0,
          mismatched_players: 0,
          rows: [],
          reason: "verification_not_run",
        };
        if (importRes.requestOk) {
          const primaryVerify = await verifyExtensionRows();
          postSalariesRes = primaryVerify.postSalariesRes;
          afterSnapshot = primaryVerify.afterSnapshot;
          verification = primaryVerify.verification;
        }
        let statuslessRetryUsed = false;
        const allowStatuslessRetry = safeStr(env?.TWB_EXT_RETRY_WITHOUT_STATUS || "0") === "1";
        if (importRes.requestOk && !verification.ok) {
          const retryGetRes = await postMflImportForm(
            season,
            {
              TYPE: "salaries",
              L: leagueId,
              APPEND: "1",
              DATA: dataXmlUsed,
            },
            { TYPE: "salaries", L: leagueId, APPEND: "1" },
            { method: "GET" }
          );
          try {
            console.log(
              "[TWB][extensions][retry_get]",
              JSON.stringify({
                trade_id: tradeId,
                timestamp_utc: new Date().toISOString(),
                league_id: safeStr(leagueId),
                season: safeStr(season),
                post_url: retryGetRes.targetImportUrl,
                post_status: safeInt(retryGetRes.status, 0),
                post_response_excerpt: safeStr(retryGetRes.upstreamPreview).slice(0, 600),
                ok: !!retryGetRes.requestOk,
              })
            );
          } catch (_) {
            // noop
          }
          if (retryGetRes.requestOk) {
            importRes = retryGetRes;
            const retryGetVerify = await verifyExtensionRows();
            postSalariesRes = retryGetVerify.postSalariesRes;
            afterSnapshot = retryGetVerify.afterSnapshot;
            verification = retryGetVerify.verification;
          }
        }
        if (
          allowStatuslessRetry &&
          importRes.requestOk &&
          !verification.ok &&
          plan.xml_without_status &&
          plan.xml_without_status !== plan.xml
        ) {
          const retryRes = await postMflImportForm(
            season,
            {
              TYPE: "salaries",
              L: leagueId,
              APPEND: "1",
              DATA: plan.xml_without_status,
            },
            { TYPE: "salaries", L: leagueId, APPEND: "1" }
          );
          try {
            console.log(
              "[TWB][extensions][retry_without_status]",
              JSON.stringify({
                trade_id: tradeId,
                timestamp_utc: new Date().toISOString(),
                league_id: safeStr(leagueId),
                season: safeStr(season),
                post_url: retryRes.targetImportUrl,
                post_status: safeInt(retryRes.status, 0),
                post_response_excerpt: safeStr(retryRes.upstreamPreview).slice(0, 600),
                ok: !!retryRes.requestOk,
              })
            );
          } catch (_) {
            // noop
          }
          if (retryRes.requestOk) {
            statuslessRetryUsed = true;
            dataXmlUsed = plan.xml_without_status;
            importRes = retryRes;
            const retryVerify = await verifyExtensionRows();
            postSalariesRes = retryVerify.postSalariesRes;
            afterSnapshot = retryVerify.afterSnapshot;
            verification = retryVerify.verification;
          }
        }
        try {
          console.log(
            "[TWB][extensions][verify]",
            JSON.stringify({
              trade_id: tradeId,
              timestamp_utc: new Date().toISOString(),
              league_id: safeStr(leagueId),
              season: safeStr(season),
              statusless_retry_used: statuslessRetryUsed,
              verification,
            })
          );
        } catch (_) {
          // noop
        }
        const strictVerifyMode = safeStr(env?.TWB_EXT_VERIFY_STRICT || "1") !== "0";
        const requestOk = !!importRes.requestOk;
        const verificationOk = !!verification.ok;
        const verificationSoftFailed = requestOk && !verificationOk;
        const finalOk = requestOk && (verificationOk || !strictVerifyMode);
        return {
          ok: finalOk,
          request_ok: requestOk,
          verification_ok: verificationOk,
          verification_soft_failed: verificationSoftFailed,
          strict_verify: strictVerifyMode,
          skipped: false,
          applied: plan.applied,
          skipped_rows: plan.skipped.concat(preparationSkipped),
          dataXml: dataXmlUsed,
          upstreamStatus: importRes.status,
          upstreamPreview: importRes.upstreamPreview,
          targetImportUrl: importRes.targetImportUrl,
          formFields: importRes.formFields,
          error: requestOk
            ? (verificationOk ? "" : strictVerifyMode ? "salaries import verification failed" : "")
            : importRes.error || "salaries import failed",
          reason: requestOk
            ? (verificationOk ? "" : strictVerifyMode ? "salaries_import_verification_failed" : "verification_pending")
            : "salaries_import_failed",
          before_snapshot: beforeSnapshot,
          after_snapshot: afterSnapshot,
          verification,
          post_import_salaries_export: postSalariesRes
            ? {
                ok: !!postSalariesRes.ok,
                status: postSalariesRes.status,
                url: postSalariesRes.url,
                error: postSalariesRes.error,
                preview: postSalariesRes.textPreview,
              }
            : null,
          expected_extension_count: expectedExtensionCount,
          extension_trigger_found: extensionTriggerFound,
        };
      };

      const buildSalaryAlignmentDiagnostics = (salariesPayload, filterPlayerIds = null) => {
        const salariesRoot = salariesPayload?.salaries || salariesPayload || {};
        const leagueUnit = salariesRoot?.leagueUnit || salariesRoot?.leagueunit || {};
        const players = asArray(leagueUnit?.player || leagueUnit?.players).filter(Boolean);
        const includeId = (id) => {
          if (!filterPlayerIds || !filterPlayerIds.size) return true;
          return filterPlayerIds.has(id);
        };
        const out = {
          analyzed_players: 0,
          missing_required_fields: [],
          unresolved_contract_year_salary: [],
          mismatches: [],
          matches: 0,
        };
        for (const p of players) {
          const playerId = String(p?.id || "").replace(/\D/g, "");
          if (!playerId || !includeId(playerId)) continue;
          out.analyzed_players += 1;
          const salaryText = safeStr(p?.salary);
          const contractYearText = safeStr(p?.contractYear || p?.contractyear);
          const contractInfoText = safeStr(p?.contractInfo || p?.contractinfo);
          if (!salaryText || !contractYearText || !contractInfoText) {
            out.missing_required_fields.push({
              player_id: playerId,
              salary: salaryText,
              contractYear: contractYearText,
              contractInfo: contractInfoText,
            });
            continue;
          }
          const contractYear = safeInt(contractYearText, NaN);
          const salaryNow = parseMoneyTokenToDollars(salaryText, { assumeKIfNoUnit: false });
          if (!Number.isFinite(contractYear) || contractYear <= 0 || !Number.isFinite(salaryNow) || salaryNow < 0) {
            out.missing_required_fields.push({
              player_id: playerId,
              salary: salaryText,
              contractYear: contractYearText,
              contractInfo: contractInfoText,
            });
            continue;
          }
          const yearMap = parseContractInfoYearSalaries(contractInfoText);
          const expected = yearMap[String(contractYear)];
          if (!Number.isFinite(expected)) {
            out.unresolved_contract_year_salary.push({
              player_id: playerId,
              contractYear: contractYear,
              salary: salaryNow,
              contractInfo: contractInfoText,
            });
            continue;
          }
          if (safeInt(expected, -1) !== safeInt(salaryNow, -2)) {
            out.mismatches.push({
              player_id: playerId,
              contractYear: contractYear,
              salary_actual: salaryNow,
              salary_expected: expected,
              delta: salaryNow - expected,
              contractInfo: contractInfoText,
              salary_by_year: salaryByYearToSortedPairs(yearMap),
            });
          } else {
            out.matches += 1;
          }
        }
        out.ok = out.mismatches.length === 0;
        return out;
      };

      const sanitizeBugAttachments = (rawAttachments) => {
        const rows = Array.isArray(rawAttachments) ? rawAttachments : [];
        const out = [];
        const maxItems = 6;
        const maxDataUrlChars = 450000;
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const dataUrl = safeStr(row.data_url || row.dataUrl);
          if (!dataUrl || !/^data:image\//i.test(dataUrl)) continue;
          if (dataUrl.length > maxDataUrlChars) continue;
          out.push({
            name: safeStr(row.name || "screenshot.jpg").slice(0, 120),
            type: safeStr(row.type || "image/jpeg").slice(0, 60),
            original_type: safeStr(row.original_type || row.originalType || "").slice(0, 60),
            size_bytes: Math.max(0, safeInt(row.size_bytes || row.sizeBytes || 0)),
            data_url: dataUrl,
          });
          if (out.length >= maxItems) break;
        }
        return out;
      };

      if (path === "/admin/bug-report/test-discord" && request.method === "POST") {
        let body = {};
        try {
          body = (await request.json()) || {};
        } catch (_) {
          return jsonOut(400, { ok: false, error: "Invalid JSON body" });
        }
        const context = body && typeof body.context === "object" && body.context ? body.context : {};
        const leagueId = safeStr(
          url.searchParams.get("L") ||
            L ||
            body.league_id ||
            body.leagueId ||
            context.league_id ||
            context.leagueId ||
            ""
        );
        const season = safeStr(
          url.searchParams.get("YEAR") ||
            YEAR ||
            body.season ||
            body.year ||
            context.season ||
            context.year ||
            ""
        );
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L/league_id" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR/season" });

        const moduleName = safeStr(body.module || body.screen || "other").toLowerCase();
        const issueType = safeStr(body.issue_type || body.type || "other").toLowerCase();
        const requestKind = safeStr(body.request_kind || body.requestKind || "bug-report").toLowerCase();
        const commishEnhancement = requestKind === "commish-enhancement" || !!safeInt(
          body.commish_enhancement || body.commishEnhancement || 0
        );
        const details = safeStr(body.details || body.description || "");
        const steps = safeStr(body.steps_to_reproduce || body.steps || "");
        const expectedActual = safeStr(
          body.expected_vs_actual || body.expected_actual || body.expected || ""
        );
        const attachments = sanitizeBugAttachments(body.attachments || body.screenshots);
        if (!details) return jsonOut(400, { ok: false, error: "Missing details" });

        const createdAt = new Date().toISOString();
        const franchiseId = padFranchiseId(
          body.franchise_id ||
            body.franchiseId ||
            context.franchise_id ||
            context.franchiseId ||
            url.searchParams.get("FRANCHISE_ID") ||
            ""
        );
        const franchiseName = safeStr(
          body.franchise_name ||
            body.franchiseName ||
            context.franchise_name ||
            context.franchiseName ||
            ""
        ).slice(0, 120);
        const mflUserId = safeStr(
          body.mfl_user_id ||
          body.mflUserId ||
          context.mfl_user_id ||
          context.mflUserId ||
          browserMflUserId ||
          ""
        );
        const submittedByLabel = safeStr(
          body.submitted_by_label ||
          body.submittedByLabel ||
          context.submitted_by_label ||
          [
            franchiseName || franchiseId || "",
            mflUserId ? `MFL ${mflUserId}` : "",
            commishEnhancement ? "Commish Enhancement" : "",
          ].filter(Boolean).join(" | ")
        ).slice(0, 200);
        const reportRow = {
          bug_id: `TEST-BUG-${safeStr(season)}-${Date.now().toString(36).toUpperCase()}`,
          created_at_utc: createdAt,
          league_id: leagueId,
          season: season,
          franchise_id: franchiseId,
          franchise_name: franchiseName,
          mfl_user_id: mflUserId,
          module: moduleName,
          issue_type: issueType,
          request_kind: commishEnhancement ? "commish-enhancement" : requestKind || "bug-report",
          commish_enhancement: commishEnhancement,
          submitted_by_label: submittedByLabel,
          submitted_by_mfl_user_id: mflUserId,
          details: details.slice(0, 5000),
          steps_to_reproduce: steps.slice(0, 4000),
          expected_vs_actual: expectedActual.slice(0, 4000),
          attachments,
          source: safeStr(body.source || "ups-hot-links-widget"),
          status: "OPEN",
          issue_sequence: Math.max(1, safeInt(body.issue_sequence || body.issueSequence || 1)),
          thread_id: "",
          thread_root_message_id: "",
          thread_name: "",
          delivery_target: "test",
          status_updated_at_utc: createdAt,
          status_updated_by: "system-test",
          triage_summary: "",
          triage_updated_at_utc: "",
          triage_updated_by: "",
          approval_state: "",
          approval_requested_at_utc: "",
          approval_received_at_utc: "",
          approval_decision_by: "",
          last_discord_sync_error: "",
          last_discord_sync_at_utc: "",
          context: context && typeof context === "object" ? context : {},
        };
        reportRow.thread_name = buildBugThreadName(reportRow, reportRow.status);
        const notify = await sendDiscordNotificationForBug(reportRow, "");
        return jsonOut(notify && notify.ok ? 201 : 502, {
          ok: !!(notify && notify.ok),
          test_only: true,
          delivery_target: "test",
          bug_id: reportRow.bug_id,
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          thread_name: safeStr((notify && notify.thread_name) || reportRow.thread_name),
          thread_id: safeStr(notify && notify.thread_id),
          thread_root_message_id: safeStr(notify && (notify.thread_root_message_id || notify.message_id)),
          notify,
        });
      }

      if (path === "/bug-report" && request.method === "POST") {
        let body = {};
        try {
          body = (await request.json()) || {};
        } catch (_) {
          return jsonOut(400, { ok: false, error: "Invalid JSON body" });
        }
        const context = body && typeof body.context === "object" && body.context ? body.context : {};
        const leagueId = safeStr(
          url.searchParams.get("L") ||
            L ||
            body.league_id ||
            body.leagueId ||
            context.league_id ||
            context.leagueId ||
            ""
        );
        const season = safeStr(
          url.searchParams.get("YEAR") ||
            YEAR ||
            body.season ||
            body.year ||
            context.season ||
            context.year ||
            ""
        );
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L/league_id" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR/season" });

        const moduleName = safeStr(body.module || body.screen || "other").toLowerCase();
        const issueType = safeStr(body.issue_type || body.type || "other").toLowerCase();
        const requestKind = safeStr(body.request_kind || body.requestKind || "bug-report").toLowerCase();
        const commishEnhancement = requestKind === "commish-enhancement" || !!safeInt(
          body.commish_enhancement || body.commishEnhancement || 0
        );
        const details = safeStr(body.details || body.description || "");
        const steps = safeStr(body.steps_to_reproduce || body.steps || "");
        const expectedActual = safeStr(
          body.expected_vs_actual || body.expected_actual || body.expected || ""
        );
        const attachments = sanitizeBugAttachments(body.attachments || body.screenshots);
        if (!details) return jsonOut(400, { ok: false, error: "Missing details" });

        const createdAt = new Date().toISOString();
        const bugId = `BUG-${safeStr(season)}-${Date.now().toString(36).toUpperCase()}`;
        const franchiseId = padFranchiseId(
          body.franchise_id ||
            body.franchiseId ||
            context.franchise_id ||
            context.franchiseId ||
            url.searchParams.get("FRANCHISE_ID") ||
            ""
        );
        const franchiseName = safeStr(
          body.franchise_name ||
            body.franchiseName ||
            context.franchise_name ||
            context.franchiseName ||
            ""
        ).slice(0, 120);
        const mflUserId = safeStr(
          body.mfl_user_id ||
          body.mflUserId ||
          context.mfl_user_id ||
          context.mflUserId ||
          browserMflUserId ||
          ""
        );
        const submittedByLabel = safeStr(
          body.submitted_by_label ||
          body.submittedByLabel ||
          context.submitted_by_label ||
          [
            franchiseName || franchiseId || "",
            mflUserId ? `MFL ${mflUserId}` : "",
            commishEnhancement ? "Commish Enhancement" : "",
          ].filter(Boolean).join(" | ")
        ).slice(0, 200);
        const reportRow = {
          bug_id: bugId,
          created_at_utc: createdAt,
          league_id: leagueId,
          season: season,
          franchise_id: franchiseId,
          franchise_name: franchiseName,
          mfl_user_id: mflUserId,
          module: moduleName,
          issue_type: issueType,
          request_kind: commishEnhancement ? "commish-enhancement" : requestKind || "bug-report",
          commish_enhancement: commishEnhancement,
          submitted_by_label: submittedByLabel,
          submitted_by_mfl_user_id: mflUserId,
          details: details.slice(0, 5000),
          steps_to_reproduce: steps.slice(0, 4000),
          expected_vs_actual: expectedActual.slice(0, 4000),
          attachments,
          source: safeStr(body.source || "ups-hot-links-widget"),
          status: "OPEN",
          thread_id: "",
          thread_root_message_id: "",
          thread_name: buildBugThreadName({
            season,
            module: moduleName,
            issue_type: issueType,
            issue_sequence: 1,
            status: "OPEN",
          }),
          status_updated_at_utc: createdAt,
          status_updated_by: "system",
          triage_summary: "",
          triage_updated_at_utc: "",
          triage_updated_by: "",
          approval_state: "",
          approval_requested_at_utc: "",
          approval_received_at_utc: "",
          approval_decision_by: "",
          last_discord_sync_error: "",
          last_discord_sync_at_utc: "",
          context: context && typeof context === "object" ? context : {},
        };

        const loaded = await readBugReportsDoc(leagueId, season);
        if (!loaded.ok) {
          return jsonOut(500, {
            ok: false,
            error: loaded.error || "bug_report_read_failed",
            storage: {
              file_path: loaded.filePath || "",
              upstream_status: loaded.upstreamStatus || 0,
              upstream_preview: loaded.upstreamPreview || "",
            },
          });
        }
        const doc = normalizeBugReportsDoc(loaded.doc, leagueId, season);
        const reports = Array.isArray(doc.reports) ? doc.reports : [];
        reports.unshift(reportRow);
        reportRow.issue_sequence = reports.filter((row) => {
          if (!row || typeof row !== "object") return false;
          return (
            safeStr(row.season || "") === season &&
            safeStr(row.module || "") === moduleName &&
            safeStr(row.issue_type || "") === issueType
          );
        }).length;
        reportRow.thread_name = buildBugThreadName(reportRow, reportRow.status);
        doc.reports = reports.slice(0, 3000);

        const save = await writeBugReportsDoc(
          leagueId,
          season,
          doc,
          loaded.sha,
          `feat(reports): append bug report ${bugId}`
        );
        if (!save.ok) {
          return jsonOut(500, {
            ok: false,
            error: save.error || "bug_report_write_failed",
            storage: {
              file_path: save.filePath || loaded.filePath || "",
              upstream_status: save.upstreamStatus || 0,
              upstream_preview: save.upstreamPreview || "",
            },
          });
        }

        const notify = await sendDiscordNotificationForBug(reportRow, save.filePath);
        let persistedThread = {
          thread_id: "",
          thread_root_message_id: "",
          thread_name: reportRow.thread_name,
        };
        let persistedContentSha = save.contentSha || "";
        if (
          safeStr(notify.thread_id) ||
          safeStr(notify.thread_root_message_id || notify.message_id) ||
          safeStr(notify.thread_name) ||
          safeStr(notify.error)
        ) {
          const savedDoc = normalizeBugReportsDoc(save.doc, leagueId, season);
          const savedReports = Array.isArray(savedDoc.reports) ? savedDoc.reports : [];
          const idx = savedReports.findIndex((row) => safeStr(row && row.bug_id) === bugId);
          if (idx >= 0) {
            savedReports[idx] = {
              ...savedReports[idx],
              thread_id: safeStr(notify.thread_id),
              thread_root_message_id: safeStr(notify.thread_root_message_id || notify.message_id),
              thread_name: safeStr(notify.thread_name || savedReports[idx].thread_name || reportRow.thread_name),
              last_discord_sync_error: safeStr(notify.ok ? "" : notify.error),
              last_discord_sync_at_utc: new Date().toISOString(),
            };
            persistedThread = {
              thread_id: safeStr(savedReports[idx].thread_id),
              thread_root_message_id: safeStr(savedReports[idx].thread_root_message_id),
              thread_name: safeStr(savedReports[idx].thread_name),
            };
            const syncSave = await writeBugReportsDoc(
              leagueId,
              season,
              savedDoc,
              save.contentSha,
              `feat(reports): sync bug thread metadata ${bugId}`
            );
            if (syncSave.ok) {
              persistedContentSha = syncSave.contentSha || persistedContentSha;
            }
          }
        }

        return jsonOut(201, {
          ok: true,
          bug_id: bugId,
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          stored: {
            file_path: save.filePath || "",
            commit_sha: save.commitSha || "",
            content_sha: persistedContentSha || "",
          },
          thread_id: persistedThread.thread_id || "",
          thread_name: persistedThread.thread_name || "",
          thread_root_message_id: persistedThread.thread_root_message_id || "",
          notify,
        });
      }

      if (path === "/bug-reports" && request.method === "GET") {
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || "");
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L param" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR param" });

        const includeContext = ["1", "true", "yes"].includes(
          safeStr(url.searchParams.get("include_context")).toLowerCase()
        );
        const limit = Math.max(1, Math.min(500, safeInt(url.searchParams.get("limit"), 100)));

        const loaded = await readBugReportsDoc(leagueId, season);
        if (!loaded.ok) {
          return jsonOut(500, {
            ok: false,
            error: loaded.error || "bug_report_read_failed",
            storage: {
              file_path: loaded.filePath || "",
              upstream_status: loaded.upstreamStatus || 0,
              upstream_preview: loaded.upstreamPreview || "",
            },
          });
        }
        const doc = normalizeBugReportsDoc(loaded.doc, leagueId, season);
        const reports = (Array.isArray(doc.reports) ? doc.reports : [])
          .slice()
          .sort((a, b) =>
            safeStr(b && b.created_at_utc).localeCompare(safeStr(a && a.created_at_utc))
          )
          .slice(0, limit)
          .map((row) => {
            const out = row && typeof row === "object" ? { ...row } : {};
            if (!includeContext) delete out.context;
            return out;
          });

        return jsonOut(200, {
          ok: true,
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          file_path: loaded.filePath || "",
          count: reports.length,
          reports,
        });
      }

      if (path === "/admin/bug-report/status" && request.method === "POST") {
        let body = {};
        try {
          body = (await request.json()) || {};
        } catch (_) {
          return jsonOut(400, { ok: false, error: "Invalid JSON body" });
        }
        if (!commishApiKey) {
          return jsonOut(500, { ok: false, error: "Missing COMMISH_API_KEY worker secret" });
        }
        if (!sessionByApiKey) {
          return jsonOut(403, { ok: false, error: "Valid COMMISH_API_KEY is required for bug status updates." });
        }
        const leagueId = safeStr(body.league_id || body.leagueId || url.searchParams.get("L") || L || "");
        const season = safeStr(body.season || body.year || body.YEAR || url.searchParams.get("YEAR") || YEAR || "");
        const bugId = safeStr(body.bug_id || body.bugId || body.report_id || "");
        const nextStatus = normalizeBugStatus(body.status || "OPEN");
        const updatedBy = safeStr(body.updated_by || body.updatedBy || "commish");
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing league_id or L" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing season or YEAR" });
        if (!bugId) return jsonOut(400, { ok: false, error: "Missing bug_id" });

        const loaded = await readBugReportsDoc(leagueId, season);
        if (!loaded.ok) {
          return jsonOut(500, {
            ok: false,
            error: loaded.error || "bug_report_read_failed",
            storage: {
              file_path: loaded.filePath || "",
              upstream_status: loaded.upstreamStatus || 0,
              upstream_preview: loaded.upstreamPreview || "",
            },
          });
        }
        const doc = normalizeBugReportsDoc(loaded.doc, leagueId, season);
        const reports = Array.isArray(doc.reports) ? doc.reports : [];
        const idx = reports.findIndex((row) => safeStr(row && row.bug_id) === bugId);
        if (idx < 0) return jsonOut(404, { ok: false, error: "bug_not_found" });

        const statusUpdatedAt = new Date().toISOString();
        reports[idx] = {
          ...reports[idx],
          status: nextStatus,
          status_updated_at_utc: statusUpdatedAt,
          status_updated_by: updatedBy || "commish",
          thread_name: buildBugThreadName(reports[idx], nextStatus),
        };
        if (nextStatus === "CLOSED_RESOLVED" && !safeStr(reports[idx].approval_state)) {
          reports[idx].approval_state = "RESOLVED";
        }

        const save = await writeBugReportsDoc(
          leagueId,
          season,
          doc,
          loaded.sha,
          `feat(reports): update bug status ${bugId} -> ${nextStatus}`
        );
        if (!save.ok) {
          return jsonOut(500, {
            ok: false,
            error: save.error || "bug_report_write_failed",
            storage: {
              file_path: save.filePath || loaded.filePath || "",
              upstream_status: save.upstreamStatus || 0,
              upstream_preview: save.upstreamPreview || "",
            },
          });
        }

        const discordSync = await syncBugThreadStatus(reports[idx], nextStatus);
        try {
          console.log(
            "[BUG][thread-status-sync]",
            JSON.stringify({
              bug_id: bugId,
              league_id: leagueId,
              season,
              status: nextStatus,
              discord_sync: discordSync,
            })
          );
        } catch (_) {
          // noop
        }

        return jsonOut(discordSync.ok || discordSync.skipped ? 200 : 207, {
          ok: true,
          bug_id: bugId,
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          status: nextStatus,
          stored: {
            file_path: save.filePath || "",
            commit_sha: save.commitSha || "",
            content_sha: save.contentSha || "",
          },
          thread_id: safeStr(reports[idx].thread_id),
          thread_name: safeStr(discordSync.thread_name || reports[idx].thread_name),
          thread_root_message_id: safeStr(reports[idx].thread_root_message_id),
          discord_sync: discordSync,
        });
      }

      if (path === "/admin/bug-report/triage-note" && request.method === "POST") {
        let body = {};
        try {
          body = (await request.json()) || {};
        } catch (_) {
          return jsonOut(400, { ok: false, error: "Invalid JSON body" });
        }
        if (!commishApiKey) {
          return jsonOut(500, { ok: false, error: "Missing COMMISH_API_KEY worker secret" });
        }
        if (!sessionByApiKey) {
          return jsonOut(403, { ok: false, error: "Valid COMMISH_API_KEY is required for bug triage updates." });
        }
        const leagueId = safeStr(body.league_id || body.leagueId || url.searchParams.get("L") || L || "");
        const season = safeStr(body.season || body.year || body.YEAR || url.searchParams.get("YEAR") || YEAR || "");
        const bugId = safeStr(body.bug_id || body.bugId || body.report_id || "");
        const triageSummary = safeStr(body.triage_summary || body.triageSummary || "");
        const updatedBy = safeStr(body.updated_by || body.updatedBy || "commish");
        const postToThread = ["1", "true", "yes"].includes(
          safeStr(body.post_to_thread || body.postToThread || "").toLowerCase()
        );
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing league_id or L" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing season or YEAR" });
        if (!bugId) return jsonOut(400, { ok: false, error: "Missing bug_id" });
        if (!triageSummary) return jsonOut(400, { ok: false, error: "Missing triage_summary" });

        const loaded = await readBugReportsDoc(leagueId, season);
        if (!loaded.ok) {
          return jsonOut(500, {
            ok: false,
            error: loaded.error || "bug_report_read_failed",
            storage: {
              file_path: loaded.filePath || "",
              upstream_status: loaded.upstreamStatus || 0,
              upstream_preview: loaded.upstreamPreview || "",
            },
          });
        }
        const doc = normalizeBugReportsDoc(loaded.doc, leagueId, season);
        const reports = Array.isArray(doc.reports) ? doc.reports : [];
        const idx = reports.findIndex((row) => safeStr(row && row.bug_id) === bugId);
        if (idx < 0) return jsonOut(404, { ok: false, error: "bug_not_found" });

        reports[idx] = {
          ...reports[idx],
          triage_summary: triageSummary,
          triage_updated_at_utc: new Date().toISOString(),
          triage_updated_by: updatedBy || "commish",
        };

        const save = await writeBugReportsDoc(
          leagueId,
          season,
          doc,
          loaded.sha,
          `feat(reports): update bug triage note ${bugId}`
        );
        if (!save.ok) {
          return jsonOut(500, {
            ok: false,
            error: save.error || "bug_report_write_failed",
            storage: {
              file_path: save.filePath || loaded.filePath || "",
              upstream_status: save.upstreamStatus || 0,
              upstream_preview: save.upstreamPreview || "",
            },
          });
        }

        let thread_post = { ok: false, skipped: true, status: 0, error: "post_to_thread_disabled" };
        if (postToThread) {
          const notePrefix = updatedBy ? `Triage note from ${updatedBy}:` : "Triage note:";
          thread_post = await postBugThreadNote(reports[idx], `${notePrefix}\n${triageSummary}`);
          try {
            console.log(
              "[BUG][thread-note]",
              JSON.stringify({
                bug_id: bugId,
                league_id: leagueId,
                season,
                thread_post,
              })
            );
          } catch (_) {
            // noop
          }
        }

        return jsonOut(thread_post.ok || thread_post.skipped ? 200 : 207, {
          ok: true,
          bug_id: bugId,
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          triage_summary: triageSummary,
          stored: {
            file_path: save.filePath || "",
            commit_sha: save.commitSha || "",
            content_sha: save.contentSha || "",
          },
          thread_post,
        });
      }

      if (path === "/salary-alignment-check" && request.method === "GET") {
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || "");
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L param" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR param" });
        const playerFilterRaw = safeStr(
          url.searchParams.get("PLAYER_IDS") ||
            url.searchParams.get("player_ids") ||
            url.searchParams.get("PLAYER_ID") ||
            url.searchParams.get("player_id") ||
            url.searchParams.get("P") ||
            ""
        );
        const playerFilter = new Set(
          playerFilterRaw
            .split(/[,\s]+/)
            .map((v) => String(v || "").replace(/\D/g, ""))
            .filter(Boolean)
        );
        const salariesRes = await mflExportJson(season, leagueId, "salaries");
        if (!salariesRes.ok) {
          return jsonOut(502, {
            ok: false,
            error: "Failed to load salaries export from MFL",
            upstream: {
              status: salariesRes.status,
              url: salariesRes.url,
              error: salariesRes.error,
              preview: salariesRes.textPreview,
            },
          });
        }
        const report = buildSalaryAlignmentDiagnostics(
          salariesRes.data,
          playerFilter.size ? playerFilter : null
        );
        return jsonOut(200, {
          ok: true,
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          player_filter: playerFilter.size ? Array.from(playerFilter.values()) : [],
          report,
          upstream: {
            status: salariesRes.status,
            url: salariesRes.url,
          },
          generated_at: new Date().toISOString(),
        });
      }

      if (
        (path === "/trade-offers" || path === "/api/trades/proposals") &&
        request.method === "GET"
      ) {
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        const season = safeStr(
          url.searchParams.get("YEAR") ||
            url.searchParams.get("season") ||
            YEAR ||
            ""
        );
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L param" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR/season param" });

        const franchiseId = padFranchiseId(
          url.searchParams.get("acting_franchise_id") ||
            url.searchParams.get("ACTING_FRANCHISE_ID") ||
          url.searchParams.get("FRANCHISE_ID") ||
            url.searchParams.get("franchise_id") ||
            url.searchParams.get("F") ||
            ""
        );
        const includePayload = ["1", "true", "yes"].includes(
          safeStr(url.searchParams.get("include_payload")).toLowerCase()
        );
        const statusFilter = offerStatusNormalized(url.searchParams.get("status"), "");
        const limit = Math.max(1, Math.min(300, safeInt(url.searchParams.get("limit"), 50)));

        const live = await loadLivePendingProposals({
          leagueId,
          season,
          franchiseId,
          includePayload,
          statusFilter,
          limit,
        });
        if (!live.ok) {
          return jsonOut(live.status || 502, {
            ok: false,
            error: live.error || "Failed to load pending trades from MFL",
            pending_lookup: live.pendingLookup || {
              ok: false,
              rows_count: 0,
              upstream_status: 0,
              error: live.error || "pendingTrades lookup failed",
            },
            upstream: live.upstream || null,
          });
        }

        return jsonOut(200, {
          ok: true,
          server: safeStr(url.host),
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          franchise_id: franchiseId || "",
          source: "worker:live_mfl_pending_trades",
          pending_lookup: live.pendingLookup,
          counts: live.counts,
          proposals: live.proposals,
          incoming: live.incoming,
          outgoing: live.outgoing,
          offers: live.related,
          generated_at: live.generatedAt || new Date().toISOString(),
        });
      }

      if (path.startsWith("/api/trades/proposals/") && request.method === "GET") {
        const proposalId = safeStr(path.split("/").pop());
        if (!proposalId || proposalId === "action") {
          return jsonOut(400, { ok: false, error: "proposal_id is required" });
        }
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        const season = safeStr(
          url.searchParams.get("YEAR") ||
            url.searchParams.get("season") ||
            YEAR ||
            ""
        );
        const franchiseId = padFranchiseId(
          url.searchParams.get("acting_franchise_id") ||
            url.searchParams.get("ACTING_FRANCHISE_ID") ||
          url.searchParams.get("FRANCHISE_ID") ||
            url.searchParams.get("franchise_id") ||
            url.searchParams.get("F") ||
            ""
        );
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L param" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR/season param" });

        const live = await loadLivePendingProposals({
          leagueId,
          season,
          franchiseId,
          includePayload: true,
          statusFilter: "PENDING",
          limit: 300,
        });
        if (!live.ok) {
          return jsonOut(live.status || 502, {
            ok: false,
            error: live.error || "Failed to load pending trades from MFL",
            pending_lookup: live.pendingLookup || {
              ok: false,
              rows_count: 0,
              upstream_status: 0,
              error: live.error || "pendingTrades lookup failed",
            },
            upstream: live.upstream || null,
          });
        }

        const keyRaw = proposalId;
        const keyDigits = keyRaw.replace(/\D/g, "");
        const proposal = (live.proposals || []).find((p) => {
          const id = safeStr(p && p.id);
          const pid = safeStr(p && p.proposal_id);
          const tid = safeStr(p && p.trade_id);
          return (
            id === keyRaw ||
            pid === keyRaw ||
            tid === keyRaw ||
            (keyDigits &&
              (pid.replace(/\D/g, "") === keyDigits ||
                tid.replace(/\D/g, "") === keyDigits ||
                id.replace(/\D/g, "") === keyDigits))
          );
        });

        if (!proposal) {
          return jsonOut(404, {
            ok: false,
            error: "Proposal not found or no longer pending in MFL",
            proposal_id: keyRaw,
          });
        }

        return jsonOut(200, {
          ok: true,
          server: safeStr(url.host),
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          franchise_id: franchiseId || "",
          proposal,
        });
      }

      if (path === "/trade-pending" && request.method === "GET") {
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || "");
        const franchiseId = padFranchiseId(
          url.searchParams.get("acting_franchise_id") ||
            url.searchParams.get("ACTING_FRANCHISE_ID") ||
          url.searchParams.get("FRANCHISE_ID") ||
            url.searchParams.get("F") ||
            url.searchParams.get("franchise_id") ||
            ""
        );
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L param" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR param" });
        if (!viewerCookieHeader) {
          return jsonOut(500, {
            ok: false,
            error: "Missing MFL owner session for pending trade lookup",
          });
        }

        const pendingRes = await loadPendingTradesExportAsViewer(
          season,
          leagueId,
          franchiseId
        );
        if (!pendingRes.ok) {
          return jsonOut(502, {
            ok: false,
            error: "Failed to load pendingTrades from MFL",
            upstream: {
              status: pendingRes.status,
              url: pendingRes.url,
              error: pendingRes.error,
              preview: pendingRes.textPreview,
            },
          });
        }
        return jsonOut(200, {
          ok: true,
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          franchise_id: franchiseId,
          source: "worker:/trade-pending",
          pending_trades: pendingRes.data || {},
          upstream: {
            status: pendingRes.status,
            url: pendingRes.url,
          },
          generated_at: new Date().toISOString(),
        });
      }

      if ((path === "/trade-offers" || path === "/api/trades/proposals") && request.method === "POST") {
        let body = null;
        try {
          body = await request.json();
        } catch (_) {
          return jsonOut(400, { ok: false, error: "Invalid JSON payload." });
        }

        const payload = body?.payload && typeof body.payload === "object" ? body.payload : null;
        const leagueId = safeStr(body?.league_id || payload?.league_id || L || "");
        const season = safeStr(body?.season || payload?.season || YEAR || "");
        const fromFranchiseId = padFranchiseId(body?.from_franchise_id || payload?.ui?.left_team_id || "");
        const toFranchiseId = padFranchiseId(body?.to_franchise_id || payload?.ui?.right_team_id || "");
        const offerId = safeStr(body?.offer_id || body?.proposal_id || body?.id || "");
        const fromFranchiseName = safeStr(body?.from_franchise_name);
        const toFranchiseName = safeStr(body?.to_franchise_name);
        const message = safeStr(body?.message || body?.comment || payload?.comment).slice(0, 2000);
        const validationStatus = safeStr(payload?.validation?.status).toLowerCase();
        // Queue mode is retired: always submit directly to MFL.
        const directMfl = true;

        if (!leagueId) return jsonOut(400, { ok: false, error: "league_id is required" });
        if (!season) return jsonOut(400, { ok: false, error: "season is required" });
        if (!fromFranchiseId) return jsonOut(400, { ok: false, error: "from_franchise_id is required" });
        if (!toFranchiseId) return jsonOut(400, { ok: false, error: "to_franchise_id is required" });
        if (fromFranchiseId === toFranchiseId) return jsonOut(400, { ok: false, error: "Teams must be different" });
        if (!payload) return jsonOut(400, { ok: false, error: "payload is required" });
        if (validationStatus && validationStatus !== "ready") {
          const diagnostics = buildValidationFailureDiagnostics({
            reason: "trade_payload_not_ready",
            leagueId,
            season,
            actingFranchiseId: fromFranchiseId,
            counterpartyFranchiseId: toFranchiseId,
            tradeProposalPayload: {
              request_body: body,
              payload,
              validation_status: validationStatus,
              validation_issues: payload?.validation?.issues || [],
            },
          });
          return jsonOut(400, {
            ok: false,
            error_type: "validation_pre_post",
            error: "Trade payload is not ready to submit",
            diagnostics,
          });
        }

        if (directMfl) {
          if (!viewerCookieHeader) {
            return jsonOut(500, { ok: false, error: "Missing MFL owner session for direct MFL submission" });
          }

          const proposalAssets = buildTradeProposalAssetLists(payload);
          const willGiveUp = proposalAssets.willGiveUp;
          const willReceive = proposalAssets.willReceive;
          if (!proposalAssets.isValid) {
            const diagnostics = buildValidationFailureDiagnostics({
              reason: "invalid_trade_assets_for_mfl",
              leagueId,
              season,
              actingFranchiseId: fromFranchiseId,
              counterpartyFranchiseId: toFranchiseId,
              tradeProposalPayload: {
                request_body: body,
                payload,
                invalid_assets: {
                  left: proposalAssets.leftTokensOut.invalid,
                  right: proposalAssets.rightTokensOut.invalid,
                },
              },
            });
            return jsonOut(400, {
              ok: false,
              error_type: "validation_pre_post",
              error: "Could not build valid MFL trade assets for both sides",
              diagnostics,
              invalid_assets: {
                left: proposalAssets.leftTokensOut.invalid,
                right: proposalAssets.rightTokensOut.invalid,
              },
            });
          }

          const intentBundle = await buildTradeIntentBundleFromPayload({
            leagueId,
            season,
            tradeId: "",
            actionType: "SUBMIT",
            fromFranchiseId,
            toFranchiseId,
            payload,
          });

          let outboxId = "";
          let outboxBackend = "";
          let outboxWriteError = "";
          const initialOutboxWrite = await writeOutboxRow({
            mode: "insert",
            leagueId,
            season,
            row: {
              created_ts: new Date().toISOString(),
              trade_id: "",
              action_type: "SUBMIT",
              from_franchise_id: fromFranchiseId,
              to_franchise_id: toFranchiseId,
              payload_xml_extensions: intentBundle.payload_xml_extensions,
              payload_xml_salary_adj: intentBundle.payload_xml_salary_adj,
              payload_xml_salary_trade: intentBundle.payload_xml_salary_trade,
              payload_json: payload,
              comment_trailer: "",
              payload_hash: intentBundle.payload_hash,
              status: "PENDING",
              mfl_post_response_snip: "",
              mfl_verify_response_snip: "",
            },
          });
          if (initialOutboxWrite.ok) {
            outboxId = safeStr(initialOutboxWrite.id);
            outboxBackend = safeStr(initialOutboxWrite.backend);
          } else {
            outboxWriteError = safeStr(initialOutboxWrite.error);
            outboxBackend = safeStr(initialOutboxWrite.backend);
          }

          const outboxTrailer = buildOutboxTrailerText({
            outboxId,
            payloadHash: intentBundle.payload_hash,
            payloadXmlExtensions: intentBundle.payload_xml_extensions,
            payloadXmlSalaryAdj: intentBundle.payload_xml_salary_adj,
            payloadXmlSalaryTrade: intentBundle.payload_xml_salary_trade,
          });

          if (outboxId) {
            await writeOutboxRow({
              mode: "update",
              leagueId,
              season,
              where: { id: outboxId },
              row: {
                trade_id: "",
                payload_xml_extensions: intentBundle.payload_xml_extensions,
                payload_xml_salary_adj: intentBundle.payload_xml_salary_adj,
                payload_xml_salary_trade: intentBundle.payload_xml_salary_trade,
                payload_json: payload,
                comment_trailer: outboxTrailer,
                payload_hash: intentBundle.payload_hash,
                status: "PENDING",
                mfl_post_response_snip: "",
                mfl_verify_response_snip: "",
              },
            });
          }

          const commentsOut = appendTradeMetaTagToComments(
            message,
            payload,
            fromFranchiseId,
            toFranchiseId,
            outboxTrailer
          );

          const importFields = {
            TYPE: "tradeProposal",
            L: leagueId,
            OFFEREDTO: toFranchiseId,
            WILL_GIVE_UP: willGiveUp.join(","),
            WILL_RECEIVE: willReceive.join(","),
            COMMENTS: commentsOut,
            FRANCHISE_ID: fromFranchiseId,
          };
          const expiresUnix = safeInt(
            body?.expires_unix || body?.expires || body?.EXPIRES,
            0
          );
          if (expiresUnix > 0) importFields.EXPIRES = String(expiresUnix);

          const proposalSubmit = await postTradeProposalImportWithFallback(
            season,
            importFields,
            browserCookieHeader
          );
          const importRes = proposalSubmit.importRes;

          if (!proposalSubmit.ok) {
            const diagnostics = buildTradeProposalFailureDiagnostics({
              errorType: "trade_proposal_import_failed",
              leagueId,
              season,
              actingFranchiseId: fromFranchiseId,
              counterpartyFranchiseId: toFranchiseId,
              tradeProposalPayload: {
                request_body: body,
                payload,
                import_fields: importFields,
                will_give_up: willGiveUp,
                will_receive: willReceive,
              },
              importRes,
              firstRes: proposalSubmit.firstRes,
              retriedWithoutFranchiseId: proposalSubmit.retriedWithoutFranchiseId,
            });
            logTradeProposalFailure(diagnostics);
            if (outboxId) {
              await writeOutboxRow({
                mode: "update",
                leagueId,
                season,
                where: { id: outboxId },
                row: {
                  trade_id: "",
                  payload_xml_extensions: intentBundle.payload_xml_extensions,
                  payload_xml_salary_adj: intentBundle.payload_xml_salary_adj,
                  payload_xml_salary_trade: intentBundle.payload_xml_salary_trade,
                  payload_json: payload,
                  comment_trailer: outboxTrailer,
                  payload_hash: intentBundle.payload_hash,
                  status: "FAILED",
                  mfl_post_response_snip: trimDiagText(importRes.upstreamPreview || importRes.error || "", 1000),
                  mfl_verify_response_snip: "",
                },
              });
            }
            return jsonOut(502, {
              ok: false,
              mode: "direct_mfl",
              error_type: "trade_proposal_import_failed",
              error: "Trade proposal rejected by MFL.",
              reason:
                diagnostics?.mfl_response?.reason_snippet ||
                importRes.error ||
                "MFL tradeProposal import failed",
              diagnostics,
              upstreamStatus: importRes.status,
              upstreamPreview: importRes.upstreamPreview,
              upstreamPreviewInitial:
                proposalSubmit.retriedWithoutFranchiseId && proposalSubmit.firstRes
                  ? proposalSubmit.firstRes.upstreamPreview
                  : "",
              retriedWithoutFranchiseId: !!proposalSubmit.retriedWithoutFranchiseId,
              targetImportUrl: importRes.targetImportUrl,
              formFields: importRes.formFields,
              outbox: {
                outbox_id: outboxId || "",
                payload_hash: intentBundle.payload_hash,
                backend: outboxBackend || "",
                status: outboxId ? "FAILED" : "NOT_PERSISTED",
                write_error: outboxWriteError || "",
              },
            });
          }

          let tradeId = extractTradeIdFromImportText(importRes.text);
          let pendingLookup = {
            ok: false,
            matched: false,
            match_count: 0,
            rows_count: 0,
            matched_trade_id: "",
          };
          const pendingRes = await loadPendingTradesExportAsViewer(
            season,
            leagueId,
            fromFranchiseId
          );
          if (pendingRes.ok) {
            const rows = pendingTradesRows(pendingRes.data).map(normalizePendingTradeRow);
            const metaPrefix = "[UPS_TWB_META:";
            const fromToMatches = rows.filter(
              (r) =>
                r.from_franchise_id === fromFranchiseId &&
                r.to_franchise_id === toFranchiseId
            );
            const exactMatches = fromToMatches.filter((r) =>
              safeStr(r.raw_comment || r.comments).includes(metaPrefix)
            );
            const bestList = exactMatches.length ? exactMatches : fromToMatches;
            bestList.sort((a, b) => b.timestamp - a.timestamp);
            const best = bestList[0] || null;
            if (best && !tradeId) tradeId = safeStr(best.trade_id);
            pendingLookup = {
              ok: true,
              matched: !!best,
              match_count: bestList.length,
              rows_count: rows.length,
              matched_trade_id: best ? safeStr(best.trade_id) : "",
              upstream_status: pendingRes.status,
            };
          } else {
            pendingLookup = {
              ok: false,
              matched: false,
              match_count: 0,
              rows_count: 0,
              matched_trade_id: "",
              error: pendingRes.error || "pendingTrades lookup failed",
              upstream_status: pendingRes.status,
            };
          }
          const resolvedTradeId = String(
            tradeId || pendingLookup.matched_trade_id || ""
          ).replace(/\D/g, "");
          if (outboxId) {
            await writeOutboxRow({
              mode: "update",
              leagueId,
              season,
              where: { id: outboxId },
              row: {
                trade_id: resolvedTradeId,
                payload_xml_extensions: intentBundle.payload_xml_extensions,
                payload_xml_salary_adj: intentBundle.payload_xml_salary_adj,
                payload_xml_salary_trade: intentBundle.payload_xml_salary_trade,
                payload_json: payload,
                comment_trailer: outboxTrailer,
                payload_hash: intentBundle.payload_hash,
                status: "POSTED",
                mfl_post_response_snip: trimDiagText(importRes.upstreamPreview || "", 1000),
                mfl_verify_response_snip: trimDiagText(JSON.stringify(pendingLookup || {}), 1000),
              },
            });
          }
          const syncOut = await syncDirectMflOfferToStorage({
            leagueId,
            season,
            offerId,
            resolvedTradeId,
            fromFranchiseId,
            toFranchiseId,
            fromFranchiseName,
            toFranchiseName,
            message,
            commentsOut,
            willGiveUp,
            willReceive,
            payload,
            source: safeStr(body?.source || "trade-workbench-ui"),
          });
          return jsonOut(201, {
            ok: true,
            mode: "direct_mfl",
            league_id: leagueId,
            season: safeInt(season, Number(season) || 0),
            proposal: {
              from_franchise_id: fromFranchiseId,
              to_franchise_id: toFranchiseId,
              from_franchise_name: fromFranchiseName || fromFranchiseId,
              to_franchise_name: toFranchiseName || toFranchiseId,
              will_give_up: willGiveUp,
              will_receive: willReceive,
              comments: commentsOut,
              salary_net_k: proposalAssets.salaryNets,
            },
            submitted_comment: message,
            mfl: {
              trade_id: tradeId || "",
              upstream_status: importRes.status,
              upstream_preview: importRes.upstreamPreview,
              target_import_url: importRes.targetImportUrl,
              retried_without_franchise_id: !!proposalSubmit.retriedWithoutFranchiseId,
              used_franchise_id: !!proposalSubmit.usedFranchiseId,
              pending_lookup: pendingLookup,
            },
            invalid_assets: {
              left: proposalAssets.leftTokensOut.invalid,
              right: proposalAssets.rightTokensOut.invalid,
            },
            stored_offer: syncOut.storedOffer ? sanitizeOfferForList(syncOut.storedOffer, true) : null,
            storage_sync: syncOut.storageSync,
            outbox: {
              outbox_id: outboxId || "",
              payload_hash: intentBundle.payload_hash,
              backend: outboxBackend || "",
              status: outboxId ? "POSTED" : "NOT_PERSISTED",
              write_error: outboxWriteError || "",
            },
          });
        }

        const nowIso = new Date().toISOString();
        const makeOffer = () => ({
          id: `TWB-${(crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).toString()}`,
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          status: "PENDING",
          created_at: nowIso,
          updated_at: nowIso,
          from_franchise_id: fromFranchiseId,
          to_franchise_id: toFranchiseId,
          from_franchise_name: fromFranchiseName || fromFranchiseId,
          to_franchise_name: toFranchiseName || toFranchiseId,
          message,
          source: safeStr(body?.source || "trade-workbench-ui"),
          summary: summarizeOfferPayload(payload),
          payload,
        });

        let saveOut = null;
        let createdOffer = null;
        let attempts = 0;
        while (attempts < 2) {
          attempts += 1;
          const loaded = await readTradeOffersDoc(leagueId, season);
          if (!loaded.ok) {
            return jsonOut(500, {
              ok: false,
              error: loaded.error || "Failed to load trade offers store",
              storage_path: loaded.filePath || tradeOffersFilePath(leagueId, season),
            });
          }
          const doc = normalizeTradeOffersDoc(loaded.doc, leagueId, season);
          createdOffer = makeOffer();
          doc.offers.push(createdOffer);
          saveOut = await writeTradeOffersDoc(
            leagueId,
            season,
            doc,
            loaded.sha,
            `feat(trades): store trade offer ${createdOffer.id}`
          );
          if (saveOut.ok) break;
          // Retry once on GitHub SHA/contention failures.
          if (attempts >= 2) break;
        }

        if (!saveOut || !saveOut.ok) {
          return jsonOut(500, {
            ok: false,
            error: saveOut?.error || "Failed to save trade offer",
            storage_path: saveOut?.filePath || tradeOffersFilePath(leagueId, season),
            upstreamStatus: saveOut?.upstreamStatus || 0,
            upstreamPreview: saveOut?.upstreamPreview || "",
          });
        }

        const savedDoc = saveOut.doc || emptyTradeOffersDoc(leagueId, season);
        const allOffers = Array.isArray(savedDoc.offers) ? savedDoc.offers : [];
        return jsonOut(201, {
          ok: true,
          offer: sanitizeOfferForList(createdOffer, true),
          storage_path: saveOut.filePath,
          storage_commit_sha: saveOut.commitSha || "",
          counts: {
            total: allOffers.length,
            pending: allOffers.filter((o) => offerStatusNormalized(o?.status, "PENDING") === "PENDING").length,
            incoming_pending_for_recipient: allOffers.filter(
              (o) =>
                padFranchiseId(o?.to_franchise_id) === toFranchiseId &&
                offerStatusNormalized(o?.status, "PENDING") === "PENDING"
            ).length,
          },
        });
      }

      if ((path === "/trade-offers/action" || path === "/api/trades/proposals/action") && request.method === "POST") {
        let body = null;
        try {
          body = await request.json();
        } catch (_) {
          return jsonOut(400, { ok: false, error: "Invalid JSON payload." });
        }

        const leagueId = safeStr(body?.league_id || L || "");
        const season = safeStr(body?.season || YEAR || "");
        const offerId = safeStr(body?.offer_id || body?.proposal_id);
        const action = offerStatusNormalized(body?.action, "");
        const actingFranchiseId = padFranchiseId(body?.acting_franchise_id || body?.franchise_id || "");
        const offerFromFranchiseId = padFranchiseId(
          body?.offer_from_franchise_id ||
            body?.from_franchise_id ||
            body?.fromFranchiseId ||
            ""
        );
        const offerToFranchiseId = padFranchiseId(
          body?.offer_to_franchise_id ||
            body?.to_franchise_id ||
            body?.toFranchiseId ||
            ""
        );
        const actionMessage = safeStr(body?.message).slice(0, 2000);
        const mflTradeId = String(
          body?.trade_id ||
            body?.mfl_trade_id ||
            body?.TRADE_ID ||
            body?.proposal_id ||
            ""
        ).replace(/\D/g, "");
        // Queue mode is retired: direct MFL actions only.
        const directMfl = true;
        let payload =
          body?.payload && typeof body.payload === "object"
            ? body.payload
            : body?.offer_payload && typeof body.offer_payload === "object"
              ? body.offer_payload
              : null;
        let offerComment = safeStr(
          body?.offer_comment ||
          body?.offer_comments ||
          body?.offer_raw_comment ||
          body?.offer_message ||
          body?.raw_comment ||
          body?.comments ||
          body?.comment ||
          body?.notes ||
          body?.message ||
          (payload && (
            payload.raw_comment ||
            payload.comments ||
            payload.comment ||
            payload.message ||
            payload.notes
          )) ||
          ""
        );
        let offerWillGiveUp = safeStr(
          body?.offer_will_give_up ||
          body?.will_give_up ||
          body?.WILL_GIVE_UP
        );
        let offerWillReceive = safeStr(
          body?.offer_will_receive ||
          body?.will_receive ||
          body?.WILL_RECEIVE
        );
        let offerMeta =
          body?.offer_twb_meta && typeof body.offer_twb_meta === "object"
            ? body.offer_twb_meta
            : null;
        let offerTrailerMeta = parseOutboxTrailerFromComment(offerComment);
        let acceptOutboxRow = null;
        const offerExtensionRequests = Array.isArray(body?.offer_extension_requests)
          ? body.offer_extension_requests.filter((row) => row && typeof row === "object")
          : [];

        if (!leagueId) return jsonOut(400, { ok: false, error: "league_id is required" });
        if (!season) return jsonOut(400, { ok: false, error: "season is required" });

        if (directMfl) {
          if (!viewerCookieHeader) {
            return jsonOut(500, { ok: false, error: "Missing MFL owner session for direct MFL actions" });
          }
          if (!actingFranchiseId) {
            return jsonOut(400, { ok: false, error: "acting_franchise_id is required for direct MFL actions" });
          }

          const runDirectProposal = async (proposalPayload, fromFranchiseId, toFranchiseId, comments) => {
            const proposalAssets = buildTradeProposalAssetLists(proposalPayload || {});
            if (!proposalAssets.isValid) {
              const diagnostics = buildValidationFailureDiagnostics({
                reason: "invalid_trade_assets_for_mfl",
                leagueId,
                season,
                actingFranchiseId: fromFranchiseId,
                counterpartyFranchiseId: toFranchiseId,
                tradeProposalPayload: {
                  payload: proposalPayload,
                  invalid_assets: {
                    left: proposalAssets.leftTokensOut.invalid,
                    right: proposalAssets.rightTokensOut.invalid,
                  },
                },
              });
              return {
                ok: false,
                error_type: "validation_pre_post",
                error: "Could not build valid MFL trade assets for both sides",
                diagnostics,
                invalid_assets: {
                  left: proposalAssets.leftTokensOut.invalid,
                  right: proposalAssets.rightTokensOut.invalid,
                },
              };
            }
            const intentBundle = await buildTradeIntentBundleFromPayload({
              leagueId,
              season,
              tradeId: "",
              actionType: "SUBMIT",
              fromFranchiseId,
              toFranchiseId,
              payload: proposalPayload || {},
            });
            let outboxId = "";
            let outboxBackend = "";
            let outboxWriteError = "";
            const outboxInsert = await writeOutboxRow({
              mode: "insert",
              leagueId,
              season,
              row: {
                created_ts: new Date().toISOString(),
                trade_id: "",
                action_type: "SUBMIT",
                from_franchise_id: fromFranchiseId,
                to_franchise_id: toFranchiseId,
                payload_xml_extensions: intentBundle.payload_xml_extensions,
                payload_xml_salary_adj: intentBundle.payload_xml_salary_adj,
                payload_xml_salary_trade: intentBundle.payload_xml_salary_trade,
                payload_json: proposalPayload || {},
                comment_trailer: "",
                payload_hash: intentBundle.payload_hash,
                status: "PENDING",
                mfl_post_response_snip: "",
                mfl_verify_response_snip: "",
              },
            });
            if (outboxInsert.ok) {
              outboxId = safeStr(outboxInsert.id);
              outboxBackend = safeStr(outboxInsert.backend);
            } else {
              outboxWriteError = safeStr(outboxInsert.error);
              outboxBackend = safeStr(outboxInsert.backend);
            }
            const outboxTrailer = buildOutboxTrailerText({
              outboxId,
              payloadHash: intentBundle.payload_hash,
              payloadXmlExtensions: intentBundle.payload_xml_extensions,
              payloadXmlSalaryAdj: intentBundle.payload_xml_salary_adj,
              payloadXmlSalaryTrade: intentBundle.payload_xml_salary_trade,
            });
            if (outboxId) {
              await writeOutboxRow({
                mode: "update",
                leagueId,
                season,
                where: { id: outboxId },
                row: {
                  trade_id: "",
                  action_type: "SUBMIT",
                  from_franchise_id: fromFranchiseId,
                  to_franchise_id: toFranchiseId,
                  payload_xml_extensions: intentBundle.payload_xml_extensions,
                  payload_xml_salary_adj: intentBundle.payload_xml_salary_adj,
                  payload_xml_salary_trade: intentBundle.payload_xml_salary_trade,
                  payload_json: proposalPayload || {},
                  comment_trailer: outboxTrailer,
                  payload_hash: intentBundle.payload_hash,
                  status: "PENDING",
                  mfl_post_response_snip: "",
                  mfl_verify_response_snip: "",
                },
              });
            }
            const commentsOut = appendTradeMetaTagToComments(
              comments,
              proposalPayload || {},
              fromFranchiseId,
              toFranchiseId,
              outboxTrailer
            );
            const importFields = {
              TYPE: "tradeProposal",
              L: leagueId,
              OFFEREDTO: toFranchiseId,
              WILL_GIVE_UP: proposalAssets.willGiveUp.join(","),
              WILL_RECEIVE: proposalAssets.willReceive.join(","),
              COMMENTS: commentsOut,
              FRANCHISE_ID: fromFranchiseId,
            };
            const proposalSubmit = await postTradeProposalImportWithFallback(
              season,
              importFields,
              browserCookieHeader
            );
            const proposalImport = proposalSubmit.importRes;
            if (!proposalSubmit.ok) {
              const diagnostics = buildTradeProposalFailureDiagnostics({
                errorType: "trade_proposal_import_failed",
                leagueId,
                season,
                actingFranchiseId: fromFranchiseId,
                counterpartyFranchiseId: toFranchiseId,
                tradeProposalPayload: {
                  payload: proposalPayload,
                  import_fields: importFields,
                  will_give_up: proposalAssets.willGiveUp,
                  will_receive: proposalAssets.willReceive,
                },
                importRes: proposalImport,
                firstRes: proposalSubmit.firstRes,
                retriedWithoutFranchiseId: proposalSubmit.retriedWithoutFranchiseId,
              });
              logTradeProposalFailure(diagnostics);
              if (outboxId) {
                await writeOutboxRow({
                  mode: "update",
                  leagueId,
                  season,
                  where: { id: outboxId },
                  row: {
                    trade_id: "",
                    action_type: "SUBMIT",
                    from_franchise_id: fromFranchiseId,
                    to_franchise_id: toFranchiseId,
                    payload_xml_extensions: intentBundle.payload_xml_extensions,
                    payload_xml_salary_adj: intentBundle.payload_xml_salary_adj,
                    payload_xml_salary_trade: intentBundle.payload_xml_salary_trade,
                    payload_json: proposalPayload || {},
                    comment_trailer: outboxTrailer,
                    payload_hash: intentBundle.payload_hash,
                    status: "FAILED",
                    mfl_post_response_snip: trimDiagText(proposalImport.upstreamPreview || proposalImport.error || "", 1000),
                    mfl_verify_response_snip: "",
                  },
                });
              }
              return {
                ok: false,
                error_type: "trade_proposal_import_failed",
                error: "Trade proposal rejected by MFL.",
                reason:
                  diagnostics?.mfl_response?.reason_snippet ||
                  proposalImport.error ||
                  "MFL tradeProposal import failed",
                diagnostics,
                upstreamStatus: proposalImport.status,
                upstreamPreview: proposalImport.upstreamPreview,
                upstreamPreviewInitial:
                  proposalSubmit.retriedWithoutFranchiseId && proposalSubmit.firstRes
                    ? proposalSubmit.firstRes.upstreamPreview
                    : "",
                retriedWithoutFranchiseId: !!proposalSubmit.retriedWithoutFranchiseId,
                targetImportUrl: proposalImport.targetImportUrl,
                formFields: proposalImport.formFields,
                invalid_assets: {
                  left: proposalAssets.leftTokensOut.invalid,
                  right: proposalAssets.rightTokensOut.invalid,
                },
                outbox: {
                  outbox_id: outboxId || "",
                  payload_hash: intentBundle.payload_hash,
                  backend: outboxBackend || "",
                  status: outboxId ? "FAILED" : "NOT_PERSISTED",
                  write_error: outboxWriteError || "",
                },
              };
            }
            let tradeIdOut = extractTradeIdFromImportText(proposalImport.text);
            let pendingLookup = {
              ok: false,
              matched: false,
              match_count: 0,
              rows_count: 0,
              matched_trade_id: "",
            };
            const pendingRes = await loadPendingTradesExportAsViewer(
              season,
              leagueId,
              fromFranchiseId
            );
            if (pendingRes.ok) {
              const rows = pendingTradesRows(pendingRes.data).map(normalizePendingTradeRow);
              const metaPrefix = "[UPS_TWB_META:";
              const fromToMatches = rows.filter(
                (r) =>
                  r.from_franchise_id === fromFranchiseId &&
                  r.to_franchise_id === toFranchiseId
              );
              const exactMatches = fromToMatches.filter((r) =>
                safeStr(r.raw_comment || r.comments).includes(metaPrefix)
              );
              const bestList = exactMatches.length ? exactMatches : fromToMatches;
              bestList.sort((a, b) => b.timestamp - a.timestamp);
              const best = bestList[0] || null;
              if (best && !tradeIdOut) tradeIdOut = safeStr(best.trade_id);
              pendingLookup = {
                ok: true,
                matched: !!best,
                match_count: bestList.length,
                rows_count: rows.length,
                matched_trade_id: best ? safeStr(best.trade_id) : "",
                upstream_status: pendingRes.status,
              };
            } else {
              pendingLookup = {
                ok: false,
                matched: false,
                match_count: 0,
                rows_count: 0,
                matched_trade_id: "",
                error: pendingRes.error || "pendingTrades lookup failed",
                upstream_status: pendingRes.status,
              };
            }
            const resolvedTradeId = String(
              tradeIdOut || pendingLookup.matched_trade_id || ""
            ).replace(/\D/g, "");
            if (outboxId) {
              await writeOutboxRow({
                mode: "update",
                leagueId,
                season,
                where: { id: outboxId },
                row: {
                  trade_id: resolvedTradeId,
                  action_type: "SUBMIT",
                  from_franchise_id: fromFranchiseId,
                  to_franchise_id: toFranchiseId,
                  payload_xml_extensions: intentBundle.payload_xml_extensions,
                  payload_xml_salary_adj: intentBundle.payload_xml_salary_adj,
                  payload_xml_salary_trade: intentBundle.payload_xml_salary_trade,
                  payload_json: proposalPayload || {},
                  comment_trailer: outboxTrailer,
                  payload_hash: intentBundle.payload_hash,
                  status: "POSTED",
                  mfl_post_response_snip: trimDiagText(proposalImport.upstreamPreview || "", 1000),
                  mfl_verify_response_snip: trimDiagText(JSON.stringify(pendingLookup || {}), 1000),
                },
              });
            }
            const syncOut = await syncDirectMflOfferToStorage({
              leagueId,
              season,
              offerId: "",
              resolvedTradeId,
              fromFranchiseId,
              toFranchiseId,
              fromFranchiseName: "",
              toFranchiseName: "",
              message: comments,
              commentsOut,
              willGiveUp: proposalAssets.willGiveUp,
              willReceive: proposalAssets.willReceive,
              payload: proposalPayload || {},
              source: safeStr(body?.source || "trade-workbench-ui"),
            });

            return {
              ok: true,
              proposal: {
                from_franchise_id: fromFranchiseId,
                to_franchise_id: toFranchiseId,
                will_give_up: proposalAssets.willGiveUp,
                will_receive: proposalAssets.willReceive,
                comments: commentsOut,
                salary_net_k: proposalAssets.salaryNets,
              },
              mfl: {
                trade_id: tradeIdOut || "",
                upstream_status: proposalImport.status,
                upstream_preview: proposalImport.upstreamPreview,
                target_import_url: proposalImport.targetImportUrl,
                retried_without_franchise_id: !!proposalSubmit.retriedWithoutFranchiseId,
                used_franchise_id: !!proposalSubmit.usedFranchiseId,
                pending_lookup: pendingLookup,
              },
              invalid_assets: {
                left: proposalAssets.leftTokensOut.invalid,
                right: proposalAssets.rightTokensOut.invalid,
              },
              stored_offer: syncOut.storedOffer
                ? sanitizeOfferForList(syncOut.storedOffer, true)
                : null,
              storage_sync: syncOut.storageSync,
              outbox: {
                outbox_id: outboxId || "",
                payload_hash: intentBundle.payload_hash,
                backend: outboxBackend || "",
                status: outboxId ? "POSTED" : "NOT_PERSISTED",
                write_error: outboxWriteError || "",
              },
            };
          };

          if (!action) {
            return jsonOut(400, { ok: false, error: "action is required for direct MFL actions" });
          }

          if (action === "COUNTER") {
            if (!mflTradeId) return jsonOut(400, { ok: false, error: "trade_id is required for COUNTER action" });
            const counter = body?.counter_offer && typeof body.counter_offer === "object" ? body.counter_offer : {};
            const counterPayload =
              counter?.payload && typeof counter.payload === "object"
                ? counter.payload
                : payload;
            if (!counterPayload) {
              return jsonOut(400, { ok: false, error: "counter_offer.payload is required for direct COUNTER" });
            }
            const counterFromId = padFranchiseId(
              counter?.from_franchise_id || counterPayload?.ui?.left_team_id || actingFranchiseId || ""
            );
            const counterToId = padFranchiseId(
              counter?.to_franchise_id || counterPayload?.ui?.right_team_id || ""
            );
            if (!counterFromId || !counterToId || counterFromId === counterToId) {
              return jsonOut(400, { ok: false, error: "Valid counter from/to franchise ids are required" });
            }

            const rejectImport = await postMflImportFormAsViewer(
              season,
              {
                TYPE: "tradeResponse",
                L: leagueId,
                TRADE_ID: mflTradeId,
                RESPONSE: "reject",
                FRANCHISE_ID: actingFranchiseId,
                COMMENTS: actionMessage || "Countered in UPS Trade Workbench",
              },
              {
                TYPE: "tradeResponse",
                L: leagueId,
                TRADE_ID: mflTradeId,
                RESPONSE: "reject",
                FRANCHISE_ID: actingFranchiseId,
                COMMENTS: actionMessage || "Countered in UPS Trade Workbench",
              },
              { method: "GET" }
            );
            if (!rejectImport.requestOk) {
              return jsonOut(502, {
                ok: false,
                mode: "direct_mfl",
                action: "COUNTER",
                error: "Failed to reject original MFL trade prior to counter",
                upstreamStatus: rejectImport.status,
                upstreamPreview: rejectImport.upstreamPreview,
                targetImportUrl: rejectImport.targetImportUrl,
                formFields: rejectImport.formFields,
              });
            }

            const counterMessage = safeStr(counter?.message || actionMessage).slice(0, 2000);
            const proposalOut = await runDirectProposal(
              counterPayload,
              counterFromId,
              counterToId,
              counterMessage
            );
            if (!proposalOut.ok) {
              return jsonOut(502, {
                ok: false,
                mode: "direct_mfl",
                action: "COUNTER",
                error_type: safeStr(proposalOut.error_type || "trade_proposal_import_failed"),
                error: proposalOut.error || "Counter proposal failed",
                rejected_trade: {
                  trade_id: mflTradeId,
                  upstream_status: rejectImport.status,
                  upstream_preview: rejectImport.upstreamPreview,
                },
                proposal_error: proposalOut,
              });
            }

            return jsonOut(200, {
              ok: true,
              mode: "direct_mfl",
              action: "COUNTER",
              rejected_trade: {
                trade_id: mflTradeId,
                upstream_status: rejectImport.status,
                upstream_preview: rejectImport.upstreamPreview,
              },
              counter_offer: proposalOut.proposal,
              mfl: proposalOut.mfl,
              invalid_assets: proposalOut.invalid_assets,
              stored_offer: proposalOut.stored_offer || null,
              storage_sync: proposalOut.storage_sync || null,
              outbox: proposalOut.outbox || null,
            });
          }

          if (!["ACCEPT", "REJECT", "REVOKE"].includes(action)) {
            return jsonOut(400, { ok: false, error: "action must be ACCEPT, REJECT, REVOKE, or COUNTER in direct mode" });
          }
          if (!mflTradeId) {
            return jsonOut(400, { ok: false, error: "trade_id is required for direct MFL actions" });
          }

          let resolvedOfferFromFranchiseId = offerFromFranchiseId;
          let resolvedOfferToFranchiseId = offerToFranchiseId;
          let acceptStoredOffer = null;
          let acceptPendingRow = null;
          if (action === "ACCEPT") {
            if (offerExtensionRequests.length) {
              if (!payload || typeof payload !== "object") payload = {};
              const payloadExt = Array.isArray(payload?.extension_requests)
                ? payload.extension_requests
                : [];
              if (!payloadExt.length) {
                payload.extension_requests = JSON.parse(JSON.stringify(offerExtensionRequests));
              }
            }
            try {
              const loaded = await readTradeOffersDoc(leagueId, season);
              if (loaded.ok) {
                const offers = Array.isArray(loaded.doc?.offers) ? loaded.doc.offers : [];
                acceptStoredOffer = findStoredOfferForDirectAction(offers, {
                  tradeId: mflTradeId,
                  offerId,
                  fromFranchiseId: resolvedOfferFromFranchiseId,
                  toFranchiseId: resolvedOfferToFranchiseId,
                  actingFranchiseId,
                });
                if (acceptStoredOffer) {
                  if ((!payload || typeof payload !== "object") && acceptStoredOffer.payload && typeof acceptStoredOffer.payload === "object") {
                    payload = JSON.parse(JSON.stringify(acceptStoredOffer.payload));
                  }
                  if (payload && typeof payload === "object" && acceptStoredOffer.payload && typeof acceptStoredOffer.payload === "object") {
                    const payloadExt = Array.isArray(payload?.extension_requests)
                      ? payload.extension_requests
                      : [];
                    const storedExt = Array.isArray(acceptStoredOffer.payload?.extension_requests)
                      ? acceptStoredOffer.payload.extension_requests
                      : [];
                    if (!payloadExt.length && storedExt.length) {
                      payload.extension_requests = JSON.parse(JSON.stringify(storedExt));
                    }
                  }
                  if (!offerComment) {
                    offerComment = safeStr(
                      acceptStoredOffer.raw_comment ||
                        acceptStoredOffer.comments ||
                        acceptStoredOffer.comment ||
                        acceptStoredOffer.message
                    );
                  }
                  if (!offerMeta) {
                    offerMeta =
                      (acceptStoredOffer.twb_meta && typeof acceptStoredOffer.twb_meta === "object"
                        ? acceptStoredOffer.twb_meta
                        : null) ||
                      parseTradeMetaTagFromComments(
                        safeStr(
                          acceptStoredOffer.raw_comment ||
                            acceptStoredOffer.comments ||
                            acceptStoredOffer.comment ||
                            acceptStoredOffer.message
                        )
                      );
                  }
                  if (!offerWillGiveUp) offerWillGiveUp = safeStr(acceptStoredOffer.will_give_up);
                  if (!offerWillReceive) offerWillReceive = safeStr(acceptStoredOffer.will_receive);
                  if (!resolvedOfferFromFranchiseId) {
                    resolvedOfferFromFranchiseId = padFranchiseId(
                      acceptStoredOffer.from_franchise_id
                    );
                  }
                  if (!resolvedOfferToFranchiseId) {
                    resolvedOfferToFranchiseId = padFranchiseId(
                      acceptStoredOffer.to_franchise_id
                    );
                  }
                }
              }
            } catch (_) {
              // noop
            }
            try {
              const pendingRes = await loadPendingTradesExportAsViewer(
                season,
                leagueId,
                actingFranchiseId
              );
              if (pendingRes.ok) {
                const rows = pendingTradesRows(pendingRes.data).map(normalizePendingTradeRow);
                acceptPendingRow = rows.find(
                  (r) => String(r?.trade_id || "").replace(/\D/g, "") === mflTradeId
                ) || null;
                if (acceptPendingRow) {
                  const pendingComment = safeStr(
                    acceptPendingRow.raw_comment || acceptPendingRow.comments
                  );
                  if (pendingComment) {
                    if (!offerComment) offerComment = pendingComment;
                    if (!offerMeta) offerMeta = parseTradeMetaTagFromComments(pendingComment);
                  }
                  if (!offerWillGiveUp) offerWillGiveUp = safeStr(acceptPendingRow.will_give_up);
                  if (!offerWillReceive) offerWillReceive = safeStr(acceptPendingRow.will_receive);
                  if (!resolvedOfferFromFranchiseId) {
                    resolvedOfferFromFranchiseId = padFranchiseId(
                      acceptPendingRow.from_franchise_id
                    );
                  }
                  if (!resolvedOfferToFranchiseId) {
                    resolvedOfferToFranchiseId = padFranchiseId(
                      acceptPendingRow.to_franchise_id
                    );
                  }
                }
              }
            } catch (_) {
              // noop
            }
            offerTrailerMeta = parseOutboxTrailerFromComment(offerComment);
            if (offerTrailerMeta && (offerTrailerMeta.outbox_id || offerTrailerMeta.payload_hash)) {
              const outboxLookup = await findOutboxRow({
                leagueId,
                season,
                id: offerTrailerMeta.outbox_id,
                tradeId: mflTradeId,
                payloadHash: offerTrailerMeta.payload_hash,
              });
              if (outboxLookup && outboxLookup.ok && outboxLookup.row) {
                acceptOutboxRow = outboxLookup.row;
                if ((!payload || typeof payload !== "object") && acceptOutboxRow.payload_json) {
                  payload = JSON.parse(JSON.stringify(acceptOutboxRow.payload_json));
                } else if (payload && typeof payload === "object" && acceptOutboxRow.payload_json) {
                  const payloadExt = Array.isArray(payload?.extension_requests)
                    ? payload.extension_requests
                    : [];
                  const outboxExt = Array.isArray(acceptOutboxRow.payload_json?.extension_requests)
                    ? acceptOutboxRow.payload_json.extension_requests
                    : [];
                  if (!payloadExt.length && outboxExt.length) {
                    payload.extension_requests = JSON.parse(JSON.stringify(outboxExt));
                  }
                }
                if (!offerComment && acceptOutboxRow.comment_trailer) {
                  offerComment = safeStr(acceptOutboxRow.comment_trailer);
                }
              }
            }
          }
          if (action === "ACCEPT" && payload && typeof payload === "object" && offerComment) {
            if (!safeStr(payload.comment)) payload.comment = offerComment;
            if (!safeStr(payload.comments)) payload.comments = offerComment;
            if (!safeStr(payload.raw_comment)) payload.raw_comment = offerComment;
            if (!safeStr(payload.message)) payload.message = offerComment;
            if (!safeStr(payload.notes)) payload.notes = offerComment;
          }

          // Ensure finalize payload exists for ACCEPT flows even when stored queue payload is missing.
          if (action === "ACCEPT" && (!payload || !Array.isArray(payload?.teams) || !payload.teams.length)) {
            let rebuiltPayload = null;
            let rosterStatusLookup = null;
            try {
              const rostersForRebuildRes = await mflExportJson(
                season,
                leagueId,
                "rosters",
                {},
                { useCookie: true }
              );
              if (rostersForRebuildRes.ok) {
                rosterStatusLookup = buildRosterStatusLookup(rostersForRebuildRes.data);
              }
            } catch (_) {
              // noop
            }
            if (
              offerWillGiveUp &&
              offerWillReceive &&
              resolvedOfferFromFranchiseId &&
              resolvedOfferToFranchiseId
            ) {
              rebuiltPayload = buildPayloadFromOfferTokens({
                leagueId,
                season,
                fromFranchiseId: resolvedOfferFromFranchiseId,
                toFranchiseId: resolvedOfferToFranchiseId,
                willGiveUp: offerWillGiveUp,
                willReceive: offerWillReceive,
                comment: offerComment,
                rosterStatusLookup,
              });
            }
            if (!rebuiltPayload && acceptPendingRow) {
              rebuiltPayload = buildPayloadFromOfferTokens({
                leagueId,
                season,
                fromFranchiseId: acceptPendingRow.from_franchise_id || resolvedOfferFromFranchiseId,
                toFranchiseId: acceptPendingRow.to_franchise_id || resolvedOfferToFranchiseId,
                willGiveUp: acceptPendingRow.will_give_up || offerWillGiveUp,
                willReceive: acceptPendingRow.will_receive || offerWillReceive,
                comment: acceptPendingRow.raw_comment || acceptPendingRow.comments || offerComment,
                rosterStatusLookup,
              });
            }
            if (rebuiltPayload) {
              payload = rebuiltPayload;
              if (!safeStr(payload.comment)) payload.comment = offerComment;
              try {
                console.log(
                  "[TWB][accept][payload_rebuild]",
                  JSON.stringify({
                    timestamp_utc: new Date().toISOString(),
                    trade_id: safeStr(mflTradeId),
                    league_id: safeStr(leagueId),
                    season: safeStr(season),
                    source: "offer_tokens",
                    left_team_id: safeStr(payload?.ui?.left_team_id),
                    right_team_id: safeStr(payload?.ui?.right_team_id),
                    left_assets: (payload?.teams?.[0]?.selected_assets || []).length,
                    right_assets: (payload?.teams?.[1]?.selected_assets || []).length,
                  })
                );
              } catch (_) {
                // noop
              }
            }
          }

          if (action === "ACCEPT" && payload && typeof payload === "object") {
            const acceptProposalAssets = buildTradeProposalAssetLists(payload);
            if (!acceptProposalAssets.isValid) {
              const diagnostics = buildValidationFailureDiagnostics({
                reason: "invalid_trade_assets_for_mfl",
                leagueId,
                season,
                actingFranchiseId,
                counterpartyFranchiseId:
                  padFranchiseId(resolvedOfferFromFranchiseId) === padFranchiseId(actingFranchiseId)
                    ? resolvedOfferToFranchiseId
                    : resolvedOfferFromFranchiseId,
                tradeProposalPayload: {
                  payload,
                  invalid_assets: {
                    left: acceptProposalAssets.leftTokensOut.invalid,
                    right: acceptProposalAssets.rightTokensOut.invalid,
                  },
                },
              });
              return jsonOut(400, {
                ok: false,
                mode: "direct_mfl",
                action,
                error_type: "validation_pre_post",
                error: "Trade payload contains invalid assets",
                diagnostics,
                invalid_assets: {
                  left: acceptProposalAssets.leftTokensOut.invalid,
                  right: acceptProposalAssets.rightTokensOut.invalid,
                },
              });
            }
          }

          const responseImport = await postMflImportFormAsViewer(
            season,
            {
              TYPE: "tradeResponse",
              L: leagueId,
              TRADE_ID: mflTradeId,
              RESPONSE: action.toLowerCase(),
              FRANCHISE_ID: actingFranchiseId,
              COMMENTS: actionMessage,
            },
            {
              TYPE: "tradeResponse",
              L: leagueId,
              TRADE_ID: mflTradeId,
              RESPONSE: action.toLowerCase(),
              FRANCHISE_ID: actingFranchiseId,
              COMMENTS: actionMessage,
            },
            { method: "GET" }
          );

          if (!responseImport.requestOk) {
            const acceptDebugEarly = action === "ACCEPT"
              ? {
                  trade_context: {
                    timestamp_utc: new Date().toISOString(),
                    league_id: safeStr(leagueId),
                    season: safeStr(season),
                    mfl_base_host: hostFromUrl(responseImport?.targetImportUrl),
                    acting_franchise_id: safeStr(actingFranchiseId),
                    counterparty_franchise_id: "",
                    trade_key: safeStr(mflTradeId || offerId || body?.proposal_id || body?.offer_id),
                  },
                  comment_source: {
                    field: "offer_comment",
                    raw_comment_text: safeStr(offerComment).slice(0, 500),
                    extension_trigger_found: false,
                  },
                  extension_parse: {
                    requested_count: 0,
                    prepared_count: 0,
                    rows: [],
                  },
                  import_attempts: [
                    buildImportAttemptDebug({
                      step: "trade_response_import",
                      endpointUrl: responseImport?.targetImportUrl,
                      httpStatus: responseImport?.status,
                      responseText: responseImport?.upstreamPreview,
                      parsedError: extractMflReasonSnippet(responseImport?.upstreamPreview || responseImport?.error || ""),
                      payloadXml: null,
                    }),
                  ],
                  final_summary: {
                    salary_adjustments: { attempted: 0, posted: 0, failed: 0 },
                    extensions: { attempted: 0, posted: 0, failed: 0, skipped: 0, skip_reasons: [] },
                  },
                }
              : null;
            if (acceptDebugEarly) {
              try {
                console.log("[TWB][accept][debug]", JSON.stringify(acceptDebugEarly));
              } catch (_) {
                // noop
              }
            }
            return jsonOut(502, {
              ok: false,
              mode: "direct_mfl",
              action,
              error_type: "trade_response_import_failed",
              error: "MFL tradeResponse import failed",
              accept_debug: acceptDebugEarly,
              upstreamStatus: responseImport.status,
              upstreamPreview: responseImport.upstreamPreview,
              targetImportUrl: responseImport.targetImportUrl,
              formFields: responseImport.formFields,
            });
          }

          let acceptOutboxId = safeStr(acceptOutboxRow && acceptOutboxRow.id);
          let acceptOutboxBackend = "";
          let acceptOutboxWriteError = "";
          let acceptIntentBundle = {
            payload_hash: safeStr(offerTrailerMeta && offerTrailerMeta.payload_hash),
            payload_xml_extensions: safeStr(offerTrailerMeta && offerTrailerMeta.payload_xml_extensions),
            payload_xml_salary_adj: safeStr(offerTrailerMeta && offerTrailerMeta.payload_xml_salary_adj),
            payload_xml_salary_trade: safeStr(offerTrailerMeta && offerTrailerMeta.payload_xml_salary_trade),
            comment_trailer: safeStr(offerTrailerMeta && offerTrailerMeta.raw_block),
          };
          if (action === "ACCEPT" && payload && typeof payload === "object") {
            const builtIntent = await buildTradeIntentBundleFromPayload({
              leagueId,
              season,
              tradeId: mflTradeId,
              actionType: "ACCEPT",
              fromFranchiseId: resolvedOfferFromFranchiseId,
              toFranchiseId: resolvedOfferToFranchiseId,
              payload,
              commentTrailerHint: acceptIntentBundle.comment_trailer,
            });
            acceptIntentBundle = {
              ...acceptIntentBundle,
              ...builtIntent,
              comment_trailer: safeStr(acceptIntentBundle.comment_trailer || builtIntent.comment_trailer),
            };
            try {
              const appliedRows = Array.isArray(acceptIntentBundle.extension_applied)
                ? acceptIntentBundle.extension_applied
                : [];
              const canonicalLog = {
                timestamp_utc: new Date().toISOString(),
                trade_id: safeStr(mflTradeId),
                league_id: safeStr(leagueId),
                season: safeStr(season),
                from_franchise_id: safeStr(resolvedOfferFromFranchiseId),
                to_franchise_id: safeStr(resolvedOfferToFranchiseId),
                extension_rows: appliedRows.map((row) => extensionRowAuditShape(row)),
                salary_adjustments_rows: buildSalaryAdjRowsFromPayload(payload, mflTradeId, season),
                payload_xml_extensions_preview: trimDiagText(
                  safeStr(acceptIntentBundle.payload_xml_extensions),
                  1200
                ),
                payload_xml_salary_adj_preview: trimDiagText(
                  safeStr(acceptIntentBundle.payload_xml_salary_adj),
                  1200
                ),
                payload_hash: safeStr(acceptIntentBundle.payload_hash),
              };
              console.log("[TWB][accept][canonical_payload]", JSON.stringify(canonicalLog));
            } catch (_) {
              // noop
            }
          }
          if (action === "ACCEPT") {
            if (acceptOutboxId) {
              const upd = await writeOutboxRow({
                mode: "update",
                leagueId,
                season,
                where: { id: acceptOutboxId },
                row: {
                  trade_id: mflTradeId,
                  action_type: "ACCEPT",
                  from_franchise_id: resolvedOfferFromFranchiseId,
                  to_franchise_id: resolvedOfferToFranchiseId,
                  payload_xml_extensions: acceptIntentBundle.payload_xml_extensions,
                  payload_xml_salary_adj: acceptIntentBundle.payload_xml_salary_adj,
                  payload_xml_salary_trade: acceptIntentBundle.payload_xml_salary_trade,
                  payload_json: payload || null,
                  comment_trailer: acceptIntentBundle.comment_trailer,
                  payload_hash: acceptIntentBundle.payload_hash,
                  status: "PENDING",
                  mfl_post_response_snip: trimDiagText(responseImport.upstreamPreview || "", 1000),
                  mfl_verify_response_snip: "",
                },
              });
              if (!upd.ok) {
                acceptOutboxWriteError = safeStr(upd.error);
                acceptOutboxBackend = safeStr(upd.backend);
              } else {
                acceptOutboxBackend = safeStr(upd.backend);
              }
            } else {
              const ins = await writeOutboxRow({
                mode: "insert",
                leagueId,
                season,
                row: {
                  created_ts: new Date().toISOString(),
                  trade_id: mflTradeId,
                  action_type: "ACCEPT",
                  from_franchise_id: resolvedOfferFromFranchiseId,
                  to_franchise_id: resolvedOfferToFranchiseId,
                  payload_xml_extensions: acceptIntentBundle.payload_xml_extensions,
                  payload_xml_salary_adj: acceptIntentBundle.payload_xml_salary_adj,
                  payload_xml_salary_trade: acceptIntentBundle.payload_xml_salary_trade,
                  payload_json: payload || null,
                  comment_trailer: acceptIntentBundle.comment_trailer,
                  payload_hash: acceptIntentBundle.payload_hash,
                  status: "PENDING",
                  mfl_post_response_snip: trimDiagText(responseImport.upstreamPreview || "", 1000),
                  mfl_verify_response_snip: "",
                },
              });
              if (ins.ok) {
                acceptOutboxId = safeStr(ins.id);
                acceptOutboxBackend = safeStr(ins.backend);
              } else {
                acceptOutboxWriteError = safeStr(ins.error);
                acceptOutboxBackend = safeStr(ins.backend);
              }
            }
          }

          let salaryAdjOut = {
            ok: true,
            skipped: true,
            reason: "not_run",
          };
          let extensionsOut = {
            ok: true,
            skipped: true,
            reason: "not_run",
          };
          let taxiSyncOut = {
            ok: true,
            skipped: true,
            reason: "not_run",
          };
          let extensionPreparation = null;
          if (action === "ACCEPT") {
            if (payload) {
              extensionPreparation = await prepareExtensionRequestsFromOfferContext({
                payload,
                season,
                queryParams: url.searchParams,
                offerComment,
                offerMeta,
                tradeId: mflTradeId,
              });
              if (extensionPreparation && extensionPreparation.payload) {
                payload = extensionPreparation.payload;
              }
              const plannedSalaryAdjRows = buildSalaryAdjRowsFromPayload(payload, mflTradeId, season);
              const plannedExtCount = Array.isArray(payload?.extension_requests)
                ? payload.extension_requests.length
                : 0;
              const needsPrivilegedImports = plannedSalaryAdjRows.length > 0 || plannedExtCount > 0;
              let adminStateForImports = { ok: true, isAdmin: true, reason: "not_checked" };
              if (needsPrivilegedImports) {
                adminStateForImports = await getLeagueAdminState(leagueId, season);
              }
              if (needsPrivilegedImports && (!adminStateForImports.ok || !adminStateForImports.isAdmin)) {
                salaryAdjOut = {
                  ok: false,
                  skipped: true,
                  reason: "requires_commish_cookie",
                  error:
                    "MFL_COOKIE lacks commissioner privileges required for salary adjustments/extensions",
                  rows: plannedSalaryAdjRows,
                  admin_state: adminStateForImports,
                };
                extensionsOut = {
                  ok: false,
                  skipped: true,
                  reason: "requires_commish_cookie",
                  error:
                    "MFL_COOKIE lacks commissioner privileges required for salary adjustments/extensions",
                  applied: [],
                  skipped_rows: (extensionPreparation?.skipped_rows || []).concat([
                    { reason: "requires_commish_cookie" },
                  ]),
                  expected_extension_count: safeInt(extensionPreparation?.expected_extension_count, 0),
                  extension_trigger_found: !!(extensionPreparation?.extension_trigger_found),
                  verification: {
                    ok: false,
                    reason: "requires_commish_cookie",
                    checked_players: 0,
                    matched_players: 0,
                    mismatched_players: 0,
                    rows: [],
                  },
                  admin_state: adminStateForImports,
                };
              } else {
                salaryAdjOut = await applySalaryAdjFromPayload(leagueId, season, payload, mflTradeId);
                extensionsOut = await applyExtensionsFromPayload(leagueId, season, payload, {
                  expected_extension_count: safeInt(extensionPreparation?.expected_extension_count, 0),
                  extension_trigger_found: !!(extensionPreparation?.extension_trigger_found),
                  preparation_skipped_rows: extensionPreparation?.skipped_rows || [],
                  trade_id: mflTradeId,
                });
              }
              taxiSyncOut = await applyTaxiDemotionsFromPayload(leagueId, season, payload, {
                trade_id: mflTradeId,
              });
            } else {
              salaryAdjOut = {
                ok: true,
                skipped: true,
                reason: "missing_payload_for_finalize",
              };
              extensionsOut = {
                ok: false,
                skipped: true,
                reason: "missing_payload_for_finalize",
                skipped_rows: [
                  { reason: "missing_payload_for_finalize" },
                ],
              };
              taxiSyncOut = {
                ok: false,
                skipped: true,
                reason: "missing_payload_for_finalize",
                rows: [],
              };
            }
          }

          let postVerifyTransactions = null;
          let postVerifySalaries = null;
          if (action === "ACCEPT") {
            const txRes = await mflExportJson(season, leagueId, "transactions", {}, { useCookie: true });
            postVerifyTransactions = {
              ok: !!txRes.ok,
              status: txRes.status,
              url: txRes.url,
              error: txRes.error,
              preview: txRes.textPreview,
            };
            const salRes = await mflExportJson(season, leagueId, "salaries", {}, { useCookie: true });
            postVerifySalaries = {
              ok: !!salRes.ok,
              status: salRes.status,
              url: salRes.url,
              error: salRes.error,
              preview: salRes.textPreview,
            };
          }

          let acceptDebug = null;
          if (action === "ACCEPT") {
            const salaryRows = Array.isArray(salaryAdjOut?.rows) ? salaryAdjOut.rows : [];
            const salaryAttempted = salaryRows.length;
            const salaryPosted = salaryAdjOut && salaryAdjOut.ok ? salaryAttempted : 0;
            const salaryFailed = Math.max(0, salaryAttempted - salaryPosted);
            const extAppliedRows = Array.isArray(extensionsOut?.applied) ? extensionsOut.applied : [];
            const extSkippedRows = Array.isArray(extensionsOut?.skipped_rows) ? extensionsOut.skipped_rows : [];
            const extAttempted = Math.max(
              safeInt(extensionPreparation?.expected_extension_count, 0),
              extAppliedRows.length + extSkippedRows.length
            );
            const extPosted = extensionsOut && extensionsOut.ok ? extAppliedRows.length : 0;
            const extFailed = Math.max(0, extAttempted - extPosted - extSkippedRows.length);
            const extSkipReasons = Array.from(
              new Set(
                extSkippedRows
                  .map((row) => safeStr(row?.reason || row?.parse_error))
                  .filter(Boolean)
              )
            );
            const taxiRows = Array.isArray(taxiSyncOut?.rows) ? taxiSyncOut.rows : [];
            const taxiVerificationRows = Array.isArray(taxiSyncOut?.verification?.rows)
              ? taxiSyncOut.verification.rows
              : [];
            const counterpartyFromPayload = padFranchiseId(
              payload?.ui?.left_team_id === actingFranchiseId
                ? payload?.ui?.right_team_id
                : payload?.ui?.left_team_id
            );
            acceptDebug = {
              trade_context: {
                timestamp_utc: new Date().toISOString(),
                league_id: safeStr(leagueId),
                season: safeStr(season),
                mfl_base_host: hostFromUrl(responseImport?.targetImportUrl),
                acting_franchise_id: safeStr(actingFranchiseId),
                counterparty_franchise_id: safeStr(counterpartyFromPayload),
                trade_key: safeStr(mflTradeId || offerId || body?.proposal_id || body?.offer_id),
              },
              comment_source: {
                field: safeStr(extensionPreparation?.comment_field_used || "unknown"),
                raw_comment_text: safeStr(extensionPreparation?.raw_comment_excerpt || offerComment).slice(0, 500),
                extension_trigger_found: !!(extensionPreparation?.extension_trigger_found),
              },
              extension_parse: {
                requested_count: safeInt(extensionPreparation?.expected_extension_count, 0),
                prepared_count: safeInt(extensionPreparation?.prepared_count, 0),
                rows: Array.isArray(extensionPreparation?.parse_rows)
                  ? extensionPreparation.parse_rows
                  : [],
              },
              import_attempts: [
                buildImportAttemptDebug({
                  step: "trade_response_import",
                  endpointUrl: responseImport?.targetImportUrl,
                  httpStatus: responseImport?.status,
                  responseText: responseImport?.upstreamPreview,
                  parsedError: extractMflReasonSnippet(responseImport?.upstreamPreview || responseImport?.error || ""),
                  payloadXml: null,
                }),
                buildImportAttemptDebug({
                  step: "salary_adjustment_import",
                  endpointUrl: salaryAdjOut?.targetImportUrl,
                  httpStatus: salaryAdjOut?.upstreamStatus,
                  responseText: salaryAdjOut?.upstreamPreview,
                  parsedError: extractMflReasonSnippet(salaryAdjOut?.upstreamPreview || salaryAdjOut?.error || ""),
                  payloadXml: salaryAdjOut?.dataXml || null,
                }),
                buildImportAttemptDebug({
                  step: "extension_contract_import",
                  endpointUrl: extensionsOut?.targetImportUrl,
                  httpStatus: extensionsOut?.upstreamStatus,
                  responseText: extensionsOut?.upstreamPreview,
                  parsedError: extractMflReasonSnippet(extensionsOut?.upstreamPreview || extensionsOut?.error || ""),
                  payloadXml: extensionsOut?.dataXml || null,
                }),
              ],
              final_summary: {
                salary_adjustments: {
                  attempted: salaryAttempted,
                  posted: salaryPosted,
                  failed: salaryFailed,
                },
                extensions: {
                  attempted: extAttempted,
                  posted: extPosted,
                  failed: extFailed,
                  skipped: extSkippedRows.length,
                  skip_reasons: extSkipReasons,
                },
                taxi_sync: {
                  attempted: taxiRows.length,
                  posted: taxiSyncOut && taxiSyncOut.ok
                    ? safeInt(taxiSyncOut?.verification?.matched_count, taxiRows.length)
                    : 0,
                  failed: taxiSyncOut && taxiSyncOut.ok
                    ? 0
                    : Math.max(0, taxiRows.length - safeInt(taxiSyncOut?.verification?.matched_count, 0)),
                  skipped: taxiSyncOut && taxiSyncOut.skipped ? taxiRows.length : 0,
                  reason: safeStr(taxiSyncOut?.reason),
                },
              },
              canonical_payload: {
                hash: safeStr(acceptIntentBundle?.payload_hash),
                extension_rows: extAppliedRows.map((row) => extensionRowAuditShape(row)),
                extension_skipped_rows: extSkippedRows,
                salary_adjustment_rows: salaryRows,
                taxi_sync_rows: taxiVerificationRows.length ? taxiVerificationRows : taxiRows,
                posted_xml: {
                  extensions: trimDiagText(safeStr(extensionsOut?.dataXml), 1200),
                  salary_adjustments: trimDiagText(safeStr(salaryAdjOut?.dataXml), 1200),
                },
              },
            };
            try {
              console.log("[TWB][accept][debug]", JSON.stringify(acceptDebug));
            } catch (_) {
              // noop
            }
          }

          if (action === "ACCEPT" && (!salaryAdjOut.ok || !extensionsOut.ok)) {
            if (acceptOutboxId) {
              await writeOutboxRow({
                mode: "update",
                leagueId,
                season,
                where: { id: acceptOutboxId },
                row: {
                  trade_id: mflTradeId,
                  action_type: "ACCEPT",
                  from_franchise_id: resolvedOfferFromFranchiseId,
                  to_franchise_id: resolvedOfferToFranchiseId,
                  payload_xml_extensions: acceptIntentBundle.payload_xml_extensions,
                  payload_xml_salary_adj: acceptIntentBundle.payload_xml_salary_adj,
                  payload_xml_salary_trade: acceptIntentBundle.payload_xml_salary_trade,
                  payload_json: payload || null,
                  comment_trailer: acceptIntentBundle.comment_trailer,
                  payload_hash: acceptIntentBundle.payload_hash,
                  status: "FAILED",
                  mfl_post_response_snip: trimDiagText(
                    JSON.stringify({
                      trade_response: responseImport?.upstreamPreview || "",
                      salary: salaryAdjOut?.upstreamPreview || salaryAdjOut?.error || "",
                      extensions: extensionsOut?.upstreamPreview || extensionsOut?.error || "",
                    }),
                    1000
                  ),
                  mfl_verify_response_snip: trimDiagText(
                    JSON.stringify({
                      transactions_export: postVerifyTransactions || null,
                      salaries_export: postVerifySalaries || null,
                    }),
                    1000
                  ),
                },
              });
            }
            const counterpartyFromPayload = padFranchiseId(
              payload?.ui?.left_team_id === actingFranchiseId
                ? payload?.ui?.right_team_id
                : payload?.ui?.left_team_id
            );
            const diagnostics = buildSalaryContractImportFailureDiagnostics({
              leagueId,
              season,
              actingFranchiseId,
              counterpartyFranchiseId: counterpartyFromPayload,
              action,
              tradeId: mflTradeId,
              payload,
              salaryAdjustments: salaryAdjOut,
              extensions: extensionsOut,
              taxiSync: taxiSyncOut,
            });
            try {
              console.error("[TWB][postAcceptImport][error]", JSON.stringify(diagnostics));
            } catch (_) {
              console.error("[TWB][postAcceptImport][error]", diagnostics);
            }
            return jsonOut(502, {
              ok: false,
              mode: "direct_mfl",
              action,
              error_type: "salary_contract_import_failure",
              error: "Salary/contract import failed after MFL trade response.",
              diagnostics,
              response: {
                upstream_status: responseImport.status,
                upstream_preview: responseImport.upstreamPreview,
                target_import_url: responseImport.targetImportUrl,
                form_fields: responseImport.formFields,
              },
              salary_adjustments: salaryAdjOut,
              extensions: extensionsOut,
              taxi_sync: taxiSyncOut,
              extension_preparation: extensionPreparation,
              accept_debug: acceptDebug,
              outbox: {
                outbox_id: acceptOutboxId || "",
                payload_hash: safeStr(acceptIntentBundle.payload_hash),
                backend: acceptOutboxBackend || "",
                status: acceptOutboxId ? "FAILED" : "NOT_PERSISTED",
                write_error: acceptOutboxWriteError || "",
              },
              post_verify: {
                transactions_export: postVerifyTransactions,
                salaries_export: postVerifySalaries,
              },
            });
          }

          const acceptVerified =
            action === "ACCEPT"
              ? (
                  !!salaryAdjOut?.ok &&
                  !(extensionsOut && extensionsOut.verification_ok === false) &&
                  !!(taxiSyncOut?.skipped || taxiSyncOut?.ok)
                )
              : true;
          const acceptOutboxStatus = acceptVerified ? "VERIFIED" : "POSTED";

          if (action === "ACCEPT" && acceptOutboxId) {
            await writeOutboxRow({
              mode: "update",
              leagueId,
              season,
              where: { id: acceptOutboxId },
              row: {
                trade_id: mflTradeId,
                action_type: "ACCEPT",
                from_franchise_id: resolvedOfferFromFranchiseId,
                to_franchise_id: resolvedOfferToFranchiseId,
                payload_xml_extensions: acceptIntentBundle.payload_xml_extensions,
                payload_xml_salary_adj: acceptIntentBundle.payload_xml_salary_adj,
                payload_xml_salary_trade: acceptIntentBundle.payload_xml_salary_trade,
                payload_json: payload || null,
                comment_trailer: acceptIntentBundle.comment_trailer,
                payload_hash: acceptIntentBundle.payload_hash,
                status: acceptOutboxStatus,
                mfl_post_response_snip: trimDiagText(
                  JSON.stringify({
                    trade_response: responseImport?.upstreamPreview || "",
                    salary: salaryAdjOut?.upstreamPreview || salaryAdjOut?.error || "",
                    extensions: extensionsOut?.upstreamPreview || extensionsOut?.error || "",
                  }),
                  1000
                ),
                mfl_verify_response_snip: trimDiagText(
                  JSON.stringify({
                    transactions_export: postVerifyTransactions || null,
                    salaries_export: postVerifySalaries || null,
                  }),
                  1000
                ),
              },
            });
          }

          return jsonOut(200, {
            ok: true,
            mode: "direct_mfl",
            action,
            trade_id: mflTradeId,
            response: {
              upstream_status: responseImport.status,
              upstream_preview: responseImport.upstreamPreview,
              target_import_url: responseImport.targetImportUrl,
              form_fields: responseImport.formFields,
            },
            salary_adjustments: salaryAdjOut,
            extensions: extensionsOut,
            taxi_sync: taxiSyncOut,
            extension_preparation: extensionPreparation,
            accept_debug: acceptDebug,
            outbox: {
              outbox_id: acceptOutboxId || "",
              payload_hash: safeStr(acceptIntentBundle.payload_hash),
              backend: acceptOutboxBackend || "",
              status: acceptOutboxId ? acceptOutboxStatus : "NOT_PERSISTED",
              write_error: acceptOutboxWriteError || "",
            },
            post_verify: {
              transactions_export: postVerifyTransactions,
              salaries_export: postVerifySalaries,
            },
          });
        }

        if (!offerId) return jsonOut(400, { ok: false, error: "offer_id is required" });
        if (!["ACCEPT", "REJECT", "COUNTER"].includes(action)) {
          return jsonOut(400, { ok: false, error: "action must be ACCEPT, REJECT, or COUNTER" });
        }

        let saveOut = null;
        let updatedOffer = null;
        let counterOffer = null;
        let attempts = 0;

        while (attempts < 2) {
          attempts += 1;
          const loaded = await readTradeOffersDoc(leagueId, season);
          if (!loaded.ok) {
            return jsonOut(500, {
              ok: false,
              error: loaded.error || "Failed to load trade offers store",
              storage_path: loaded.filePath || tradeOffersFilePath(leagueId, season),
            });
          }
          const doc = normalizeTradeOffersDoc(loaded.doc, leagueId, season);
          const offers = Array.isArray(doc.offers) ? doc.offers : [];
          const idx = offers.findIndex((o) => safeStr(o?.id) === offerId);
          if (idx === -1) return jsonOut(404, { ok: false, error: "Offer not found" });

          const nowIso = new Date().toISOString();
          const target = offers[idx];
          target.status = offerStatusNormalized(target.status, "PENDING");

          if (target.status !== "PENDING") {
            return jsonOut(409, {
              ok: false,
              error: `Offer is already ${target.status}`,
              offer: sanitizeOfferForList(target, false),
            });
          }

          if (actingFranchiseId && action !== "COUNTER") {
            const recipientId = padFranchiseId(target.to_franchise_id);
            if (recipientId && actingFranchiseId !== recipientId) {
              return jsonOut(403, { ok: false, error: "Only the recipient team can accept/reject this offer" });
            }
          }

          if (action === "ACCEPT" || action === "REJECT") {
            target.status = action === "ACCEPT" ? "ACCEPTED" : "REJECTED";
            target.updated_at = nowIso;
            target.acted_at = nowIso;
            if (actingFranchiseId) target.acted_by_franchise_id = actingFranchiseId;
            if (actionMessage) target.action_message = actionMessage;
            updatedOffer = { ...target };
          } else if (action === "COUNTER") {
            const counter = body?.counter_offer && typeof body.counter_offer === "object" ? body.counter_offer : {};
            const counterPayload =
              counter?.payload && typeof counter.payload === "object"
                ? counter.payload
                : body?.payload && typeof body.payload === "object"
                  ? body.payload
                  : null;
            const validationStatus = safeStr(counterPayload?.validation?.status).toLowerCase();
            const fromFranchiseId = padFranchiseId(
              counter?.from_franchise_id || counterPayload?.ui?.left_team_id || actingFranchiseId || ""
            );
            const toFranchiseId = padFranchiseId(
              counter?.to_franchise_id || counterPayload?.ui?.right_team_id || target.from_franchise_id || ""
            );
            const fromFranchiseName = safeStr(counter?.from_franchise_name);
            const toFranchiseName = safeStr(counter?.to_franchise_name);
            const counterMessage = safeStr(counter?.message || actionMessage).slice(0, 2000);

            if (!counterPayload) return jsonOut(400, { ok: false, error: "counter_offer.payload is required" });
            if (validationStatus && validationStatus !== "ready") {
              return jsonOut(400, { ok: false, error: "Counter payload is not ready" });
            }
            if (!fromFranchiseId || !toFranchiseId) {
              return jsonOut(400, { ok: false, error: "Counter offer team ids are required" });
            }
            if (fromFranchiseId === toFranchiseId) {
              return jsonOut(400, { ok: false, error: "Counter offer teams must be different" });
            }
            if (actingFranchiseId && actingFranchiseId !== padFranchiseId(target.to_franchise_id)) {
              return jsonOut(403, { ok: false, error: "Only the recipient team can counter this offer" });
            }

            const rootId = safeStr(target.thread_root_offer_id || target.id);
            counterOffer = {
              id: `TWB-${(crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).toString()}`,
              league_id: leagueId,
              season: safeInt(season, Number(season) || 0),
              status: "PENDING",
              created_at: nowIso,
              updated_at: nowIso,
              from_franchise_id: fromFranchiseId,
              to_franchise_id: toFranchiseId,
              from_franchise_name: fromFranchiseName || fromFranchiseId,
              to_franchise_name: toFranchiseName || toFranchiseId,
              message: counterMessage,
              source: safeStr(counter?.source || body?.source || "trade-workbench-ui-counter"),
              summary: summarizeOfferPayload(counterPayload),
              payload: counterPayload,
              counter_of_offer_id: target.id,
              thread_root_offer_id: rootId,
            };

            target.status = "COUNTERED";
            target.updated_at = nowIso;
            target.acted_at = nowIso;
            if (actingFranchiseId) target.acted_by_franchise_id = actingFranchiseId;
            target.counter_offer_id = counterOffer.id;
            if (counterMessage) target.action_message = counterMessage;
            if (!safeStr(target.thread_root_offer_id)) target.thread_root_offer_id = rootId;
            offers.push(counterOffer);
            updatedOffer = { ...target };
          }

          saveOut = await writeTradeOffersDoc(
            leagueId,
            season,
            doc,
            loaded.sha,
            `feat(trades): ${action.toLowerCase()} trade offer ${offerId}`
          );
          if (saveOut.ok) break;
          if (attempts >= 2) break;
        }

        if (!saveOut || !saveOut.ok) {
          return jsonOut(500, {
            ok: false,
            error: saveOut?.error || "Failed to update trade offer",
            storage_path: saveOut?.filePath || tradeOffersFilePath(leagueId, season),
            upstreamStatus: saveOut?.upstreamStatus || 0,
            upstreamPreview: saveOut?.upstreamPreview || "",
          });
        }

        const savedDoc = saveOut.doc || emptyTradeOffersDoc(leagueId, season);
        const allOffers = Array.isArray(savedDoc.offers) ? savedDoc.offers : [];
        return jsonOut(200, {
          ok: true,
          action,
          offer: sanitizeOfferForList(updatedOffer, true),
          counter_offer: counterOffer ? sanitizeOfferForList(counterOffer, true) : null,
          storage_path: saveOut.filePath,
          storage_commit_sha: saveOut.commitSha || "",
          counts: {
            total: allOffers.length,
            pending: allOffers.filter((o) => offerStatusNormalized(o?.status, "PENDING") === "PENDING").length,
          },
        });
      }

      if ((path === "/trade-outbox" || path === "/api/trades/outbox") && request.method === "GET") {
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || "");
        const outboxId = safeStr(url.searchParams.get("OUTBOX_ID") || url.searchParams.get("outbox_id"));
        const tradeId = safeStr(url.searchParams.get("TRADE_ID") || url.searchParams.get("trade_id")).replace(/\D/g, "");
        const payloadHash = safeStr(url.searchParams.get("PAYLOAD_HASH") || url.searchParams.get("payload_hash"));
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L param" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR param" });
        const lookup = await findOutboxRow({
          leagueId,
          season,
          id: outboxId,
          tradeId,
          payloadHash,
        });
        if (!lookup.ok) {
          return jsonOut(500, { ok: false, error: lookup.error || "outbox lookup failed", backend: lookup.backend || "" });
        }
        return jsonOut(200, {
          ok: true,
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          backend: lookup.backend || "",
          row: lookup.row || null,
        });
      }

      if ((path === "/trade-outbox/replay" || path === "/api/trades/outbox/replay") && request.method === "POST") {
        let body = null;
        try {
          body = await request.json();
        } catch (_) {
          return jsonOut(400, { ok: false, error: "Invalid JSON payload." });
        }
        const leagueId = safeStr(body?.league_id || L || "");
        const season = safeStr(body?.season || YEAR || "");
        const outboxId = safeStr(body?.outbox_id);
        const tradeId = safeStr(body?.trade_id || body?.mfl_trade_id || "").replace(/\D/g, "");
        const payloadHash = safeStr(body?.payload_hash);
        if (!leagueId) return jsonOut(400, { ok: false, error: "league_id is required" });
        if (!season) return jsonOut(400, { ok: false, error: "season is required" });
        if (!outboxId && !tradeId && !payloadHash) {
          return jsonOut(400, {
            ok: false,
            error: "One of outbox_id, trade_id, or payload_hash is required",
          });
        }
        const lookup = await findOutboxRow({
          leagueId,
          season,
          id: outboxId,
          tradeId,
          payloadHash,
        });
        if (!lookup.ok) {
          return jsonOut(500, {
            ok: false,
            error: lookup.error || "outbox lookup failed",
            backend: lookup.backend || "",
          });
        }
        const row = lookup.row ? normalizeOutboxRow(lookup.row) : null;
        if (!row) {
          return jsonOut(404, {
            ok: false,
            error: "Outbox row not found",
            league_id: leagueId,
            season: safeInt(season, Number(season) || 0),
          });
        }
        if (!cookieHeader) {
          return jsonOut(500, { ok: false, error: "Missing MFL_COOKIE worker secret for replay" });
        }

        const replayImports = [];
        const runReplayImport = async (step, fields, fallbackGetFields = fields) => {
          const importRes = await postMflImportForm(
            season,
            fields,
            fallbackGetFields
          );
          replayImports.push({
            step,
            ok: !!importRes.requestOk,
            status: importRes.status,
            target_import_url: importRes.targetImportUrl,
            preview: trimDiagText(importRes.upstreamPreview || importRes.error || "", 500),
          });
          return importRes;
        };

        let salaryAdjXml = safeStr(row.payload_xml_salary_adj);
        let salaryTradeXml = safeStr(row.payload_xml_salary_trade);
        let extensionXml = safeStr(row.payload_xml_extensions);
        if (row.payload_json && (!salaryAdjXml || !extensionXml)) {
          const rebuilt = await buildTradeIntentBundleFromPayload({
            leagueId,
            season,
            tradeId: safeStr(row.trade_id || tradeId),
            actionType: safeStr(row.action_type || "ACCEPT"),
            fromFranchiseId: safeStr(row.from_franchise_id),
            toFranchiseId: safeStr(row.to_franchise_id),
            payload: row.payload_json,
            commentTrailerHint: safeStr(row.comment_trailer),
          });
          if (!salaryAdjXml) salaryAdjXml = safeStr(rebuilt.payload_xml_salary_adj);
          if (!salaryTradeXml) salaryTradeXml = safeStr(rebuilt.payload_xml_salary_trade);
          if (!extensionXml) extensionXml = safeStr(rebuilt.payload_xml_extensions);
        }

        const expectedExtensionRows = parseExpectedExtensionRowsFromXml(extensionXml);
        const expectedSalaryAdjRows = parseExpectedSalaryAdjRowsFromXml(salaryAdjXml).concat(
          parseExpectedSalaryAdjRowsFromXml(salaryTradeXml)
        );
        const needsPrivilegedImports =
          expectedExtensionRows.length > 0 || expectedSalaryAdjRows.length > 0;
        let replayAdminState = { ok: true, isAdmin: true, reason: "not_checked" };
        if (needsPrivilegedImports) {
          replayAdminState = await getLeagueAdminState(leagueId, season);
        }
        if (needsPrivilegedImports && (!replayAdminState.ok || !replayAdminState.isAdmin)) {
          const adminReason = safeStr(replayAdminState.reason || "requires_commish_cookie");
          const updateNoAdmin = await writeOutboxRow({
            mode: "update",
            leagueId,
            season,
            where: { id: row.id },
            row: {
              trade_id: safeStr(row.trade_id || tradeId),
              action_type: safeStr(row.action_type || "ACCEPT"),
              from_franchise_id: safeStr(row.from_franchise_id),
              to_franchise_id: safeStr(row.to_franchise_id),
              payload_xml_extensions: extensionXml,
              payload_xml_salary_adj: salaryAdjXml,
              payload_xml_salary_trade: salaryTradeXml,
              payload_json: row.payload_json || null,
              comment_trailer: safeStr(row.comment_trailer),
              payload_hash: safeStr(row.payload_hash),
              status: "FAILED",
              mfl_post_response_snip: trimDiagText(
                JSON.stringify({
                  reason: "requires_commish_cookie",
                  admin_state: replayAdminState,
                }),
                1000
              ),
              mfl_verify_response_snip: trimDiagText(
                JSON.stringify({
                  expected_extensions: expectedExtensionRows.length,
                  expected_salary_adjustments: expectedSalaryAdjRows.length,
                }),
                1000
              ),
            },
          });
          return jsonOut(412, {
            ok: false,
            error_type: "requires_commish_cookie",
            error: "MFL_COOKIE lacks commissioner privileges required for replay imports",
            admin_state: replayAdminState,
            expected: {
              extensions: expectedExtensionRows.length,
              salary_adjustments: expectedSalaryAdjRows.length,
            },
            outbox: {
              outbox_id: safeStr(row.id),
              payload_hash: safeStr(row.payload_hash),
              status: "FAILED",
              backend: updateNoAdmin.backend || lookup.backend || "",
              write_error: updateNoAdmin.ok ? "" : safeStr(updateNoAdmin.error),
            },
          });
        }

        if (salaryAdjXml) {
          await runReplayImport(
            "salary_adjustments",
            { TYPE: "salaryAdj", L: leagueId, DATA: salaryAdjXml },
            { TYPE: "salaryAdj", L: leagueId }
          );
        }
        if (salaryTradeXml) {
          await runReplayImport(
            "salary_trade",
            { TYPE: "salaryAdj", L: leagueId, DATA: salaryTradeXml },
            { TYPE: "salaryAdj", L: leagueId }
          );
        }
        if (extensionXml) {
          await runReplayImport(
            "extensions",
            { TYPE: "salaries", L: leagueId, APPEND: "1", DATA: extensionXml },
            { TYPE: "salaries", L: leagueId, APPEND: "1" }
          );
        }

        const allPostsOk = replayImports.every((r) => !!r.ok);
        const verifySalaries = await mflExportJson(season, leagueId, "salaries", {}, { useCookie: true });
        const verifySalaryAdjustments = await mflExportJson(
          season,
          leagueId,
          "salaryAdjustments",
          {},
          { useCookie: true }
        );
        const verifyTransactions = await mflExportJson(season, leagueId, "transactions", {}, { useCookie: true });
        let extensionVerification = {
          ok: expectedExtensionRows.length === 0,
          reason: expectedExtensionRows.length ? "verification_not_run" : "no_expected_extension_rows",
          checked_players: 0,
          matched_players: 0,
          mismatched_players: 0,
          rows: [],
        };
        if (expectedExtensionRows.length && verifySalaries.ok) {
          const afterByPlayer = parseSalariesExportByPlayer(verifySalaries.data);
          extensionVerification = buildExtensionPostImportVerification({}, expectedExtensionRows, afterByPlayer);
        } else if (expectedExtensionRows.length && !verifySalaries.ok) {
          extensionVerification = {
            ok: false,
            reason: "failed_post_import_salaries_export",
            checked_players: 0,
            matched_players: 0,
            mismatched_players: expectedExtensionRows.length,
            rows: [],
          };
        }

        let salaryAdjustmentVerification = {
          ok: expectedSalaryAdjRows.length === 0,
          reason: expectedSalaryAdjRows.length ? "verification_not_run" : "no_expected_salary_adjustments",
          expected_count: expectedSalaryAdjRows.length,
          matched_count: 0,
          mismatched_count: expectedSalaryAdjRows.length,
          rows: [],
        };
        if (expectedSalaryAdjRows.length && verifySalaryAdjustments.ok) {
          salaryAdjustmentVerification = verifyExpectedSalaryAdjustmentsInExport(
            expectedSalaryAdjRows,
            verifySalaryAdjustments.data
          );
          salaryAdjustmentVerification.reason = salaryAdjustmentVerification.ok
            ? ""
            : "expected_salary_adjustments_missing_from_export";
        } else if (expectedSalaryAdjRows.length && !verifySalaryAdjustments.ok) {
          salaryAdjustmentVerification = {
            ok: false,
            reason: "failed_post_import_salary_adjustments_export",
            expected_count: expectedSalaryAdjRows.length,
            matched_count: 0,
            mismatched_count: expectedSalaryAdjRows.length,
            rows: [],
          };
        }

        const verifyOk =
          !!verifySalaries.ok &&
          !!verifyTransactions.ok &&
          !!verifySalaryAdjustments.ok &&
          !!extensionVerification.ok &&
          !!salaryAdjustmentVerification.ok;
        const nextStatus = allPostsOk && verifyOk ? "VERIFIED" : "FAILED";

        const updateReplay = await writeOutboxRow({
          mode: "update",
          leagueId,
          season,
          where: { id: row.id },
          row: {
            trade_id: safeStr(row.trade_id || tradeId),
            action_type: safeStr(row.action_type || "ACCEPT"),
            from_franchise_id: safeStr(row.from_franchise_id),
            to_franchise_id: safeStr(row.to_franchise_id),
            payload_xml_extensions: extensionXml,
            payload_xml_salary_adj: salaryAdjXml,
            payload_xml_salary_trade: salaryTradeXml,
            payload_json: row.payload_json || null,
            comment_trailer: safeStr(row.comment_trailer),
            payload_hash: safeStr(row.payload_hash),
            status: nextStatus,
            mfl_post_response_snip: trimDiagText(JSON.stringify(replayImports), 1000),
            mfl_verify_response_snip: trimDiagText(
              JSON.stringify({
                salaries_status: verifySalaries.status,
                salaries_ok: !!verifySalaries.ok,
                salary_adjustments_status: verifySalaryAdjustments.status,
                salary_adjustments_ok: !!verifySalaryAdjustments.ok,
                transactions_status: verifyTransactions.status,
                transactions_ok: !!verifyTransactions.ok,
                extension_verification: extensionVerification,
                salary_adjustment_verification: salaryAdjustmentVerification,
              }),
              1000
            ),
          },
        });

        return jsonOut(200, {
          ok: nextStatus === "VERIFIED",
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          outbox: {
            outbox_id: safeStr(row.id),
            payload_hash: safeStr(row.payload_hash),
            status: nextStatus,
            backend: safeStr(updateReplay.backend || lookup.backend || ""),
            write_error: updateReplay.ok ? "" : safeStr(updateReplay.error),
          },
          replay_imports: replayImports,
          verify: {
            salaries_export: {
              ok: !!verifySalaries.ok,
              status: verifySalaries.status,
              error: verifySalaries.error || "",
              preview: verifySalaries.textPreview || "",
            },
            salary_adjustments_export: {
              ok: !!verifySalaryAdjustments.ok,
              status: verifySalaryAdjustments.status,
              error: verifySalaryAdjustments.error || "",
              preview: verifySalaryAdjustments.textPreview || "",
            },
            transactions_export: {
              ok: !!verifyTransactions.ok,
              status: verifyTransactions.status,
              error: verifyTransactions.error || "",
              preview: verifyTransactions.textPreview || "",
            },
            extension_verification: extensionVerification,
            salary_adjustment_verification: salaryAdjustmentVerification,
          },
        });
      }

      if (
        (path === "/reconcile/extensions" || path === "/api/trades/reconcile/extensions") &&
        (request.method === "GET" || request.method === "POST")
      ) {
        let body = {};
        if (request.method === "POST") {
          try {
            body = (await request.json()) || {};
          } catch (_) {
            body = {};
          }
        }
        const leagueId = safeStr(body?.league_id || body?.L || url.searchParams.get("L") || L || "");
        const season = safeStr(body?.season || body?.YEAR || url.searchParams.get("YEAR") || YEAR || "");
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L/league_id param" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR/season param" });

        const limit = Math.max(
          1,
          Math.min(100, safeInt(body?.limit || url.searchParams.get("limit"), 25))
        );
        const sinceDays = Math.max(
          1,
          Math.min(120, safeInt(body?.since_days || url.searchParams.get("since_days"), 30))
        );
        const statusesInput = Array.isArray(body?.statuses)
          ? body.statuses
          : safeStr(url.searchParams.get("statuses")).split(",");
        const statuses = Array.from(
          new Set(
            statusesInput
              .map((v) => offerStatusNormalized(v, ""))
              .filter(Boolean)
          )
        );
        const statusSet = new Set(statuses.length ? statuses : ["FAILED", "POSTED"]);
        const cutoffMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

        const listOut = await listOutboxRows({
          leagueId,
          season,
          limit: Math.max(100, limit * 4),
        });
        if (!listOut.ok) {
          return jsonOut(500, {
            ok: false,
            error: listOut.error || "failed_to_list_outbox_rows",
            backend: listOut.backend || "",
          });
        }
        const allRows = Array.isArray(listOut.rows) ? listOut.rows : [];
        const candidates = allRows.filter((row) => {
          const actionType = offerStatusNormalized(row?.action_type, "");
          if (actionType !== "ACCEPT") return false;
          const status = offerStatusNormalized(row?.status, "");
          if (statusSet.size && !statusSet.has(status)) return false;
          const tsRaw = safeStr(row?.updated_ts || row?.created_ts);
          const tsMs = tsRaw ? Date.parse(tsRaw) : NaN;
          if (Number.isFinite(tsMs) && tsMs < cutoffMs) return false;
          const hasExtXml = !!safeStr(row?.payload_xml_extensions);
          const hasExtPayload =
            !!(row?.payload_json && Array.isArray(row.payload_json.extension_requests) && row.payload_json.extension_requests.length);
          return hasExtXml || hasExtPayload;
        });

        const selected = candidates.slice(0, limit);
        const replayUrl = new URL("/trade-outbox/replay", url.origin).toString();
        const results = [];
        let replayOk = 0;
        let replayFailed = 0;
        for (const row of selected) {
          const replayBody = {
            league_id: leagueId,
            season,
            outbox_id: safeStr(row?.id),
            trade_id: safeStr(row?.trade_id),
            payload_hash: safeStr(row?.payload_hash),
          };
          try {
            const replayRes = await fetch(replayUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(replayBody),
              cf: { cacheTtl: 0, cacheEverything: false },
            });
            const replayText = await replayRes.text();
            let replayJson = null;
            try {
              replayJson = replayText ? JSON.parse(replayText) : null;
            } catch (_) {
              replayJson = null;
            }
            const ok = !!replayRes.ok && !!(replayJson && replayJson.ok);
            if (ok) replayOk += 1;
            else replayFailed += 1;
            results.push({
              outbox_id: safeStr(row?.id),
              trade_id: safeStr(row?.trade_id),
              payload_hash: safeStr(row?.payload_hash),
              status_before: offerStatusNormalized(row?.status, ""),
              ok,
              replay_http_status: replayRes.status,
              replay_status: safeStr(replayJson?.outbox?.status),
              replay_error: safeStr(replayJson?.error || replayJson?.reason || ""),
              replay_verify: replayJson?.verify || null,
              replay_preview: ok ? "" : trimDiagText(replayText, 500),
            });
          } catch (e) {
            replayFailed += 1;
            results.push({
              outbox_id: safeStr(row?.id),
              trade_id: safeStr(row?.trade_id),
              payload_hash: safeStr(row?.payload_hash),
              status_before: offerStatusNormalized(row?.status, ""),
              ok: false,
              replay_http_status: 0,
              replay_status: "",
              replay_error: `fetch_failed: ${e?.message || String(e)}`,
              replay_verify: null,
              replay_preview: "",
            });
          }
        }

        return jsonOut(200, {
          ok: replayFailed === 0,
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          since_days: sinceDays,
          status_filter: Array.from(statusSet.values()),
          counts: {
            outbox_rows_scanned: allRows.length,
            candidate_rows: candidates.length,
            replay_attempted: selected.length,
            replay_ok: replayOk,
            replay_failed: replayFailed,
          },
          results,
          generated_at: new Date().toISOString(),
        });
      }

      if (path === "/acquisition-hub/bootstrap" && request.method === "GET") {
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || "");
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        if (!leagueId) return jsonNoStore(400, { ok: false, error: "Missing L param" });
        const cacheKey = `acq:bootstrap:${season}:${leagueId}`;
        const cached = acqCacheGet(cacheKey, 60000);
        if (cached) {
          const copy = JSON.parse(JSON.stringify(cached));
          copy.source_age_seconds = Math.max(0, Math.round((Date.now() - Date.parse(copy.fetched_at || new Date().toISOString())) / 1000));
          return jsonNoStore(200, copy);
        }
        const [teamsSnapshot, adminState, manifestRes, calendarRes] = await Promise.all([
          buildLiveTeamsSnapshot(season, leagueId),
          getLeagueAdminState(leagueId, season),
          fetchArtifactJson("manifest"),
          fetchLeagueCalendarAcq(season, leagueId),
        ]);
        const rookieDraftEvent = teamsSnapshot.ok
          ? findRookieDraftCalendarEventAcq(calendarRes.ok ? calendarRes.data : {}, teamsSnapshot.leagueRes?.data || {})
          : null;
        const rookieRefreshPlan = deriveRookieDraftRefreshPlanAcq(rookieDraftEvent, null);
        const payload = {
          ok: true,
          league: {
            league_id: leagueId,
            season: safeInt(season, Number(season) || 0),
            salary_cap_dollars: teamsSnapshot.ok ? safeInt(teamsSnapshot.salaryCapDollars, 0) : 0,
            franchises: teamsSnapshot.ok ? teamsSnapshot.franchises : [],
          },
          viewer: {
            franchise_id: teamsSnapshot.ok ? safeStr(teamsSnapshot.viewerFranchiseId) : "",
            is_commish: !!(adminState && adminState.ok && adminState.isAdmin),
            commish_franchise_id: safeStr(adminState && adminState.commishFranchiseId),
            admin_reason: safeStr(adminState && adminState.reason),
          },
          rules: readAcquisitionRules(),
          feature_flags: {
            waiver_lab_enabled: false,
            live_actions_enabled: true,
          },
          draft_events: {
            rookie_draft: rookieRefreshPlan.draft_event,
          },
          native_links: {
            rookie_draft: `https://www48.myfantasyleague.com/${encodeURIComponent(String(season))}/live_draft?L=${encodeURIComponent(leagueId)}`,
            free_agent_auction: `https://www48.myfantasyleague.com/${encodeURIComponent(String(season))}/options?L=${encodeURIComponent(leagueId)}&O=43`,
            expired_rookie_auction: `https://www48.myfantasyleague.com/${encodeURIComponent(String(season))}/options?L=${encodeURIComponent(leagueId)}&O=43`,
            waivers: `https://www48.myfantasyleague.com/${encodeURIComponent(String(season))}/add_drop?L=${encodeURIComponent(leagueId)}`,
          },
          refresh_policy: {
            bootstrap_ms: 60000,
            rookie_draft_live_ms: safeInt(rookieRefreshPlan.next_refresh_recommended_ms, 60000),
            rookie_draft_hidden_ms: safeInt(rookieRefreshPlan.hidden_refresh_recommended_ms, 300000),
            free_agent_auction_live_ms: 20000,
            expired_rookie_live_ms: 30000,
          },
          fetched_at: new Date().toISOString(),
          source_age_seconds: 0,
          stale: !teamsSnapshot.ok,
          artifacts: manifestRes.ok ? manifestRes.data : null,
        };
        acqCacheSet(cacheKey, payload);
        return jsonNoStore(200, payload);
      }

      if (path === "/acquisition-hub/rookie-draft/live" && request.method === "GET") {
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || "");
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        if (!leagueId) return jsonNoStore(400, { ok: false, error: "Missing L param" });
        const disableCache = safeStr(url.searchParams.get("NO_CACHE")) === "1";
        const cacheKey = `acq:rookie-live:${season}:${leagueId}`;
        if (!disableCache) {
          const cached = acqCacheGet(cacheKey, 5000);
          if (cached) {
            const copy = JSON.parse(JSON.stringify(cached));
            copy.source_age_seconds = Math.max(0, Math.round((Date.now() - Date.parse(copy.fetched_at || new Date().toISOString())) / 1000));
            copy.stale = copy.source_age_seconds > 10 ? true : !!copy.stale;
            return jsonNoStore(200, copy);
          }
        }
        const payload = await buildRookieDraftLivePayload(season, leagueId);
        acqCacheSet(cacheKey, payload);
        return jsonNoStore(200, payload);
      }

      if (path === "/acquisition-hub/rookie-draft/history" && request.method === "GET") {
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || "");
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        const seasonContext = safeStr(url.searchParams.get("season_context") || "all");
        const artifact = await fetchArtifactJson("rookie_draft_history");
        if (!artifact.ok) return jsonNoStore(502, { ok: false, error: artifact.error, url: artifact.url });
        const filtered = filterRookieHistoryArtifactAcq(artifact.data || {}, seasonContext);
        let franchiseMap = {};
        if (leagueId) {
          const teamsSnapshot = await buildLiveTeamsSnapshot(season, leagueId);
          franchiseMap = teamsSnapshot.ok ? teamsSnapshot.franchiseMap || {} : {};
        }
        return jsonNoStore(200, {
          ok: true,
          generated_at: safeStr(filtered?.meta?.generated_at),
          ...filtered,
          current_order: overlayFranchiseBrandingAcq(filtered.current_order, franchiseMap),
          history_rows: overlayFranchiseBrandingAcq(filtered.history_rows, franchiseMap),
          owner_summary_rows: overlayFranchiseBrandingAcq(filtered.owner_summary_rows, franchiseMap),
          top_hits: overlayFranchiseBrandingAcq(filtered.top_hits, franchiseMap),
        });
      }

      if (path === "/acquisition-hub/rookie-draft/action" && request.method === "POST") {
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || "");
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        if (!leagueId) return jsonNoStore(400, { ok: false, error: "Missing L param" });
        let body = {};
        try {
          body = (await request.json()) || {};
        } catch (_) {
          body = {};
        }
        const actionRes = await performRookieDraftAction(season, leagueId, body);
        if (!actionRes.ok) {
          return jsonNoStore(actionRes.status >= 400 ? actionRes.status : 502, {
            ok: false,
            error: actionRes.error,
            preview: actionRes.preview || "",
            url: actionRes.url || "",
          });
        }
        acqCacheBustPrefix(`acq:rookie-live:${season}:${leagueId}`);
        acqCacheBustPrefix(`acq:rookiexml:${season}:${leagueId}`);
        const rookieArtifact = await fetchArtifactJson("rookie_draft_history");
        let live = await buildRookieDraftLivePayload(season, leagueId);
        let liveBoard = asArray(live?.live_board);
        let draftedRow = liveBoard.find((row) => safeStr(row?.player_id) === safeStr(body?.player_id || body?.playerId)) || null;
        if (safeStr(body?.action).toLowerCase() === "draft" && !draftedRow && safeStr(body?.player_id || body?.playerId)) {
          for (let attempt = 0; attempt < 2 && !draftedRow; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            acqCacheBustPrefix(`acq:rookiexml:${season}:${leagueId}`);
            live = await buildRookieDraftLivePayload(season, leagueId);
            liveBoard = asArray(live?.live_board);
            draftedRow = liveBoard.find((row) => safeStr(row?.player_id) === safeStr(body?.player_id || body?.playerId)) || null;
          }
        }
        const contractApplyResult =
          safeStr(body?.action).toLowerCase() === "draft" && draftedRow
            ? await applyRookieContractForDraftPickAcq({
                season,
                leagueId,
                liveRow: draftedRow,
                fallbackRound: body?.round,
                fallbackPick: body?.pick,
                rookieArtifactData: rookieArtifact.ok ? rookieArtifact.data || {} : {},
              })
            : {
                ok: true,
                skipped: true,
                reason: "no_contract_apply_required",
                status_label: "No contract import required for this action.",
              };
        const refreshedLive = await buildRookieDraftLivePayload(season, leagueId);
        acqCacheSet(`acq:rookie-live:${season}:${leagueId}`, refreshedLive);
        return jsonNoStore(200, {
          ok: true,
          message: "Rookie draft action submitted.",
          action_result: {
            status: actionRes.status,
            url: actionRes.url || "",
            preview: actionRes.preview || "",
          },
          contract_apply_result: contractApplyResult,
          live: refreshedLive,
        });
      }

      if (path === "/acquisition-hub/rookie-draft/reconcile-contracts" && request.method === "POST") {
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || "");
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        if (!leagueId) return jsonNoStore(400, { ok: false, error: "Missing L param" });
        const adminState = await getLeagueAdminState(leagueId, season);
        if (!adminState.ok || !adminState.isAdmin) {
          return jsonNoStore(403, { ok: false, error: "Only league admin can reconcile rookie draft contracts." });
        }
        const reconcile = await reconcileRookieDraftContractsAcq(season, leagueId);
        acqCacheBustPrefix(`acq:rookie-live:${season}:${leagueId}`);
        acqCacheBustPrefix(`acq:rookiexml:${season}:${leagueId}`);
        return jsonNoStore(200, {
          ok: !!reconcile.ok,
          message: reconcile.applied_count ? "Rookie contracts reconciled." : "No missing rookie contracts found.",
          ...reconcile,
        });
      }

      if (path === "/acquisition-hub/free-agent-auction/live" && request.method === "GET") {
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || "");
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        const franchiseId = padFranchiseId(url.searchParams.get("F") || url.searchParams.get("FRANCHISE_ID") || "");
        if (!leagueId) return jsonNoStore(400, { ok: false, error: "Missing L param" });
        const disableCache = safeStr(url.searchParams.get("NO_CACHE")) === "1";
        const cacheKey = `acq:auction-live:${season}:${leagueId}:free-agent:${franchiseId || "viewer"}`;
        if (!disableCache) {
          const cached = acqCacheGet(cacheKey, 15000);
          if (cached) {
            const copy = JSON.parse(JSON.stringify(cached));
            copy.source_age_seconds = Math.max(0, Math.round((Date.now() - Date.parse(copy.fetched_at || new Date().toISOString())) / 1000));
            copy.stale = copy.source_age_seconds > 40 ? true : !!copy.stale;
            return jsonNoStore(200, copy);
          }
        }
        const payload = await buildAuctionLivePayload(season, leagueId, franchiseId, "free-agent");
        acqCacheSet(cacheKey, payload);
        return jsonNoStore(payload.ok ? 200 : 502, payload);
      }

      if (path === "/acquisition-hub/free-agent-auction/history" && request.method === "GET") {
        const artifact = await fetchArtifactJson("free_agent_auction_history");
        if (!artifact.ok) return jsonNoStore(502, { ok: false, error: artifact.error, url: artifact.url });
        return jsonNoStore(200, {
          ok: true,
          generated_at: safeStr(artifact.data?.meta?.generated_at),
          ...artifact.data,
        });
      }

      if (path === "/acquisition-hub/free-agent-auction/action" && request.method === "POST") {
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || "");
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        if (!leagueId) return jsonNoStore(400, { ok: false, error: "Missing L param" });
        let body = {};
        try {
          body = (await request.json()) || {};
        } catch (_) {
          body = {};
        }
        const actionRes = await performAuctionAction(season, leagueId, body, "free-agent");
        if (!actionRes.ok) {
          return jsonNoStore(actionRes.status >= 400 ? actionRes.status : 502, {
            ok: false,
            error: actionRes.error,
            preview: actionRes.preview || "",
            native_link: actionRes.native_link || "",
          });
        }
        acqCacheBustPrefix(`acq:auction-live:${season}:${leagueId}:free-agent`);
        const live = await buildAuctionLivePayload(season, leagueId, body?.franchise_id || body?.franchiseId || "", "free-agent");
        acqCacheSet(`acq:auction-live:${season}:${leagueId}:free-agent:${padFranchiseId(body?.franchise_id || body?.franchiseId || "") || "viewer"}`, live);
        return jsonNoStore(200, {
          ok: true,
          message: "Auction action submitted.",
          action_result: {
            status: actionRes.status,
            preview: actionRes.preview || "",
            native_link: actionRes.native_link || "",
          },
          live,
        });
      }

      if (path === "/acquisition-hub/expired-rookie-auction/live" && request.method === "GET") {
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || "");
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        const franchiseId = padFranchiseId(url.searchParams.get("F") || url.searchParams.get("FRANCHISE_ID") || "");
        if (!leagueId) return jsonNoStore(400, { ok: false, error: "Missing L param" });
        const disableCache = safeStr(url.searchParams.get("NO_CACHE")) === "1";
        const cacheKey = `acq:auction-live:${season}:${leagueId}:expired-rookie:${franchiseId || "viewer"}`;
        if (!disableCache) {
          const cached = acqCacheGet(cacheKey, 30000);
          if (cached) {
            const copy = JSON.parse(JSON.stringify(cached));
            copy.source_age_seconds = Math.max(0, Math.round((Date.now() - Date.parse(copy.fetched_at || new Date().toISOString())) / 1000));
            copy.stale = copy.source_age_seconds > 60 ? true : !!copy.stale;
            return jsonNoStore(200, copy);
          }
        }
        const payload = await buildAuctionLivePayload(season, leagueId, franchiseId, "expired-rookie");
        acqCacheSet(cacheKey, payload);
        return jsonNoStore(payload.ok ? 200 : 502, payload);
      }

      if (path === "/acquisition-hub/expired-rookie-auction/history" && request.method === "GET") {
        const artifact = await fetchArtifactJson("expired_rookie_history");
        if (!artifact.ok) return jsonNoStore(502, { ok: false, error: artifact.error, url: artifact.url });
        return jsonNoStore(200, {
          ok: true,
          generated_at: safeStr(artifact.data?.meta?.generated_at),
          ...artifact.data,
        });
      }

      if (path === "/acquisition-hub/expired-rookie-auction/action" && request.method === "POST") {
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || "");
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        if (!leagueId) return jsonNoStore(400, { ok: false, error: "Missing L param" });
        let body = {};
        try {
          body = (await request.json()) || {};
        } catch (_) {
          body = {};
        }
        const actionRes = await performAuctionAction(season, leagueId, body, "expired-rookie");
        if (!actionRes.ok) {
          return jsonNoStore(actionRes.status >= 400 ? actionRes.status : 502, {
            ok: false,
            error: actionRes.error,
            preview: actionRes.preview || "",
            native_link: actionRes.native_link || "",
          });
        }
        acqCacheBustPrefix(`acq:auction-live:${season}:${leagueId}:expired-rookie`);
        const live = await buildAuctionLivePayload(season, leagueId, body?.franchise_id || body?.franchiseId || "", "expired-rookie");
        acqCacheSet(`acq:auction-live:${season}:${leagueId}:expired-rookie:${padFranchiseId(body?.franchise_id || body?.franchiseId || "") || "viewer"}`, live);
        return jsonNoStore(200, {
          ok: true,
          message: "Expired rookie auction action submitted.",
          action_result: {
            status: actionRes.status,
            preview: actionRes.preview || "",
            native_link: actionRes.native_link || "",
          },
          live,
        });
      }

      if (path === "/acquisition-hub/waivers" && request.method === "GET") {
        const artifact = await fetchArtifactJson("waiver_history");
        if (!artifact.ok) return jsonNoStore(502, { ok: false, error: artifact.error, url: artifact.url });
        return jsonNoStore(200, {
          ok: true,
          generated_at: safeStr(artifact.data?.meta?.generated_at),
          feature_enabled: false,
          ...artifact.data,
        });
      }

      if (path === "/acquisition-hub/admin/refresh" && request.method === "POST") {
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || "");
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        const adminState = await getLeagueAdminState(leagueId, season);
        if (!adminState.ok || !adminState.isAdmin) {
          return jsonNoStore(403, { ok: false, error: "admin_required" });
        }
        const dispatchOut = await dispatchRepoEvent("refresh-acquisition-hub", {
          season,
          league_id: leagueId,
          requested_at_utc: new Date().toISOString(),
          source: "worker-acquisition-hub",
        });
        return jsonNoStore(dispatchOut.ok ? 202 : 500, {
          ok: !!dispatchOut.ok,
          queued: !!dispatchOut.queued,
          reason: dispatchOut.reason || "",
          repo: dispatchOut.repo || "",
        });
      }

      if (path === "/roster-workbench" && request.method === "GET") {
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || "");
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L param" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR param" });

        const cacheKey = new Request(
          `https://upsmfl-roster-workbench.local/cache?L=${encodeURIComponent(leagueId)}&YEAR=${encodeURIComponent(season)}`,
          { method: "GET" }
        );
        const disableCache = safeStr(url.searchParams.get("NO_CACHE")) === "1";
        if (!disableCache) {
          try {
            const cached = await caches.default.match(cacheKey);
            if (cached) return cached;
          } catch (_) {}
        }

        const parseSalaryRows = (payload, rosteredPlayerIds) => {
          const out = {};
          const rosterSet = rosteredPlayerIds ? new Set(rosteredPlayerIds) : null;
          const rows = asArray(payload?.salaries?.leagueUnit?.player).filter(Boolean);
          for (const row of rows) {
            const pid = String(row?.id || "").replace(/\D/g, "");
            if (!pid || pid === "0000") continue;
            const contractYearRaw = safeStr(row?.contractYear);
            const contractYearInt = contractYearRaw ? safeInt(contractYearRaw, 0) : 0;
            // Skip players with no years remaining — expired/off-roster
            if (contractYearInt <= 0) continue;
            // Skip players not on any roster (salary ghost entries)
            if (rosterSet && !rosterSet.has(pid)) continue;
            const salaryRaw = safeStr(row?.salary);
            const contractStatusRaw = safeStr(row?.contractStatus);
            const contractInfoRaw = safeStr(row?.contractInfo);
            if (!salaryRaw && !contractYearRaw && !contractStatusRaw && !contractInfoRaw) continue;
            out[pid] = {
              salary: salaryRaw ? safeInt(salaryRaw, 0) : null,
              contractYear: contractYearInt,
              contractStatus: contractStatusRaw || null,
              contractInfo: contractInfoRaw || null,
            };
          }
          return out;
        };

        const parseContractMoneyToken = (token) => {
          const raw = safeStr(token).toUpperCase().replace(/\$/g, "");
          if (!raw) return 0;
          let cleaned = raw.replace(/[^0-9K.\-]/g, "");
          if (!cleaned) return 0;
          const mult = cleaned.includes("K") ? 1000 : 1;
          cleaned = cleaned.replace(/K/g, "");
          if (!cleaned) return 0;
          const num = Number(cleaned);
          if (!Number.isFinite(num)) return 0;
          let amount = Math.round(num * mult);
          if (mult === 1 && amount > 0 && amount < 1000) amount *= 1000;
          return amount;
        };

        const currentCapHit = (salary, years, isTaxi, isIr) => {
          const amt = safeInt(salary, 0);
          const y = Math.max(0, safeInt(years, 0));
          if (isTaxi) return 0;
          if (y <= 0) return 0;
          if (isIr) return Math.round(amt * 0.5);
          return amt;
        };

        const formatContractK = (amount) => {
          const dollars = safeMoneyInt(amount, 0);
          if (dollars <= 0) return "0K";
          const text = Math.round((dollars / 1000) * 10) / 10;
          return `${String(text).replace(/\.0$/, "")}K`;
        };

        const parseContractAavValues = (contractInfo) => {
          const info = safeStr(contractInfo);
          if (!info) return [];
          const match = info.match(/(?:^|\|)\s*AAV\s*([^|]+)/i);
          if (!match || !safeStr(match[1])) return [];
          const segment = safeStr(match[1]).replace(/\bY\d+\s*-[^|]*$/i, "");
          return segment
            .split(/[\/,]/)
            .map((token) => {
              const moneyMatch = safeStr(token).match(/-?\d+(?:\.\d+)?K?/i);
              return parseContractMoneyToken(moneyMatch ? moneyMatch[0] : "");
            })
            .filter((amount) => amount > 0);
        };

        const replaceContractInfoAavValue = (contractInfo, nextAav) => {
          const info = safeStr(contractInfo);
          const aav = safeMoneyInt(nextAav, 0);
          if (!info || aav <= 0) return info;
          if (/AAV\s+/i.test(info)) {
            return info.replace(/AAV\s+[^|]+/i, `AAV ${formatContractK(aav)}`);
          }
          return info;
        };

        const formatContractYearValuesSegment = (yearValues) => {
          const values = yearValues && typeof yearValues === "object" ? yearValues : null;
          if (!values) return "";
          const keys = Object.keys(values)
            .map((key) => safeInt(key, 0))
            .filter((idx) => idx > 0 && safeInt(values[idx], 0) > 0)
            .sort((a, b) => a - b);
          if (!keys.length) return "";
          return keys.map((idx) => `Y${idx}-${formatContractK(values[idx])}`).join(", ");
        };

        const appendContractInfoSegment = (contractInfo, segment) => {
          const info = safeStr(contractInfo).trim();
          const next = safeStr(segment).trim();
          if (!next) return info;
          if (!info) return next;
          return info + (/\|\s*$/.test(info) ? " " : "| ") + next;
        };

        const parseContractYearValues = (contractInfo) => {
          const info = safeStr(contractInfo);
          const out = {};
          if (!info) return out;
          const re = /Y(\d+)\s*-\s*([0-9]+(?:\.[0-9]+)?K?)(?=\s*(?:,|\||Y\d+\s*-|$))/ig;
          let match;
          while ((match = re.exec(info))) {
            const idx = safeInt(match[1], 0);
            const amount = parseContractMoneyToken(match[2]);
            if (idx > 0 && amount > 0) out[idx] = amount;
          }
          return out;
        };

        const normalizeContractInfoForDisplay = (contractInfo, years, priorContract) => {
          const info = safeStr(contractInfo);
          if (!info || !priorContract) return info;
          const currentYears = Math.max(0, safeInt(years, 0));
          const priorYears = Math.max(
            0,
            safeInt(
              priorContract?.years ?? priorContract?.contractYear ?? priorContract?.contract_year ?? 0,
              0
            )
          );
          if (!currentYears || priorYears !== currentYears + 1) return info;
          const priorInfo = safeStr(
            priorContract?.special ||
            priorContract?.contractInfo ||
            priorContract?.contract_info ||
            ""
          );
          let nextInfo = info;
          const priorAavs = parseContractAavValues(priorInfo);
          if (priorAavs.length >= 1) {
            nextInfo = replaceContractInfoAavValue(nextInfo, priorAavs[priorAavs.length - 1]);
          } else {
            const priorAav = safeMoneyInt(
              priorContract?.aav ?? priorContract?.currentAav ?? 0,
              0
            );
            if (priorAav > 0) {
              nextInfo = replaceContractInfoAavValue(nextInfo, priorAav);
            }
          }
          if (!Object.keys(parseContractYearValues(nextInfo)).length) {
            const priorYearSegment = formatContractYearValuesSegment(parseContractYearValues(priorInfo));
            if (priorYearSegment) nextInfo = appendContractInfoSegment(nextInfo, priorYearSegment);
          }
          return nextInfo;
        };

        const parsePlayerScoresRows = (payload) => {
          const out = {};
          const rows = asArray(payload?.playerScores?.playerScore).filter(Boolean);
          for (const row of rows) {
            const pid = String(row?.id || "").replace(/\D/g, "");
            if (!pid) continue;
            const score = Number.parseFloat(String(row?.score || "").replace(/[^0-9.-]/g, ""));
            out[pid] = Number.isFinite(score) ? score : 0;
          }
          return out;
        };

        const fetchNflByeWeeksMap = async (year) => {
          const qs = new URLSearchParams({ TYPE: "nflByeWeeks", JSON: "1", _: String(Date.now()) });
          const targetUrl = `https://api.myfantasyleague.com/${encodeURIComponent(String(year || season))}/export?${qs.toString()}`;
          try {
            const res = await fetch(targetUrl, {
              headers: { "User-Agent": "upsmflproduction-worker" },
              cf: { cacheTtl: 0, cacheEverything: false },
            });
            if (!res.ok) {
              return {
                ok: false,
                year: String(year || season),
                map: {},
                status: res.status,
                url: redactUrlSecrets(targetUrl),
              };
            }
            const data = await res.json();
            const rows = asArray(data?.nflByeWeeks?.team).filter(Boolean);
            const map = {};
            let hasAnyBye = false;
            for (const row of rows) {
              const team = safeStr(row?.id).toUpperCase();
              if (!team) continue;
              const bye = safeStr(row?.bye_week || "");
              if (bye) hasAnyBye = true;
              map[team] = bye;
            }
            return {
              ok: true,
              year: String(year || season),
              map,
              hasAnyBye,
              status: 200,
              url: redactUrlSecrets(targetUrl),
            };
          } catch (e) {
            return {
              ok: false,
              year: String(year || season),
              map: {},
              status: 0,
              url: redactUrlSecrets(targetUrl),
              error: `fetch_failed: ${e?.message || String(e)}`,
            };
          }
        };

        const priorSeason = String(Math.max(0, safeInt(season, Number(season) || 0) - 1));

        const [leagueRes, rostersRes, salariesRes, salaryAdjustmentsRes, priorSalariesRes, extRes] = await Promise.all([
          mflExportJson(season, leagueId, "league", {}, { includeApiKey: true, useCookie: true }),
          mflExportJson(season, leagueId, "rosters", {}, { includeApiKey: true, useCookie: true }),
          mflExportJson(season, leagueId, "salaries", {}, { includeApiKey: true, useCookie: true }),
          mflExportJson(season, leagueId, "salaryAdjustments", {}, { includeApiKey: true, useCookie: true }),
          priorSeason && priorSeason !== String(season)
            ? mflExportJson(priorSeason, leagueId, "salaries", {}, { includeApiKey: true, useCookie: true })
            : Promise.resolve({ ok: false, status: 0, url: "", data: null, error: "" }),
          fetchExtensionPreviewRows(season, url.searchParams),
        ]);

        if (!leagueRes.ok) {
          return jsonOut(502, {
            ok: false,
            error: "Failed to load MFL league export",
            upstream: {
              type: "league",
              status: leagueRes.status,
              url: leagueRes.url,
              error: leagueRes.error,
              preview: leagueRes.textPreview,
            },
          });
        }
        if (!rostersRes.ok) {
          return jsonOut(502, {
            ok: false,
            error: "Failed to load MFL rosters export",
            upstream: {
              type: "rosters",
              status: rostersRes.status,
              url: rostersRes.url,
              error: rostersRes.error,
              preview: rostersRes.textPreview,
            },
          });
        }

        const scoreCurrentRes = await mflExportJson(
          season,
          leagueId,
          "playerScores",
          { W: "YTD" },
          { includeApiKey: true, useCookie: false }
        );
        let scoreYear = String(season);
        let scoresByPlayer = scoreCurrentRes.ok ? parsePlayerScoresRows(scoreCurrentRes.data) : {};
        if (!Object.keys(scoresByPlayer).length) {
          const fallbackScoreYear = String(safeInt(season, Number(season) || 0) - 1);
          if (fallbackScoreYear && fallbackScoreYear !== String(season)) {
            const scorePrevRes = await mflExportJson(
              fallbackScoreYear,
              leagueId,
              "playerScores",
              { W: "YTD" },
              { includeApiKey: true, useCookie: false }
            );
            if (scorePrevRes.ok) {
              const nextMap = parsePlayerScoresRows(scorePrevRes.data);
              if (Object.keys(nextMap).length) {
                scoresByPlayer = nextMap;
                scoreYear = fallbackScoreYear;
              }
            }
          }
        }

        const byeCurrent = await fetchNflByeWeeksMap(season);
        let byeYear = String(season);
        let byesByTeam = byeCurrent.map || {};
        if (!(byeCurrent.ok && byeCurrent.hasAnyBye)) {
          const fallbackByeYear = String(safeInt(season, Number(season) || 0) - 1);
          if (fallbackByeYear && fallbackByeYear !== String(season)) {
            const byePrev = await fetchNflByeWeeksMap(fallbackByeYear);
            if (byePrev.ok && byePrev.hasAnyBye) {
              byesByTeam = byePrev.map || {};
              byeYear = fallbackByeYear;
            }
          }
        }

        const leagueFranchises = parseLeagueFranchises(leagueRes.data);
        const leagueRoot = leagueRes.data?.league || leagueRes.data || {};
        const salaryCapDollars = safeMoneyInt(
          firstTruthy(
            leagueRoot?.auctionStartAmount,
            leagueRoot?.salaryCapAmount,
            leagueRoot?.salary_cap_amount
          ),
          0
        );
        const { rosterAssetsByFranchise, allPlayerIds } = parseRostersExport(rostersRes.data);
        const playersById = await fetchPlayersByIdsChunked(season, leagueId, allPlayerIds);
        const salaryByPlayer = salariesRes.ok ? parseSalaryRows(salariesRes.data, allPlayerIds) : {};
        const priorSalaryByPlayer = priorSalariesRes.ok ? parseSalaryRows(priorSalariesRes.data) : {};
        const salaryAdjustmentRows = salaryAdjustmentsRes.ok
          ? collectSalaryAdjustmentExportRows(
              salaryAdjustmentsRes.data?.salaryAdjustments || salaryAdjustmentsRes.data?.salaryadjustments || salaryAdjustmentsRes.data || {}
            )
          : [];
        const salaryAdjustmentByFranchise = {};
        const salaryAdjustmentBreakdownByFranchise = {};
        for (const row of salaryAdjustmentRows) {
          const fid = padFranchiseId(row?.franchise_id);
          if (!fid) continue;
          if (!salaryAdjustmentBreakdownByFranchise[fid]) {
            salaryAdjustmentBreakdownByFranchise[fid] = emptySalaryAdjustmentBreakdown();
          }
          salaryAdjustmentByFranchise[fid] = safeInt(salaryAdjustmentByFranchise[fid], 0) + safeInt(row?.amount, 0);
          const category = salaryAdjustmentCategory(row?.explanation);
          salaryAdjustmentBreakdownByFranchise[fid][category] =
            safeInt(salaryAdjustmentBreakdownByFranchise[fid][category], 0) + safeInt(row?.amount, 0);
        }

        const franchiseMetaById = {};
        for (const fr of leagueFranchises) {
          franchiseMetaById[fr.franchise_id] = fr;
        }
        const extRowsNormalized = remapExtensionPreviewRowsToCurrentOwners(
          extRes.rows || [],
          rosterAssetsByFranchise,
          franchiseMetaById
        );
        const extensionPreviewsByPlayer = {};
        for (const row of extRowsNormalized.rows || []) {
          const playerId = String(row?.player_id || "").replace(/\D/g, "");
          const franchiseId = padFranchiseId(row?.franchise_id);
          if (!playerId || !franchiseId) continue;
          if (!extensionPreviewsByPlayer[playerId]) extensionPreviewsByPlayer[playerId] = [];
          extensionPreviewsByPlayer[playerId].push(row);
        }
        for (const playerId of Object.keys(extensionPreviewsByPlayer)) {
          extensionPreviewsByPlayer[playerId].sort((a, b) => {
            const aTerm = safeStr(a?.extension_term).toUpperCase();
            const bTerm = safeStr(b?.extension_term).toUpperCase();
            if (aTerm !== bTerm) return aTerm.localeCompare(bTerm);
            return safeStr(a?.loaded_indicator).localeCompare(safeStr(b?.loaded_indicator));
          });
        }
        const franchiseIds = new Set([
          ...Object.keys(franchiseMetaById),
          ...Object.keys(rosterAssetsByFranchise),
        ]);

        const teams = Array.from(franchiseIds).map((franchiseId) => {
          const meta = franchiseMetaById[franchiseId] || {
            franchise_id: franchiseId,
            franchise_name: franchiseId,
            franchise_abbrev: franchiseId,
            icon_url: "",
          };
          const rawAssets = asArray(rosterAssetsByFranchise[franchiseId]).filter(Boolean);
          const players = rawAssets
            .filter((asset) => safeStr(asset?.type).toUpperCase() === "PLAYER")
            .map((asset, idx) => {
              const playerId = String(asset?.player_id || "").replace(/\D/g, "");
              const pMeta = playersById[playerId] || {};
              const overlay = salaryByPlayer[playerId] || null;
              const salary = overlay && overlay.salary != null ? safeInt(overlay.salary, 0) : safeInt(asset?.salary, 0);
              const years = overlay && overlay.contractYear != null
                ? safeInt(overlay.contractYear, 0)
                : (asset?.years == null ? 0 : safeInt(asset?.years, 0));
              const type = safeStr(overlay?.contractStatus || asset?.contract_type || "");
              const specialRaw = safeStr(overlay?.contractInfo || asset?.contract_info || "");
              const special = normalizeContractInfoForDisplay(specialRaw, years, priorSalaryByPlayer[playerId] || null);
              const aavValues = parseContractAavValues(special);
              const aav = aavValues.length ? safeInt(aavValues[0], 0) : 0;
              const nflTeam = safeStr(pMeta?.nfl_team || "").toUpperCase();
              const statusRaw = safeStr(asset?.roster_status || "").toUpperCase();
              const status = statusRaw || (asset?.taxi ? "TAXI_SQUAD" : "ROSTER");
              const isTaxi = status.includes("TAXI");
              const isIr = status.includes("IR");
              return {
                id: playerId,
                order: idx,
                name: safeStr(pMeta?.player_name || playerId),
                position: safeStr(pMeta?.position || "").toUpperCase() || "-",
                nfl_team: nflTeam,
                points: Number.isFinite(scoresByPlayer[playerId]) ? scoresByPlayer[playerId] : 0,
                bye: safeStr(byesByTeam[nflTeam] || ""),
                salary,
                years,
                aav,
                type: type || "-",
                special: special || "-",
                acquisition_text: safeStr(asset?.notes || ""),
                status,
                is_taxi: isTaxi,
                is_ir: isIr,
                extension_previews: extensionPreviewsByPlayer[playerId] || [],
              };
            });

          const taxiCount = players.reduce((acc, p) => acc + (p.is_taxi ? 1 : 0), 0);
          const capTotal = players.reduce((acc, p) => acc + currentCapHit(p.salary, p.years, p.is_taxi, p.is_ir), 0);
          const salaryAdjustmentTotal = safeInt(salaryAdjustmentByFranchise[franchiseId], 0);
          const salaryAdjustmentBreakdown = salaryAdjustmentBreakdownByFranchise[franchiseId] || emptySalaryAdjustmentBreakdown();
          // Pass through raw salary adjustment rows (live MFL) for this franchise so the
          // workbench Cap Summary can show per-row drilldown (trade partner/date/amount).
          const rawSalaryAdjustmentRows = salaryAdjustmentRows
            .filter((r) => padFranchiseId(r?.franchise_id) === franchiseId)
            .map((r) => ({
              franchise_id: padFranchiseId(r?.franchise_id),
              amount: safeInt(r?.amount, 0),
              explanation: safeStr(r?.explanation || r?.description || ""),
              timestamp: safeStr(r?.timestamp || ""),
              category: salaryAdjustmentCategory(r?.explanation),
            }));
          const compliant = salaryCapDollars > 0 ? capTotal + salaryAdjustmentTotal <= salaryCapDollars : true;
          const complianceLabel = compliant
            ? "Compliant"
            : `Over $${Math.max(0, capTotal + salaryAdjustmentTotal - salaryCapDollars).toLocaleString("en-US")}`;

          return {
            franchise_id: franchiseId,
            franchise_name: meta.franchise_name,
            franchise_abbrev: meta.franchise_abbrev,
            icon_url: meta.icon_url,
            players,
            summary: {
              players: players.length,
              taxi: taxiCount,
              cap_total_dollars: capTotal,
              salary_adjustment_total_dollars: salaryAdjustmentTotal,
              salary_adjustment_breakdown_dollars: salaryAdjustmentBreakdown,
              salary_adjustment_raw_rows: rawSalaryAdjustmentRows,
              compliance: {
                ok: compliant,
                label: complianceLabel,
              },
            },
          };
        });

        teams.sort((a, b) => safeStr(a.franchise_name).localeCompare(safeStr(b.franchise_name)));

        const warnings = [];
        if (!extRes.ok) {
          warnings.push({
            code: "extension_previews_unavailable",
            message: "Extension previews were unavailable; roster extension actions are disabled.",
            upstream: {
              status: extRes.status,
              url: extRes.url,
              error: extRes.error,
            },
          });
        }

        const payload = {
          ok: true,
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          generated_at: new Date().toISOString(),
          source: "worker:/roster-workbench",
          salary_cap_dollars: salaryCapDollars,
          points_year: scoreYear,
          bye_year: byeYear,
          teams,
          meta: {
            counts: {
              teams: teams.length,
              roster_players: allPlayerIds.length,
              extension_preview_rows: Array.isArray(extRowsNormalized.rows) ? extRowsNormalized.rows.length : 0,
              extension_preview_rows_owner_remapped: safeInt(extRowsNormalized.remapped_count, 0),
            },
            upstream: {
              league: { status: leagueRes.status, url: leagueRes.url },
              rosters: { status: rostersRes.status, url: rostersRes.url },
              salaries: { status: salariesRes.status, url: salariesRes.url, ok: salariesRes.ok },
              salary_adjustments: {
                status: salaryAdjustmentsRes.status,
                url: salaryAdjustmentsRes.url,
                ok: salaryAdjustmentsRes.ok,
              },
              prior_salaries: {
                status: priorSalariesRes.status,
                url: priorSalariesRes.url,
                ok: priorSalariesRes.ok,
                season: priorSeason,
              },
              extension_previews: {
                status: extRes.status,
                url: extRes.url,
                ok: extRes.ok,
              },
              player_scores: { status: scoreCurrentRes.status, url: scoreCurrentRes.url, ok: scoreCurrentRes.ok },
              bye_weeks: { status: byeCurrent.status || 0, url: byeCurrent.url || "", ok: !!byeCurrent.ok },
            },
            warnings,
          },
        };

        const response = jsonOut(200, payload);
        response.headers.set("Cache-Control", "public, max-age=60");
        if (!disableCache) {
          try { await caches.default.put(cacheKey, response.clone()); } catch (_) {}
        }
        return response;
      }

      if (path === "/roster-workbench/admin-state" && request.method === "GET") {
        return adminStateResponse();
      }

      // Audit log helpers for salary changes.
      // Writes one row per player touched by /admin/import-salaries (dry-run
      // and real) to the D1 `salary_change_log` table when a DB binding is
      // present, and always console.logs a one-line summary so the change is
      // visible in Cloudflare Workers real-time logs too.
      const ensureSalaryChangeLogTable = async (db) => {
        if (!db) return { ok: false, error: "no_db_binding" };
        try {
          await db.exec(
            "CREATE TABLE IF NOT EXISTS salary_change_log ( " +
              "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
              "created_ts TEXT NOT NULL, " +
              "endpoint TEXT NOT NULL, " +
              "league_id TEXT, " +
              "season TEXT, " +
              "dry_run INTEGER NOT NULL DEFAULT 0, " +
              "actor_ip TEXT, " +
              "actor_ua TEXT, " +
              "actor_had_api_key INTEGER NOT NULL DEFAULT 0, " +
              "player_id TEXT, " +
              "before_salary TEXT, " +
              "before_contract_status TEXT, " +
              "before_contract_year TEXT, " +
              "before_contract_info TEXT, " +
              "after_salary TEXT, " +
              "after_contract_status TEXT, " +
              "after_contract_year TEXT, " +
              "after_contract_info TEXT, " +
              "intended_salary TEXT, " +
              "intended_contract_status TEXT, " +
              "intended_contract_year TEXT, " +
              "intended_contract_info TEXT, " +
              "landed INTEGER, " +
              "import_status INTEGER, " +
              "notes TEXT " +
              ");"
          );
          await db.exec(
            "CREATE INDEX IF NOT EXISTS idx_salary_change_log_lookup ON salary_change_log(league_id, season, player_id, created_ts);"
          );
          return { ok: true };
        } catch (e) {
          return { ok: false, error: `schema_failed: ${e?.message || String(e)}` };
        }
      };
      const logSalaryChangeRow = async (db, row) => {
        try {
          console.log(
            JSON.stringify({
              kind: "salary_change_log",
              endpoint: row.endpoint,
              league_id: row.league_id,
              season: row.season,
              dry_run: !!row.dry_run,
              player_id: row.player_id,
              before_salary: row.before_salary,
              after_salary: row.after_salary,
              intended_salary: row.intended_salary,
              landed: row.landed,
              import_status: row.import_status,
              created_ts: row.created_ts,
              actor_ip: row.actor_ip,
            })
          );
        } catch (_) {}
        if (!db) return;
        try {
          await db
            .prepare(
              "INSERT INTO salary_change_log (" +
                "created_ts, endpoint, league_id, season, dry_run, actor_ip, actor_ua, actor_had_api_key, player_id, " +
                "before_salary, before_contract_status, before_contract_year, before_contract_info, " +
                "after_salary, after_contract_status, after_contract_year, after_contract_info, " +
                "intended_salary, intended_contract_status, intended_contract_year, intended_contract_info, " +
                "landed, import_status, notes" +
                ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
            )
            .bind(
              row.created_ts,
              row.endpoint,
              row.league_id || null,
              row.season || null,
              row.dry_run ? 1 : 0,
              row.actor_ip || null,
              row.actor_ua || null,
              row.actor_had_api_key ? 1 : 0,
              row.player_id || null,
              row.before_salary || null,
              row.before_contract_status || null,
              row.before_contract_year || null,
              row.before_contract_info || null,
              row.after_salary || null,
              row.after_contract_status || null,
              row.after_contract_year || null,
              row.after_contract_info || null,
              row.intended_salary || null,
              row.intended_contract_status || null,
              row.intended_contract_year || null,
              row.intended_contract_info || null,
              row.landed == null ? null : (row.landed ? 1 : 0),
              row.import_status == null ? null : safeInt(row.import_status, 0),
              row.notes || null
            )
            .run();
        } catch (e) {
          console.log("salary_change_log_insert_failed", e?.message || String(e));
        }
      };

      // GET /admin/salary-change-log — read the audit trail
      // Params: season, league_id, player_id, limit (default 100, max 500)
      if (path === "/admin/salary-change-log" && request.method === "GET") {
        const db = env.TWB_OUTBOX_DB || env.TWB_DB || env.DB || null;
        if (!db) return jsonOut(503, { ok: false, error: "D1 database binding not configured (TWB_OUTBOX_DB / TWB_DB / DB)" });
        await ensureSalaryChangeLogTable(db);
        const qs = url.searchParams;
        const qSeason = safeStr(qs.get("season"));
        const qLeague = safeStr(qs.get("league_id") || qs.get("L"));
        const qPlayer = safeStr(qs.get("player_id"));
        const qLimit = Math.max(1, Math.min(500, safeInt(qs.get("limit"), 100)));
        const clauses = [];
        const binds = [];
        if (qSeason) { clauses.push("season = ?"); binds.push(qSeason); }
        if (qLeague) { clauses.push("league_id = ?"); binds.push(qLeague); }
        if (qPlayer) { clauses.push("player_id = ?"); binds.push(qPlayer); }
        const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
        const sql = "SELECT * FROM salary_change_log " + where + " ORDER BY id DESC LIMIT ?";
        binds.push(qLimit);
        try {
          const res = await db.prepare(sql).bind(...binds).all();
          return jsonOut(200, { ok: true, count: (res?.results || []).length, rows: res?.results || [] });
        } catch (e) {
          return jsonOut(500, { ok: false, error: `query_failed: ${e?.message || String(e)}` });
        }
      }

      // POST /admin/import-salaries
      // Body: {
      //   season: "2026",
      //   league_id: "74598",
      //   dry_run?: bool,
      //   rows: [ { id, salary, contractStatus, contractYear, contractInfo }, ... ]
      // }
      // Posts a <salaries>... XML to MFL's TYPE=salaries import endpoint.
      // Requires commissioner auth via MFL_COOKIE secret.
      if (path === "/admin/import-salaries" && request.method === "POST") {
        let body = {};
        try { body = (await request.json()) || {}; } catch (_) { body = {}; }
        if (!!commishApiKey && !sessionByApiKey) {
          return jsonOut(403, { ok: false, error: "Valid COMMISH_API_KEY is required." });
        }
        const auditDb = env.TWB_OUTBOX_DB || env.TWB_DB || env.DB || null;
        await ensureSalaryChangeLogTable(auditDb);
        const auditActor = {
          ip: safeStr(request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")),
          ua: safeStr(request.headers.get("user-agent")).slice(0, 200),
          had_api_key: !!sessionByApiKey,
        };
        const targetSeason = safeStr(body?.season || url.searchParams.get("YEAR") || YEAR || "");
        const leagueId = safeStr(body?.league_id || body?.L || url.searchParams.get("L") || L || "74598");
        const dryRun = !!body?.dry_run;
        const rows = Array.isArray(body?.rows) ? body.rows : [];
        if (!targetSeason) return jsonOut(400, { ok: false, error: "Missing season" });
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing league_id" });
        if (!rows.length) return jsonOut(400, { ok: false, error: "rows array required" });

        // Validate each row
        const valid = [];
        const invalid = [];
        for (const r of rows) {
          if (!r || typeof r !== "object") { invalid.push({ reason: "not_object", row: r }); continue; }
          const pid = String(r.id || r.player_id || "").replace(/\D/g, "");
          if (!pid) { invalid.push({ reason: "missing_player_id", row: r }); continue; }
          const salary = safeStr(r.salary);
          const contractStatus = safeStr(r.contractStatus || r.contract_status || "");
          const contractYear = safeStr(r.contractYear || r.contract_year || "");
          const contractInfo = safeStr(r.contractInfo || r.contract_info || "");
          if (!salary || !contractInfo) { invalid.push({ reason: "missing_salary_or_contractInfo", row: r }); continue; }
          valid.push({ id: pid, salary, contractStatus, contractYear, contractInfo });
        }
        if (!valid.length) {
          return jsonOut(400, { ok: false, error: "No valid rows", invalid });
        }

        // CRITICAL: MFL's TYPE=salaries import REPLACES the entire salaries table,
        // not merges. We MUST fetch the current salaries, merge in our updates,
        // and post the full merged set, or every other player's contract gets wiped.
        const mergeCurrentRes = await mflExportJson(targetSeason, leagueId, "salaries", {}, { useCookie: true });
        if (!mergeCurrentRes.ok) {
          return jsonOut(502, {
            ok: false,
            error: "Failed to fetch current salaries for merge (refusing to post — would wipe other players)",
            upstream: mergeCurrentRes,
          });
        }
        const currentPlayers = (() => {
          const root = mergeCurrentRes.data?.salaries?.leagueUnit?.player;
          return Array.isArray(root) ? root : (root ? [root] : []);
        })();
        // Build merged map keyed by player_id: start with current, overwrite with our updates.
        const mergedById = {};
        for (const p of currentPlayers) {
          const pid = safeStr(p?.id).replace(/\D/g, "");
          if (!pid) continue;
          const sal = safeStr(p?.salary);
          const info = safeStr(p?.contractInfo);
          if (!sal && !info) continue; // skip empty rows — don't ossify blanks
          mergedById[pid] = {
            id: pid,
            salary: sal,
            contractStatus: safeStr(p?.contractStatus),
            contractYear: safeStr(p?.contractYear),
            contractInfo: info,
          };
        }
        for (const r of valid) {
          mergedById[r.id] = {
            id: r.id,
            salary: r.salary,
            contractStatus: r.contractStatus,
            contractYear: r.contractYear,
            contractInfo: r.contractInfo,
          };
        }
        const mergedRows = Object.values(mergedById).sort((a, b) => a.id.localeCompare(b.id));

        // Build XML from MERGED set (preserves all other players)
        const xmlEsc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const playerXml = mergedRows.map((r) =>
          `<player id="${xmlEsc(r.id)}" salary="${xmlEsc(r.salary)}" contractStatus="${xmlEsc(r.contractStatus)}" contractYear="${xmlEsc(r.contractYear)}" contractInfo="${xmlEsc(r.contractInfo)}" />`
        ).join("");
        const dataXml = `<salaries><leagueUnit unit="LEAGUE">${playerXml}</leagueUnit></salaries>`;

        if (dryRun) {
          // Log dry-run intent per player so we have a record of "someone
          // previewed changing these salaries" even if they never committed.
          const nowIso = new Date().toISOString();
          for (const r of valid) {
            const before = mergedById[r.id] && currentPlayers.find((p) => safeStr(p?.id).replace(/\D/g, "") === r.id);
            await logSalaryChangeRow(auditDb, {
              created_ts: nowIso,
              endpoint: "/admin/import-salaries",
              league_id: leagueId,
              season: targetSeason,
              dry_run: true,
              actor_ip: auditActor.ip,
              actor_ua: auditActor.ua,
              actor_had_api_key: auditActor.had_api_key,
              player_id: r.id,
              before_salary: safeStr(before?.salary),
              before_contract_status: safeStr(before?.contractStatus),
              before_contract_year: safeStr(before?.contractYear),
              before_contract_info: safeStr(before?.contractInfo),
              intended_salary: r.salary,
              intended_contract_status: r.contractStatus,
              intended_contract_year: r.contractYear,
              intended_contract_info: r.contractInfo,
              landed: null,
              import_status: null,
              notes: "dry_run",
            });
          }
          return jsonOut(200, {
            ok: true,
            dry_run: true,
            season: targetSeason,
            league_id: leagueId,
            rows_valid: valid,
            rows_invalid: invalid,
            rows_merged_total: mergedRows.length,
            rows_preserved_count: mergedRows.length - valid.length,
            xml_preview_first_2kb: dataXml.slice(0, 2000),
            xml_length: dataXml.length,
          });
        }

        // Verify admin
        const adminState = await getLeagueAdminState(leagueId, targetSeason);
        if (!adminState.ok || !adminState.isAdmin) {
          return jsonOut(403, {
            ok: false,
            error: "MFL_COOKIE lacks commissioner privileges for salaries import",
            admin_state: adminState,
          });
        }

        // Capture pre-state snapshot for verification
        const preExportRes = await mflExportJson(targetSeason, leagueId, "salaries", {}, { useCookie: true });
        const preMap = {};
        if (preExportRes.ok) {
          const plist = preExportRes.data?.salaries?.leagueUnit?.player;
          const arr = Array.isArray(plist) ? plist : (plist ? [plist] : []);
          for (const p of arr) preMap[safeStr(p?.id)] = p;
        }

        // POST to MFL. Critical config (learned 2026-04-18):
        //   - Use browser-like User-Agent — the "upsmflproduction-worker" UA
        //     triggered MFL silent rejection (HTTP 200 with empty body, no
        //     actual persistence).
        //   - redirect: "follow" — MFL redirects to a success page; manual
        //     redirect mode returned empty body.
        //   - Accept-Encoding: identity — avoid any gzip surprises.
        //   - NO APIKEY in form — cookie-only auth works; mixing cookie+APIKEY
        //     was also causing silent reject.
        const importUrl = `https://www48.myfantasyleague.com/${encodeURIComponent(targetSeason)}/import?TYPE=salaries&L=${encodeURIComponent(leagueId)}`;
        const importFetchRes = await fetch(importUrl, {
          method: "POST",
          headers: {
            Cookie: cookieHeader,
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "Accept": "text/xml, text/plain, application/xml, */*",
            "Accept-Encoding": "identity",
          },
          body: new URLSearchParams({ DATA: dataXml }).toString(),
          redirect: "follow",
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        const importText = await importFetchRes.text();
        const importStatusXml = /<status>OK<\/status>/i.test(importText);
        const importErrorXml = /<error>([^<]+)<\/error>/i.exec(importText);
        const importRes = {
          ok: importFetchRes.ok && importStatusXml,
          requestOk: importFetchRes.ok && importStatusXml,
          status: importFetchRes.status,
          text: importText,
          upstreamPreview: importText.slice(0, 2000),
          targetImportUrl: importFetchRes.url,
          formFields: { TYPE: "salaries", L: leagueId, DATA: `<${dataXml.length} bytes>` },
          error: importErrorXml ? importErrorXml[1] : (importStatusXml ? "" : "unexpected_response"),
        };

        // Verify by re-fetching
        const postExportRes = await mflExportJson(targetSeason, leagueId, "salaries", {}, { useCookie: true });
        const postMap = {};
        if (postExportRes.ok) {
          const plist = postExportRes.data?.salaries?.leagueUnit?.player;
          const arr = Array.isArray(plist) ? plist : (plist ? [plist] : []);
          for (const p of arr) postMap[safeStr(p?.id)] = p;
        }

        const verification = valid.map((r) => {
          const before = preMap[r.id] || {};
          const after = postMap[r.id] || {};
          const fieldsMatch =
            safeStr(after?.salary) === r.salary &&
            safeStr(after?.contractStatus) === r.contractStatus &&
            safeStr(after?.contractYear) === r.contractYear &&
            safeStr(after?.contractInfo) === r.contractInfo;
          return {
            id: r.id,
            expected: r,
            before: {
              salary: safeStr(before?.salary),
              contractStatus: safeStr(before?.contractStatus),
              contractYear: safeStr(before?.contractYear),
              contractInfo: safeStr(before?.contractInfo),
            },
            after: {
              salary: safeStr(after?.salary),
              contractStatus: safeStr(after?.contractStatus),
              contractYear: safeStr(after?.contractYear),
              contractInfo: safeStr(after?.contractInfo),
            },
            landed: fieldsMatch,
          };
        });
        const allLanded = verification.every((v) => v.landed);

        // Audit: one row per player actually posted to MFL, with before/after/landed.
        const nowIso = new Date().toISOString();
        for (const v of verification) {
          await logSalaryChangeRow(auditDb, {
            created_ts: nowIso,
            endpoint: "/admin/import-salaries",
            league_id: leagueId,
            season: targetSeason,
            dry_run: false,
            actor_ip: auditActor.ip,
            actor_ua: auditActor.ua,
            actor_had_api_key: auditActor.had_api_key,
            player_id: v.id,
            before_salary: v.before?.salary,
            before_contract_status: v.before?.contractStatus,
            before_contract_year: v.before?.contractYear,
            before_contract_info: v.before?.contractInfo,
            after_salary: v.after?.salary,
            after_contract_status: v.after?.contractStatus,
            after_contract_year: v.after?.contractYear,
            after_contract_info: v.after?.contractInfo,
            intended_salary: v.expected?.salary,
            intended_contract_status: v.expected?.contractStatus,
            intended_contract_year: v.expected?.contractYear,
            intended_contract_info: v.expected?.contractInfo,
            landed: !!v.landed,
            import_status: importRes.status,
            notes: v.landed ? "committed" : "mismatch_or_rejected",
          });
        }

        return jsonOut(importRes.requestOk && allLanded ? 200 : 502, {
          ok: !!(importRes.requestOk && allLanded),
          season: targetSeason,
          league_id: leagueId,
          posted_count: valid.length,
          landed_count: verification.filter((v) => v.landed).length,
          mismatched_count: verification.filter((v) => !v.landed).length,
          verification,
          import_status: importRes.status,
          // Full upstream response (2KB) so we can diagnose silent rejects.
          import_response_full: safeStr(importRes.upstreamPreview).slice(0, 2000),
          import_target_url: importRes.targetImportUrl,
          import_form_keys: Object.keys(importRes.formFields || {}),
          direct_attempt_status: importRes.direct_attempt_status,
          direct_attempt_error: importRes.direct_attempt_error,
          xml_length: dataXml.length,
          invalid_rows: invalid,
        });
      }

      // POST /admin/import-drop-penalties
      // Body: { season, league_id?, dry_run? }
      // Pulls DROP_PENALTY_CANDIDATE rows from the salary_adjustments JSON report
      // for the season, filters to import_eligible entries targeting that season,
      // then posts each as a salary adjustment to MFL (one row per franchise/player).
      if (path === "/admin/import-drop-penalties" && request.method === "POST") {
        let body = {};
        try { body = (await request.json()) || {}; } catch (_) { body = {}; }
        if (!!commishApiKey && !sessionByApiKey) {
          return jsonOut(403, { ok: false, error: "Valid COMMISH_API_KEY is required." });
        }
        const targetSeason = safeStr(body?.season || url.searchParams.get("YEAR") || YEAR || "");
        const leagueId = safeStr(body?.league_id || body?.L || url.searchParams.get("L") || L || "74598");
        const dryRun = !!body?.dry_run;
        const limit = safeInt(body?.limit, 0);
        if (!targetSeason) return jsonOut(400, { ok: false, error: "Missing season param" });
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing league_id param" });

        // Fetch the report JSON from jsDelivr (production-pinned).
        const reportUrl = `https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/reports/salary_adjustments/salary_adjustments_${encodeURIComponent(targetSeason)}.json`;
        let reportPayload = null;
        try {
          const r = await fetch(reportUrl, { cf: { cacheTtl: 0, cacheEverything: false } });
          if (!r.ok) {
            return jsonOut(502, { ok: false, error: "Failed to fetch salary adjustments report", status: r.status, url: reportUrl });
          }
          reportPayload = await r.json();
        } catch (e) {
          return jsonOut(502, { ok: false, error: `Failed to fetch report: ${e?.message || e}`, url: reportUrl });
        }
        const reportRows = Array.isArray(reportPayload?.rows) ? reportPayload.rows : [];
        const eligible = reportRows.filter((r) => {
          if (!r || typeof r !== "object") return false;
          if (safeStr(r.adjustment_type).toUpperCase() !== "DROP_PENALTY_CANDIDATE") return false;
          if (r.import_eligible !== true && safeStr(r.import_eligible).toLowerCase() !== "true") return false;
          const targetYr = safeInt(r.adjustment_season ?? r.import_target_season, 0);
          if (targetYr && String(targetYr) !== String(targetSeason)) return false;
          if (safeInt(r.amount, 0) <= 0) return false;
          return true;
        }).map((r) => {
          // TCV < $5K contracts: fixed $1K cap penalty (rule override, not a floor).
          // Per-drop rounding REMOVED — RULE-CAP-002 rounds at the TEAM level,
          // not per transaction. Each drop stays at its raw computed amount;
          // team-level rounding is computed downstream and shown in displays
          // (Discord, Cap Summary). Rounding only hits MFL at Auction lock.
          const tcv = safeInt(r.pre_drop_tcv, 0);
          const amt = safeInt(r.amount, 0);
          if (tcv > 0 && tcv <= 4000 && amt > 0 && amt !== 1000) {
            return { ...r, amount: 1000, penalty_amount: 1000, original_amount: amt };
          }
          return r;
        });

        // Fetch currently-posted salary adjustments so we don't double-post.
        const existingRes = await mflExportJson(targetSeason, leagueId, "salaryAdjustments", {}, { useCookie: true });
        const existingRows = existingRes.ok
          ? collectSalaryAdjustmentExportRows(existingRes.data?.salaryAdjustments || existingRes.data?.salaryadjustments || existingRes.data || {})
          : [];
        const existingKeys = new Set();
        for (const ex of existingRows) {
          const explanation = safeStr(ex.explanation);
          // Match either legacy bracket tag or new "id:KEY" tail
          const m1 = explanation.match(/ups_drop_penalty:([A-Za-z0-9_.:-]+)/);
          if (m1) existingKeys.add(m1[1]);
          const m2 = explanation.match(/\bid:([A-Za-z0-9_.:-]+)\s*$/);
          if (m2) existingKeys.add(m2[1]);
        }

        // Build salary adjustment rows for MFL
        const rowsToPost = [];
        const skipped = [];
        for (const row of eligible) {
          const fid = padFranchiseId(row.franchise_id);
          if (!fid) { skipped.push({ row, reason: "missing_franchise_id" }); continue; }
          const amount = safeInt(row.amount, 0);
          if (amount <= 0) { skipped.push({ row, reason: "non_positive_amount" }); continue; }
          const ledgerKey = safeStr(row.ledger_key) || safeStr(row.source_id) || `${row.player_id}_${row.transaction_datetime_et}`;
          if (existingKeys.has(ledgerKey)) {
            skipped.push({ row, reason: "already_posted", ledger_key: ledgerKey });
            continue;
          }
          const playerName = safeStr(row.player_name) || safeStr(row.player_id);
          // Simple explanation without special characters that MFL may reject.
          // Idempotency key embedded via the tail `id:KEY` suffix.
          const safeExplanation = `UPS drop penalty ${playerName.replace(/[^A-Za-z0-9 ,.'-]/g, '')} ${amount} id:${ledgerKey}`;
          rowsToPost.push({
            franchise_id: fid,
            amount: amount,
            explanation: safeExplanation,
          });
        }

        if (!rowsToPost.length) {
          return jsonOut(200, {
            ok: true,
            season: targetSeason,
            league_id: leagueId,
            posted: 0,
            eligible: eligible.length,
            already_posted: existingKeys.size,
            skipped,
            message: "No new drop penalties to post.",
          });
        }

        // Apply test limit if provided
        const rowsSliced = limit > 0 ? rowsToPost.slice(0, limit) : rowsToPost;

        if (dryRun) {
          return jsonOut(200, {
            ok: true,
            dry_run: true,
            season: targetSeason,
            league_id: leagueId,
            would_post: rowsSliced,
            total_eligible: rowsToPost.length,
            skipped,
            xml_preview: buildSalaryAdjXml(rowsSliced),
          });
        }

        // Verify admin privileges
        const adminState = await getLeagueAdminState(leagueId, targetSeason);
        if (!adminState.ok || !adminState.isAdmin) {
          return jsonOut(403, {
            ok: false,
            error: "MFL_COOKIE lacks commissioner privileges for salary adjustments",
            admin_state: adminState,
            would_post: rowsSliced,
          });
        }

        // MFL's salaryAdj import REPLACES all existing adjustments when posted
        // as a flat <salary_adjustments> document. To preserve existing ones
        // (like trade settlements), merge them in.
        const preservePreviousRes = await mflExportJson(targetSeason, leagueId, "salaryAdjustments", {}, { useCookie: true });
        const preservePrevious = preservePreviousRes.ok
          ? collectSalaryAdjustmentExportRows(preservePreviousRes.data?.salaryAdjustments || preservePreviousRes.data?.salaryadjustments || preservePreviousRes.data || {})
          : [];
        const newLedgerKeys = new Set(rowsSliced.map((r) => {
          const m = r.explanation.match(/\bid:([A-Za-z0-9_.:-]+)\s*$/);
          return m ? m[1] : "";
        }).filter(Boolean));
        // Keep existing rows unless we're replacing them (same ledger_key)
        const preservedRows = preservePrevious
          .filter((r) => {
            const expl = safeStr(r.explanation);
            const m1 = expl.match(/ups_drop_penalty:([A-Za-z0-9_.:-]+)/);
            const m2 = expl.match(/\bid:([A-Za-z0-9_.:-]+)\s*$/);
            const key = (m1 && m1[1]) || (m2 && m2[1]) || "";
            return !key || !newLedgerKeys.has(key);
          })
          .map((r) => ({
            franchise_id: r.franchise_id,
            amount: r.amount,
            explanation: r.explanation,
          }));

        // Debug toggle: preserve_existing=false will post only new rows
        const preserveExisting = body?.preserve_existing !== false;
        const combinedRows = preserveExisting ? [...preservedRows, ...rowsSliced] : rowsSliced;
        const dataXml = buildSalaryAdjXml(combinedRows);

        // MFL's /import endpoint — use the same pattern that works for the
        // trade workflow's applySalaryAdjFromPayload.
        const importFormFields = { TYPE: "salaryAdj", L: leagueId, DATA: dataXml };
        const importRes = await postMflImportForm(
          targetSeason,
          importFormFields,
          { TYPE: "salaryAdj", L: leagueId }
        );

        // Post-import verification
        const postVerifyRes = await mflExportJson(targetSeason, leagueId, "salaryAdjustments", {}, { useCookie: true });
        const postVerifyRows = postVerifyRes.ok
          ? collectSalaryAdjustmentExportRows(postVerifyRes.data?.salaryAdjustments || postVerifyRes.data?.salaryadjustments || postVerifyRes.data || {})
          : [];
        const verifiedKeys = new Set();
        for (const ex of postVerifyRows) {
          const expl = safeStr(ex.explanation);
          const m1 = expl.match(/ups_drop_penalty:([A-Za-z0-9_.:-]+)/);
          const m2 = expl.match(/\bid:([A-Za-z0-9_.:-]+)\s*$/);
          if (m1) verifiedKeys.add(m1[1]);
          if (m2) verifiedKeys.add(m2[1]);
        }
        const matchedCount = rowsSliced.filter((r) => {
          const m = r.explanation.match(/\bid:([A-Za-z0-9_.:-]+)\s*$/);
          return m && verifiedKeys.has(m[1]);
        }).length;

        return jsonOut(importRes.requestOk ? 200 : 502, {
          ok: !!importRes.requestOk,
          season: targetSeason,
          league_id: leagueId,
          posted_count: rowsSliced.length,
          preserved_existing: preservedRows.length,
          combined_total: combinedRows.length,
          posted_rows: rowsSliced,
          skipped,
          import_status: importRes.status,
          import_response_preview: safeStr(importRes.upstreamPreview).slice(0, 600),
          import_target_url: importRes.targetImportUrl,
          verified_posted_count: matchedCount,
          verify_total_export_rows: postVerifyRows.length,
          admin_check: { ok: adminState.ok, isAdmin: adminState.isAdmin },
          xml_length: dataXml.length,
          write_hint: matchedCount === 0 && importRes.status === 200
            ? "MFL returned 200 with empty body but rows did not land — MFL_COOKIE secret likely needs refresh (no commissioner write access)"
            : undefined,
        });
      }

      if (path === "/admin/test-sync/prod-rosters" && request.method === "POST") {
        let body = {};
        try {
          body = (await request.json()) || {};
        } catch (_) {
          body = {};
        }
        if (!!commishApiKey && !sessionByApiKey) {
          return jsonOut(403, { ok: false, error: "Valid COMMISH_API_KEY is required for test sync." });
        }

        const season = safeStr(body?.season || body?.YEAR || url.searchParams.get("YEAR") || YEAR || "");
        const sourceLeagueId = safeStr(body?.source_league_id || body?.sourceLeagueId || url.searchParams.get("SOURCE_L") || "74598");
        const targetLeagueId = safeStr(body?.target_league_id || body?.targetLeagueId || url.searchParams.get("TARGET_L") || "25625");
        const targetCookieRaw = safeStr(env.MFLTEST_COMMISHCOOKIE || env.MFL_COOKIE || "");
        const targetCookieHeaderBase = targetCookieRaw
          ? (targetCookieRaw.includes("=") ? targetCookieRaw : `MFL_USER_ID=${targetCookieRaw}`)
          : "";
        if (!cookieHeader) return jsonOut(500, { ok: false, error: "Missing MFL_COOKIE secret for prod source reads." });
        if (!targetCookieHeaderBase) return jsonOut(500, { ok: false, error: "Missing MFLTEST_COMMISHCOOKIE secret for test target writes." });
        const sourceRostersRes = await mflExportJsonForCookie(cookieHeader, season, sourceLeagueId, "rosters", {}, { useCookie: true });
        if (!sourceRostersRes.ok) {
          return jsonOut(502, {
            ok: false,
            error: "Failed to load source rosters export",
            upstream: sourceRostersRes,
          });
        }
        const sourceSalariesRes = await mflExportJsonForCookie(cookieHeader, season, sourceLeagueId, "salaries", {}, { useCookie: true });
        if (!sourceSalariesRes.ok) {
          return jsonOut(502, {
            ok: false,
            error: "Failed to load source salaries export",
            upstream: sourceSalariesRes,
          });
        }

        const sourceByFranchise = rosterRowsByFranchiseFromRostersPayload(sourceRostersRes.data);
        const franchiseIds = Object.keys(sourceByFranchise).sort();
        const rosterSyncResults = [];

        for (const franchiseId of franchiseIds) {
          const franchiseCookieHeader = await establishCommishCookieHeader(targetCookieHeaderBase, season, targetLeagueId);
          const formRes = await fetchLoadRostFormForCookie(franchiseCookieHeader, season, targetLeagueId, franchiseId);
          if (!formRes.ok) {
            return jsonOut(502, {
              ok: false,
              error: "Failed to load target roster form",
              franchise_id: franchiseId,
              details: formRes,
            });
          }
          const desiredRosterIds = (sourceByFranchise[franchiseId] || []).map((row) => row.player_id);
          const currentRosterIds = formRes.currentRosterIds || [];
          const currentSet = new Set(currentRosterIds);
          const desiredSet = new Set(desiredRosterIds);
          const added = desiredRosterIds.filter((playerId) => !currentSet.has(playerId));
          const removed = currentRosterIds.filter((playerId) => !desiredSet.has(playerId));
          let postResult = { ok: true, skipped: true, status: 200 };
          if (added.length || removed.length || currentRosterIds.length !== desiredRosterIds.length) {
            postResult = await postLoadRostFormForCookie(franchiseCookieHeader, formRes, desiredRosterIds);
            if (!postResult.ok) {
              return jsonOut(502, {
                ok: false,
                error: "Target roster membership post failed",
                franchise_id: franchiseId,
                details: postResult,
              });
            }
          }
          rosterSyncResults.push({
            franchise_id: franchiseId,
            desired_count: desiredRosterIds.length,
            current_count: currentRosterIds.length,
            add_count: added.length,
            remove_count: removed.length,
            skipped: !!postResult.skipped,
            status: postResult.status,
          });
        }

        const taxiIrResults = [];
        for (const franchiseId of franchiseIds) {
          const sourceRows = sourceByFranchise[franchiseId] || [];
          const taxiIds = sourceRows.filter((row) => safeStr(row.status).includes("TAXI")).map((row) => row.player_id);
          const irIds = sourceRows.filter((row) => safeStr(row.status).includes("IR")).map((row) => row.player_id);
          const franchiseCookieHeader = await establishCommishCookieHeader(targetCookieHeaderBase, season, targetLeagueId);
          if (taxiIds.length) {
            const taxiRes = await postMflImportFormForCookie(
              franchiseCookieHeader,
              season,
              { TYPE: "taxi_squad", L: targetLeagueId, FRANCHISE_ID: franchiseId, DEMOTE: taxiIds.join(",") },
              { TYPE: "taxi_squad", L: targetLeagueId, FRANCHISE_ID: franchiseId }
            );
            if (!taxiRes.requestOk) {
              return jsonOut(502, {
                ok: false,
                error: "Target taxi sync failed",
                franchise_id: franchiseId,
                details: taxiRes,
              });
            }
            taxiIrResults.push({ franchise_id: franchiseId, type: "taxi_squad", count: taxiIds.length, status: taxiRes.status });
          }
          if (irIds.length) {
            const irRes = await postMflImportFormForCookie(
              franchiseCookieHeader,
              season,
              { TYPE: "ir", L: targetLeagueId, FRANCHISE_ID: franchiseId, DEACTIVATE: irIds.join(",") },
              { TYPE: "ir", L: targetLeagueId, FRANCHISE_ID: franchiseId }
            );
            if (!irRes.requestOk) {
              return jsonOut(502, {
                ok: false,
                error: "Target IR sync failed",
                franchise_id: franchiseId,
                details: irRes,
              });
            }
            taxiIrResults.push({ franchise_id: franchiseId, type: "ir", count: irIds.length, status: irRes.status });
          }
        }

        const salaryRows = [];
        const salaryPlayers = asArray(sourceSalariesRes?.data?.salaries?.leagueUnit?.player || sourceSalariesRes?.data?.salaries?.leagueunit?.player).filter(Boolean);
        for (const player of salaryPlayers) {
          salaryRows.push({
            player_id: String(player?.id || "").replace(/\D/g, ""),
            salary: safeStr(player?.salary || ""),
            contract_year: safeStr(player?.contractYear || ""),
            contract_status: safeStr(player?.contractStatus || ""),
            contract_info: safeStr(player?.contractInfo || ""),
          });
        }
        const salaryCookieHeader = await establishCommishCookieHeader(targetCookieHeaderBase, season, targetLeagueId);
        const salaryXml = buildSalaryImportXmlFromRows(salaryRows);
        const salaryImportRes = await postMflImportFormForCookie(
          salaryCookieHeader,
          season,
          { TYPE: "salaries", L: targetLeagueId, APPEND: "1", DATA: salaryXml },
          { TYPE: "salaries", L: targetLeagueId, APPEND: "1" }
        );
        if (!salaryImportRes.requestOk) {
          return jsonOut(502, {
            ok: false,
            error: "Target salary import failed",
            details: salaryImportRes,
          });
        }

        const verifyCookieHeader = await establishCommishCookieHeader(targetCookieHeaderBase, season, targetLeagueId);
        const verifyRostersRes = await mflExportJsonForCookie(verifyCookieHeader, season, targetLeagueId, "rosters", {}, { useCookie: true });
        const verifySalariesRes = await mflExportJsonForCookie(verifyCookieHeader, season, targetLeagueId, "salaries", {}, { useCookie: true });
        if (!verifyRostersRes.ok || !verifySalariesRes.ok) {
          return jsonOut(502, {
            ok: false,
            error: "Post-sync verification failed",
            rosters: verifyRostersRes,
            salaries: verifySalariesRes,
          });
        }
        const verifiedByFranchise = rosterRowsByFranchiseFromRostersPayload(verifyRostersRes.data);
        const salaryByPlayerVerified = parseSalaryRows(verifySalariesRes.data);
        for (const franchiseId of Object.keys(verifiedByFranchise)) {
          verifiedByFranchise[franchiseId] = (verifiedByFranchise[franchiseId] || []).map((row) => {
            const salaryRow = salaryByPlayerVerified[row.player_id] || {};
            return {
              ...row,
              salary: safeStr(salaryRow.salary != null ? salaryRow.salary : row.salary),
              contract_year: safeStr(salaryRow.contractYear != null ? salaryRow.contractYear : row.contract_year),
              contract_status: safeStr(salaryRow.contractStatus != null ? salaryRow.contractStatus : row.contract_status),
              contract_info: safeStr(salaryRow.contractInfo != null ? salaryRow.contractInfo : row.contract_info),
            };
          });
        }
        const mismatches = compareRosterState(sourceByFranchise, verifiedByFranchise);
        return jsonOut(200, {
          ok: mismatches.length === 0,
          season,
          source_league_id: sourceLeagueId,
          target_league_id: targetLeagueId,
          roster_sync: rosterSyncResults,
          status_sync: taxiIrResults,
          salary_import: {
            player_count: salaryRows.length,
            status: salaryImportRes.status,
          },
          verification: {
            mismatch_count: mismatches.length,
            mismatches: mismatches.slice(0, 50),
          },
        });
      }

      if (path === "/admin/discord/post" && request.method === "POST") {
        let body = {};
        try {
          body = (await request.json()) || {};
        } catch (_) {
          body = {};
        }
        if (!!commishApiKey && !sessionByApiKey) {
          return jsonOut(403, { ok: false, error: "Valid COMMISH_API_KEY is required for Discord post." });
        }
        const botToken = safeStr(env.DISCORD_BOT_TOKEN || env.DISCORD_BOT || env.Discord_bot || "");
        if (!botToken) return jsonOut(500, { ok: false, error: "Missing Discord bot token secret." });
        const channelId = safeStr(body?.channel_id || body?.channelId || "").replace(/\D/g, "");
        const content = safeStr(body?.content || "");
        if (!channelId) return jsonOut(400, { ok: false, error: "channel_id is required" });
        if (!content) return jsonOut(400, { ok: false, error: "content is required" });
        let res;
        let text = "";
        try {
          res = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
            method: "POST",
            headers: {
              Authorization: `Bot ${botToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              content,
              allowed_mentions: { parse: [] },
            }),
          });
          text = await res.text();
        } catch (e) {
          return jsonOut(502, { ok: false, error: `discord_fetch_failed: ${e?.message || String(e)}` });
        }
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (_) {
          data = null;
        }
      if (!res.ok) {
          return jsonOut(502, {
            ok: false,
            error: "Discord post failed",
            upstream_status: res.status,
            upstream_body: safeStr(text).slice(0, 800),
          });
        }
        return jsonOut(200, {
          ok: true,
          channel_id: channelId,
          message_id: safeStr(data?.id || ""),
        });
      }

      if (path === "/admin/deadline-reminders/test-discord" && request.method === "POST") {
        let body = {};
        try {
          body = (await request.json()) || {};
        } catch (_) {
          body = {};
        }
        if (!sessionByApiKey && !sessionByCookie) {
          return jsonOut(403, { ok: false, error: "Valid COMMISH_API_KEY or MFL_USER_ID is required for reminder test messages." });
        }
        const season = safeStr(body.season || body.year || body.YEAR || url.searchParams.get("YEAR") || YEAR || "");
        const leagueId = safeStr(body.league_id || body.leagueId || url.searchParams.get("L") || L || "");
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing league_id or L" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing season or YEAR" });
        const tradeDeadlineResolution = await resolveTradeDeadlineKickoffEt(season);
        const catalog = deadlineReminderCatalogForSeason(season, {
          trade_deadline: {
            deadline_date_et: safeStr(tradeDeadlineResolution.deadline_date_et),
            deadline_time_et: safeStr(tradeDeadlineResolution.deadline_time_et),
          },
        });
        if (!catalog.length) {
          return jsonOut(400, { ok: false, error: `No reminder calendar configured for season ${season}` });
        }
        const eventKey = safeStr(body.event_key || body.eventKey || url.searchParams.get("event_key") || "contract_deadline");
        const reminderCode = safeStr(body.reminder_code || body.reminderCode || url.searchParams.get("reminder_code") || "one_week");
        const sentKeys = new Set();
        const triggerDateEtOverride =
          safeStr(body.trigger_date_et || body.triggerDateEt || "") ||
          buildDueDeadlineReminders({
            season,
            catalog,
            currentEt: currentEtParts(),
            deliveryTarget: "test",
            sentKeys,
            eventKeyFilter: eventKey,
            reminderCodeFilter: reminderCode,
          })[0]?.trigger_date_et ||
          shiftPlainDateKey(
            catalog.find((row) => safeStr(row.event_key) === eventKey)?.deadline_date_et || "",
            -safeInt(
              Object.entries({
                one_week: 7,
                "72_hours": 3,
                "48_hours": 2,
                "24_hours": 1,
                "1_hour": 0,
              }).find(([key]) => key === reminderCode)?.[1] || 7,
              7
            )
          );
        const selectedEvent = catalog.find((row) => safeStr(row.event_key) === eventKey) || {};
        const triggerTimeEtOverride =
          safeStr(body.trigger_time_et || body.triggerTimeEt || "") ||
          (reminderCode === "1_hour"
            ? shiftDateTimeEt(
                safeStr(selectedEvent.deadline_date_et || ""),
                safeStr(selectedEvent.deadline_time_et || "09:00"),
                -60
              ).time_et
            : safeStr(selectedEvent.reminder_send_time_et || "09:00"));
        const triggerParts = parseEtTimeParts(triggerTimeEtOverride, 9, 0);
        const due = buildDueDeadlineReminders({
          season,
          catalog,
          currentEt: {
            date_key: triggerDateEtOverride,
            hour: triggerParts.hour,
            minute: triggerParts.minute,
          },
          deliveryTarget: "test",
          sentKeys,
          eventKeyFilter: eventKey,
          reminderCodeFilter: reminderCode,
        });
        let reminder = due[0] || null;
        if (!reminder && selectedEvent && safeStr(selectedEvent.event_key)) {
          let triggerDateEt = triggerDateEtOverride;
          let triggerTimeEt = triggerTimeEtOverride;
          let reminderLabel = reminderCode;
          let reminderDaysBefore = 0;
          let reminderHoursBefore = 0;
          if (reminderCode === "one_week") {
            triggerDateEt = shiftPlainDateKey(safeStr(selectedEvent.deadline_date_et || ""), -7);
            triggerTimeEt = safeStr(selectedEvent.reminder_send_time_et || "09:00");
            reminderLabel = "1 Week";
            reminderDaysBefore = 7;
          } else if (reminderCode === "72_hours") {
            triggerDateEt = shiftPlainDateKey(safeStr(selectedEvent.deadline_date_et || ""), -3);
            triggerTimeEt = safeStr(selectedEvent.reminder_send_time_et || "09:00");
            reminderLabel = "72 Hours";
            reminderDaysBefore = 3;
          } else if (reminderCode === "48_hours") {
            triggerDateEt = shiftPlainDateKey(safeStr(selectedEvent.deadline_date_et || ""), -2);
            triggerTimeEt = safeStr(selectedEvent.reminder_send_time_et || "09:00");
            reminderLabel = "48 Hours";
            reminderDaysBefore = 2;
          } else if (reminderCode === "24_hours") {
            triggerDateEt = shiftPlainDateKey(safeStr(selectedEvent.deadline_date_et || ""), -1);
            triggerTimeEt = safeStr(selectedEvent.reminder_send_time_et || "09:00");
            reminderLabel = "24 Hours";
            reminderDaysBefore = 1;
          } else if (reminderCode === "1_hour") {
            const shifted = shiftDateTimeEt(
              safeStr(selectedEvent.deadline_date_et || ""),
              safeStr(selectedEvent.deadline_time_et || "09:00"),
              -60
            );
            triggerDateEt = safeStr(shifted.date_key || triggerDateEtOverride);
            triggerTimeEt = safeStr(shifted.time_et || triggerTimeEtOverride);
            reminderLabel = "1 Hour";
            reminderHoursBefore = 1;
          }
          reminder = {
            season: safeStr(season),
            event_key: safeStr(selectedEvent.event_key),
            title: safeStr(selectedEvent.title),
            deadline_date_et: safeStr(selectedEvent.deadline_date_et),
            deadline_time_et: safeStr(selectedEvent.deadline_time_et || "23:59"),
            summary: safeStr(selectedEvent.summary),
            reminder_days_before: reminderDaysBefore,
            reminder_hours_before: reminderHoursBefore,
            reminder_code: reminderCode,
            reminder_label: reminderLabel,
            trigger_date_et: triggerDateEt,
            trigger_time_et: triggerTimeEt,
            reminder_key: buildDeadlineReminderKey({
              season,
              eventKey: safeStr(selectedEvent.event_key),
              reminderCode,
              deliveryTarget: "test",
            }),
          };
        }
        if (!reminder) {
          return jsonOut(400, {
            ok: false,
            error: "Could not resolve reminder entry for test send",
            season: safeInt(season, Number(season) || 0),
            event_key: eventKey,
            reminder_code: reminderCode,
          });
        }
        const notify = await sendDiscordDeadlineReminder({
          reminder,
          forceTestOnly: true,
        });
        return jsonOut(notify && notify.ok ? 200 : 502, {
          ok: !!(notify && notify.ok),
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          test_only: true,
          reminder,
          trade_deadline_resolution: tradeDeadlineResolution,
          notify,
        });
      }

      if (path === "/admin/deadline-reminders/run" && request.method === "POST") {
        let body = {};
        try {
          body = (await request.json()) || {};
        } catch (_) {
          body = {};
        }
        if (!sessionByApiKey && !sessionByCookie) {
          return jsonOut(403, { ok: false, error: "Valid COMMISH_API_KEY or MFL_USER_ID is required for reminder delivery." });
        }
        const season = safeStr(body.season || body.year || body.YEAR || url.searchParams.get("YEAR") || YEAR || "");
        const leagueId = safeStr(body.league_id || body.leagueId || url.searchParams.get("L") || L || "");
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing league_id or L" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing season or YEAR" });
        const nowEt = currentEtParts();
        const loaded = await readDeadlineRemindersDoc(season);
        if (!loaded.ok) {
          return jsonOut(500, {
            ok: false,
            error: loaded.error || "deadline_reminder_log_read_failed",
            storage: {
              file_path: loaded.filePath || "",
              upstream_status: loaded.upstreamStatus || 0,
              upstream_preview: loaded.upstreamPreview || "",
            },
          });
        }
        const doc = normalizeDeadlineRemindersDoc(loaded.doc, season);
        const previousTradeDeadlineResolution =
          doc.meta && typeof doc.meta.trade_deadline_resolution === "object"
            ? doc.meta.trade_deadline_resolution
            : {};
        const fetchedTradeDeadlineResolution = await resolveTradeDeadlineKickoffEt(season);
        const previousOfficialTradeDeadlineResolution =
          safeInt(previousTradeDeadlineResolution.fallback_used, 1) === 0 &&
          safeStr(previousTradeDeadlineResolution.deadline_date_et) &&
          safeStr(previousTradeDeadlineResolution.deadline_time_et)
            ? previousTradeDeadlineResolution
            : null;
        const tradeDeadlineResolution =
          safeInt(fetchedTradeDeadlineResolution.fallback_used, 1) === 1 && previousOfficialTradeDeadlineResolution
            ? {
                ...previousOfficialTradeDeadlineResolution,
                checked_at_utc: safeStr(fetchedTradeDeadlineResolution.checked_at_utc || new Date().toISOString()),
                upstream_status: safeInt(fetchedTradeDeadlineResolution.upstream_status, 0),
                upstream_error: safeStr(fetchedTradeDeadlineResolution.upstream_error || ""),
                source_url: safeStr(fetchedTradeDeadlineResolution.source_url || previousOfficialTradeDeadlineResolution.source_url || ""),
              }
            : fetchedTradeDeadlineResolution;
        const catalog = deadlineReminderCatalogForSeason(season, {
          trade_deadline: {
            deadline_date_et: safeStr(tradeDeadlineResolution.deadline_date_et),
            deadline_time_et: safeStr(tradeDeadlineResolution.deadline_time_et),
          },
        });
        if (!catalog.length) {
          return jsonOut(400, { ok: false, error: `No reminder calendar configured for season ${season}` });
        }
        const tradeResolutionChanged = tradeDeadlineResolutionChanged(previousTradeDeadlineResolution, tradeDeadlineResolution);
        const tradeResolutionNotify = shouldNotifyTradeDeadlineResolution(
          previousTradeDeadlineResolution,
          tradeDeadlineResolution
        );
        const tradeResolutionPersist = tradeResolutionChanged && safeInt(tradeDeadlineResolution.fallback_used, 1) === 0;
        if (tradeResolutionPersist) {
          doc.meta.trade_deadline_resolution = tradeDeadlineResolution;
        }
        const sentKeys = new Set((Array.isArray(doc.reminders) ? doc.reminders : []).map((row) => sentDeadlineReminderKey(row)).filter(Boolean));
        const due = buildDueDeadlineReminders({
          season,
          catalog,
          currentEt: nowEt,
          deliveryTarget: "primary",
          sentKeys,
        });
        const spacingSeconds = Math.max(0, safeInt(body.spacing_seconds || body.spacingSeconds || 5, 5));
        const results = [];
        const newRows = [];
        for (let i = 0; i < due.length; i += 1) {
          const reminder = due[i];
          const notify = await sendDiscordDeadlineReminder({
            reminder,
            forcePrimaryOnly: true,
          });
          results.push({
            event_key: reminder.event_key,
            reminder_code: reminder.reminder_code,
            reminder_key: reminder.reminder_key,
            ok: !!(notify && notify.ok),
            notify,
          });
          if (notify && notify.ok) {
            newRows.push({
              season: safeInt(season, Number(season) || 0),
              league_id: leagueId,
              reminder_key: reminder.reminder_key,
              event_key: reminder.event_key,
              event_title: reminder.title,
              deadline_date_et: reminder.deadline_date_et,
              deadline_time_et: reminder.deadline_time_et,
              trigger_date_et: reminder.trigger_date_et,
              trigger_time_et: reminder.trigger_time_et,
              reminder_code: reminder.reminder_code,
              reminder_label: reminder.reminder_label,
              delivery_target: safeStr(notify.delivery_target || "primary"),
              test_flag: 0,
              discord_channel_id: safeStr(notify.channel_id || ""),
              discord_message_id: safeStr(notify.message_id || ""),
              gif_query: safeStr(notify.gif_query || ""),
              gif_url: safeStr(notify.gif_url || ""),
              posted_at_utc: new Date().toISOString(),
              source: "worker-deadline-reminders",
            });
          }
          if (i < due.length - 1 && spacingSeconds > 0) {
            await sleepMs(spacingSeconds * 1000);
          }
        }
        let saved = null;
        const needsDocSave = newRows.length || tradeResolutionPersist;
        if (needsDocSave) {
          doc.reminders = [...newRows, ...(Array.isArray(doc.reminders) ? doc.reminders : [])];
          saved = await writeDeadlineRemindersDoc(
            season,
            doc,
            loaded.sha,
            tradeResolutionPersist && newRows.length
              ? `Update trade deadline resolution and log deadline reminders for ${season}`
              : tradeResolutionPersist
              ? `Update trade deadline resolution for ${season}`
              : `Log deadline reminders for ${season}`
          );
          if (!saved.ok) {
            return jsonOut(500, {
              ok: false,
              error: saved.error || "deadline_reminder_log_write_failed",
              count_due: due.length,
              count_sent: newRows.length,
              results,
              storage: {
                file_path: saved.filePath || loaded.filePath || "",
                upstream_status: saved.upstreamStatus || 0,
                upstream_preview: saved.upstreamPreview || "",
              },
            });
          }
        }
        let resolutionDmResults = [];
        if (tradeResolutionNotify) {
          const dmUserIds = parseDiscordUserIds(env.DISCORD_DM_USER_IDS || "");
          if (dmUserIds.length) {
            resolutionDmResults = await sendDiscordDmEmbedsToUsers({
              userIds: dmUserIds,
              content: "",
              embeds: [
                buildTradeDeadlineResolutionDmEmbed({
                  season,
                  previous: previousTradeDeadlineResolution,
                  current: tradeDeadlineResolution,
                }),
              ],
            });
          }
        }
        const allOk = results.every((row) => row.ok);
        return jsonOut(allOk ? 200 : 502, {
          ok: allOk,
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          now_et: nowEt,
          count_due: due.length,
          count_sent: newRows.length,
          spacing_seconds: spacingSeconds,
          trade_deadline_resolution: tradeDeadlineResolution,
          trade_deadline_resolution_changed: tradeResolutionChanged,
          trade_deadline_resolution_persisted: tradeResolutionPersist,
          trade_deadline_resolution_dm: resolutionDmResults,
          storage: saved
            ? {
                file_path: saved.filePath || "",
                commit_sha: saved.commitSha || "",
                content_sha: saved.contentSha || "",
              }
            : null,
          results,
        });
      }

      // POST /admin/trade-notification/test-discord (and /post)
      // Body: {
      //   league_id, season,
      //   trade_date_iso, trade_id?,
      //   left_franchise_id, left_franchise_name,
      //   right_franchise_id, right_franchise_name,
      //   left_receives: [ { kind:'player'|'pick'|'cap', ... } ],
      //   right_receives: [ ... ],
      //   cap_adjustments: [ { franchise_name, amount } ],  // optional
      //   note_text?,                                       // freeform analysis
      //   featured_player_name?                             // GIF search seed
      // }
      if ((path === "/admin/trade-notification/test-discord" || path === "/admin/trade-notification/post") && request.method === "POST") {
        let body = {};
        try {
          body = (await request.json()) || {};
        } catch (_) {
          return jsonOut(400, { ok: false, error: "Invalid JSON body" });
        }
        const leagueId = safeStr(url.searchParams.get("L") || L || body.league_id || "");
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || body.season || "");
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L/league_id" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR/season" });
        const adminState = await getLeagueAdminState(leagueId, season);
        if (!adminState.ok || !adminState.isAdmin) {
          return jsonOut(403, { ok: false, error: "Only league admin can send trade notifications" });
        }
        const missing = [];
        if (!body.trade_date_iso) missing.push("trade_date_iso");
        if (!body.left_franchise_name) missing.push("left_franchise_name");
        if (!body.right_franchise_name) missing.push("right_franchise_name");
        if (missing.length) return jsonOut(400, { ok: false, error: "missing_fields", missing });
        const isTest = path === "/admin/trade-notification/test-discord";
        const notify = await sendDiscordTradeNotification({
          leagueId,
          season,
          tradeDateIso: body.trade_date_iso,
          tradeId: body.trade_id,
          leftFranchiseId: body.left_franchise_id,
          leftFranchiseName: body.left_franchise_name,
          rightFranchiseId: body.right_franchise_id,
          rightFranchiseName: body.right_franchise_name,
          leftReceives: body.left_receives,
          rightReceives: body.right_receives,
          capAdjustments: body.cap_adjustments,
          noteText: body.note_text,
          featuredPlayerName: body.featured_player_name,
          forceTestOnly: isTest,
          forcePrimaryOnly: !isTest,
          channelIdOverride: isTest ? "" : (body.channel_id_override || ""),
        });
        return jsonOut(notify.ok ? 200 : 502, {
          ok: !!notify.ok,
          test_only: isTest,
          delivery_target: safeStr(notify.delivery_target),
          notify,
        });
      }

      // POST /admin/cap-penalty/test-discord (and /post)
      // Body: {
      //   league_id, season,
      //   franchise_id, franchise_name,
      //   team_total_dollars,
      //   activity_year_label,               // e.g. "2025 Activity"
      //   cap_penalty_lines: string[]        // pre-formatted narrative per drop
      //   channel_id_override? (for /post)
      // }
      // POST /admin/restructure-alert/test-discord (and /post)
      // Body: {
      //   league_id, season, franchise_id, franchise_name, player_name,
      //   years_remaining (int),
      //   tcv_label (string, e.g. "129K" or "$129,000"),
      //   guaranteed_label (string, e.g. "96.8K"),
      //   aav_label (string, e.g. "54K"),  // NEVER recomputed
      //   usage_text (string, e.g. "Restructure: 1 of 3 - 2 remaining. ..."),
      //   channel_id_override? (for /post)
      // }
      if ((path === "/admin/restructure-alert/test-discord" || path === "/admin/restructure-alert/post") && request.method === "POST") {
        let body = {};
        try { body = (await request.json()) || {}; }
        catch (_) { return jsonOut(400, { ok: false, error: "Invalid JSON body" }); }
        const leagueId = safeStr(url.searchParams.get("L") || L || body.league_id || "");
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || body.season || "");
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L/league_id" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR/season" });
        const adminState = await getLeagueAdminState(leagueId, season);
        if (!adminState.ok || !adminState.isAdmin) {
          return jsonOut(403, { ok: false, error: "Only league admin can send restructure alerts" });
        }
        const missing = [];
        if (!body.player_name) missing.push("player_name");
        if (!body.franchise_name) missing.push("franchise_name");
        if (missing.length) return jsonOut(400, { ok: false, error: "missing_fields", missing });
        const isTest = path === "/admin/restructure-alert/test-discord";
        const notify = await sendDiscordRestructureAlert({
          leagueId, season,
          franchiseId: body.franchise_id,
          franchiseName: body.franchise_name,
          playerName: body.player_name,
          yearsRemaining: body.years_remaining,
          tcvLabel: body.tcv_label,
          guaranteedLabel: body.guaranteed_label,
          aavLabel: body.aav_label,
          yearlyBreakdown: body.yearly_breakdown,
          usageText: body.usage_text,
          gifUrlOverride: body.gif_url_override,
          forceTestOnly: isTest,
          forcePrimaryOnly: !isTest,
          channelIdOverride: isTest ? "" : (body.channel_id_override || ""),
        });
        return jsonOut(notify.ok ? 200 : 502, {
          ok: !!notify.ok,
          test_only: isTest,
          delivery_target: safeStr(notify.delivery_target),
          notify,
        });
      }

      if ((path === "/admin/cap-penalty/test-discord" || path === "/admin/cap-penalty/post") && request.method === "POST") {
        let body = {};
        try {
          body = (await request.json()) || {};
        } catch (_) {
          return jsonOut(400, { ok: false, error: "Invalid JSON body" });
        }
        const leagueId = safeStr(url.searchParams.get("L") || L || body.league_id || "");
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || body.season || "");
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L/league_id" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR/season" });
        const adminState = await getLeagueAdminState(leagueId, season);
        if (!adminState.ok || !adminState.isAdmin) {
          return jsonOut(403, { ok: false, error: "Only league admin can send cap penalty announcements" });
        }
        const missing = [];
        if (!body.franchise_name) missing.push("franchise_name");
        if (!Array.isArray(body.cap_penalty_lines) || !body.cap_penalty_lines.length) missing.push("cap_penalty_lines");
        if (missing.length) return jsonOut(400, { ok: false, error: "missing_fields", missing });
        const isTest = path === "/admin/cap-penalty/test-discord";
        const notify = await sendDiscordCapPenaltyAnnouncement({
          leagueId,
          season,
          franchiseId: body.franchise_id,
          franchiseName: body.franchise_name,
          teamTotalDollars: body.team_total_dollars,
          capPenaltyLines: body.cap_penalty_lines,
          activityYearLabel: body.activity_year_label,
          forceTestOnly: isTest,
          forcePrimaryOnly: !isTest,
          channelIdOverride: isTest ? "" : (body.channel_id_override || ""),
        });
        return jsonOut(notify.ok ? 200 : 502, {
          ok: !!notify.ok,
          test_only: isTest,
          delivery_target: safeStr(notify.delivery_target),
          notify,
        });
      }

      if (path === "/admin/contract-activity/test-discord" && request.method === "POST") {
        let body = {};
        try {
          body = (await request.json()) || {};
        } catch (_) {
          return jsonOut(400, { ok: false, error: "Invalid JSON body" });
        }

        const leagueId = safeStr(
          url.searchParams.get("L") ||
            L ||
            body.league_id ||
            body.leagueId ||
            ""
        );
        const season = safeStr(
          url.searchParams.get("YEAR") ||
            YEAR ||
            body.season ||
            body.year ||
            ""
        );
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L/league_id" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR/season" });

        const adminState = await getLeagueAdminState(leagueId, season);
        if (!adminState.ok || !adminState.isAdmin) {
          return jsonOut(403, { ok: false, error: "Only league admin can send contract activity test messages" });
        }

        const playerName = safeStr(body.player_name || body.playerName || "");
        const franchiseId = padFranchiseId(body.franchise_id || body.franchiseId || "");
        const franchiseName = safeStr(body.franchise_name || body.franchiseName || "");
        const creditedFranchiseId = padFranchiseId(
          body.credited_franchise_id || body.creditedFranchiseId || franchiseId
        );
        const creditedFranchiseName = safeStr(
          body.credited_franchise_name || body.creditedFranchiseName || franchiseName
        );
        const tradePartnerName = safeStr(body.trade_partner_name || body.tradePartnerName || "");
        const contractInfo = safeStr(body.contract_info || body.contractInfo || "");
        const contractYear = safeStr(body.contract_year || body.contractYear || "");
        const salary = safeStr(body.salary || "");
        const submittedAtUtc = safeStr(body.submitted_at_utc || body.submittedAtUtc || new Date().toISOString());
        const contractStatus = safeStr(body.contract_status || body.contractStatus || "");
        const usageLabel = safeStr(body.usage_label || body.usageLabel || "");
        const noteText = safeStr(body.note_text || body.noteText || "");
        const activityType =
          safeStr(body.activity_type || body.activityType || "") ||
          deriveContractActivityType({
            isExtensionSubmission: /\bext/i.test(contractStatus),
            isRestructure: /\brestructure\b/i.test(contractStatus),
            contractStatus,
          });

        const missingFields = [];
        if (!playerName) missingFields.push("player_name");
        if (!franchiseId) missingFields.push("franchise_id");
        if (!contractInfo) missingFields.push("contract_info");
        if (!contractYear) missingFields.push("contract_year");
        if (!salary) missingFields.push("salary");
        if (missingFields.length) {
          return jsonOut(400, {
            ok: false,
            error: "Missing required fields",
            missing_fields: missingFields,
          });
        }

        const notify = await sendDiscordContractActivity({
          activityType,
          leagueId,
          franchiseId,
          franchiseName,
          creditedFranchiseId,
          creditedFranchiseName,
          playerName,
          contractInfo,
          contractYear,
          contractStatus,
          season,
          salary,
          submittedAtUtc,
          forceTestOnly: true,
          bypassAnnouncementRules: true,
          usageLabel,
          noteText,
          tradePartnerName,
        });
        return jsonOut(notify && notify.ok ? 200 : 502, {
          ok: !!(notify && notify.ok),
          test_only: true,
          delivery_target: "test",
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          player_name: playerName,
          franchise_id: franchiseId,
          activity_type: activityType,
          notify,
        });
      }

      if (path === "/admin/contract-activity/test-discord-batch" && request.method === "POST") {
        let body = {};
        try {
          body = (await request.json()) || {};
        } catch (_) {
          return jsonOut(400, { ok: false, error: "Invalid JSON body" });
        }

        const leagueId = safeStr(
          url.searchParams.get("L") ||
            L ||
            body.league_id ||
            body.leagueId ||
            ""
        );
        const season = safeStr(
          url.searchParams.get("YEAR") ||
            YEAR ||
            body.season ||
            body.year ||
            ""
        );
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L/league_id" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR/season" });

        const adminState = await getLeagueAdminState(leagueId, season);
        if (!adminState.ok || !adminState.isAdmin) {
          return jsonOut(403, { ok: false, error: "Only league admin can send contract activity test messages" });
        }

        const entries = Array.isArray(body.entries) ? body.entries.filter((row) => row && typeof row === "object") : [];
        if (!entries.length) {
          return jsonOut(400, { ok: false, error: "entries array is required" });
        }
        const spacingSeconds = Math.max(0, safeInt(body.spacing_seconds || body.spacingSeconds || 30, 30));
        const results = [];
        for (let i = 0; i < entries.length; i += 1) {
          const fields = parseContractActivityRequestFields(entries[i], body);
          const missingFields = [];
          if (!fields.playerName) missingFields.push("player_name");
          if (!fields.franchiseId) missingFields.push("franchise_id");
          if (!fields.contractInfo) missingFields.push("contract_info");
          if (!fields.contractYear) missingFields.push("contract_year");
          if (!fields.salary) missingFields.push("salary");
          if (missingFields.length) {
            results.push({
              index: i,
              ok: false,
              error: "Missing required fields",
              missing_fields: missingFields,
              player_name: fields.playerName,
              franchise_id: fields.franchiseId,
              activity_type: fields.activityType,
            });
          } else {
            const notify = await sendDiscordContractActivity({
              activityType: fields.activityType,
              leagueId,
              franchiseId: fields.franchiseId,
              franchiseName: fields.franchiseName,
              creditedFranchiseId: fields.creditedFranchiseId,
              creditedFranchiseName: fields.creditedFranchiseName,
              playerName: fields.playerName,
              contractInfo: fields.contractInfo,
              contractYear: fields.contractYear,
              contractStatus: fields.contractStatus,
              season,
              salary: fields.salary,
              submittedAtUtc: fields.submittedAtUtc,
              forceTestOnly: true,
              bypassAnnouncementRules: true,
              usageLabel: fields.usageLabel,
              noteText: fields.noteText,
              tradePartnerName: fields.tradePartnerName,
            });
            results.push({
              index: i,
              ok: !!(notify && notify.ok),
              player_name: fields.playerName,
              franchise_id: fields.franchiseId,
              activity_type: fields.activityType,
              notify,
            });
          }
          if (i < entries.length - 1 && spacingSeconds > 0) {
            await sleepMs(spacingSeconds * 1000);
          }
        }
        const allOk = results.every((row) => row.ok);
        return jsonOut(allOk ? 200 : 502, {
          ok: allOk,
          test_only: true,
          delivery_target: "test",
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          spacing_seconds: spacingSeconds,
          count: results.length,
          results,
        });
      }

      if (path === "/admin/contract-activity/post" && request.method === "POST") {
        let body = {};
        try {
          body = (await request.json()) || {};
        } catch (_) {
          return jsonOut(400, { ok: false, error: "Invalid JSON body" });
        }

        const leagueId = safeStr(
          url.searchParams.get("L") ||
            L ||
            body.league_id ||
            body.leagueId ||
            ""
        );
        const season = safeStr(
          url.searchParams.get("YEAR") ||
            YEAR ||
            body.season ||
            body.year ||
            ""
        );
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L/league_id" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR/season" });

        const adminState = await getLeagueAdminState(leagueId, season);
        if (!adminState.ok || !adminState.isAdmin) {
          return jsonOut(403, { ok: false, error: "Only league admin can send contract activity messages" });
        }

        const playerName = safeStr(body.player_name || body.playerName || "");
        const franchiseId = padFranchiseId(body.franchise_id || body.franchiseId || "");
        const franchiseName = safeStr(body.franchise_name || body.franchiseName || "");
        const creditedFranchiseId = padFranchiseId(
          body.credited_franchise_id || body.creditedFranchiseId || franchiseId
        );
        const creditedFranchiseName = safeStr(
          body.credited_franchise_name || body.creditedFranchiseName || franchiseName
        );
        const tradePartnerName = safeStr(body.trade_partner_name || body.tradePartnerName || "");
        const contractInfo = safeStr(body.contract_info || body.contractInfo || "");
        const contractYear = safeStr(body.contract_year || body.contractYear || "");
        const salary = safeStr(body.salary || "");
        const submittedAtUtc = safeStr(body.submitted_at_utc || body.submittedAtUtc || new Date().toISOString());
        const contractStatus = safeStr(body.contract_status || body.contractStatus || "");
        const usageLabel = safeStr(body.usage_label || body.usageLabel || "");
        const noteText = safeStr(body.note_text || body.noteText || "");
        const activityType =
          safeStr(body.activity_type || body.activityType || "") ||
          deriveContractActivityType({
            isExtensionSubmission: /\bext/i.test(contractStatus),
            isRestructure: /\brestructure\b/i.test(contractStatus),
            contractStatus,
          });
        const channelIdOverride = safeStr(body.channel_id || body.channelId || "");
        const pinMessage = !!safeInt(body.pin_message || body.pinMessage || 0);
        const deliveryTargetRaw = safeStr(body.delivery_target || body.deliveryTarget || "").toLowerCase();
        const forceTestOnly = deliveryTargetRaw === "test";
        const forcePrimaryOnly = deliveryTargetRaw === "primary";
        const dmUserIds = body.dm_user_ids || body.dmUserIds || env.DISCORD_DM_USER_IDS || "";

        const missingFields = [];
        if (!playerName) missingFields.push("player_name");
        if (!franchiseId) missingFields.push("franchise_id");
        if (!contractInfo) missingFields.push("contract_info");
        if (!contractYear) missingFields.push("contract_year");
        if (!salary) missingFields.push("salary");
        if (missingFields.length) {
          return jsonOut(400, {
            ok: false,
            error: "Missing required fields",
            missing_fields: missingFields,
          });
        }

        const notify = deliveryTargetRaw === "dm"
          ? await sendDiscordContractActivityDm({
              activityType,
              leagueId,
              franchiseId,
              franchiseName,
              creditedFranchiseId,
              creditedFranchiseName,
              playerName,
              contractInfo,
              contractYear,
              contractStatus,
              season,
              salary,
              submittedAtUtc,
              usageLabel,
              noteText,
              tradePartnerName,
              dmUserIds,
            })
          : await sendDiscordContractActivity({
              activityType,
              leagueId,
              franchiseId,
              franchiseName,
              creditedFranchiseId,
              creditedFranchiseName,
              playerName,
              contractInfo,
              contractYear,
              contractStatus,
              season,
              salary,
              submittedAtUtc,
              forceTestOnly,
              forcePrimaryOnly,
              channelIdOverride,
              pinMessage,
              usageLabel,
              noteText,
              tradePartnerName,
            });
        return jsonOut(notify && notify.ok ? 200 : 502, {
          ok: !!(notify && notify.ok),
          delivery_target: safeStr((notify && notify.delivery_target) || deliveryTargetRaw || ""),
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          player_name: playerName,
          franchise_id: franchiseId,
          activity_type: activityType,
          notify,
        });
      }

      if (path === "/admin/contract-activity/post-batch" && request.method === "POST") {
        let body = {};
        try {
          body = (await request.json()) || {};
        } catch (_) {
          return jsonOut(400, { ok: false, error: "Invalid JSON body" });
        }

        const leagueId = safeStr(
          url.searchParams.get("L") ||
            L ||
            body.league_id ||
            body.leagueId ||
            ""
        );
        const season = safeStr(
          url.searchParams.get("YEAR") ||
            YEAR ||
            body.season ||
            body.year ||
            ""
        );
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L/league_id" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR/season" });

        const adminState = await getLeagueAdminState(leagueId, season);
        if (!adminState.ok || !adminState.isAdmin) {
          return jsonOut(403, { ok: false, error: "Only league admin can send contract activity messages" });
        }

        const entries = Array.isArray(body.entries) ? body.entries.filter((row) => row && typeof row === "object") : [];
        if (!entries.length) {
          return jsonOut(400, { ok: false, error: "entries array is required" });
        }
        const spacingSeconds = Math.max(0, safeInt(body.spacing_seconds || body.spacingSeconds || 30, 30));
        const channelIdOverride = safeStr(body.channel_id || body.channelId || "");
        const pinMessage = !!safeInt(body.pin_message || body.pinMessage || 0);
        const deliveryTargetRaw = safeStr(body.delivery_target || body.deliveryTarget || "").toLowerCase();
        const forceTestOnly = deliveryTargetRaw === "test";
        const forcePrimaryOnly = deliveryTargetRaw === "primary";
        const results = [];
        for (let i = 0; i < entries.length; i += 1) {
          const fields = parseContractActivityRequestFields(entries[i], body);
          const missingFields = [];
          if (!fields.playerName) missingFields.push("player_name");
          if (!fields.franchiseId) missingFields.push("franchise_id");
          if (!fields.contractInfo) missingFields.push("contract_info");
          if (!fields.contractYear) missingFields.push("contract_year");
          if (!fields.salary) missingFields.push("salary");
          if (missingFields.length) {
            results.push({
              index: i,
              ok: false,
              error: "Missing required fields",
              missing_fields: missingFields,
              player_name: fields.playerName,
              franchise_id: fields.franchiseId,
              activity_type: fields.activityType,
            });
          } else {
            const notify = await sendDiscordContractActivity({
              activityType: fields.activityType,
              leagueId,
              franchiseId: fields.franchiseId,
              franchiseName: fields.franchiseName,
              creditedFranchiseId: fields.creditedFranchiseId,
              creditedFranchiseName: fields.creditedFranchiseName,
              playerName: fields.playerName,
              contractInfo: fields.contractInfo,
              contractYear: fields.contractYear,
              contractStatus: fields.contractStatus,
              season,
              salary: fields.salary,
              submittedAtUtc: fields.submittedAtUtc,
              forceTestOnly,
              forcePrimaryOnly,
              channelIdOverride,
              pinMessage,
              usageLabel: fields.usageLabel,
              noteText: fields.noteText,
              tradePartnerName: fields.tradePartnerName,
            });
            results.push({
              index: i,
              ok: !!(notify && notify.ok),
              player_name: fields.playerName,
              franchise_id: fields.franchiseId,
              activity_type: fields.activityType,
              notify,
            });
          }
          if (i < entries.length - 1 && spacingSeconds > 0) {
            await sleepMs(spacingSeconds * 1000);
          }
        }
        const allOk = results.every((row) => row.ok);
        return jsonOut(allOk ? 200 : 502, {
          ok: allOk,
          delivery_target: deliveryTargetRaw || "",
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          spacing_seconds: spacingSeconds,
          count: results.length,
          results,
        });
      }

      if (path === "/admin/contract-activity/edit" && request.method === "POST") {
        let body = {};
        try {
          body = (await request.json()) || {};
        } catch (_) {
          return jsonOut(400, { ok: false, error: "Invalid JSON body" });
        }

        const leagueId = safeStr(
          url.searchParams.get("L") ||
            L ||
            body.league_id ||
            body.leagueId ||
            ""
        );
        const season = safeStr(
          url.searchParams.get("YEAR") ||
            YEAR ||
            body.season ||
            body.year ||
            ""
        );
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L/league_id" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR/season" });

        const adminState = await getLeagueAdminState(leagueId, season);
        if (!adminState.ok || !adminState.isAdmin) {
          return jsonOut(403, { ok: false, error: "Only league admin can edit contract activity messages" });
        }

        const playerName = safeStr(body.player_name || body.playerName || "");
        const franchiseId = padFranchiseId(body.franchise_id || body.franchiseId || "");
        const franchiseName = safeStr(body.franchise_name || body.franchiseName || "");
        const creditedFranchiseId = padFranchiseId(
          body.credited_franchise_id || body.creditedFranchiseId || franchiseId
        );
        const creditedFranchiseName = safeStr(
          body.credited_franchise_name || body.creditedFranchiseName || franchiseName
        );
        const tradePartnerName = safeStr(body.trade_partner_name || body.tradePartnerName || "");
        const contractInfo = safeStr(body.contract_info || body.contractInfo || "");
        const contractYear = safeStr(body.contract_year || body.contractYear || "");
        const salary = safeStr(body.salary || "");
        const submittedAtUtc = safeStr(body.submitted_at_utc || body.submittedAtUtc || new Date().toISOString());
        const contractStatus = safeStr(body.contract_status || body.contractStatus || "");
        const usageLabel = safeStr(body.usage_label || body.usageLabel || "");
        const noteText = safeStr(body.note_text || body.noteText || "");
        const activityType =
          safeStr(body.activity_type || body.activityType || "") ||
          deriveContractActivityType({
            isExtensionSubmission: /\bext/i.test(contractStatus),
            isRestructure: /\brestructure\b/i.test(contractStatus),
            contractStatus,
          });
        const channelId = safeStr(body.channel_id || body.channelId || "");
        const messageId = safeStr(body.message_id || body.messageId || "");
        const gifUrl = safeStr(body.gif_url || body.gifUrl || "");

        const missingFields = [];
        if (!playerName) missingFields.push("player_name");
        if (!franchiseId) missingFields.push("franchise_id");
        if (!contractInfo) missingFields.push("contract_info");
        if (!contractYear) missingFields.push("contract_year");
        if (!salary) missingFields.push("salary");
        if (!channelId) missingFields.push("channel_id");
        if (!messageId) missingFields.push("message_id");
        if (missingFields.length) {
          return jsonOut(400, {
            ok: false,
            error: "Missing required fields",
            missing_fields: missingFields,
          });
        }

        const notify = await editDiscordContractActivity({
          activityType,
          leagueId,
          franchiseId,
          franchiseName,
          creditedFranchiseId,
          creditedFranchiseName,
          playerName,
          contractInfo,
          contractYear,
          season,
          salary,
          submittedAtUtc,
          channelId,
          messageId,
          gifUrl,
          usageLabel,
          noteText,
          tradePartnerName,
        });
        return jsonOut(notify && notify.ok ? 200 : 502, {
          ok: !!(notify && notify.ok),
          delivery_target: "edit",
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          player_name: playerName,
          franchise_id: franchiseId,
          activity_type: activityType,
          notify,
        });
      }

      if (path === "/roster-workbench/action" && request.method === "POST") {
        let body = {};
        try {
          body = (await request.json()) || {};
        } catch (_) {
          body = {};
        }

        const season = safeStr(body?.season || body?.YEAR || url.searchParams.get("YEAR") || YEAR || "");
        const leagueId = safeStr(body?.league_id || body?.L || url.searchParams.get("L") || L || "");
        const action = safeStr(body?.action || url.searchParams.get("action")).toLowerCase();
        const playerId = String(body?.player_id || url.searchParams.get("player_id") || "").replace(/\D/g, "");
        const franchiseId = padFranchiseId(
          body?.franchise_id ||
          body?.FRANCHISE_ID ||
          url.searchParams.get("franchise_id") ||
          url.searchParams.get("FRANCHISE_ID") ||
          ""
        );

        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing league_id/L" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing season/YEAR" });
        if (!playerId) return jsonOut(400, { ok: false, error: "Missing player_id" });
        const isImportRosterAction = action === "promote_taxi" || action === "activate_ir" || action === "drop_player";
        const isMembershipRosterAction = action === "load_player" || action === "unload_player";

        if (!isImportRosterAction && !isMembershipRosterAction) {
          return jsonOut(400, { ok: false, error: "Unsupported roster action" });
        }

        if (isMembershipRosterAction) {
          const commishCookieHeader = await establishCommishCookieHeader(cookieHeader, season, leagueId);
          const formRes = await fetchLoadRostFormForCookie(commishCookieHeader, season, leagueId, franchiseId);
          if (!formRes.ok) {
            return jsonOut(502, {
              ok: false,
              error: "Unable to load commissioner roster form",
              action,
              player_id: playerId,
              franchise_id: franchiseId,
              details: formRes,
            });
          }

          const currentRosterIds = Array.isArray(formRes.currentRosterIds) ? formRes.currentRosterIds : [];
          const currentSet = new Set(currentRosterIds);
          const desiredRosterIds = action === "load_player"
            ? (currentSet.has(playerId) ? currentRosterIds.slice() : currentRosterIds.concat(playerId))
            : currentRosterIds.filter((pid) => String(pid || "").replace(/\D/g, "") !== playerId);
          const skipped = desiredRosterIds.length === currentRosterIds.length &&
            desiredRosterIds.every((pid, index) => String(pid || "") === String(currentRosterIds[index] || ""));

          let postResult = { ok: true, skipped: true, status: 200, actionUrl: formRes.actionUrl };
          if (!skipped) {
            postResult = await postLoadRostFormForCookie(commishCookieHeader, formRes, desiredRosterIds);
            if (!postResult.ok) {
              return jsonOut(502, {
                ok: false,
                error: "Target roster membership post failed",
                action,
                player_id: playerId,
                franchise_id: franchiseId,
                details: postResult,
              });
            }
          }

          const cacheKey = new Request(
            `https://upsmfl-roster-workbench.local/cache?L=${encodeURIComponent(leagueId)}&YEAR=${encodeURIComponent(season)}`,
            { method: "GET" }
          );
          try {
            await caches.default.delete(cacheKey);
          } catch (_) {
            // noop
          }

          const verifyRes = await mflExportJsonForCookie(commishCookieHeader, season, leagueId, "rosters", {}, { useCookie: true });
          let verification = {
            ok: false,
            reason: "post_membership_rosters_export_failed",
            player_id: playerId,
            franchise_id: franchiseId,
          };
          if (verifyRes.ok) {
            const byFranchise = rosterRowsByFranchiseFromRostersPayload(verifyRes.data);
            let locatedFranchiseId = "";
            for (const fid of Object.keys(byFranchise)) {
              const found = (byFranchise[fid] || []).some((row) => safeStr(row?.player_id) === playerId);
              if (found) {
                locatedFranchiseId = fid;
                break;
              }
            }
            const expectedOk = action === "load_player"
              ? locatedFranchiseId === franchiseId
              : !locatedFranchiseId;
            verification = {
              ok: expectedOk,
              reason: expectedOk ? "" : (action === "load_player" ? "player_not_found_on_target_roster" : "player_still_found_on_roster"),
              player_id: playerId,
              franchise_id: locatedFranchiseId || franchiseId,
            };
          }

          if (!verification.ok) {
            return jsonOut(502, {
              ok: false,
              error: verification.reason || "Roster membership verification failed",
              action,
              player_id: playerId,
              franchise_id: franchiseId,
              verification,
              response: {
                upstream_status: postResult.status,
                skipped,
                action_url: formRes.actionUrl,
                current_count: currentRosterIds.length,
                desired_count: desiredRosterIds.length,
              },
            });
          }

          return jsonOut(200, {
            ok: true,
            action,
            player_id: playerId,
            franchise_id: franchiseId,
            skipped,
            message: action === "load_player"
              ? (skipped ? "Player already loaded on roster." : "Player loaded to roster in MFL.")
              : (skipped ? "Player already absent from roster." : "Player unloaded from roster in MFL."),
            verification,
            response: {
              upstream_status: postResult.status,
              skipped,
              action_url: formRes.actionUrl,
              current_count: currentRosterIds.length,
              desired_count: desiredRosterIds.length,
            },
          });
        }

        const importFields = {
          TYPE: action === "activate_ir" ? "ir" : "taxi_squad",
          L: leagueId,
        };
        if (action === "activate_ir") {
          importFields.ACTIVATE = playerId;
        } else if (action === "drop_player") {
          importFields.DROP = playerId;
        } else {
          importFields.PROMOTE = playerId;
        }
        if (franchiseId) importFields.FRANCHISE_ID = franchiseId;

        let importRes = await postMflImportForm(season, importFields, importFields);
        if (!importRes.requestOk) {
          const getRes = await postMflImportForm(season, importFields, importFields, { method: "GET" });
          if (getRes.requestOk) importRes = getRes;
        }
        let usedFranchiseId = !!safeStr(importFields.FRANCHISE_ID);
        if (!importRes.requestOk && usedFranchiseId) {
          const retryFields = { ...importFields };
          delete retryFields.FRANCHISE_ID;
          const retryRes = await postMflImportForm(season, retryFields, retryFields);
          if (retryRes.requestOk) {
            importRes = retryRes;
            usedFranchiseId = false;
          } else {
            const retryGetRes = await postMflImportForm(season, retryFields, retryFields, { method: "GET" });
            if (retryGetRes.requestOk) {
              importRes = retryGetRes;
              usedFranchiseId = false;
            }
          }
        }

        const cacheKey = new Request(
          `https://upsmfl-roster-workbench.local/cache?L=${encodeURIComponent(leagueId)}&YEAR=${encodeURIComponent(season)}`,
          { method: "GET" }
        );
        try {
          await caches.default.delete(cacheKey);
        } catch (_) {
          // noop
        }

        if (!importRes.requestOk) {
          return jsonOut(502, {
            ok: false,
            error: importRes.error || "MFL roster action failed",
            action,
            player_id: playerId,
            franchise_id: franchiseId,
            used_franchise_id: usedFranchiseId,
            upstream_status: importRes.status,
            upstream_preview: importRes.upstreamPreview,
            target_import_url: importRes.targetImportUrl,
            form_fields: importRes.formFields,
          });
        }

        const verifyRes = await mflExportJson(season, leagueId, "rosters", {}, { useCookie: true });
        let verification = {
          ok: false,
          reason: "post_import_rosters_export_failed",
          player_id: playerId,
          franchise_id: franchiseId,
        };
        if (verifyRes.ok) {
          const franchiseRows = asArray(verifyRes.data?.rosters?.franchise || verifyRes.data?.rosters?.franchises).filter(Boolean);
          let located = null;
          for (const fr of franchiseRows) {
            const fid = padFranchiseId(fr?.id || fr?.franchise_id);
            const playerRows = asArray(fr?.player || fr?.players).filter(Boolean);
            for (const row of playerRows) {
              const pid = String(row?.id || row?.player_id || "").replace(/\D/g, "");
              if (!pid || pid !== playerId) continue;
              located = {
                franchise_id: fid,
                status: safeStr(row?.status || "").toUpperCase(),
              };
              break;
            }
            if (located) break;
          }
          if (located) {
            const status = safeStr(located.status);
            const expectedOk = action === "activate_ir"
              ? !status.includes("IR")
              : !status.includes("TAXI");
            verification = {
              ok: expectedOk,
              reason: expectedOk ? "" : "player_status_did_not_change",
              player_id: playerId,
              franchise_id: located.franchise_id,
              status,
            };
          } else {
            verification = {
              ok: action === "drop_player",
              reason: action === "drop_player" ? "" : "player_not_found_in_post_import_rosters",
              player_id: playerId,
              franchise_id: franchiseId,
            };
          }
        }

        return jsonOut(200, {
          ok: true,
          action,
          player_id: playerId,
          franchise_id: franchiseId,
          used_franchise_id: usedFranchiseId,
          message: action === "activate_ir"
            ? "Player activated from IR in MFL."
            : (action === "drop_player" ? "Player dropped in MFL." : "Player promoted from taxi in MFL."),
          verification,
          response: {
            upstream_status: importRes.status,
            upstream_preview: importRes.upstreamPreview,
            target_import_url: importRes.targetImportUrl,
            form_fields: importRes.formFields,
          },
        });
      }

      if (path === "/trade-workbench" && request.method === "GET") {
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || "");
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L param" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR param" });
        const cacheKey = new Request(
          `https://upsmfl-trade-workbench.local/cache?L=${encodeURIComponent(leagueId)}&YEAR=${encodeURIComponent(
            season
          )}`,
          { method: "GET" }
        );
        const disableCache = safeStr(url.searchParams.get("NO_CACHE")) === "1";
        let cachedTradeWorkbench = null;
        try {
          cachedTradeWorkbench = await caches.default.match(cacheKey);
        } catch (_) {
          cachedTradeWorkbench = null;
        }

        const staleFallbackResponse = async (reasonCode, upstreamMeta) => {
          if (!cachedTradeWorkbench) return null;
          try {
            const text = await cachedTradeWorkbench.clone().text();
            const data = text ? JSON.parse(text) : null;
            if (data && typeof data === "object") {
              const next = JSON.parse(JSON.stringify(data));
              next.meta = next.meta && typeof next.meta === "object" ? next.meta : {};
              next.meta.stale_fallback = {
                used: true,
                reason: safeStr(reasonCode || "upstream_failed"),
                at: new Date().toISOString(),
                upstream: upstreamMeta || null,
              };
              const resp = jsonOut(200, next);
              resp.headers.set("Cache-Control", "no-store");
              resp.headers.set("X-UPS-Stale-Fallback", "1");
              return resp;
            }
          } catch (_) {
            // fall through to raw cached response
          }
          return cachedTradeWorkbench;
        };

        const requestedDefaultFranchiseId = padFranchiseId(
          url.searchParams.get("F") ||
          url.searchParams.get("FRANCHISE_ID") ||
          url.searchParams.get("franchise_id") ||
          url.searchParams.get("MY") ||
          ""
        );

        const [leagueRes, rostersRes, assetsRes, myFrRes, extRes] = await Promise.all([
          mflExportJsonWithRetry(season, leagueId, "league", {}, { includeApiKey: false, useCookie: true }),
          mflExportJsonWithRetry(season, leagueId, "rosters", {}, { includeApiKey: false, useCookie: true }),
          mflExportJsonWithRetry(season, leagueId, "assets", {}, { includeApiKey: true, useCookie: true }),
          mflExportJsonWithRetryAsViewer(season, leagueId, "myfranchise", {}, { useCookie: true }),
          fetchExtensionPreviewRows(season, url.searchParams),
        ]);

        if (!leagueRes.ok) {
          const fallback = await staleFallbackResponse("league_export_failed", {
            type: "league",
            status: leagueRes.status,
            url: leagueRes.url,
            error: leagueRes.error,
          });
          if (fallback) return fallback;
          return jsonOut(502, {
            ok: false,
            error: "Failed to load MFL league export",
            upstream: {
              type: "league",
              status: leagueRes.status,
              url: leagueRes.url,
              error: leagueRes.error,
              preview: leagueRes.textPreview,
            },
          });
        }
        if (!rostersRes.ok) {
          const fallback = await staleFallbackResponse("rosters_export_failed", {
            type: "rosters",
            status: rostersRes.status,
            url: rostersRes.url,
            error: rostersRes.error,
          });
          if (fallback) return fallback;
          return jsonOut(502, {
            ok: false,
            error: "Failed to load MFL rosters export",
            upstream: {
              type: "rosters",
              status: rostersRes.status,
              url: rostersRes.url,
              error: rostersRes.error,
              preview: rostersRes.textPreview,
            },
          });
        }

        const leagueFranchises = parseLeagueFranchises(leagueRes.data);
        const leagueRoot = leagueRes.data?.league || leagueRes.data || {};
        const leagueSalaryCapDollars = safeMoneyInt(
          firstTruthy(
            leagueRoot?.auctionStartAmount,
            leagueRoot?.salaryCapAmount,
            leagueRoot?.salary_cap_amount
          ),
          0
        );
        const { rosterAssetsByFranchise, allPlayerIds } = parseRostersExport(rostersRes.data);
        const playersById = await fetchPlayersByIdsChunked(season, leagueId, allPlayerIds);
        const pickAssetsByFranchise = assetsRes.ok ? parseAssetsExportPicks(assetsRes.data) : {};
        const loggedInFranchiseId = myFrRes.ok ? parseMyFranchiseId(myFrRes.data) : "";
        const commissionerLockoutRaw = safeStr(
          firstTruthy(
            leagueRoot?.commissioner_lockout,
            leagueRoot?.commissionerLockout,
            leagueRoot?.commish_lockout,
            leagueRoot?.commishLockout,
            leagueRoot?.franchise_lockout,
            leagueRoot?.franchiseLockout
          )
        ).toUpperCase();
        let commissionerLockout =
          commissionerLockoutRaw === "N" || commissionerLockoutRaw === "0" || commissionerLockoutRaw === "NO"
            ? "N"
            : commissionerLockoutRaw === "Y" || commissionerLockoutRaw === "1" || commissionerLockoutRaw === "YES"
              ? "Y"
              : "";
        if (!commissionerLockout) {
          commissionerLockout =
            requestedDefaultFranchiseId &&
            loggedInFranchiseId &&
            requestedDefaultFranchiseId !== loggedInFranchiseId
              ? "N"
              : "Y";
        }
        const activeFranchiseId = commissionerLockout === "N"
          ? (requestedDefaultFranchiseId || loggedInFranchiseId || "")
          : (loggedInFranchiseId || requestedDefaultFranchiseId || "");

        // Merge player identity/position data into roster assets.
        for (const [franchiseId, assets] of Object.entries(rosterAssetsByFranchise)) {
          for (const asset of assets) {
            if (!asset || asset.type !== "PLAYER") continue;
            const p = playersById[String(asset.player_id || "")] || {};
            asset.player_name = safeStr(p.player_name || asset.player_name || asset.player_id);
            asset.nfl_team = safeStr(p.nfl_team || asset.nfl_team);
            asset.position = safeStr(p.position || asset.position).toUpperCase();
            if (!asset.injury && safeStr(p.injury)) asset.injury = safeStr(p.injury);
          }
          rosterAssetsByFranchise[franchiseId] = assets;
        }

        const franchiseMetaById = {};
        for (const fr of leagueFranchises) {
          franchiseMetaById[fr.franchise_id] = fr;
        }

        const extRowsNormalized = remapExtensionPreviewRowsToCurrentOwners(
          extRes.rows || [],
          rosterAssetsByFranchise,
          franchiseMetaById
        );

        const franchiseIds = new Set([
          ...Object.keys(franchiseMetaById),
          ...Object.keys(rosterAssetsByFranchise),
          ...Object.keys(pickAssetsByFranchise),
        ]);

        const teams = Array.from(franchiseIds).map((franchiseId) => {
          const meta = franchiseMetaById[franchiseId] || {
            franchise_id: franchiseId,
            franchise_name: franchiseId,
            franchise_abbrev: franchiseId,
            icon_url: "",
          };
          const playerAssets = asArray(rosterAssetsByFranchise[franchiseId]).filter(Boolean);
          const pickAssets = asArray(pickAssetsByFranchise[franchiseId]).filter(Boolean);
          return {
            franchise_id: franchiseId,
            franchise_name: meta.franchise_name,
            franchise_abbrev: meta.franchise_abbrev,
            icon_url: meta.icon_url,
            available_salary_dollars: meta.available_salary_dollars,
            is_default: !!activeFranchiseId && franchiseId === activeFranchiseId,
            assets: [...playerAssets, ...pickAssets],
          };
        });

        teams.sort((a, b) => {
          if (!!a.is_default !== !!b.is_default) return a.is_default ? -1 : 1;
          return safeStr(a.franchise_name).localeCompare(safeStr(b.franchise_name));
        });

        const warnings = [];
        if (!assetsRes.ok) {
          warnings.push({
            code: "assets_unavailable",
            message: "Draft picks export was unavailable; returning players only.",
            upstream: {
              status: assetsRes.status,
              url: assetsRes.url,
              error: assetsRes.error,
              preview: assetsRes.textPreview,
            },
          });
        }
        if (!extRes.ok) {
          warnings.push({
            code: "extension_previews_unavailable",
            message: "Extension previews file unavailable; returning no extension options.",
            upstream: {
              status: extRes.status,
              url: extRes.url,
              error: extRes.error,
            },
          });
        }

        const response = jsonOut(200, {
          ok: true,
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          generated_at: new Date().toISOString(),
          source: "worker:/trade-workbench",
          salary_cap_dollars: leagueSalaryCapDollars,
          teams,
          extension_previews: extRowsNormalized.rows || [],
          meta: {
            default_franchise_id: activeFranchiseId || "",
            active_franchise_id: activeFranchiseId || "",
            logged_in_franchise_id: loggedInFranchiseId || "",
            commissioner_lockout: commissionerLockout,
            salary_cap_dollars: leagueSalaryCapDollars,
            counts: {
              teams: teams.length,
              roster_players: allPlayerIds.length,
              draft_picks: Object.values(pickAssetsByFranchise).reduce(
                (acc, arr) => acc + asArray(arr).length,
                0
              ),
              extension_preview_rows: Array.isArray(extRowsNormalized.rows) ? extRowsNormalized.rows.length : 0,
              extension_preview_rows_owner_remapped: safeInt(extRowsNormalized.remapped_count, 0),
            },
            upstream: {
              league: { status: leagueRes.status, url: leagueRes.url },
              rosters: { status: rostersRes.status, url: rostersRes.url },
              assets: { status: assetsRes.status, url: assetsRes.url, ok: assetsRes.ok },
              myfranchise: { status: myFrRes.status, url: myFrRes.url, ok: myFrRes.ok },
              extension_previews: { status: extRes.status, url: extRes.url, ok: extRes.ok },
            },
            warnings,
          },
        });
        response.headers.set("Cache-Control", "public, max-age=45");
        if (!disableCache) {
          try {
            await caches.default.put(cacheKey, response.clone());
          } catch (_) {
            // noop
          }
        }
        return response;
      }

      if (
        (path === "/refresh/after-trade" || path === "/api/trades/refresh-after-trade") &&
        (request.method === "GET" || request.method === "POST")
      ) {
        let body = {};
        if (request.method === "POST") {
          try {
            body = (await request.json()) || {};
          } catch (_) {
            body = {};
          }
        }
        const leagueId = safeStr(
          body?.league_id ||
            body?.L ||
            url.searchParams.get("L") ||
            L ||
            ""
        );
        const season = safeStr(
          body?.season ||
            body?.YEAR ||
            url.searchParams.get("YEAR") ||
            YEAR ||
            ""
        );
        const tradeId = safeStr(
          body?.trade_id ||
            body?.mfl_trade_id ||
            url.searchParams.get("trade_id") ||
            ""
        ).replace(/\D/g, "");
        const actingFranchiseId = padFranchiseId(
          body?.acting_franchise_id ||
            body?.franchise_id ||
            url.searchParams.get("acting_franchise_id") ||
            url.searchParams.get("FRANCHISE_ID") ||
            ""
        );
        const shouldDispatchMymRefresh = parseBoolFlag(
          body?.dispatch_refresh_mym_json ??
            url.searchParams.get("dispatch_refresh_mym_json") ??
            "1"
        );
        const shouldRunReconcile = parseBoolFlag(
          body?.reconcile_extensions ??
            url.searchParams.get("reconcile_extensions") ??
            "0"
        );
        const sinceDays = Math.max(
          1,
          Math.min(90, safeInt(body?.since_days || url.searchParams.get("since_days"), 30))
        );
        const limit = Math.max(
          1,
          Math.min(100, safeInt(body?.limit || url.searchParams.get("limit"), 25))
        );

        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L/league_id param" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR/season param" });

        const rosterCacheKey = new Request(
          `https://upsmfl-roster-workbench.local/cache?L=${encodeURIComponent(leagueId)}&YEAR=${encodeURIComponent(
            season
          )}`,
          { method: "GET" }
        );
        const tradeCacheKey = new Request(
          `https://upsmfl-trade-workbench.local/cache?L=${encodeURIComponent(leagueId)}&YEAR=${encodeURIComponent(
            season
          )}`,
          { method: "GET" }
        );
        let cacheClearOk = false;
        let tradeCacheClearOk = false;
        try {
          cacheClearOk = await caches.default.delete(rosterCacheKey);
        } catch (_) {
          cacheClearOk = false;
        }
        try {
          tradeCacheClearOk = await caches.default.delete(tradeCacheKey);
        } catch (_) {
          tradeCacheClearOk = false;
        }

        const [leagueRes, rostersRes, salariesRes, pendingRes] = await Promise.all([
          mflExportJsonWithRetry(season, leagueId, "league", {}, { includeApiKey: false, useCookie: true }),
          mflExportJsonWithRetry(season, leagueId, "rosters", {}, { includeApiKey: false, useCookie: true }),
          mflExportJsonWithRetry(season, leagueId, "salaries", {}, { includeApiKey: false, useCookie: true }),
          mflExportJson(
            season,
            leagueId,
            "pendingTrades",
            actingFranchiseId ? { FRANCHISE_ID: actingFranchiseId } : {},
            { useCookie: true }
          ),
        ]);

        let dispatchOut = null;
        if (shouldDispatchMymRefresh) {
          try {
            const adminState = await getLeagueAdminState(leagueId, season);
            if (adminState.ok && adminState.isAdmin) {
              dispatchOut = await dispatchRepoEvent("refresh-mym-json", {
                league_id: leagueId,
                year: season,
                trade_id: tradeId,
                acting_franchise_id: actingFranchiseId,
                source: "twb-refresh-after-trade",
              });
            } else {
              dispatchOut = {
                ok: false,
                queued: false,
                reason: adminState.reason || "not_admin",
                upstreamStatus: safeInt(adminState.mflHttp, 0),
                repo: "",
              };
            }
          } catch (e) {
            dispatchOut = {
              ok: false,
              queued: false,
              reason: `dispatch_failed: ${e?.message || String(e)}`,
              upstreamStatus: 0,
              repo: "",
            };
          }
        }

        let reconcileOut = null;
        if (shouldRunReconcile) {
          try {
            const reconcileUrl = new URL("/reconcile/extensions", url.origin);
            reconcileUrl.searchParams.set("L", leagueId);
            reconcileUrl.searchParams.set("YEAR", season);
            reconcileUrl.searchParams.set("since_days", String(sinceDays));
            reconcileUrl.searchParams.set("limit", String(limit));
            const reconcileRes = await fetch(reconcileUrl.toString(), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                league_id: leagueId,
                season,
                since_days: sinceDays,
                limit,
                statuses: ["FAILED", "POSTED"],
              }),
              cf: { cacheTtl: 0, cacheEverything: false },
            });
            const reconcileText = await reconcileRes.text();
            let reconcileJson = null;
            try {
              reconcileJson = reconcileText ? JSON.parse(reconcileText) : null;
            } catch (_) {
              reconcileJson = null;
            }
            reconcileOut = {
              ok: !!reconcileRes.ok && !!(reconcileJson && reconcileJson.ok),
              status: reconcileRes.status,
              response: reconcileJson,
              preview: trimDiagText(reconcileText, 800),
            };
          } catch (e) {
            reconcileOut = {
              ok: false,
              status: 0,
              response: null,
              preview: `fetch_failed: ${e?.message || String(e)}`,
            };
          }
        }

        return jsonOut(200, {
          ok: !!leagueRes.ok && !!rostersRes.ok,
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          trade_id: tradeId,
          acting_franchise_id: actingFranchiseId,
          cache_cleared: cacheClearOk,
          trade_cache_cleared: tradeCacheClearOk,
          refreshed_at: new Date().toISOString(),
          upstream: {
            league: {
              ok: !!leagueRes.ok,
              status: leagueRes.status,
              url: leagueRes.url,
              error: leagueRes.error || "",
            },
            rosters: {
              ok: !!rostersRes.ok,
              status: rostersRes.status,
              url: rostersRes.url,
              error: rostersRes.error || "",
            },
            salaries: {
              ok: !!salariesRes.ok,
              status: salariesRes.status,
              url: salariesRes.url,
              error: salariesRes.error || "",
            },
            pending_trades: {
              ok: !!pendingRes.ok,
              status: pendingRes.status,
              url: pendingRes.url,
              error: pendingRes.error || "",
            },
          },
          dispatch_refresh_mym_json: dispatchOut || null,
          reconcile_extensions: reconcileOut || null,
        });
      }

      // ---------- Queue GitHub JSON refresh ----------
      if (path === "/refresh-mym-json") {
        if (request.method !== "POST") {
          return new Response(
            JSON.stringify({ ok: false, reason: "Method not allowed" }),
            { status: 405, headers: { "content-type": "application/json", ...corsHeaders } }
          );
        }

        const leagueId = String(L || "").trim();
        const year = String(YEAR || new Date().getUTCFullYear()).trim();
        const adminState = await getLeagueAdminState(leagueId, year);
        if (!adminState.ok) {
          return new Response(
            JSON.stringify({
              ok: false,
              queued: false,
              reason: adminState.reason,
              mflHttp: adminState.mflHttp,
            }),
            { status: 200, headers: { "content-type": "application/json", ...corsHeaders } }
          );
        }
        if (!adminState.isAdmin) {
          return new Response(
            JSON.stringify({
              ok: false,
              queued: false,
              reason: "Only league admin can queue refresh",
            }),
            { status: 403, headers: { "content-type": "application/json", ...corsHeaders } }
          );
        }

        const dispatchOut = await dispatchRepoEvent("refresh-mym-json", {
          league_id: leagueId,
          year,
          source: "ccc-roster-refresh",
        });

        if (!dispatchOut.ok) {
          return new Response(
            JSON.stringify({
              ok: false,
              queued: false,
              reason: dispatchOut.reason || "GitHub dispatch failed",
              upstreamStatus: dispatchOut.upstreamStatus || 0,
              upstreamPreview: dispatchOut.upstreamPreview || "",
            }),
            { status: 200, headers: { "content-type": "application/json", ...corsHeaders } }
          );
        }

        return new Response(
          JSON.stringify({
            ok: true,
            queued: true,
            reason: "Refresh queued",
            repo: dispatchOut.repo || "",
          }),
          { status: 200, headers: { "content-type": "application/json", ...corsHeaders } }
        );
      }

      // ---------- MYM contract submit ----------
      if (
        path === "/offer-mym" ||
        path === "/offer-restructure" ||
        path === "/commish-contract-update"
      ) {
        const mutationResponse = (status, submissionId, details, httpStatus = 200) =>
          new Response(
            JSON.stringify({
              status,
              submission_id: String(submissionId || "").trim(),
              details: details || {},
            }),
            { status: httpStatus, headers: { "content-type": "application/json", ...corsHeaders } }
          );

        if (request.method !== "POST") {
          return mutationResponse("validation_fail", "", { reason: "Method not allowed" }, 405);
        }

        let body = {};
        const ct = request.headers.get("content-type") || "";
        try {
          if (ct.includes("application/json")) {
            body = await request.json();
          } else {
            const raw = await request.text();
            const p = new URLSearchParams(raw);
            body = Object.fromEntries(p.entries());
          }
        } catch (e) {
          return mutationResponse("validation_fail", "", {
            reason: `Could not parse request body: ${e?.message || String(e)}`,
          });
        }

        const leagueId = String(L || body.L || body.leagueId || "").trim();
        const year = String(YEAR || body.YEAR || body.year || "").trim();
        const playerId = String(body.player_id || body.playerId || "").trim();
        const playerName = String(body.player_name || body.playerName || "").trim();
        const franchiseId = String(body.franchise_id || body.franchiseId || "").trim();
        const franchiseName = String(body.franchise_name || body.franchiseName || "").trim();
        const position = String(body.position || body.pos || "").trim();
        const salary = String(body.salary ?? "").trim();
        const contractYear = String(body.contract_year ?? body.contractYear ?? "").trim();
        const contractInfo = String(body.contract_info || body.contractInfo || "").trim();
        const requestedContractStatus = String(body.contract_status || body.contractStatus || "").trim();
        const contractTypeRaw = String(body.type || "").trim().toLowerCase();
        const submissionKindRaw = String(
          body.submission_kind || body.submissionKind || ""
        ).trim().toLowerCase();
        const providedSourceTag = String(body.source || body.sourceTag || "").trim();
        const isManualContractUpdate =
          path === "/commish-contract-update" || contractTypeRaw.includes("manual_contract_update");
        const isRestructure =
          !isManualContractUpdate &&
          (path === "/offer-restructure" || contractTypeRaw.includes("restructure"));
        const isExtensionSubmission =
          isManualContractUpdate &&
          (
            submissionKindRaw === "extension" ||
            /\bextension\b/i.test(providedSourceTag) ||
            requestedContractStatus.toLowerCase() === "extension"
          );
        const eventType = isExtensionSubmission
          ? "log-extension-submission"
          : (isRestructure ? "log-restructure-submission" : "log-mym-submission");
        const sourceTag = isExtensionSubmission
          ? (providedSourceTag || "worker-offer-extension")
          : (isRestructure
            ? (providedSourceTag || "worker-offer-restructure")
            : (providedSourceTag || "worker-offer-mym"));
        const payloadPlayerStatus = String(body.player_status || body.playerStatus || "").trim();
        const overrideAsOfDate = String(
          body.override_as_of_date || body.override_as_of || body.overrideAsOf || ""
        ).trim();
        const submittedAtUtc = String(
          body.submitted_at_utc || body.submittedAtUtc || new Date().toISOString()
        ).trim();
        const commishOverrideFlag = (() => {
          const raw = String(
            body.commish_override_flag || body.commish_override || body.commishOverride || ""
          )
            .trim()
            .toLowerCase();
          return raw === "1" || raw === "true" || raw === "yes" ? 1 : 0;
        })();

        const providedSubmissionId = String(body.submission_id || body.submissionId || "").trim();
        const submissionId =
          providedSubmissionId ||
          (await sha256Hex(
            [
              path,
              leagueId,
              year,
              playerId,
              salary,
              contractYear,
              contractInfo,
              submittedAtUtc,
            ].join("|")
          )).slice(0, 24);

        const salaryNum = Number(salary);
        const contractYearNum = Number(contractYear);
        const missingFields = [];
        if (!leagueId) missingFields.push("league_id");
        if (!year) missingFields.push("year");
        if (!playerId) missingFields.push("player_id");
        if (!salary) missingFields.push("salary");
        if (!contractYear) missingFields.push("contract_year");
        if (!contractInfo) missingFields.push("contract_info");
        if (missingFields.length) {
          return mutationResponse("validation_fail", submissionId, {
            reason: "Missing required fields",
            missing_fields: missingFields,
          });
        }
        if (!Number.isFinite(salaryNum) || salaryNum < 0) {
          return mutationResponse("validation_fail", submissionId, {
            reason: "salary must be a non-negative number",
          });
        }
        if (!Number.isFinite(contractYearNum) || contractYearNum <= 0) {
          return mutationResponse("validation_fail", submissionId, {
            reason: "contract_year must be a positive number",
          });
        }

        if (isManualContractUpdate) {
          const adminState = await getLeagueAdminState(leagueId, year);
          if (!adminState.ok || !adminState.isAdmin) {
            return mutationResponse(
              "validation_fail",
              submissionId,
              { reason: "Only league admin can perform manual contract updates" },
              403
            );
          }
        }

        const requestedTagSide = normalizeTagSideForCompare(
          body.tag_side || body.tagSide || body.side || tagSideFromPosition(position)
        );

        if (isManualContractUpdate && contractStatusLooksTagged(requestedContractStatus)) {
          if (!franchiseId) {
            return mutationResponse("validation_fail", submissionId, {
              reason: "franchise_id is required for franchise tag updates",
            }, 400);
          }
          if (!requestedTagSide) {
            return mutationResponse("validation_fail", submissionId, {
              reason: "Unable to determine tag side for requested player",
              player_id: playerId,
              position: position,
            }, 400);
          }

          const commishCookieHeader = await establishCommishCookieHeader(cookieHeader, year, leagueId);
          if (!safeStr(commishCookieHeader)) {
            return mutationResponse("validation_fail", submissionId, {
              reason: "Unable to verify existing franchise tags for this request",
              requested_tag_side: requestedTagSide,
            }, 409);
          }

          const existingTagState = await fetchFranchiseTaggedPlayersBySide(
            commishCookieHeader,
            year,
            leagueId,
            franchiseId
          );
          if (!existingTagState.ok) {
            return mutationResponse("validation_fail", submissionId, {
              reason: "Unable to verify existing franchise tags for this request",
              requested_tag_side: requestedTagSide,
              validation: existingTagState,
            }, 409);
          }
          if (Array.isArray(existingTagState.unresolved) && existingTagState.unresolved.length) {
            return mutationResponse("validation_fail", submissionId, {
              reason: "Unable to determine tag side for one or more already-tagged players on this franchise",
              requested_tag_side: requestedTagSide,
              unresolved_players: existingTagState.unresolved,
            }, 409);
          }

          const conflicts = (existingTagState.bySide[requestedTagSide] || []).filter(
            (row) => safeStr(row?.player_id) !== playerId
          );
          if (conflicts.length) {
            return mutationResponse("validation_fail", submissionId, {
              reason:
                `${tagSideLabelForRule(requestedTagSide)} tag already used by ` +
                conflicts.map((row) => safeStr(row?.player_name) || safeStr(row?.player_id)).join(", "),
              requested_tag_side: requestedTagSide,
              conflicting_players: conflicts,
            }, 409);
          }
        }

        const esc = (s) =>
          String(s)
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        const makeDataXml = (statusValue) => {
          const attrs = [
            `id="${esc(playerId)}"`,
            `salary="${esc(salary)}"`,
            `contractYear="${esc(contractYear)}"`,
            `contractInfo="${esc(contractInfo)}"`,
          ];
          if (statusValue) attrs.push(`contractStatus="${esc(statusValue)}"`);
          return (
            `<salaries><leagueUnit unit="LEAGUE">` +
            `<player ${attrs.join(" ")} />` +
            `</leagueUnit></salaries>`
          );
        }

        const rookieLike = (raw) => {
          const val = String(raw || "").trim().toLowerCase();
          if (!val) return false;
          return (
            val === "r" ||
            val.startsWith("r-") ||
            val.includes("rookie") ||
            val.includes("mym - rookie")
          );
        };

        let playerStatusLookup = {
          source: "none",
          value: "",
          rookie: null,
        };

        if (!isRestructure && !isManualContractUpdate) {
          if (payloadPlayerStatus) {
            playerStatusLookup = {
              source: "payload",
              value: payloadPlayerStatus,
              rookie: rookieLike(payloadPlayerStatus),
            };
          } else {
            try {
              const playersQs = new URLSearchParams({
                TYPE: "players",
                L: leagueId,
                P: playerId,
                DETAILS: "1",
                JSON: "1",
                _: String(Date.now()),
              });
              if (env.MFL_APIKEY) {
                playersQs.set("APIKEY", String(env.MFL_APIKEY));
              }
              const playerStatusUrl =
                `https://api.myfantasyleague.com/${encodeURIComponent(year)}` +
                `/export?${playersQs.toString()}`;
              const playerRes = await fetch(playerStatusUrl, {
                headers: {
                  Cookie: cookieHeader,
                  "User-Agent": "upsmflproduction-worker",
                },
                cf: { cacheTtl: 0, cacheEverything: false },
              });
              if (playerRes.ok) {
                const pdata = await playerRes.json();
                const playersRaw = pdata?.players?.player || [];
                const players = Array.isArray(playersRaw)
                  ? playersRaw
                  : [playersRaw].filter(Boolean);
                const p = players.find((x) => String(x?.id || "") === String(playerId));
                const pStatus = String(p?.status || "").trim();
                if (pStatus) {
                  playerStatusLookup = {
                    source: "mfl_players_export",
                    value: pStatus,
                    rookie: rookieLike(pStatus),
                  };
                }
              }
            } catch (_) {
              // Fall through to requested status if lookup fails.
            }
          }
        }

        let contractStatus = "";
        if (isManualContractUpdate) {
          contractStatus = requestedContractStatus || "";
          playerStatusLookup = {
            source: "manual-contract-update",
            value: requestedContractStatus,
            rookie: null,
          };
        } else if (isRestructure) {
          contractStatus = requestedContractStatus || "Veteran";
          playerStatusLookup = {
            source: "restructure-skip-rookie-check",
            value: "",
            rookie: null,
          };
        } else {
          const isRookie =
            playerStatusLookup.rookie !== null
              ? playerStatusLookup.rookie
              : rookieLike(requestedContractStatus);
          contractStatus = isRookie ? "MYM - Rookie" : "MYM - Vet";
        }

        const importQuery =
          `TYPE=salaries&L=${encodeURIComponent(leagueId)}&APPEND=1`;
        const importUrl = `https://api.myfantasyleague.com/${encodeURIComponent(
          year
        )}/import?${importQuery}`;

        // api.myfantasyleague.com issues 302 to a specific shard (wwwNN). If we auto-follow
        // a POST through 302, body data can be dropped. Resolve target first, then POST once.
        let targetImportUrl = importUrl;
        const probe = await fetch(importUrl, {
          method: "GET",
          redirect: "manual",
          headers: { Cookie: cookieHeader, "User-Agent": "upsmflproduction-worker" },
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        const loc = probe.headers.get("Location") || probe.headers.get("location");
        if (probe.status >= 300 && probe.status < 400 && loc) {
          targetImportUrl = loc;
        }

        const verifyUrlBase =
          `https://api.myfantasyleague.com/${encodeURIComponent(year)}` +
          `/export?TYPE=salaries&L=${encodeURIComponent(leagueId)}&JSON=1&_=`;
        const readPlayer = async (nonce) => {
          const verifyUrl = verifyUrlBase + encodeURIComponent(String(nonce));
          const verifyRes = await fetch(verifyUrl, {
            headers: {
              Cookie: cookieHeader,
              "User-Agent": "upsmflproduction-worker",
            },
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          if (!verifyRes.ok) return null;
          const v = await verifyRes.json();
          const leagueUnit = (v?.salaries && (v.salaries.leagueUnit || v.salaries.leagueunit)) || {};
          const playersRaw = leagueUnit.player || [];
          const players = Array.isArray(playersRaw) ? playersRaw : [playersRaw].filter(Boolean);
          const found = players.find((p) => String(p.id) === String(playerId));
          if (!found) return { id: String(playerId), found: false };
          return {
            id: String(found.id || ""),
            salary: String(found.salary || ""),
            contractYear: String(found.contractYear || ""),
            contractInfo: String(found.contractInfo || ""),
            contractStatus: String(found.contractStatus || ""),
          };
        };

        const preCheck = await readPlayer(Date.now() - 1);

        const importAttempts = [];
        const statusAttempts = contractStatus
          ? [contractStatus]
          : Array.from(new Set([preCheck?.contractStatus || "", "A", ""]).values());

        let mflRes = null;
        let text = "";
        let looksOk = false;
        let postCheck = preCheck;
        let dataXmlUsed = "";
        let statusUsed = "";
        let anyChanged = false;
        let verifyAvailable = preCheck !== null;

        for (const statusCandidate of statusAttempts) {
          const dataXml = makeDataXml(statusCandidate);
          const bodyData = `DATA=${encodeURIComponent(dataXml)}`;

          const res = await fetch(targetImportUrl, {
            method: "POST",
            headers: {
              Cookie: cookieHeader,
              "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
              "User-Agent": "upsmflproduction-worker",
            },
            body: bodyData,
            redirect: "manual",
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          const bodyText = await res.text();
          const lowered = bodyText.toLowerCase();
          const requestOk =
            res.ok &&
            !lowered.includes("error") &&
            !lowered.includes("invalid") &&
            !lowered.includes("not authorized");

          await new Promise((r) => setTimeout(r, 250));
          const verifyAfter = await readPlayer(Date.now());
          const changed =
            !!preCheck &&
            !!verifyAfter &&
            (String(preCheck.contractYear || "") !== String(verifyAfter.contractYear || "") ||
              String(preCheck.contractInfo || "") !== String(verifyAfter.contractInfo || "") ||
              String(preCheck.contractStatus || "") !== String(verifyAfter.contractStatus || ""));
          if (verifyAfter !== null) verifyAvailable = true;

          importAttempts.push({
            statusTried: statusCandidate || "(none)",
            upstreamStatus: res.status,
            requestOk,
            changed,
          });

          mflRes = res;
          text = bodyText;
          postCheck = verifyAfter || preCheck;
          dataXmlUsed = dataXml;
          statusUsed = statusCandidate || "";
          looksOk = requestOk;
          if (changed) anyChanged = true;

          if (changed) break;
        }

        const shouldDispatchSubmissionLog = !isManualContractUpdate || isExtensionSubmission;
        let logDispatch = {
          ok: false,
          queued: false,
          skipped: true,
          reason: shouldDispatchSubmissionLog
            ? "No applied change detected"
            : "Manual update does not dispatch submission log",
        };
        if (looksOk && anyChanged && shouldDispatchSubmissionLog) {
          try {
            logDispatch = await dispatchRepoEvent(eventType, {
              payload: {
                league_id: leagueId,
                year: year,
                season: year,
                player_id: playerId,
                player_name: playerName,
                position: position,
                franchise_id: franchiseId,
                franchise_name: franchiseName,
                salary: salary,
                contract_year: contractYear,
                contract_status: statusUsed || contractStatus,
                contract_info: contractInfo,
                submitted_at_utc: submittedAtUtc || new Date().toISOString(),
                commish_override_flag: commishOverrideFlag,
                override_as_of_date: overrideAsOfDate,
                source: sourceTag,
                submission_id: submissionId,
              },
            });
          } catch (e) {
            logDispatch = {
              ok: false,
              queued: false,
              skipped: false,
              reason: `Submission log dispatch error: ${e?.message || String(e)}`,
            };
          }
        }

        const announceTaggedContract =
          isManualContractUpdate &&
          safeStr(statusUsed || contractStatus).toUpperCase() === "TAG";
        const activityContractStatus = announceTaggedContract
          ? (statusUsed || contractStatus)
          : (postCheck?.contractStatus || statusUsed || contractStatus);
        const activityContractInfo = announceTaggedContract
          ? contractInfo
          : (postCheck?.contractInfo || contractInfo);
        const activityContractYear = announceTaggedContract
          ? contractYear
          : (postCheck?.contractYear || contractYear);
        const activitySalary = announceTaggedContract
          ? salary
          : (postCheck?.salary || salary);

        const activityType = deriveContractActivityType({
          isExtensionSubmission,
          isRestructure,
          contractStatus: activityContractStatus,
        });

        let contractDiscord = {
          ok: false,
          skipped: true,
          status: 0,
          error: looksOk && anyChanged ? "announcement_not_attempted" : "no_applied_change_detected",
          delivery_target: "",
          gif_url: "",
          gif_query: "",
        };
        if (looksOk && anyChanged) {
          try {
            contractDiscord = await sendDiscordContractActivity({
              activityType,
              leagueId: leagueId,
              franchiseId: franchiseId,
              franchiseName: franchiseName,
              playerName: playerName,
              contractInfo: activityContractInfo,
              contractYear: activityContractYear,
              contractStatus: activityContractStatus,
              season: year,
              salary: activitySalary,
              submittedAtUtc: submittedAtUtc || new Date().toISOString(),
            });
          } catch (e) {
            contractDiscord = {
              ok: false,
              skipped: false,
              status: 0,
              error: `contract_discord_failed: ${e?.message || String(e)}`,
              delivery_target: "",
              gif_url: "",
              gif_query: "",
            };
          }
        }

        let contractActivityDispatch = {
          ok: false,
          queued: false,
          skipped: true,
          reason: looksOk && anyChanged ? "not_attempted" : "No applied change detected",
        };
        if (looksOk && anyChanged) {
          try {
            contractActivityDispatch = await dispatchRepoEvent("log-contract-activity", {
              payload: {
                activity_id: submissionId,
                submission_id: submissionId,
                activity_scope: "contract_mutation",
                activity_type: activityType,
                season: year,
                year: year,
                league_id: leagueId,
                player_id: playerId,
                player_name: playerName,
                position: position,
                franchise_id: franchiseId,
                franchise_name: franchiseName,
                salary: activitySalary,
                contract_year: activityContractYear,
                contract_status: activityContractStatus,
                contract_info: activityContractInfo,
                submitted_at_utc: submittedAtUtc || new Date().toISOString(),
                source: sourceTag,
                test_flag: 0,
                commish_override_flag: commishOverrideFlag,
                override_as_of_date: overrideAsOfDate,
                delivery_target: contractDiscord?.delivery_target || "",
                discord_channel_id: contractDiscord?.channel_id || "",
                discord_message_id: contractDiscord?.message_id || "",
                discord_pinned_flag:
                  contractDiscord && contractDiscord.pin && contractDiscord.pin.ok ? 1 : 0,
              },
            });
          } catch (e) {
            contractActivityDispatch = {
              ok: false,
              queued: false,
              skipped: false,
              reason: `Contract activity dispatch error: ${e?.message || String(e)}`,
            };
          }
        }

        let mutationStatus = "import_rejected";
        if (!looksOk) {
          mutationStatus = "import_rejected";
        } else if (!verifyAvailable) {
          mutationStatus = "verify_unavailable";
        } else if (!anyChanged) {
          mutationStatus = "import_no_change";
        } else if (!shouldDispatchSubmissionLog) {
          mutationStatus = "import_ok_log_dispatched";
        } else if (logDispatch.ok) {
          mutationStatus = "import_ok_log_dispatched";
        } else {
          mutationStatus = "import_ok_log_failed";
        }

        // Audit log: capture every contract mutation going through this path
        // (extensions, restructures, tags, manual commish updates) — same
        // salary_change_log table used by /admin/import-salaries.
        try {
          const auditDb = env.TWB_OUTBOX_DB || env.TWB_DB || env.DB || null;
          await ensureSalaryChangeLogTable(auditDb);
          const landedFlag =
            mutationStatus === "import_ok_log_dispatched" ||
            mutationStatus === "import_ok_log_failed";
          await logSalaryChangeRow(auditDb, {
            created_ts: new Date().toISOString(),
            endpoint: path,
            league_id: leagueId,
            season: year,
            dry_run: false,
            actor_ip: safeStr(request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")),
            actor_ua: safeStr(request.headers.get("user-agent")).slice(0, 200),
            actor_had_api_key: !!sessionByApiKey,
            player_id: playerId,
            before_salary: safeStr(preCheck?.salary),
            before_contract_status: safeStr(preCheck?.contractStatus),
            before_contract_year: safeStr(preCheck?.contractYear),
            before_contract_info: safeStr(preCheck?.contractInfo),
            after_salary: safeStr(postCheck?.salary),
            after_contract_status: safeStr(postCheck?.contractStatus),
            after_contract_year: safeStr(postCheck?.contractYear),
            after_contract_info: safeStr(postCheck?.contractInfo),
            intended_salary: safeStr(salary),
            intended_contract_status: safeStr(contractStatus),
            intended_contract_year: safeStr(contractYear),
            intended_contract_info: safeStr(contractInfo),
            landed: landedFlag,
            import_status: mflRes ? mflRes.status : 0,
            notes: mutationStatus,
          });
        } catch (_) { /* never fail the request on audit errors */ }

        return mutationResponse(mutationStatus, submissionId, {
          reason:
            mutationStatus === "import_ok_log_dispatched"
              ? isManualContractUpdate
                ? "Manual contract update submitted to MFL"
                : "Submitted to MFL and logged"
              : mutationStatus === "import_ok_log_failed"
                ? "Submitted to MFL but submission log dispatch failed"
                : mutationStatus === "import_no_change"
                  ? "MFL accepted request but no contract change was observed"
                  : mutationStatus === "verify_unavailable"
                    ? "Submitted to MFL but verification export was unavailable"
                    : "MFL import rejected request",
          upstreamStatus: mflRes ? mflRes.status : 0,
          upstreamPreview: text.slice(0, 800),
          preCheck,
          postCheck,
          submitDebug: {
            targetImportUrl,
            contentType: "application/x-www-form-urlencoded;charset=UTF-8",
            formFields: { TYPE: "salaries", L: leagueId, APPEND: "1" },
            statusUsed,
            playerStatusLookup,
            dataXml: dataXmlUsed,
            importAttempts,
            isManualContractUpdate,
            logDispatch,
            contractActivityDispatch,
            contractDiscord,
          },
        });
      }

      // ── Extension Assistant ──────────────────────────────────────────────
      if (path === "/extension-assistant" && request.method === "POST") {
        const EXTENSION_SYSTEM_PROMPT = `You are the UPS Dynasty League Extension Assistant — a specialized help bot for owners in the UPS Dynasty League, a 12-team salary-cap dynasty league built on MyFantasyLeague (MFL).

SCOPE: Only answer player extension questions. For any other topic (restructures, MYM, tags, trades, reports, rules engine), reply: "I can only help with player extension questions. For other topics, please check the relevant section of the site or contact the commissioner."

LEAGUE CONTEXT:
- 12-team salary-cap dynasty format built on MFL
- Contract deadline for 2026 season: September 6, 2026
- Extensions are an offseason action submitted before the contract deadline

EXTENSION RULES:
1. A player is extension eligible when they are in their FINAL contract year (contract expires after this season).
2. Tagged players are NOT eligible for extension.
3. Players with "No Further Extensions" in their contract_info are NOT eligible.
4. Two extension terms available: +1 Year or +2 Years.
5. Extension cost is added to TCV and raises AAV:
   - Offense (QB, RB, WR, TE): +1yr adds $10,000 | +2yr adds $20,000
   - Defense/ST (DL, LB, DB, PK, P): +1yr adds $3,000 | +2yr adds $5,000
6. Extensions affect FUTURE seasons only — current-year salary is unchanged.
7. The system calculates all new contract values automatically. Owners cannot change them manually.

HOW TO EXTEND A PLAYER:
1. Open Contract Command Center (CCC) from the league navigation.
2. Select the Extend Player action.
3. Filter by team, position, or search for the player.
4. Only eligible players appear. Select your player.
5. Choose +1 Year or +2 Years.
6. Review the updated AAV, TCV, and contract length.
7. Click Submit Extension.
8. Open the Finalized Submissions tab to confirm. If your extension appears there, it is complete.

GLOSSARY:
- AAV (Average Annual Value): average salary per year across the full contract.
- TCV (Total Contract Value): total dollars across all contract years.
- CL (Contract Length): total years on the deal.
- Extension Eligible: player qualifies for extension under current rules.
- Finalized Submission: extension recorded and confirmed in the system.
- Contract Deadline: last day to submit any contract action for the season.

COMMON ISSUES:
- Player not in eligible list → not eligible; check contract_info for the reason.
- No term option shown → no valid extension window; contact commissioner.
- Submission not showing → refresh page and check Finalized Submissions tab; do not resubmit without checking.
- Values look unexpected → all values are auto-calculated; contact commissioner if unsure before submitting.

ANSWER FORMAT: Direct answer → brief reason → what to do next → relevant rule or term if helpful.
Keep responses under 150 words. Be practical and league-specific. Never give generic fantasy football advice.`;

        const body = await request.json().catch(() => ({}));
        const question = String(body.question || "").trim().slice(0, 600);
        const context  = String(body.context  || "").trim().slice(0, 4000);

        if (!question) return jsonOut(400, { ok: false, error: "No question provided." });

        const apiKey = (env.ANTHROPIC_API_KEY || "").trim();
        if (!apiKey) {
          return jsonOut(503, { ok: false, error: "Assistant is not configured. Please contact the commissioner." });
        }

        const userMessage = context
          ? `${question}\n\nLeague data context:\n${context}`
          : question;

        let aiAnswer = "";
        try {
          const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 350,
              system: EXTENSION_SYSTEM_PROMPT,
              messages: [{ role: "user", content: userMessage }],
            }),
          });
          if (!aiRes.ok) {
            const upstreamText = (await aiRes.text().catch(() => "")).trim();
            const upstreamSnippet = upstreamText.slice(0, 400);
            console.error("Anthropic API error", {
              status: aiRes.status,
              statusText: aiRes.statusText,
              body: upstreamSnippet,
            });
            return jsonOut(502, {
              ok: false,
              error: "Anthropic API request failed.",
              upstream_status: aiRes.status,
              upstream_status_text: aiRes.statusText || "",
              upstream_body: upstreamSnippet,
            });
          }
          const aiData = await aiRes.json();
          aiAnswer = (aiData?.content?.[0]?.text || "").trim() || "No response received. Please try again.";
        } catch (err) {
          console.error("Anthropic API fetch failed", {
            message: err?.message || String(err),
          });
          return jsonOut(502, {
            ok: false,
            error: "Anthropic API request failed.",
            upstream_message: err?.message || String(err),
          });
        }

        return jsonOut(200, { ok: true, answer: aiAnswer });
      }
      // ── End Extension Assistant ──────────────────────────────────────────

      return adminStateResponse();
    } catch (e) {
      return new Response(
        JSON.stringify({
          ok: false,
          isAdmin: false,
          reason: `Worker error: ${e?.message || String(e)}`,
        }),
        { status: 200, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }
  },
};
