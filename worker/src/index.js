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
      const YEAR = url.searchParams.get("YEAR") || "2025";
      const browserMflUserId = String(url.searchParams.get("MFL_USER_ID") || "").trim();
      const browserApiKey = String(url.searchParams.get("APIKEY") || "").trim();

      if (
        !L &&
        !path.startsWith("/mcm") &&
        path !== "/offer-mym" &&
        path !== "/offer-restructure" &&
        path !== "/commish-contract-update" &&
        path !== "/trade-workbench" &&
        !path.startsWith("/trade-offers") &&
        path !== "/trade-pending"
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
        if (path === "/trade-workbench" || path.startsWith("/trade-offers")) {
          // Allow public trade workbench payloads (league/rosters/players) without a commish cookie.
          // Draft picks (assets export) and default-franchise detection may be unavailable and are surfaced as warnings.
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

        return {
          ok: true,
          isAdmin: emailCount > 1,
          reason: emailCount > 1
            ? "Private owner data visible (commish)"
            : "No private owner data visible (not commish)",
          emailCount,
          commishFranchiseId,
          mflHttp: 200,
        };
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

      const mflExportJson = async (year, leagueId, type, extraParams = {}, options = {}) => {
        const qs = new URLSearchParams({
          TYPE: String(type || "").trim(),
          L: String(leagueId || "").trim(),
          JSON: "1",
          _: String(Date.now()),
        });
        for (const [k, v] of Object.entries(extraParams || {})) {
          if (v == null) continue;
          const s = String(v).trim();
          if (!s) continue;
          qs.set(k, s);
        }
        if (options.includeApiKey && env.MFL_APIKEY) {
          qs.set("APIKEY", String(env.MFL_APIKEY));
        }
        const urlOut =
          `https://api.myfantasyleague.com/${encodeURIComponent(String(year || YEAR || "2025"))}` +
          `/export?${qs.toString()}`;
        const headers = { "User-Agent": "upsmflproduction-worker" };
        if (options.useCookie !== false && cookieHeader) headers.Cookie = cookieHeader;

        let res;
        let text = "";
        try {
          res = await fetch(urlOut, {
            headers,
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          text = await res.text();
        } catch (e) {
          return {
            ok: false,
            status: 0,
            url: urlOut,
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
          url: urlOut,
          data,
          error: payloadErr || (parsedOk ? "" : "non_json_response"),
          textPreview: String(text || "").slice(0, 500),
        };
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
              notes: safeStr(p?.drafted || ""),
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
        const franchiseRows = asArray(assetsPayload?.assets?.franchise || assetsPayload?.franchise).filter(Boolean);
        const out = {};
        for (const fr of franchiseRows) {
          const franchiseId = padFranchiseId(fr?.id || fr?.franchise_id);
          if (!franchiseId) continue;
          const rows = [];
          const seen = new Set();
          const pushPicks = (pickRows) => {
            for (const p of asArray(pickRows).filter(Boolean)) {
              const pickKey = safeStr(p?.pick || p?.id || p?.asset_id);
              const description = safeStr(p?.description || p?.name || pickKey || "Draft Pick");
              const key = pickKey || description;
              if (!key || seen.has(key)) continue;
              seen.add(key);
              rows.push({
                type: "PICK",
                asset_id: `pick:${key}`,
                pick_key: pickKey || description,
                description,
              });
            }
          };
          pushPicks(fr?.currentYearDraftPicks?.draftPick || fr?.currentYearDraftPicks?.draftpick);
          pushPicks(fr?.futureYearDraftPicks?.draftPick || fr?.futureYearDraftPicks?.draftpick);
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
          `https://api.myfantasyleague.com/${encodeURIComponent(String(season || YEAR || "2025"))}` +
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

      const base64UrlFromUtf8 = (text) =>
        utf8ToBase64(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

      const pickTokenFromAsset = (asset) => {
        const candidates = [
          safeStr(asset?.pick_key),
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
            to_franchise_id: padFranchiseId(r?.to_franchise_id),
            option_key: safeStr(r?.option_key),
            extension_term: safeStr(r?.extension_term),
            new_contract_status: safeStr(r?.new_contract_status),
            preview_contract_info_string: safeStr(r?.preview_contract_info_string),
          })),
        };
        return `[UPS_TWB_META:${base64UrlFromUtf8(JSON.stringify(compact))}]`;
      };

      const appendTradeMetaTagToComments = (comments, payload, fromFranchiseId, toFranchiseId) => {
        const base = safeStr(comments);
        const tag = buildTradeMetaTag(payload, fromFranchiseId, toFranchiseId);
        const out = base ? `${base} ${tag}` : tag;
        return out.slice(0, 2000);
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
          isValid: !!willGiveUp.length && !!willReceive.length,
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

      const normalizePendingTradeRow = (row) => {
        const tradeId = String(row?.trade_id || row?.tradeId || row?.id || "").replace(/\D/g, "");
        const fromId = padFranchiseId(
          row?.offeringteam ||
            row?.from_franchise_id ||
            row?.offeredfrom ||
            row?.franchise_id ||
            row?.franchise
        );
        const toId = padFranchiseId(
          row?.offeredto ||
            row?.to_franchise_id ||
            row?.target_franchise_id ||
            row?.to
        );
        const ts = safeInt(row?.timestamp || row?.created || row?.created_at, 0);
        return {
          trade_id: tradeId,
          from_franchise_id: fromId,
          to_franchise_id: toId,
          timestamp: ts,
          comments: safeStr(row?.comments),
          will_give_up: safeStr(row?.will_give_up || row?.willGiveUp),
          will_receive: safeStr(row?.will_receive || row?.willReceive),
          raw: row,
        };
      };

      const buildSalaryAdjRowsFromPayload = (payload, tradeId) => {
        const { left, right } = tradeSidesFromPayload(payload);
        const leftId = padFranchiseId(left?.franchise_id);
        const rightId = padFranchiseId(right?.franchise_id);
        if (!leftId || !rightId) return [];
        const nets = salaryNetBySideK(left, right);
        if (!nets.left_net_k) return [];
        const amount = nets.left_net_k * 1000;
        const suffix = tradeId ? ` (trade ${tradeId})` : "";
        return [
          {
            franchise_id: leftId,
            amount,
            explanation: `UPS traded salary settlement${suffix}: net ${nets.left_net_k > 0 ? "+" : ""}${nets.left_net_k}K`,
          },
          {
            franchise_id: rightId,
            amount: -amount,
            explanation: `UPS traded salary settlement${suffix}: net ${nets.right_net_k > 0 ? "+" : ""}${nets.right_net_k}K`,
          },
        ];
      };

      const buildSalaryAdjXml = (rows) => {
        const validRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
        if (!validRows.length) return "";
        const itemXml = validRows
          .map((row) => {
            const amountNum = Number(row.amount || 0);
            const amountText = Number.isFinite(amountNum)
              ? amountNum.toFixed(2).replace(/\.00$/, "")
              : "0";
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

      const buildExtensionSalariesXmlFromPayload = (payload, salariesByPlayer) => {
        const extReqs = Array.isArray(payload?.extension_requests) ? payload.extension_requests : [];
        const applied = [];
        const skipped = [];
        for (const req of extReqs) {
          const playerId = String(req?.player_id || "").replace(/\D/g, "");
          if (!playerId) {
            skipped.push({ reason: "missing_player_id", req });
            continue;
          }
          const current = salariesByPlayer[playerId] || {};
          const payloadPlayer = findPlayerRowInPayload(payload, playerId) || {};
          const salaryText = safeStr(current.salary || payloadPlayer.salary);
          const contractYearText = safeStr(current.contractYear || "1");
          const contractInfoText = safeStr(req?.preview_contract_info_string || current.contractInfo);
          const contractStatusText = safeStr(req?.new_contract_status || current.contractStatus);

          if (!salaryText || !contractYearText || !contractInfoText) {
            skipped.push({
              player_id: playerId,
              player_name: safeStr(req?.player_name),
              reason: "missing_salary_contract_fields",
            });
            continue;
          }

          applied.push({
            player_id: playerId,
            player_name: safeStr(req?.player_name),
            salary: salaryText,
            contractYear: contractYearText,
            contractInfo: contractInfoText,
            contractStatus: contractStatusText,
          });
        }

        if (!applied.length) {
          return { xml: "", applied, skipped };
        }

        const playersXml = applied
          .map((row) => {
            const attrs = [
              `id="${xmlAttrEscape(row.player_id)}"`,
              `salary="${xmlAttrEscape(row.salary)}"`,
              `contractYear="${xmlAttrEscape(row.contractYear)}"`,
              `contractInfo="${xmlAttrEscape(row.contractInfo)}"`,
            ];
            if (row.contractStatus) attrs.push(`contractStatus="${xmlAttrEscape(row.contractStatus)}"`);
            return `<player ${attrs.join(" ")} />`;
          })
          .join("");

        return {
          xml: `<salaries><leagueUnit unit="LEAGUE">${playersXml}</leagueUnit></salaries>`,
          applied,
          skipped,
        };
      };

      const applySalaryAdjFromPayload = async (leagueId, season, payload, tradeId) => {
        const rows = buildSalaryAdjRowsFromPayload(payload, tradeId);
        if (!rows.length) {
          return {
            ok: true,
            skipped: true,
            reason: "no_traded_salary_adjustments",
            rows: [],
          };
        }
        const dataXml = buildSalaryAdjXml(rows);
        const importRes = await postMflImportForm(
          season,
          {
            TYPE: "salaryAdj",
            L: leagueId,
            DATA: dataXml,
          },
          { TYPE: "salaryAdj", L: leagueId }
        );
        return {
          ok: !!importRes.requestOk,
          skipped: false,
          rows,
          upstreamStatus: importRes.status,
          upstreamPreview: importRes.upstreamPreview,
          targetImportUrl: importRes.targetImportUrl,
          formFields: importRes.formFields,
          dataXml,
          error: importRes.requestOk ? "" : importRes.error || "salaryAdj import failed",
        };
      };

      const applyExtensionsFromPayload = async (leagueId, season, payload) => {
        const extReqs = Array.isArray(payload?.extension_requests) ? payload.extension_requests : [];
        if (!extReqs.length) {
          return {
            ok: true,
            skipped: true,
            reason: "no_extension_requests",
            applied: [],
            skipped_rows: [],
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
        if (!plan.xml) {
          return {
            ok: true,
            skipped: true,
            reason: "no_valid_extension_rows",
            applied: plan.applied,
            skipped_rows: plan.skipped,
          };
        }
        const importRes = await postMflImportForm(
          season,
          {
            TYPE: "salaries",
            L: leagueId,
            APPEND: "1",
            DATA: plan.xml,
          },
          { TYPE: "salaries", L: leagueId, APPEND: "1" }
        );
        return {
          ok: !!importRes.requestOk,
          skipped: false,
          applied: plan.applied,
          skipped_rows: plan.skipped,
          dataXml: plan.xml,
          upstreamStatus: importRes.status,
          upstreamPreview: importRes.upstreamPreview,
          targetImportUrl: importRes.targetImportUrl,
          formFields: importRes.formFields,
          error: importRes.requestOk ? "" : importRes.error || "salaries import failed",
        };
      };

      if (path === "/trade-offers" && request.method === "GET") {
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || "");
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L param" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR param" });

        const franchiseId = padFranchiseId(
          url.searchParams.get("FRANCHISE_ID") ||
            url.searchParams.get("F") ||
            url.searchParams.get("franchise_id") ||
            ""
        );
        const includePayload = ["1", "true", "yes"].includes(
          safeStr(url.searchParams.get("include_payload")).toLowerCase()
        );
        const statusFilter = offerStatusNormalized(url.searchParams.get("status"), "");
        const limit = Math.max(1, Math.min(100, safeInt(url.searchParams.get("limit"), 20)));

        const loaded = await readTradeOffersDoc(leagueId, season);
        if (!loaded.ok) {
          return jsonOut(500, {
            ok: false,
            error: loaded.error || "Failed to load trade offers",
            storage_path: loaded.filePath || tradeOffersFilePath(leagueId, season),
          });
        }

        const allOffers = (loaded.doc?.offers || [])
          .map((o) => ({ ...(o || {}), status: offerStatusNormalized(o?.status, "PENDING") }))
          .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));

        const applyStatus = (rows) =>
          !safeStr(statusFilter)
            ? rows
            : rows.filter((o) => offerStatusNormalized(o.status, "PENDING") === statusFilter);

        const related = franchiseId
          ? allOffers.filter(
              (o) => padFranchiseId(o.from_franchise_id) === franchiseId || padFranchiseId(o.to_franchise_id) === franchiseId
            )
          : allOffers.slice();
        const incoming = franchiseId
          ? allOffers.filter((o) => padFranchiseId(o.to_franchise_id) === franchiseId)
          : [];
        const outgoing = franchiseId
          ? allOffers.filter((o) => padFranchiseId(o.from_franchise_id) === franchiseId)
          : [];

        const incomingFiltered = applyStatus(incoming).slice(0, limit).map((o) => sanitizeOfferForList(o, includePayload));
        const outgoingFiltered = applyStatus(outgoing).slice(0, limit).map((o) => sanitizeOfferForList(o, includePayload));
        const relatedFiltered = applyStatus(related).slice(0, limit).map((o) => sanitizeOfferForList(o, includePayload));

        return jsonOut(200, {
          ok: true,
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          franchise_id: franchiseId || "",
          storage_path: loaded.filePath,
          counts: {
            total: allOffers.length,
            related_total: related.length,
            incoming_total: incoming.length,
            outgoing_total: outgoing.length,
            incoming_pending: incoming.filter((o) => offerStatusNormalized(o.status, "PENDING") === "PENDING").length,
            outgoing_pending: outgoing.filter((o) => offerStatusNormalized(o.status, "PENDING") === "PENDING").length,
          },
          incoming: incomingFiltered,
          outgoing: outgoingFiltered,
          offers: relatedFiltered,
          generated_at: new Date().toISOString(),
        });
      }

      if (path === "/trade-pending" && request.method === "GET") {
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || "");
        const franchiseId = padFranchiseId(
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

      if (path === "/trade-offers" && request.method === "POST") {
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
        const fromFranchiseName = safeStr(body?.from_franchise_name);
        const toFranchiseName = safeStr(body?.to_franchise_name);
        const message = safeStr(body?.message).slice(0, 2000);
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
          return jsonOut(400, { ok: false, error: "Trade payload is not ready to submit" });
        }

        if (directMfl) {
          if (!cookieHeader) {
            return jsonOut(500, { ok: false, error: "Missing MFL_COOKIE worker secret for direct MFL submission" });
          }

          const proposalAssets = buildTradeProposalAssetLists(payload);
          const willGiveUp = proposalAssets.willGiveUp;
          const willReceive = proposalAssets.willReceive;
          if (!willGiveUp.length || !willReceive.length) {
            return jsonOut(400, {
              ok: false,
              error: "Could not build valid MFL trade assets for both sides",
              invalid_assets: {
                left: proposalAssets.leftTokensOut.invalid,
                right: proposalAssets.rightTokensOut.invalid,
              },
            });
          }

          const commentsOut = appendTradeMetaTagToComments(
            message,
            payload,
            fromFranchiseId,
            toFranchiseId
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
            return jsonOut(502, {
              ok: false,
              mode: "direct_mfl",
              error: "MFL tradeProposal import failed",
              upstreamStatus: importRes.status,
              upstreamPreview: importRes.upstreamPreview,
              upstreamPreviewInitial:
                proposalSubmit.retriedWithoutFranchiseId && proposalSubmit.firstRes
                  ? proposalSubmit.firstRes.upstreamPreview
                  : "",
              retriedWithoutFranchiseId: !!proposalSubmit.retriedWithoutFranchiseId,
              targetImportUrl: importRes.targetImportUrl,
              formFields: importRes.formFields,
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
            const exactMatches = fromToMatches.filter((r) => r.comments.includes(metaPrefix));
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

      if (path === "/trade-offers/action" && request.method === "POST") {
        let body = null;
        try {
          body = await request.json();
        } catch (_) {
          return jsonOut(400, { ok: false, error: "Invalid JSON payload." });
        }

        const leagueId = safeStr(body?.league_id || L || "");
        const season = safeStr(body?.season || YEAR || "");
        const offerId = safeStr(body?.offer_id);
        const action = offerStatusNormalized(body?.action, "");
        const actingFranchiseId = padFranchiseId(body?.acting_franchise_id || body?.franchise_id || "");
        const actionMessage = safeStr(body?.message).slice(0, 2000);
        const mflTradeId = String(body?.trade_id || body?.mfl_trade_id || body?.TRADE_ID || "").replace(/\D/g, "");
        // Queue mode is retired: direct MFL actions only.
        const directMfl = true;
        const payload =
          body?.payload && typeof body.payload === "object"
            ? body.payload
            : body?.offer_payload && typeof body.offer_payload === "object"
              ? body.offer_payload
              : null;

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
              return {
                ok: false,
                error: "Could not build valid MFL trade assets for both sides",
                invalid_assets: {
                  left: proposalAssets.leftTokensOut.invalid,
                  right: proposalAssets.rightTokensOut.invalid,
                },
              };
            }
            const commentsOut = appendTradeMetaTagToComments(
              comments,
              proposalPayload || {},
              fromFranchiseId,
              toFranchiseId
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
              return {
                ok: false,
                error: "MFL tradeProposal import failed",
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
              const exactMatches = fromToMatches.filter((r) => r.comments.includes(metaPrefix));
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
            });
          }

          if (!["ACCEPT", "REJECT", "REVOKE"].includes(action)) {
            return jsonOut(400, { ok: false, error: "action must be ACCEPT, REJECT, REVOKE, or COUNTER in direct mode" });
          }
          if (!mflTradeId) {
            return jsonOut(400, { ok: false, error: "trade_id is required for direct MFL actions" });
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
            return jsonOut(502, {
              ok: false,
              mode: "direct_mfl",
              action,
              error: "MFL tradeResponse import failed",
              upstreamStatus: responseImport.status,
              upstreamPreview: responseImport.upstreamPreview,
              targetImportUrl: responseImport.targetImportUrl,
              formFields: responseImport.formFields,
            });
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
          if (action === "ACCEPT") {
            if (payload) {
              salaryAdjOut = await applySalaryAdjFromPayload(leagueId, season, payload, mflTradeId);
              extensionsOut = await applyExtensionsFromPayload(leagueId, season, payload);
            } else {
              salaryAdjOut = {
                ok: true,
                skipped: true,
                reason: "missing_payload_for_finalize",
              };
              extensionsOut = {
                ok: true,
                skipped: true,
                reason: "missing_payload_for_finalize",
              };
            }
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

      if (path === "/trade-workbench" && request.method === "GET") {
        const season = safeStr(url.searchParams.get("YEAR") || YEAR || "");
        const leagueId = safeStr(url.searchParams.get("L") || L || "");
        if (!leagueId) return jsonOut(400, { ok: false, error: "Missing L param" });
        if (!season) return jsonOut(400, { ok: false, error: "Missing YEAR param" });

        const requestedDefaultFranchiseId = padFranchiseId(
          url.searchParams.get("F") ||
          url.searchParams.get("FRANCHISE_ID") ||
          url.searchParams.get("franchise_id") ||
          url.searchParams.get("MY") ||
          ""
        );

        const [leagueRes, rostersRes, assetsRes, myFrRes, extRes] = await Promise.all([
          mflExportJson(season, leagueId, "league"),
          mflExportJson(season, leagueId, "rosters"),
          mflExportJson(season, leagueId, "assets"),
          mflExportJson(season, leagueId, "myfranchise"),
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
        const myFranchiseId = requestedDefaultFranchiseId || (myFrRes.ok ? parseMyFranchiseId(myFrRes.data) : "");

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
            is_default: !!myFranchiseId && franchiseId === myFranchiseId,
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

        return jsonOut(200, {
          ok: true,
          league_id: leagueId,
          season: safeInt(season, Number(season) || 0),
          generated_at: new Date().toISOString(),
          source: "worker:/trade-workbench",
          salary_cap_dollars: leagueSalaryCapDollars,
          teams,
          extension_previews: extRes.rows || [],
          meta: {
            default_franchise_id: myFranchiseId || "",
            salary_cap_dollars: leagueSalaryCapDollars,
            counts: {
              teams: teams.length,
              roster_players: allPlayerIds.length,
              draft_picks: Object.values(pickAssetsByFranchise).reduce(
                (acc, arr) => acc + asArray(arr).length,
                0
              ),
              extension_preview_rows: Array.isArray(extRes.rows) ? extRes.rows.length : 0,
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
        const year = String(YEAR || "2025").trim();
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
