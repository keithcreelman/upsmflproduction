/* Rules view — quick-reference card for the rules that come up most often
   in mobile flows (lineups / trades / add-drop / taxi / on the block).
   Content is condensed from docs/league_context_v1.md §B/§D/§6 — the
   canonical league context. Full rulebook lives in that doc; this is
   the mobile cheat sheet. */
(function () {
  "use strict";
  if (!window.UPS_MOBILE) return;
  var M = window.UPS_MOBILE;
  var U = M.util;

  var SECTIONS = [
    {
      key: "lineups",
      title: "Lineups",
      body: [
        "<b>14 starters total.</b> 1 QB · 1-3 RB · 2-4 WR · 1-3 TE · 1 PK · 1 PN · 1-3 DL (DT/DE) · 1-3 LB · 1-3 DB (CB/S).",
        "Taxi, IR, and expired players are <b>not eligible</b> to start.",
        "Lineups lock at each player's NFL game kickoff. MFL accepts partial submissions — you can save early and adjust later.",
        "Forgetting to set a lineup carries no fee but you'll start whatever MFL defaults you to."
      ]
    },
    {
      key: "trades",
      title: "Trades",
      body: [
        "<b>Trade window:</b> offseason through NFL Thanksgiving week kickoff.",
        "Eligible to trade: players with 1+ years remaining. Expired rookies tradable through the extension deadline; other expired contracts cannot be traded.",
        "<b>Cap money:</b> trade up to 50% of an outgoing player's salary. Cash alone is not enough — each side must include at least one player or pick.",
        "<b>Picks:</b> current-year and next-year picks tradable. Round 6 pick is NOT tradable.",
        "<b>Contract inheritance:</b> contracts transfer as-is; acquiring team owns cap consequences.",
        "<b>In-season acquire → extend:</b> if the player is in their final year, the acquiring team has 4 weeks to extend."
      ]
    },
    {
      key: "add-drop",
      title: "Add / Drop",
      body: [
        "<b>Blind-bid waivers:</b> Thu/Fri/Sat/Sun 9am ET. Bid amount becomes the player's salary. Pickups are 1-yr WW contracts.",
        "<b>FCFS:</b> after Sunday morning waiver run until each player's NFL kickoff. Salary $1K, 1-yr WW.",
        "<b>Drop penalty (canonical):</b> Penalty = (TCV × 75%) − Salary Earned. Salary Earned is per-week pro-rated: (completed weeks / eligible weeks) × year's actual salary.",
        "<b>Cap-free cuts:</b> 1-yr Vet/WW under $5K · taxi never-promoted · tag cut before FA Auction · retired · jail-bird (commish) · new-owner first cut."
      ]
    },
    {
      key: "taxi",
      title: "Taxi",
      body: [
        "<b>Eligibility:</b> rookies in their first 3 league years (rounds 2–6). Round 1 rookies are NOT taxi-eligible.",
        "<b>Cap:</b> taxi salaries are off-cap entirely.",
        "<b>Call-up flexibility (2026+):</b> a taxi player can be called up to active for up to 3 weeks before the call-up becomes permanent.",
        "<b>Demotion deadline:</b> contract deadline date for the current year."
      ]
    },
    {
      key: "on-the-block",
      title: "On the Block",
      body: [
        "Posting a player on the block updates MFL Trade Bait and announces in the War Room Discord channel.",
        "<b>Taxi players</b> can be posted on the block (2026+).",
        "Use the per-player note field to specify what you want, condition the offer (\"contender only\"), or note availability windows.",
        "Players come off the block by tapping \"✓ On the Block\" → Remove."
      ]
    },
    {
      key: "extensions",
      title: "Extensions (read-only on mobile)",
      body: [
        "<b>Schedule 1</b> (QB/RB/WR/TE): +$10K (1yr) or +$20K (2yr) on AAV.",
        "<b>Schedule 2</b> (DL/LB/DB/K/P): +$3K (1yr) or +$5K (2yr) on AAV.",
        "Trigger: <b>1 year remaining</b> at decision time. Once tagged, never extend.",
        "<b>1st-round rookie option:</b> 4th-year option = Year 3 salary + $5K. Decision by Sept of final original year.",
        "Submit extensions on the desktop site until mobile picker ships."
      ]
    },
    {
      key: "tags",
      title: "Tags (read-only on mobile)",
      body: [
        "<b>1 Offense tag + 1 Defense/ST tag</b> per team per year. Offseason only.",
        "Eligibility: 0 years remaining heading into upcoming season.",
        "Cannot be extended or MYM'd by anyone the year tagged. Must go to next FA Auction.",
        "Submit tags on the desktop site until mobile picker ships."
      ]
    },
    {
      key: "cap",
      title: "Cap",
      body: [
        "<b>Ceiling:</b> $300K during FA Auction → end of fantasy season. OFF during offseason.",
        "<b>Floor:</b> $260K — must be touched during FA Auction OR met by September contract deadline.",
        "<b>IR:</b> 50% cap relief.",
        "<b>Taxi:</b> 0% (off-cap).",
        "<b>Tag salaries</b> count as active.",
        "Source of truth: <code>docs/league_context_v1.md</code> §6."
      ]
    }
  ];

  function render(mount) {
    var html =
      '<div class="ups-m-card">' +
        '<div class="ups-m-card-title">Quick Rules Reference</div>' +
        '<div class="ups-m-rules-intro">Mobile cheat sheet — the canonical rulebook lives in ' +
        '<code>docs/league_context_v1.md</code>.</div>' +
      '</div>';
    SECTIONS.forEach(function (s) {
      html += '<div class="ups-m-card ups-m-rules-card" id="rules-' + U.escapeHtml(s.key) + '">' +
        '<div class="ups-m-rules-title">' + U.escapeHtml(s.title) + '</div>' +
        '<ul class="ups-m-rules-list">' +
          s.body.map(function (line) { return '<li>' + line + '</li>'; }).join("") +
        '</ul>' +
      '</div>';
    });
    html += '<div style="height:24px"></div>';
    mount.innerHTML = html;
  }

  M.rulesView = { render: render, sections: SECTIONS };
})();
