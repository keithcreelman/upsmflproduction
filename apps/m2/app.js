// MFL 2.0 Release 1 (Gate A, Keith 2026-11-26: "R1 with lineup"). Team › Roster (with this week's lineup for the
// signed-in owner's own team), Team › Contracts, Team › Cap & picks, the player Contract tab, and More (sign-in, skin).
// Contract terms come from MFL's exports through the test worker; earned/guarantee come from the worker's cap engine
// (/api/cap-penalty/preview). A missing value says "Not recorded" / "Not available", never a computed guess.
(function () {
  "use strict";
  var S = window.UPS2_SHELL, A = window.UPS2_API, esc = S.esc, arr = A.arr, pad4 = A.pad4;
  var CM = window.UPS_CAP_MATH || null, FLEX = window.UPS_LINEUP_FLEX || null;
  var main = document.getElementById("main");

  var st = {
    season: null, me: null, league: null, rosters: null, players: {}, adj: null, loadedAt: null, error: null,
    viewFid: null, cap: null, capErr: null, capLoading: false,
    lu: null,            // { week, saved:Set, draft:Set, kick:{TEAM:unix}, bye:{TEAM:1}, error, loading, result }
    sheet: null,         // pid of the open player card
  };

  // ── helpers ────────────────────────────────────────────────────────────────────────────────────
  function money(n) {
    n = Number(n); if (!isFinite(n)) return "—"; if (n === 0) return "$0";
    var k = n / 1000, s = Math.abs(k) >= 100 || Math.round(k) === k ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, "");
    return (n < 0 ? "−$" + s.replace("-", "") : "$" + s) + "K";
  }
  function timeOf(d) { try { return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }
  function franchises() { return arr(st.league && st.league.league && st.league.league.franchises && st.league.league.franchises.franchise); }
  function teamName(fid) { var f = franchises().filter(function (x) { return pad4(x.id) === fid; })[0]; return f ? f.name : "Team " + fid; }
  function rosterOf(fid) {
    var f = arr(st.rosters && st.rosters.rosters && st.rosters.rosters.franchise).filter(function (x) { return pad4(x.id) === fid; })[0];
    return f ? arr(f.player) : [];
  }
  function pl(pid) { return st.players[pid] || { id: pid, name: "Player " + pid, position: "?", team: "" }; }
  function displayName(p) { var n = String(p.name || ""), i = n.indexOf(", "); return i > 0 ? n.slice(i + 2) + " " + n.slice(0, i) : n; }
  function group(pos) { pos = String(pos || "").toUpperCase(); if (pos === "DT" || pos === "DE") return "DL"; if (pos === "CB" || pos === "S") return "DB"; return pos; }
  var ORDER = ["QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB"];
  function byPos(a, b) {
    var ga = ORDER.indexOf(group(pl(a.id).position)), gb = ORDER.indexOf(group(pl(b.id).position));
    if (ga !== gb) return (ga < 0 ? 99 : ga) - (gb < 0 ? 99 : gb);
    return (Number(b.salary) || 0) - (Number(a.salary) || 0);
  }
  function section(r) { var s = String(r.status || ""); return /taxi/i.test(s) ? "taxi" : (/injured|^ir$/i.test(s) ? "ir" : "active"); }
  function yearsLeft(r) { var cy = parseInt(r.contractYear, 10); if (!(cy >= 0)) return "Years not recorded"; return cy === 0 ? "Expired" : cy === 1 ? "Final year" : cy + " years left"; }

  // Cap: the current app's rule (site/m/front_office_cap.js computeCapMath): expired and taxi count $0, IR counts half,
  // adjustments are summed per franchise and rounded to the nearest $1K.
  function capFor(fid) {
    var cap = Number(st.league && st.league.league && st.league.league.salaryCapAmount) || 0, players = 0;
    rosterOf(fid).forEach(function (r) {
      var sal = Number(r.salary) || 0, cy = parseInt(r.contractYear, 10), sec = section(r);
      if (cy === 0 || sec === "taxi") return;
      players += sec === "ir" ? Math.round(sal * 0.5) : sal;
    });
    var adj = 0, list = [];
    arr(st.adj && st.adj.salaryAdjustments && st.adj.salaryAdjustments.salaryAdjustment).forEach(function (a) {
      if (pad4(a.franchise_id) !== fid) return;
      var n = Number(a.amount) || 0; adj += n; list.push(a);
    });
    adj = Math.round(adj / 1000) * 1000;
    return { cap: Math.floor(cap), used: players + adj, players: players, adj: adj, space: Math.floor(cap) - (players + adj), list: list };
  }

  // Salary by season for this season and the next two. Y-tokens from MFL's contractInfo; this season falls back to MFL's
  // salary field; anything else missing is "Not recorded" (never TCV ÷ length).
  function schedule(r) {
    var info = CM ? CM.parseContractInfo(r.contractInfo) : { length: 0, yearVals: {}, tcv: 0, aav: 0, gtd: 0 };
    var cy = parseInt(r.contractYear, 10), cl = info.length || 0, base = Number(st.season) || 0, out = [];
    for (var k = 0; k < 3; k++) {
      var cell = { season: base + k };
      if (!(cy > 0) || k >= cy) cell.none = true;
      else {
        var idx = cl ? cl - cy + 1 + k : 0;
        if (idx && info.yearVals[idx] > 0) { cell.amount = info.yearVals[idx]; cell.src = "contract"; }
        else if (k === 0 && Number(r.salary) > 0) { cell.amount = Number(r.salary); cell.src = "salary"; }
        else cell.missing = true;
      }
      out.push(cell);
    }
    return { info: info, years: out };
  }
  function earnedLabel(r) {
    var sal = { contractInfo: r.contractInfo, contractYear: r.contractYear, salary: r.salary, contractStatus: r.contractStatus, status: r.status };
    if (CM && CM.isOneKPerYear(sal)) return { text: "Full-year rule", na: true };
    if (CM && CM.isWwEarnedNa(sal)) return { text: "Not applicable", na: true };
    // The cap engine's answer. "needs_review" holds the CUT PRICE (e.g. taxi eligibility unconfirmed), not the earned
    // amount, so a computed earned value still shows; an exempt contract with no earned amount is "Not applicable".
    var p = st.cap && st.cap.players && st.cap.players[r.id];
    if (p && p.earned !== null && p.earned !== undefined && p.earned !== "" && isFinite(Number(p.earned))) return { text: money(p.earned) };
    if (p && p.exempt && (p.earned === null || p.earned === undefined)) return { text: "Not applicable", na: true };
    return { text: st.capLoading ? "…" : "Not available", na: true };
  }
  function ensureCap() {
    if (st.cap || st.capLoading || st.capErr) return;
    st.capLoading = true;
    A.capPreview().then(function (j) { st.cap = j && j.ok !== false ? j : null; if (!st.cap) st.capErr = (j && j.error) || "no answer"; })
      .catch(function (e) { st.capErr = e.message; })
      .then(function () { st.capLoading = false; render(); });
  }

  // ── lineup (own team, signed in) ─────────────────────────────────────────────────────────────────
  function ranges() { return FLEX && FLEX.RANGES; }
  function eligibility(r) {
    var lu = st.lu, p = pl(r.id), team = String(p.team || "").toUpperCase(), now = Date.now() / 1000;
    if (section(r) !== "active") return { ok: false, why: section(r) === "taxi" ? "Taxi" : "IR" };
    if (!(parseInt(r.contractYear, 10) > 0)) return { ok: false, why: "Expired" };
    if (ORDER.indexOf(group(p.position)) < 0) return { ok: false, why: "Position unknown" };
    if (lu.bye[team]) return { ok: false, why: "Bye" };
    var ko = lu.kick[team];
    if (!ko) return { ok: false, why: "No game" };
    if (now >= ko) return { ok: false, locked: true, why: "Locked" };
    return { ok: true };
  }
  function lineupCheck(draft) {
    var R = ranges(), counts = {}, errors = [], short = [];
    if (!R) return { errors: ["The lineup rules didn't load, so saving is off."], short: [], total: draft.size };
    draft.forEach(function (pid) { var g = group(pl(pid).position); counts[g] = (counts[g] || 0) + 1; });
    Object.keys(R).forEach(function (g) {
      var n = counts[g] || 0, lo = R[g][0], hi = R[g][1];
      if (n > hi) errors.push(g + ": " + n + " starting, the most is " + hi + ".");
      else if (n < lo) short.push(g + " needs " + (lo - n) + " more");
    });
    if (draft.size > 18) errors.push(draft.size + " starters; the most is 18.");
    return { errors: errors, short: short, total: draft.size };
  }
  function loadLineup(fid) {
    st.lu = { week: null, saved: null, draft: null, kick: {}, bye: {}, loading: true, error: null, result: null };
    A.lineupWeek().then(function (w) {
      st.lu.week = w;
      return Promise.all([
        A.savedLineup(w),
        A.mflExport("nflSchedule", { W: w }),
        A.mflExport("nflByeWeeks", { W: w }).catch(function () { return null; }),
      ]);
    }).then(function (res) {
      var saved = res[0], sch = res[1], bye = res[2];
      if (saved && saved.known === true && Array.isArray(saved.starters)) st.lu.saved = new Set(saved.starters.map(String));
      else if (saved && saved.state === "no_record") st.lu.saved = new Set();
      else throw new Error((saved && saved.error) || "this week's lineup couldn't be read");
      arr(sch && sch.nflSchedule && sch.nflSchedule.matchup).forEach(function (m) {
        var ko = Number(m.kickoff) || 0; arr(m.team).forEach(function (t) { st.lu.kick[String(t.id).toUpperCase()] = ko; });
      });
      arr(bye && bye.nflByeWeeks && bye.nflByeWeeks.team).forEach(function (t) { st.lu.bye[String(t.id).toUpperCase()] = 1; });
      st.lu.draft = new Set(st.lu.saved);
    }).catch(function (e) { st.lu.error = e.message; })
      .then(function () { st.lu.loading = false; render(); });
  }
  function toggle(pid) {
    var lu = st.lu; if (!lu || !lu.draft) return;
    var r = rosterOf(st.viewFid).filter(function (x) { return String(x.id) === pid; })[0]; if (!r) return;
    var el = eligibility(r);
    if (lu.draft.has(pid)) { if (el.locked) return; lu.draft.delete(pid); }
    else { if (!el.ok) return; lu.draft.add(pid); }
    lu.result = null; render();
  }
  function changes() { var lu = st.lu, n = 0; if (!lu || !lu.draft) return 0; lu.draft.forEach(function (p) { if (!lu.saved.has(p)) n++; }); lu.saved.forEach(function (p) { if (!lu.draft.has(p)) n++; }); return n; }
  function save() {
    var lu = st.lu, fid = st.viewFid, chk = lineupCheck(lu.draft);
    if (chk.errors.length || lu.saving) return;
    lu.saving = true; lu.result = null; render();
    var starters = Array.from(lu.draft);
    A.submitLineup(fid, lu.week, starters).then(function (res) {
      var b = res.body || {};
      if (!res.httpOk || !b.ok) {
        var why = b.error || (b.mfl_response && b.mfl_response.error && (b.mfl_response.error.$t || b.mfl_response.error)) || ("HTTP " + res.status);
        lu.result = { kind: "bad", title: "Lineup not saved", text: String(why), more: "Your lineup on MFL is unchanged." };
        return;
      }
      lu.saved = new Set(starters);
      // Check MFL's own answer (liveScoring), not the worker's record.
      return A.mflStarters(b.week_used || lu.week, fid).then(function (onMfl) {
        if (!onMfl) { lu.result = { kind: "warn", title: "Saved, not confirmed", text: "MFL accepted the lineup, but its live scoring didn't list your team, so it couldn't be checked." }; return; }
        var want = new Set(starters), miss = starters.filter(function (p) { return onMfl.indexOf(p) < 0; }), extra = onMfl.filter(function (p) { return !want.has(p); });
        if (!miss.length && !extra.length) lu.result = { kind: "ok", title: "Saved and confirmed", text: "MFL shows the same " + onMfl.length + " starter" + (onMfl.length === 1 ? "" : "s") + " for week " + (b.week_used || lu.week) + "." };
        else lu.result = { kind: "warn", title: "Saved, but MFL shows something different", text: (miss.length ? "Missing on MFL: " + miss.map(function (p) { return displayName(pl(p)); }).join(", ") + ". " : "") + (extra.length ? "Also starting on MFL: " + extra.map(function (p) { return displayName(pl(p)); }).join(", ") + "." : "") };
      }).catch(function (e) { lu.result = { kind: "warn", title: "Saved, not confirmed", text: "MFL accepted the lineup; reading it back failed (" + e.message + ")." }; });
    }).catch(function (e) {
      lu.result = { kind: "bad", title: "Couldn't reach the test worker", text: e.message, more: "Nothing was confirmed. Check MFL before trying again." };
    }).then(function () { lu.saving = false; render(); });
  }

  // ── views ─────────────────────────────────────────────────────────────────────────────────────────
  function teamPicker() {
    var mine = st.me && st.me.signedIn ? st.me.fid : null;
    return '<div class="card"><h2>Team</h2><div style="padding:0 14px 14px"><label class="muted" for="teamPick" style="font-size:13px">Showing</label>' +
      '<select id="teamPick" class="big">' + (st.viewFid ? "" : '<option value="">Choose a team…</option>') +
      franchises().map(function (f) { var id = pad4(f.id); return '<option value="' + id + '"' + (id === st.viewFid ? " selected" : "") + ">" + esc(f.name) + (id === mine ? " (you)" : "") + "</option>"; }).join("") +
      "</select></div></div>";
  }
  function capCard(fid) {
    var c = capFor(fid);
    return '<div class="card"><h2>Cap · ' + esc(st.season) + '</h2><div class="cap">' +
      "<div><b>" + money(c.cap) + "</b><span>Cap</span></div>" +
      "<div><b>" + money(c.used) + "</b><span>Used</span></div>" +
      "<div><b>" + money(c.space) + "</b><span>Space</span></div></div>" +
      '<p class="note">Taxi and expired count $0, IR counts half, plus adjustments (' + money(c.adj) + "). From MFL" + (st.loadedAt ? " as of " + timeOf(st.loadedAt) : "") + ".</p></div>";
  }
  function playerRow(r, extra) {
    var p = pl(r.id);
    return '<button type="button" class="row" data-player="' + esc(r.id) + '"><span class="pos">' + esc(p.position) + '</span><span class="main"><span class="name">' + esc(displayName(p)) + '</span><span class="sub">' +
      esc(p.team || "FA") + " · " + esc(yearsLeft(r)) + ' · <span class="chip plain">' + esc(r.contractStatus || "No status") + "</span>" + (extra || "") +
      '</span></span><span class="num">' + money(r.salary) + "</span></button>";
  }
  function lineupRow(r, starting) {
    var p = pl(r.id), el = eligibility(r), pid = String(r.id);
    var canToggle = starting ? !el.locked : el.ok;
    var tag = el.locked ? '<span class="chip warn">Locked</span>' : (!el.ok && !starting ? '<span class="chip plain">' + esc(el.why) + "</span>" : "");
    return '<div class="row"><span class="pos">' + esc(p.position) + '</span><button type="button" class="main" data-player="' + esc(pid) + '" style="background:none;border:0;padding:0;text-align:left;min-height:44px">' +
      '<span class="name">' + esc(displayName(p)) + '</span><span class="sub">' + esc(p.team || "FA") + (tag ? " · " + tag : "") + "</span></button>" +
      '<button type="button" class="toggle" data-toggle="' + esc(pid) + '" aria-pressed="' + starting + '"' + (canToggle ? "" : " disabled") +
      ' aria-label="' + (starting ? "Starting: tap to bench " : "Bench: tap to start ") + esc(displayName(p)) + '">' + (starting ? "Start" : "Bench") + "</button></div>";
  }
  function lineupCard(fid, active) {
    var lu = st.lu;
    if (!lu || lu.loading) return '<div class="card"><h2>This week\'s lineup</h2><p class="loading">Loading this week\'s lineup…</p></div>';
    if (lu.error) return '<div class="alert bad"><b>Lineup unavailable</b>' + esc(lu.error) + ". Editing is off until it can be read.</div>";
    var starters = active.filter(function (r) { return lu.draft.has(String(r.id)); }).sort(byPos);
    var bench = active.filter(function (r) { return !lu.draft.has(String(r.id)); }).sort(byPos);
    var chk = lineupCheck(lu.draft), n = changes();
    var html = "";
    if (lu.result) html += '<div class="alert ' + lu.result.kind + '" role="status"><b>' + esc(lu.result.title) + "</b>" + esc(lu.result.text) + (lu.result.more ? " " + esc(lu.result.more) : "") + "</div>";
    html += '<div class="card"><h2>Starters · week ' + esc(lu.week) + " · " + chk.total + "/18</h2>" + (starters.length ? starters.map(function (r) { return lineupRow(r, true); }).join("") : '<p class="note">No starters set.</p>');
    if (chk.errors.length) html += '<div class="alert bad" style="margin:12px 14px"><b>Can\'t save yet</b>' + esc(chk.errors.join(" ")) + "</div>";
    else if (chk.short.length || chk.total < 18) html += '<div class="alert warn" style="margin:12px 14px"><b>Short lineup: fixable</b>' + esc((chk.short.length ? chk.short.join(", ") + ". " : "") + (18 - chk.total) + " open spot" + (18 - chk.total === 1 ? "" : "s") + ". You can still save it.") + "</div>";
    html += '<div class="bar"><span class="grow">' + (n ? n + " change" + (n === 1 ? "" : "s") + " not saved" : "No unsaved changes") + '</span><button type="button" class="btn small" data-act="reset"' + (n ? "" : " disabled") + '>Undo</button><button type="button" class="btn primary" data-act="save"' + (n && !chk.errors.length && !lu.saving ? "" : " disabled") + ">" + (lu.saving ? "Saving…" : "Save lineup") + "</button></div></div>";
    html += '<div class="card"><h2>Bench</h2>' + (bench.length ? bench.map(function (r) { return lineupRow(r, false); }).join("") : '<p class="note">Everyone is starting.</p>') + "</div>";
    return html;
  }
  function rosterView(fid) {
    var rows = rosterOf(fid), own = st.me && st.me.signedIn && st.me.fid === fid;
    var active = rows.filter(function (r) { return section(r) === "active"; }), taxi = rows.filter(function (r) { return section(r) === "taxi"; }).sort(byPos), ir = rows.filter(function (r) { return section(r) === "ir"; }).sort(byPos);
    var html = capCard(fid);
    if (own) {
      if (!st.lu) loadLineup(fid);
      html += lineupCard(fid, active);
    } else {
      html += '<div class="card"><h2>Active · ' + active.length + "</h2>" + active.sort(byPos).map(function (r) { return playerRow(r); }).join("") + "</div>";
      if (!(st.me && st.me.signedIn)) html += '<p class="note" style="padding:0">Sign in (More tab) to set your own lineup.</p>';
    }
    html += '<div class="card"><h2>Taxi · ' + taxi.length + "</h2>" + (taxi.length ? taxi.map(function (r) { return playerRow(r); }).join("") : '<p class="note">None.</p>') + "</div>";
    html += '<div class="card"><h2>Injured reserve · ' + ir.length + "</h2>" + (ir.length ? ir.map(function (r) { return playerRow(r, ' · <span class="chip plain">IR: half cap</span>'); }).join("") : '<p class="note">None.</p>') + "</div>";
    return html;
  }
  function yearCell(c) {
    if (c.none) return '<td class="na">—</td>';
    if (c.missing) return '<td class="na">Not recorded</td>';
    return "<td>" + money(c.amount) + "</td>";
  }
  function contractsView(fid) {
    ensureCap();
    var rows = rosterOf(fid).slice().sort(function (a, b) { var o = { active: 0, ir: 1, taxi: 2 }; return (o[section(a)] - o[section(b)]) || byPos(a, b); });
    var y = Number(st.season) || 0;
    var html = '<div class="card"><h2>Contracts · all years</h2><div class="scroll-x"><table class="years"><thead><tr><th scope="col">Player</th><th scope="col">' + y + '</th><th scope="col">' + (y + 1) + '</th><th scope="col">' + (y + 2) + '</th><th scope="col">Earned</th></tr></thead><tbody>' +
      rows.map(function (r) {
        var p = pl(r.id), sc = schedule(r), e = earnedLabel(r);
        return '<tr><td><a href="#" data-player="' + esc(r.id) + '">' + esc(displayName(p)) + '</a><div class="muted" style="font-size:12px">' + esc(p.position) + " · " + esc(r.contractStatus || "—") + (section(r) !== "active" ? " · " + (section(r) === "ir" ? "IR" : "Taxi") : "") + "</div></td>" +
          sc.years.map(yearCell).join("") + '<td class="' + (e.na ? "na" : "") + '">' + esc(e.text) + "</td></tr>";
      }).join("") + "</tbody></table></div>" +
      '<p class="src">Salaries: MFL contract terms (Y-tokens; this season from MFL\'s salary)' + (st.loadedAt ? ", as of " + timeOf(st.loadedAt) : "") + ". Earned: UPS cap engine" +
      (st.cap && st.cap.calculated_at ? ", calculated " + esc(st.cap.calculated_at) : "") + (st.capErr ? " (unavailable: " + esc(st.capErr) + ")" : "") + ". \"Not recorded\" means MFL has no amount for that year.</p></div>";
    return html;
  }
  function capView(fid) {
    var c = capFor(fid);
    return capCard(fid) + '<div class="card"><h2>Cap detail</h2><div class="kv">' +
      '<div class="k">Player salaries counted</div><div class="v">' + money(c.players) + "</div>" +
      '<div class="k">Adjustments</div><div class="v">' + money(c.adj) + "</div>" +
      '<div class="k">Adjustment entries</div><div class="v">' + c.list.length + "</div></div></div>" +
      '<div class="card coming"><h2>Draft picks are coming</h2><p>Your picks by year will show here in a later release.</p></div>';
  }
  function moreView() {
    var m = st.me || {}, html = "";
    html += '<div class="card"><h2>Sign-in</h2>';
    if (m.signedIn) html += '<div class="kv"><div class="k">Signed in as</div><div class="v">' + esc(teamName(m.fid)) + " (" + esc(m.fid) + ')</div></div><div class="bar"><span class="grow muted">Signed in through MFL on this device.</span><button type="button" class="btn small" data-act="signout">Sign out</button></div>';
    else html += '<p class="note">Not signed in' + (m.reason ? " (" + esc(m.reason) + ")" : "") + '. To sign in: on MFL, open league ' + esc(A.L) + "'s home page with your test account and tap \"Open UPS TEST app\". This app uses the same sign-in on this device. Then come back here.</p>";
    html += "</div>" + S.skinPicker();
    html += '<div class="card"><h2>About</h2><p class="note">MFL 2.0 Release 1 on the UPS TEST site, league ' + esc(A.L) + ". The only change it can make is saving your own lineup; everything else is read-only.</p></div>";
    return html;
  }
  function sheetHtml(pid) {
    var r = rosterOf(st.viewFid).filter(function (x) { return String(x.id) === pid; })[0];
    var p = pl(pid);
    if (!r) return "";
    ensureCap();
    var sc = schedule(r), info = sc.info, cp = st.cap && st.cap.players && st.cap.players[pid], e = earnedLabel(r);
    var gtd = info.gtd > 0 ? money(info.gtd) : (cp && cp.guaranteed != null && isFinite(Number(cp.guaranteed)) ? money(cp.guaranteed) : (cp && cp.exempt ? "None (exempt)" : "Not recorded"));
    var remaining = "Not available";
    if (cp && cp.needs_review) remaining = "Held: not priced yet";
    else if (cp && cp.exempt && Number(cp.penalty) === 0) remaining = "$0 (exempt)";
    else if (cp && cp.penalty != null && cp.guaranteed != null && cp.earned != null && Number(cp.penalty) === Math.max(0, Number(cp.guaranteed) - Number(cp.earned))) remaining = money(cp.penalty);
    var kv = [
      ["Status", r.contractStatus || "Not recorded"], ["Years left", yearsLeft(r)], ["Length", info.length ? info.length + " year" + (info.length === 1 ? "" : "s") : "Not recorded"],
      ["Total value (TCV)", info.tcv > 0 ? money(info.tcv) : "Not recorded"], ["Average (AAV)", info.aav > 0 ? money(info.aav) : "Not recorded"],
      ["Guarantee", gtd], ["Earned to date", e.text], ["Remaining guaranteed", remaining],
    ];
    sc.years.forEach(function (c) { kv.push([String(c.season), c.none ? "—" : c.missing ? "Not recorded" : money(c.amount)]); });
    return '<div class="sheet-back" data-close="1"><div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(displayName(p)) + '">' +
      '<header><span class="pos" style="font-size:12px;font-weight:700;padding:3px 6px;border-radius:6px;background:var(--chip)">' + esc(p.position) + '</span><div class="main"><h2>' + esc(displayName(p)) + '</h2><div class="muted" style="font-size:13px">' + esc(p.team || "FA") + " · " + esc(teamName(st.viewFid)) + '</div></div><button type="button" class="btn small" data-close="1">Close</button></header>' +
      '<nav class="seg" style="margin:12px" aria-label="Player"><a href="#" aria-current="page">Contract</a><a aria-disabled="true" class="muted">Performance</a><a aria-disabled="true" class="muted">Schedule</a><a aria-disabled="true" class="muted">More</a></nav>' +
      '<div class="card" style="margin:12px"><h2>Contract</h2><div class="kv">' + kv.map(function (x) { return '<div class="k">' + esc(x[0]) + '</div><div class="v">' + esc(x[1]) + "</div>"; }).join("") + "</div>" +
      '<p class="src">Terms: MFL contract info "' + esc(r.contractInfo || "") + '" and salary' + (st.loadedAt ? ", as of " + timeOf(st.loadedAt) : "") + ". Earned, guarantee and remaining: UPS cap engine" + (st.cap && st.cap.calculated_at ? " (" + esc(st.cap.calculated_at) + ")" : "") + (st.capErr ? ", unavailable" : "") + ".</p></div>" +
      (cp && (cp.review_reason || cp.exempt_reason) ? '<p class="note" style="padding:0 14px 12px">' + esc(cp.review_reason || cp.exempt_reason) + "</p>" : "") +
      '<p class="note" style="padding:0 14px 16px">Performance, Schedule and More come in a later release.</p></div></div>';
  }

  function render() {
    var r = S.route();
    S.renderTabs(r);
    var html = "";
    if (st.error) html = '<div class="alert bad"><b>Couldn\'t load the league</b>' + esc(st.error) + '</div><button type="button" class="btn" data-act="retry">Try again</button>';
    else if (!st.league) html = '<p class="loading">Loading league ' + esc(A.L) + "…</p>";
    else if (r.area.built === false) html = S.comingView(r.area);
    else if (r.area.id === "more") html = moreView();
    else {
      html = S.subTabs(r) + teamPicker();
      if (!st.viewFid) html += '<p class="note" style="padding:0">Choose a team to see its roster and contracts.</p>';
      else if (r.sub.id === "roster") html += rosterView(st.viewFid);
      else if (r.sub.id === "contracts") html += contractsView(st.viewFid);
      else html += capView(st.viewFid);
    }
    document.getElementById("title").textContent = st.viewFid ? teamName(st.viewFid) : "MFL 2.0";
    main.innerHTML = html + (st.sheet ? sheetHtml(st.sheet) : "");
  }

  function load() {
    st.error = null; render();
    A.activeSeason().then(function (y) {
      st.season = y;
      return Promise.all([A.me(), A.mflExport("league"), A.mflExport("rosters"), A.mflExport("salaryAdjustments").catch(function () { return null; })]);
    }).then(function (res) {
      st.me = res[0]; st.league = res[1]; st.rosters = res[2]; st.adj = res[3]; st.loadedAt = new Date();
      var ids = [];
      arr(st.rosters && st.rosters.rosters && st.rosters.rosters.franchise).forEach(function (f) { arr(f.player).forEach(function (p) { ids.push(String(p.id)); }); });
      var saved = S.store("ups2_team");
      st.viewFid = (st.me && st.me.signedIn && st.me.fid) || (saved && franchises().some(function (f) { return pad4(f.id) === saved; }) ? saved : null);
      return A.mflExport("players", { PLAYERS: ids.join(",") }).then(function (pj) {
        arr(pj && pj.players && pj.players.player).forEach(function (p) { st.players[String(p.id)] = p; });
      });
    }).catch(function (e) { st.error = e.message; }).then(render);
  }

  main.addEventListener("change", function (e) {
    if (e.target && e.target.id === "teamPick") { st.viewFid = e.target.value || null; S.store("ups2_team", st.viewFid || ""); st.lu = null; render(); }
  });
  main.addEventListener("click", function (e) {
    var t = e.target.closest ? e.target : null; if (!t) return;
    var tg = t.closest("[data-toggle]"); if (tg) { toggle(tg.getAttribute("data-toggle")); return; }
    var pb = t.closest("[data-player]"); if (pb && !t.closest(".sheet")) { e.preventDefault(); st.sheet = pb.getAttribute("data-player"); render(); return; }
    var cl = t.closest("[data-close]"); if (cl && (cl.classList.contains("btn") || e.target === cl)) { st.sheet = null; render(); return; }
    if (t.closest(".sheet") && t.closest("a[href='#']")) { e.preventDefault(); return; }
    var act = t.closest("[data-act]"); if (!act) return;
    var a = act.getAttribute("data-act");
    if (a === "save") save();
    else if (a === "reset" && st.lu && st.lu.saved) { st.lu.draft = new Set(st.lu.saved); st.lu.result = null; render(); }
    else if (a === "signout") { A.signOut(); st.me = { signedIn: false }; st.lu = null; render(); }
    else if (a === "retry") load();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && st.sheet) { st.sheet = null; render(); } });
  window.addEventListener("hashchange", function () { st.sheet = null; render(); window.scrollTo(0, 0); });
  load();
})();
