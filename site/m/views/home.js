/* UPS Mobile — Home command center + Market / Events mini-hubs.
   ───────────────────────────────────────────────────────────────────────
   A salary-cap dynasty OPERATIONS CONSOLE, not a generic fantasy app.
   Four compact zones (no long scroll):
     1. Identity bar  — team + season + sign-in / settings
     2. Cap hero      — Cap Room is the dominant number (shared component)
     3. Attention queue — incoming trades + contract windows + over-cap (shared)
     4. Launcher grid — 2-col icon tiles into each owner workspace

   Cap card + attention queue are the SAME functions the Roster tab uses
   (M.components.capHero / M.components.actionCenter) so they never diverge. */
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;

  var M = window.UPS_MOBILE;
  var U = M.util;
  var DATA = M.data;

  function ic(name, opts) { return window.UPS_ICONS ? window.UPS_ICONS.svg(name, opts || {}) : ""; }
  function mflHome() {
    return "https://www48.myfantasyleague.com/" +
      encodeURIComponent(M.state.ctx.year) + "/home/" + encodeURIComponent(M.state.ctx.leagueId);
  }

  // ── League-event vocabulary → label + icon name + actionable route ──
  var EVENT_META = {
    ups_rookie_draft:       { label: "Rookie Draft",           icon: "clipboard-list", route: "#league/draft" },
    rookie_draft:           { label: "Rookie Draft",           icon: "clipboard-list", route: "#league/draft" },
    free_agent_auction:     { label: "Free Agent Auction",     icon: "gavel",          route: "#league/auction" },
    faa:                    { label: "Free Agent Auction",     icon: "gavel",          route: "#league/auction" },
    expired_rookie_auction: { label: "Expired Rookie Auction", icon: "gavel",          route: "#league/auction" },
    era:                    { label: "Expired Rookie Auction", icon: "gavel",          route: "#league/auction" },
    contract_deadline:      { label: "Contract Deadline",      icon: "file-text",      route: "#myteam/contracts/myac" },
    extension_deadline:     { label: "Extension Deadline",     icon: "trending-up",    route: "#myteam/contracts/extend" },
    extensiondeadline:      { label: "Extension Deadline",     icon: "trending-up",    route: "#myteam/contracts/extend" },
    restructure_window:     { label: "Restructure Window",     icon: "sliders",        route: "#myteam/contracts/restructure" },
    restructure_deadline:   { label: "Restructure Deadline",   icon: "sliders",        route: "#myteam/contracts/restructure" },
    mym_deadline:           { label: "MYM Deadline",           icon: "clock",          route: "#myteam/contracts/mym" },
    trade_deadline:         { label: "Trade Deadline",         icon: "repeat",         route: "#league/trade" },
    tagging_deadline:       { label: "Tagging Deadline",       icon: "tag",            route: "#myteam/contracts/tag" },
    tag_deadline:           { label: "Tagging Deadline",       icon: "tag",            route: "#myteam/contracts/tag" },
    tagging_window:         { label: "Tagging Window",         icon: "tag",            route: "#myteam/contracts/tag" },
    fa_auction_start:       { label: "Free Agent Auction",     icon: "gavel",          route: "#league/auction" },
    last_day_for_cuts:      { label: "Roster Cutdown",         icon: "alert-triangle", route: "#myteam/roster" },
    nfl_kickoff:            { label: "NFL Kickoff",            icon: "calendar",       route: "#events" },
    mymdeadline:            { label: "MYM Deadline",           icon: "clock",          route: "#myteam/contracts/mym" },
    trade_deadline_thanksgiving: { label: "Trade Deadline",    icon: "repeat",         route: "#league/trade" }
  };
  function eventMeta(e) {
    var key = U.safeStr(e && e.event).toLowerCase();
    if (EVENT_META[key]) return EVENT_META[key];
    // UPS keys carry env prefixes (ups_, preseason_) — strip and retry.
    var stripped = key.replace(/^ups_/, "").replace(/^preseason_/, "");
    if (EVENT_META[stripped]) return EVENT_META[stripped];
    var label = stripped.replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    return { label: label || "League Event", icon: "calendar", route: "#events" };
  }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function prettyDate(d) {
    var m = U.safeStr(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? MONTHS[parseInt(m[2], 10) - 1] + " " + parseInt(m[3], 10) : U.safeStr(d);
  }
  function daysUntil(d) {
    var m = U.safeStr(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    var then = Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
    var now = new Date();
    var today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
    return Math.round((then - today) / 86400000);
  }
  function whenLabel(d) {
    var n = daysUntil(d);
    if (n == null) return prettyDate(d);
    if (n < 0) return "passed";
    if (n === 0) return "today";
    if (n === 1) return "tomorrow";
    if (n <= 21) return "in " + n + "d";
    return prettyDate(d);
  }
  function whenTone(d) {
    var n = daysUntil(d);
    if (n == null) return "";
    if (n < 0) return "past";
    if (n <= 3) return "now";
    if (n <= 14) return "soon";
    return "";
  }
  function upcomingEvents() {
    var evs = (M.state.leagueEvents && M.state.leagueEvents.events) || [];
    return evs.filter(function (e) { return e && e.date; }).slice().sort(function (a, b) {
      return U.safeStr(a.date).localeCompare(U.safeStr(b.date));
    });
  }

  // ── Context ──
  function eligCount(fid, action) {
    if (fid && M.components && M.components.eligiblePlayersForAction) {
      try { return M.components.eligiblePlayersForAction(fid, action).length; } catch (e) { return 0; }
    }
    return 0;
  }
  function gatherContext() {
    var fid = M.state.viewerFranchiseId;
    var cap = fid ? DATA.computeCap(fid) : null;
    var offers = M.state.tradeOffers || { incoming: [], outgoing: [] };
    return {
      fid: fid,
      team: M.state.viewerFranchise,
      cap: cap,
      incoming: (offers.incoming || []).length,
      outgoing: (offers.outgoing || []).length,
      contractOpen: eligCount(fid, "myac") + eligCount(fid, "extend") + eligCount(fid, "mym") + eligCount(fid, "restructure"),
      next: upcomingEvents()[0] || null
    };
  }

  // ── Identity bar ──
  function teamMark(team) {
    if (team && team.icon) return '<img class="ups-m-home-mark" src="' + U.escapeHtml(team.icon) + '" alt="" />';
    return '<span class="ups-m-home-mark glyph">' + ic("shield", { size: 22 }) + '</span>';
  }
  function renderIdentity(ctx) {
    var team = ctx.team;
    var teamName = team ? team.name : "Select your team";
    var sub = [];
    if (team && team.owner) sub.push(U.escapeHtml(team.owner));
    sub.push(U.escapeHtml(M.state.ctx.year) + " season");
    // Hide the Sign-in pill the moment the user is signed in. "Signed in" =
    // franchise resolved, /api/me confirmed a session, OR a forwarded
    // MFL_USER_ID token is stored — the durable sign-in artifact, which
    // survives a transient /api/me failure on a later load. Only a truly
    // signed-out user (no token, no franchise) sees it. (Keith 2026-06-10.)
    var signedIn = M.state.viewerFranchiseId || M.state.meConfigured ||
      (M.api && M.api.getStoredMflUserId && M.api.getStoredMflUserId());
    var signin = !signedIn
      ? '<a class="ups-m-signin-pill" href="' + mflHome() + '" target="_blank" rel="noopener">' + ic("log-in", { size: 15 }) + '<span>Sign in</span></a>'
      : "";
    return '' +
      '<section class="ups-m-identity">' +
        '<div class="ups-m-identity-main">' +
          teamMark(team) +
          '<div class="ups-m-identity-text">' +
            '<div class="ups-m-kicker">Owner Actions</div>' +
            '<h1 class="ups-m-home-team">' + U.escapeHtml(teamName) + '</h1>' +
            '<div class="ups-m-home-subline">' + sub.join('<span class="dot">·</span>') + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="ups-m-identity-actions">' +
          signin +
          '<a class="ups-m-icon-btn" href="#more" aria-label="Settings">' + ic("settings", { size: 20 }) + '</a>' +
        '</div>' +
      '</section>';
  }

  // ── Launcher tiles ──
  function tile(t) {
    // A numeric red badge (t.badge) takes precedence over a plain dot (t.dot) —
    // e.g. the Trades tile shows the received-offer count.
    var flag = t.badge != null
      ? '<span class="ups-m-launch-badge">' + U.escapeHtml(String(t.badge)) + '</span>'
      : (t.dot ? '<span class="ups-m-launch-dot"></span>' : "");
    return '<a class="ups-m-launch-tile tone-' + U.escapeHtml(t.tone || "base") + '" href="' + U.escapeHtml(t.href) + '">' +
      '<span class="ups-m-launch-ic">' + ic(t.icon, { size: 22 }) + '</span>' +
      flag +
      '<span class="ups-m-launch-label">' + U.escapeHtml(t.label) + '</span>' +
      '<span class="ups-m-launch-sub">' + U.escapeHtml(t.sub || "") + '</span>' +
    '</a>';
  }
  // ── Waivers tile ──
  // Status comes straight from GET /api/waivers/state via M.waivers (app.js).
  // The mode is the SERVER's `window.mode` (contract v2 §4) — nothing about
  // the waiver cadence is derived here. Subtitle answers the two things an
  // owner actually wants from the home screen: when does the next blind-bid
  // run fire, and how many claims do I have queued.
  //   returns { sub, badge, dot, href }
  function waiverTileInfo() {
    var W = M.waivers;
    if (!W || !W.mode) return { sub: "Waivers", badge: null, dot: false, href: "#players" };
    var info = W.mode();
    var w = (M.state.waiverState && M.state.waiverState.window) || null;
    var staged = (W.pickCount ? W.pickCount() : 0) + (W.clearCount ? W.clearCount() : 0);
    var viewer = M.state.waiverState && M.state.waiverState.viewer;
    // §1: a pending count is only a number when the server could READ MFL.
    // `pending_known === false` means UNKNOWN — showing 0 there would tell an
    // owner they have no claims when we simply couldn't ask.
    var pending = (viewer && viewer.pending_known !== false && viewer.pending_pick_count != null)
      ? U.safeInt(viewer.pending_pick_count, 0) : 0;
    var count = staged || pending;
    var claimsTxt = count ? (count + (count === 1 ? " claim" : " claims")) : "";
    // §5: while the write flag is dark the tile still opens (claims are
    // readable) but it says so, and never nudges toward a submit that can't
    // happen in-app.
    var readOnlyTxt = info.writeEnabled ? "" : " · read-only";
    var sub;
    if (info.mode === "bbid") {
      var cd = (w && w.next_bbid_run_unix && W.countdown) ? W.countdown(w.next_bbid_run_unix) : "";
      var runTxt = (w && w.next_bbid_run_label) ? ("Runs " + w.next_bbid_run_label) : "Blind bids open";
      sub = (cd ? runTxt + " · " + cd : runTxt) + (claimsTxt ? " · " + claimsTxt : "") + readOnlyTxt;
    } else if (info.mode === "fcfs") {
      sub = "First come, first served" + (claimsTxt ? " · " + claimsTxt : "") + readOnlyTxt;
    } else {
      // blackout / closed / unknown — the detail line IS the answer.
      sub = info.detail || "Waivers";
    }
    return {
      sub: sub,
      badge: count > 0 ? count : null,
      // Nudge when a run is imminent AND there is something staged to lose —
      // only meaningful when the owner can actually still submit it.
      dot: info.mode === "bbid" && info.writeEnabled && staged > 0 && W.isDirty && W.isDirty(),
      // With nothing claimed, the claims screen's entire content is "go to the
      // Market and tap Bid" — so send them there directly rather than through
      // a dead end. With claims to review, the claims screen IS the answer.
      //
      // Route on KNOWLEDGE, not on the count (§1). `pending` above is forced to
      // 0 when the read failed, because unknown must never render as a count —
      // but consuming that 0 as "they have none" would shortcut an owner whose
      // live claims we simply couldn't read past the one screen that explains
      // that. Only a confirmed-empty read takes the shortcut.
      href: (count > 0 || (viewer && viewer.pending_known === false))
        ? "#players/claims" : "#players"
    };
  }

  function buildTiles(ctx) {
    var cap = ctx.cap;
    var rosterSub = cap ? (cap.rosterCount + "/30" + (cap.taxiCount ? " · " + cap.taxiCount + " taxi" : "")) : "—";
    var contractsSub = ctx.contractOpen > 0 ? (ctx.contractOpen + " open") : "Up to date";
    var tradesSub = ctx.incoming > 0
      ? (ctx.incoming + " received" + (ctx.outgoing ? " · " + ctx.outgoing + " out" : ""))
      : (ctx.outgoing ? (ctx.outgoing + " out") : "No offers");
    var taxiIrSub = cap ? ((cap.taxiCount || 0) + " taxi · " + (cap.irCount || 0) + " IR") : "Moves";
    var eventsSub = ctx.next ? (eventMeta(ctx.next).label + " " + whenLabel(ctx.next.date)) : "No windows";
    var wv = waiverTileInfo();
    return [
      { label: "My Roster", icon: "clipboard-list", tone: "field",  href: "#myteam/roster",    sub: rosterSub },
      { label: "Standings", icon: "list-checks", tone: "violet", href: "#league/standings", sub: "Standings & playoff race" },
      // Live Scoring + Contracts intentionally omitted here — both are in the bottom nav.
      { label: "Trades",    icon: "repeat",         tone: "ember",  href: "#league/trade",     sub: tradesSub, badge: ctx.incoming > 0 ? ctx.incoming : null },
      { label: "Waivers",   icon: "gavel",          tone: "sky",    href: wv.href,             sub: wv.sub, badge: wv.badge, dot: wv.dot },
      { label: "Market",    icon: "tag",            tone: "sky",    href: "#players",          sub: "Browse — filter by team/FA" },
      { label: "Stats", icon: "bar-chart",   tone: "mint",   href: "#league/stats",     sub: "Leaderboards + points against" },
      { label: "Taxi & IR", icon: "shield",         tone: "violet", href: "#myteam/taxi",      sub: taxiIrSub },
      { label: "Events",    icon: "calendar",       tone: "mint",   href: "#events",           sub: eventsSub, dot: ctx.next && whenTone(ctx.next.date) === "now" }
    ];
  }

  // ── Home view ──
  function renderHome(mount) {
    var ctx = gatherContext();
    var hero = (M.components && M.components.capHero && ctx.cap) ? M.components.capHero(ctx.cap) : "";
    var attention = (M.components && M.components.actionCenter && ctx.fid) ? M.components.actionCenter(ctx.fid) : "";
    mount.innerHTML =
      '<div class="ups-m-home">' +
        renderIdentity(ctx) +
        hero +
        attention +
        '<div class="ups-m-launch-grid">' + buildTiles(ctx).map(tile).join("") + '</div>' +
        '<div class="ups-m-home-foot">UPS · salary-cap dynasty console</div>' +
      '</div>';
  }

  // ── Mini-hub header ──
  function miniHubHeader(kicker, title, sub) {
    return '<section class="ups-m-section-head">' +
      '<div class="ups-m-kicker">' + U.escapeHtml(kicker) + '</div>' +
      '<h1>' + U.escapeHtml(title) + '</h1>' +
      (sub ? '<div class="ups-m-section-sub">' + U.escapeHtml(sub) + '</div>' : '') +
    '</section>';
  }

  // ── Market mini-hub (#market) — focused entry into the player browser.
  // The player browser (#players) is the universal player surface; clicking a
  // player there reveals only the actions valid for their status + season phase
  // (Trade for / Trade away · Nominate / Bid · Add on the next WW run). ──
  function renderMarket(mount) {
    // Market === the combined, filterable player browser. The old hub (All
    // Players / Free Agents / Point Leaders) was redundant — every tile
    // opened the same #players list — so the Market card now points straight
    // at it, and the Team/FA filter lives in the players toolbar. Redirect
    // any lingering #market links there too. (Keith 2026-06-10.)
    M.route.navigate("#players");
  }

  // ── Events mini-hub (#events) — actionable league calendar ──
  function renderCalendar() {
    var evs = upcomingEvents();
    if (!evs.length) {
      return '<div class="ups-m-bucket-empty">No upcoming league events on the calendar yet.</div>';
    }
    return '<div class="ups-m-cal-list">' + evs.map(function (e, i) {
      var nm = eventMeta(e);
      var tone = whenTone(e.date);
      var cls = "ups-m-cal-row " + tone + ((i === 0 && tone === "now") ? " next" : "");
      return '<a class="' + cls + '" href="' + U.escapeHtml(nm.route) + '">' +
        '<span class="ups-m-cal-ic">' + ic(nm.icon, { size: 18 }) + '</span>' +
        '<span class="ups-m-cal-date"><span class="d">' + U.escapeHtml(prettyDate(e.date)) + '</span>' +
          '<span class="w">' + U.escapeHtml(whenLabel(e.date)) + '</span></span>' +
        '<span class="ups-m-cal-body"><span class="ups-m-cal-evt">' + U.escapeHtml(nm.label) + '</span>' +
          '<span class="ups-m-cal-go">' + (tone === "now" ? "Open now" : "Open") + '</span></span>' +
      '</a>';
    }).join("") + '</div>';
  }
  function renderEvents(mount) {
    var tiles = [
      { label: "Auction Room", icon: "gavel",          tone: "mint",   href: "#league/auction",        sub: "ERA & FAA board" },
      { label: "Rookie Draft", icon: "clipboard-list", tone: "field",  href: "#league/draft",          sub: "Draft room" },
      { label: "Tagging",      icon: "tag",            tone: "violet", href: "#myteam/contracts/tag",  sub: "Tag an expiring player" }
    ];
    mount.innerHTML =
      '<div class="ups-m-home">' +
        miniHubHeader("League Events", "League calendar", "Know what window is open and what matters next.") +
        '<section class="ups-m-info-card">' +
          '<div class="ups-m-info-title">Upcoming</div>' +
          renderCalendar() +
        '</section>' +
        '<div class="ups-m-launch-grid">' + tiles.map(tile).join("") + '</div>' +
      '</div>';
  }

  // Shared event/date helpers — the Contracts hub (and others) reuse these so
  // deadline formatting never diverges from the Events calendar.
  M.eventsUtil = {
    prettyDate: prettyDate,
    daysUntil: daysUntil,
    whenLabel: whenLabel,
    whenTone: whenTone,
    eventMeta: eventMeta,
    upcomingEvents: upcomingEvents
  };

  M.route.registerView("home", renderHome);
  M.route.registerView("market", renderMarket);
  M.route.registerView("events", renderEvents);
})();
