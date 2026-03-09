export default {
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
        !path.startsWith("/trade-offers") &&
        !path.startsWith("/trade-outbox") &&
        path !== "/refresh/after-trade" &&
        path !== "/trade-pending" &&
        path !== "/salary-alignment-check" &&
        path !== "/admin/test-sync/prod-rosters" &&
        path !== "/admin/test-sync/prod-statuses" &&
        path !== "/admin/test-sync/prod-salaries" &&
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
        } else if (path === "/bug-report" || path === "/bug-reports") {
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
        v = v.replace(/^MFL_USER_ID=/i, "").split(";")[0].trim();
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
        const contractInfo = safeStr(playerRow?.contractInfo || playerRow?.contractinfo || "");
        const contractLen = contractLengthFromInfo(contractInfo);
        const contractYearRaw = safeStr(playerRow?.contractYear || playerRow?.contractyear);
        if (!contractYearRaw) return null;
        const contractYear = safeInt(contractYearRaw, NaN);
        if (!Number.isFinite(contractYear)) return null;
        if (contractLen != null) return Math.max(contractLen - contractYear - 1, 0);
        return contractYear;
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

        const rookieLabelFromDescription = (description, pickKey, seasonValue) => {
          const raw = safeStr(description);
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
              const description = rookieLabelFromDescription(
                safeStr(p?.description || p?.name || p?.label || pickKey || "Rookie Pick"),
                pickKey,
                assetsPayload?.assets?.year || assetsPayload?.year || 0
              );
              const key = pickKey || safeStr(description).toUpperCase().replace(/[^A-Z0-9_.-]/g, "_");
              if (!key || seen.has(key)) continue;
              seen.add(key);
              rows.push({
                type: "PICK",
                asset_id: `pick:${key}`,
                pick_key: key,
                description,
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

      const normalizeBugReportsDoc = (raw, leagueId, season) => {
        const doc = raw && typeof raw === "object" ? raw : {};
        const out = emptyBugReportsDoc(leagueId, season);
        out.meta = {
          ...out.meta,
          ...(doc.meta && typeof doc.meta === "object" ? doc.meta : {}),
          league_id: String(leagueId || ""),
          season: Number(season || 0) || 0,
        };
        out.reports = Array.isArray(doc.reports) ? doc.reports.filter(Boolean) : [];
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

      const formatBugDiscordMessage = (reportRow, filePath) => {
        const row = reportRow && typeof reportRow === "object" ? reportRow : {};
        const details = safeStr(row.details || "").replace(/\s+/g, " ").slice(0, 500);
        const moduleName = safeStr(row.module || "");
        const issueType = safeStr(row.issue_type || "");
        const leagueId = safeStr(row.league_id || "");
        const season = safeStr(row.season || "");
        const bugId = safeStr(row.bug_id || "");
        const fid = safeStr(row.franchise_id || "");
        const franchiseName = safeStr(row.franchise_name || (row.context && row.context.franchise_name) || "");
        const mflUser = safeStr(row.mfl_user_id || "");
        const pageUrl = safeStr((row.context && row.context.page_url) || "");
        const attachmentCount = Array.isArray(row.attachments)
          ? row.attachments.length
          : safeInt((row.context && row.context.screenshot_count) || 0);
        const lines = [
          `UPS Bug Report${bugId ? ` #${bugId}` : ""}`,
          `League ${leagueId || "-"} | Season ${season || "-"}`,
          `Module ${moduleName || "-"} | Type ${issueType || "-"}`,
          `Franchise ${(franchiseName || fid || "-")} | MFL User ${mflUser || "unknown"}`,
          attachmentCount ? `Screenshots: ${attachmentCount}` : "",
          details ? `Details: ${details}` : "",
          pageUrl ? `Page: ${pageUrl}` : "",
          filePath ? `Log: ${filePath}` : "",
        ].filter(Boolean);
        let content = lines.join("\n");
        if (content.length > 1900) content = content.slice(0, 1897) + "...";
        return content;
      };

      const parseDiscordUserIds = (raw) => {
        const parts = String(raw == null ? "" : raw).split(/[,\s]+/);
        const out = [];
        const seen = new Set();
        for (const part of parts) {
          const id = safeStr(part).replace(/\D/g, "");
          if (!id || seen.has(id)) continue;
          seen.add(id);
          out.push(id);
        }
        return out;
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

      const sendDiscordNotificationForBug = async (reportRow, filePath) => {
        const webhook = safeStr(env.DISCORD_WEBHOOK_URL || "");
        const botToken = safeStr(
          env.DISCORD_BOT_TOKEN ||
          env.DISCORD_BOT ||
          env.Discord_bot ||
          ""
        );
        const dmUserId = safeStr(env.DISCORD_DM_USER_ID || "").replace(/\D/g, "");
        const dmUserIds = parseDiscordUserIds(env.DISCORD_DM_USER_IDS || "");
        if (dmUserId && !dmUserIds.includes(dmUserId)) dmUserIds.unshift(dmUserId);
        const channelId = safeStr(env.DISCORD_BUG_CHANNEL_ID || "").replace(/\D/g, "");
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
        let dmAttemptResult = null;

        const botRequest = async (method, apiPath, body) => {
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

        const botRequestWithFiles = async (apiPath) => {
          if (!files.length) {
            return botRequest("POST", apiPath, {
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

        if (botToken && dmUserIds.length) {
          const perUser = [];
          let delivered = 0;
          for (const userId of dmUserIds) {
            const openDm = await botRequest("POST", "/users/@me/channels", { recipient_id: userId });
            if (!openDm.ok || !safeStr(openDm.data && openDm.data.id)) {
              perUser.push({
                user_id: userId,
                ok: false,
                status: openDm.status,
                error: safeStr(openDm.text || "open_dm_failed").slice(0, 600),
              });
              continue;
            }
            const dmChannelId = safeStr(openDm.data.id);
            const sendDm = await botRequestWithFiles(`/channels/${encodeURIComponent(dmChannelId)}/messages`);
            if (!sendDm.ok) {
              perUser.push({
                user_id: userId,
                ok: false,
                status: sendDm.status,
                error: safeStr(sendDm.text || "send_dm_failed").slice(0, 600),
                ...attachmentMeta(0),
              });
              continue;
            }
            delivered += 1;
            const sentCount = responseAttachmentCount(sendDm);
            perUser.push({
              user_id: userId,
              ok: true,
              status: sendDm.status,
              channel_id: dmChannelId,
              ...attachmentMeta(sentCount),
            });
          }
          if (delivered > 0) {
            return {
              ok: true,
              mode: "bot-dm-multi",
              attempted: dmUserIds.length,
              delivered,
              results: perUser,
              ...attachmentMeta(files.length ? files.length : 0),
            };
          }
          const firstFail = perUser.find((row) => row && row.ok === false) || {};
          dmAttemptResult = {
            ok: false,
            mode: "bot-dm-multi",
            attempted: dmUserIds.length,
            delivered,
            results: perUser,
            error: safeStr(firstFail.error || "all_dm_attempts_failed").slice(0, 600),
            ...attachmentMeta(0),
          };
        }

        if (webhook) {
          try {
            let res = null;
            if (!files.length) {
              res = await fetch(webhook, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  content,
                  allowed_mentions: { parse: [] },
                }),
              });
            } else {
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
              res = await fetch(webhook, {
                method: "POST",
                body: form,
              });
            }
            if (!res.ok) {
              const preview = (await res.text()).slice(0, 600);
              return {
                ok: false,
                mode: "webhook",
                status: res.status,
                error: preview || "webhook_failed",
                dm_attempt: dmAttemptResult || undefined,
                ...attachmentMeta(0),
              };
            }
            return {
              ok: true,
              mode: "webhook",
              dm_attempt: dmAttemptResult || undefined,
              ...attachmentMeta(files.length ? files.length : 0),
            };
          } catch (e) {
            return {
              ok: false,
              mode: "webhook",
              status: 0,
              error: `fetch_failed: ${e?.message || String(e)}`,
              dm_attempt: dmAttemptResult || undefined,
              ...attachmentMeta(0),
            };
          }
        }

        if (!botToken) {
          return {
            ok: false,
            mode: "none",
            status: 0,
            error: "missing_discord_config",
            ...attachmentMeta(0),
          };
        }

        if (channelId) {
          const sendChannel = await botRequestWithFiles(`/channels/${encodeURIComponent(channelId)}/messages`);
          if (!sendChannel.ok) {
            return {
              ok: false,
              mode: "bot-channel",
              status: sendChannel.status,
              error: safeStr(sendChannel.text || "send_channel_failed").slice(0, 600),
              dm_attempt: dmAttemptResult || undefined,
              ...attachmentMeta(0),
            };
          }
          const sentCount = responseAttachmentCount(sendChannel);
          return {
            ok: true,
            mode: "bot-channel",
            channel_id: channelId,
            dm_attempt: dmAttemptResult || undefined,
            ...attachmentMeta(sentCount),
          };
        }

        if (dmAttemptResult) return dmAttemptResult;
        return {
          ok: false,
          mode: "none",
          status: 0,
          error: "missing_discord_dm_or_channel",
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

      const postTaxiSquadDemotionGroupForCookie = async (cookieHeaderOverride, season, leagueId, franchiseId, playerIds) => {
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

        let importRes = await postMflImportFormForCookie(cookieHeaderOverride, season, importFields, importFields);
        if (!importRes.requestOk) {
          const getRes = await postMflImportFormForCookie(cookieHeaderOverride, season, importFields, importFields, { method: "GET" });
          if (getRes.requestOk) importRes = getRes;
        }

        let usedFranchiseId = !!safeStr(importFields.FRANCHISE_ID);
        if (!importRes.requestOk && usedFranchiseId) {
          const retryFields = { ...importFields };
          delete retryFields.FRANCHISE_ID;
          let retryRes = await postMflImportFormForCookie(cookieHeaderOverride, season, retryFields, retryFields);
          if (!retryRes.requestOk) {
            const retryGetRes = await postMflImportFormForCookie(cookieHeaderOverride, season, retryFields, retryFields, { method: "GET" });
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

      const parseSalaryExportByPlayer = (payload) => {
        const out = {};
        const rows = asArray(payload?.salaries?.leagueUnit?.player || payload?.salaries?.leagueunit?.player).filter(Boolean);
        for (const row of rows) {
          const playerId = String(row?.id || "").replace(/\D/g, "");
          if (!playerId) continue;
          out[playerId] = {
            salary: safeStr(row?.salary || ""),
            contractYear: safeStr(row?.contractYear || ""),
            contractStatus: safeStr(row?.contractStatus || ""),
            contractInfo: safeStr(row?.contractInfo || ""),
          };
        }
        return out;
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

      const postTradeProposalImportWithFallback = async (season, importFields) => {
        const initialFields = { ...(importFields || {}) };
        const firstRes = await postMflImportForm(
          season,
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
        const retryRes = await postMflImportForm(
          season,
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
        if (!cookieHeader) {
          return {
            ok: false,
            status: 500,
            error: "Missing MFL_COOKIE worker secret",
            pendingLookup: {
              ok: false,
              rows_count: 0,
              upstream_status: 0,
              error: "Missing MFL_COOKIE worker secret",
            },
            proposals: [],
            incoming: [],
            outgoing: [],
            related: [],
          };
        }

        const extra = {};
        if (franchiseId) extra.FRANCHISE_ID = franchiseId;
        const pendingRes = await mflExportJson(season, leagueId, "pendingTrades", extra, { useCookie: true });
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
        const explanation = safeStr(node.explanation || node.note || node.notes || node.reason || "");
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
          text.includes("trade settlement")
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
        const details = safeStr(body.details || body.description || "");
        const steps = safeStr(body.steps_to_reproduce || body.steps || "");
        const expectedActual = safeStr(
          body.expected_vs_actual || body.expected_actual || body.expected || ""
        );
        const attachments = sanitizeBugAttachments(body.attachments || body.screenshots);
        if (!attachments.length) return jsonOut(400, { ok: false, error: "At least one screenshot is required" });
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
          details: details.slice(0, 5000),
          steps_to_reproduce: steps.slice(0, 4000),
          expected_vs_actual: expectedActual.slice(0, 4000),
          attachments,
          source: safeStr(body.source || "ups-hot-links-widget"),
          status: "OPEN",
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

        return jsonOut(201, {
          ok: true,
          bug_id: bugId,
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          stored: {
            file_path: save.filePath || "",
            commit_sha: save.commitSha || "",
            content_sha: save.contentSha || "",
          },
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

        const extra = {};
        if (franchiseId) extra.FRANCHISE_ID = franchiseId;
        const pendingRes = await mflExportJson(season, leagueId, "pendingTrades", extra, { useCookie: true });
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
          if (!cookieHeader) {
            return jsonOut(500, { ok: false, error: "Missing MFL_COOKIE worker secret for direct MFL submission" });
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
            importFields
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
          const pendingRes = await mflExportJson(
            season,
            leagueId,
            "pendingTrades",
            { FRANCHISE_ID: fromFranchiseId },
            { useCookie: true }
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
          if (!cookieHeader) {
            return jsonOut(500, { ok: false, error: "Missing MFL_COOKIE worker secret for direct MFL actions" });
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
              importFields
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
            const pendingRes = await mflExportJson(
              season,
              leagueId,
              "pendingTrades",
              { FRANCHISE_ID: fromFranchiseId },
              { useCookie: true }
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

            const rejectImport = await postMflImportForm(
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
              const pendingRes = await mflExportJson(
                season,
                leagueId,
                "pendingTrades",
                { FRANCHISE_ID: actingFranchiseId },
                { useCookie: true }
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

          const responseImport = await postMflImportForm(
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

        const parseSalaryRows = (payload) => {
          const out = {};
          const rows = asArray(payload?.salaries?.leagueUnit?.player).filter(Boolean);
          for (const row of rows) {
            const pid = String(row?.id || "").replace(/\D/g, "");
            if (!pid || pid === "0000") continue;
            const salaryRaw = safeStr(row?.salary);
            const contractYearRaw = safeStr(row?.contractYear);
            const contractStatusRaw = safeStr(row?.contractStatus);
            const contractInfoRaw = safeStr(row?.contractInfo);
            if (!salaryRaw && !contractYearRaw && !contractStatusRaw && !contractInfoRaw) continue;
            out[pid] = {
              salary: salaryRaw ? safeInt(salaryRaw, 0) : null,
              contractYear: contractYearRaw ? safeInt(contractYearRaw, 0) : null,
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
          return safeStr(match[1])
            .split(/[\/,]/)
            .map((token) => parseContractMoneyToken(token))
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
          const priorAavs = parseContractAavValues(priorInfo);
          if (priorAavs.length < 1) return info;
          return replaceContractInfoAavValue(info, priorAavs[priorAavs.length - 1]);
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
        const salaryByPlayer = salariesRes.ok ? parseSalaryRows(salariesRes.data) : {};
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
        const requestedFranchiseId = padFranchiseId(body?.franchise_id || body?.franchiseId || url.searchParams.get("FRANCHISE_ID") || "");
        const franchiseIds = (requestedFranchiseId ? [requestedFranchiseId] : Object.keys(sourceByFranchise)).sort();
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

      if (path === "/admin/test-sync/prod-statuses" && request.method === "POST") {
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
          return jsonOut(502, { ok: false, error: "Failed to load source rosters export", upstream: sourceRostersRes });
        }
        const sourceByFranchise = rosterRowsByFranchiseFromRostersPayload(sourceRostersRes.data);
        const requestedFranchiseId = padFranchiseId(body?.franchise_id || body?.franchiseId || url.searchParams.get("FRANCHISE_ID") || "");
        const franchiseIds = (requestedFranchiseId ? [requestedFranchiseId] : Object.keys(sourceByFranchise)).sort();
        const results = [];
        for (const franchiseId of franchiseIds) {
          const sourceRows = sourceByFranchise[franchiseId] || [];
          const taxiIds = sourceRows.filter((row) => safeStr(row.status).includes("TAXI")).map((row) => row.player_id);
          const irIds = sourceRows.filter((row) => safeStr(row.status).includes("IR")).map((row) => row.player_id);
          const franchiseCookieHeader = await establishCommishCookieHeader(targetCookieHeaderBase, season, targetLeagueId);
          if (taxiIds.length) {
            const taxiRes = await postTaxiSquadDemotionGroupForCookie(
              franchiseCookieHeader,
              season,
              targetLeagueId,
              franchiseId,
              taxiIds
            );
            if (!taxiRes.request_ok) {
              return jsonOut(502, { ok: false, error: "Target taxi sync failed", franchise_id: franchiseId, details: taxiRes });
            }
            results.push({ franchise_id: franchiseId, type: "taxi_squad", count: taxiIds.length, status: taxiRes.upstream_status });
          }
          if (irIds.length) {
            const irRes = await postMflImportFormForCookie(
              franchiseCookieHeader,
              season,
              { TYPE: "ir", L: targetLeagueId, FRANCHISE_ID: franchiseId, DEACTIVATE: irIds.join(",") },
              { TYPE: "ir", L: targetLeagueId, FRANCHISE_ID: franchiseId }
            );
            if (!irRes.requestOk) {
              return jsonOut(502, { ok: false, error: "Target IR sync failed", franchise_id: franchiseId, details: irRes });
            }
            results.push({ franchise_id: franchiseId, type: "ir", count: irIds.length, status: irRes.status });
          }
        }
        return jsonOut(200, {
          ok: true,
          season,
          source_league_id: sourceLeagueId,
          target_league_id: targetLeagueId,
          franchise_ids: franchiseIds,
          actions: results,
        });
      }

      if (path === "/admin/test-sync/prod-salaries" && request.method === "POST") {
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
        const sourceSalariesRes = await mflExportJsonForCookie(cookieHeader, season, sourceLeagueId, "salaries", {}, { useCookie: true });
        if (!sourceSalariesRes.ok) {
          return jsonOut(502, { ok: false, error: "Failed to load source salaries export", upstream: sourceSalariesRes });
        }
        const sourceRostersRes = await mflExportJsonForCookie(cookieHeader, season, sourceLeagueId, "rosters", {}, { useCookie: true });
        if (!sourceRostersRes.ok) {
          return jsonOut(502, { ok: false, error: "Failed to load source rosters export", upstream: sourceRostersRes });
        }
        const sourceByFranchise = rosterRowsByFranchiseFromRostersPayload(sourceRostersRes.data);
        const requestedFranchiseId = padFranchiseId(body?.franchise_id || body?.franchiseId || url.searchParams.get("FRANCHISE_ID") || "");
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
        const salaryByPlayer = {};
        for (const row of salaryRows) salaryByPlayer[row.player_id] = row;
        const franchiseIds = (requestedFranchiseId ? [requestedFranchiseId] : Object.keys(sourceByFranchise)).sort();
        const imports = [];
        for (const franchiseId of franchiseIds) {
          const rowsForFranchise = (sourceByFranchise[franchiseId] || [])
            .map((row) => salaryByPlayer[row.player_id] || null)
            .filter(Boolean);
          if (!rowsForFranchise.length) continue;
          const salaryCookieHeader = await establishCommishCookieHeader(targetCookieHeaderBase, season, targetLeagueId);
          const salaryImportRes = await postMflImportFormForCookie(
            salaryCookieHeader,
            season,
            { TYPE: "salaries", L: targetLeagueId, APPEND: "1", DATA: buildSalaryImportXmlFromRows(rowsForFranchise) },
            { TYPE: "salaries", L: targetLeagueId, APPEND: "1" }
          );
          if (!salaryImportRes.requestOk) {
            return jsonOut(502, { ok: false, error: "Target salary import failed", franchise_id: franchiseId, details: salaryImportRes });
          }
          imports.push({ franchise_id: franchiseId, player_count: rowsForFranchise.length, status: salaryImportRes.status });
        }
        return jsonOut(200, {
          ok: true,
          season,
          source_league_id: sourceLeagueId,
          target_league_id: targetLeagueId,
          salary_import: {
            player_count: salaryRows.length,
            franchise_imports: imports,
          },
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
          mflExportJsonWithRetry(season, leagueId, "myfranchise", {}, { includeApiKey: true, useCookie: true }),
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
        const isManualContractUpdate =
          path === "/commish-contract-update" || contractTypeRaw.includes("manual_contract_update");
        const isRestructure =
          !isManualContractUpdate &&
          (path === "/offer-restructure" || contractTypeRaw.includes("restructure"));
        const eventType = isRestructure ? "log-restructure-submission" : "log-mym-submission";
        const sourceTag = isRestructure ? "worker-offer-restructure" : "worker-offer-mym";
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

        let logDispatch = {
          ok: false,
          queued: false,
          skipped: true,
          reason: isManualContractUpdate ? "Manual update does not dispatch submission log" : "No applied change detected",
        };
        if (looksOk && anyChanged && !isManualContractUpdate) {
          try {
            logDispatch = await dispatchRepoEvent(eventType, {
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

        let mutationStatus = "import_rejected";
        if (!looksOk) {
          mutationStatus = "import_rejected";
        } else if (!verifyAvailable) {
          mutationStatus = "verify_unavailable";
        } else if (!anyChanged) {
          mutationStatus = "import_no_change";
        } else if (isManualContractUpdate) {
          mutationStatus = "import_ok_log_dispatched";
        } else if (logDispatch.ok) {
          mutationStatus = "import_ok_log_dispatched";
        } else {
          mutationStatus = "import_ok_log_failed";
        }

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
