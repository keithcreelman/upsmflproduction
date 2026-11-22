/* UPS 2027 beta (PR A): the reviewed list of 31 cut-penalty charges whose MFL row carries only an add/drop id (adddrop2025_...), so no player id.

   This is a REVIEWED MAPPING, not a direct source. It is kept apart from direct resolution (a row whose own player id names the player): an item named from
   here carries nameSource "reviewed_mapping". Keith approved displaying these 31 names on 2026-11-22 (recorded verbatim on issue #1502); everything else stays
   "Player Unknown". Frozen data, no read. A name is returned only when the source token, the team, the season AND the posted amount all match a row below,
   so a new charge (a new token), or the same token on another team, season or amount, never inherits a name. The token is never displayed.

   Each row also carries the CUT DATE: the calendar date (Eastern Time, "YYYY-MM-DD") of MFL's own drop transaction for that player and team. It is the date only:
   a waiver drop processes at 9:00 AM ET, so no time of day is kept or shown. The 31 dates were checked against MFL's 2025 transactions (evidence file below).

   Adding, changing or removing a row needs a new reviewed list and Keith's go; tests/mobile2027_reviewed_names.test.mjs compares this file row for row with
   the reviewed inventory (tests/fixtures/mobile2027/reviewed_names_31.json). */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.reviewedNames = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var PROVENANCE = {
    list: "UPS reviewed inventory, issue #1502 (31 add/drop cut-penalty charges, 2026 season)",
    approved: "Keith 2026-11-22, display choice only (recorded verbatim on issue #1502)",
    verifiedOn: "2026-11-22",
    checks: [
      "E1 repo ledger salary_adjustments_2026.json: source id to player id and team, 31 of 31",
      "E2 MFL transactions 2025: exactly one drop of that player by that team within 2 minutes, 31 of 31 (blind re-run by the backlog session, and again by the build session)",
      "E3 MFL players export 2026: all 31 player ids present",
      "Corroboration only, never identity: the name in each MFL adjustment row equals the MFL name for the id"
    ],
    key: "source token + team + season + posted amount; all four must match",
    evidence: "docs/evidence/bl_m01_mfl_verification_2026-11-22.md (the method, the 31 rows as checked, and the script to re-run)",
    limits: "identity for 12 rows rests on the ledger because the same team made another drop within 2 minutes; the team 0010 pair (Chism, Thibodeaux) is asserted by test",
    dates: "cutDate is the Eastern Time calendar date of MFL's own drop transaction (a waiver drop processes at 9:00 AM ET, so only the date is kept); taken from the UPS ledger's drop record and checked against MFL's 2025 transactions",
    datesVerified: "reviewed list: 31 of 31 equal MFL's drop date (ET); the 10 rows that carry a player id: the 10-digit time in the id equals MFL's drop transaction to the second, 10 of 10",
    testNote: "the offline test compares this file with a second copy of the same reviewed table: it checks transcription and consistency, not identity; identity is the MFL verification in the evidence file and on issue #1502"
  };

  // [source token, team, season, posted amount, player id, MFL name, cut date (ET)]
  var ROWS = [
    ["adddrop2025_114.1", "0010", 2026, 1000, "13713", "Fitzpatrick, Minkah", "2025-08-13"],
    ["adddrop2025_129.1", "0009", 2026, 1000, "13668", "Chark, D.J.", "2025-08-17"],
    ["adddrop2025_141.2", "0007", 2026, 3500, "16152", "Richardson, Anthony", "2025-08-23"],
    ["adddrop2025_192.2", "0006", 2026, 1000, "16693", "Sweat, T'Vondre", "2025-09-12"],
    ["adddrop2025_231.2", "0001", 2026, 1000, "14210", "Pratt, Germaine", "2025-09-25"],
    ["adddrop2025_266.2", "0001", 2026, 1000, "17097", "Felton, Tai", "2025-10-02"],
    ["adddrop2025_276.2", "0002", 2026, 4000, "14322", "Edwards, T.J.", "2025-10-02"],
    ["adddrop2025_298.2", "0010", 2026, 1000, "17105", "Helm, Gunnar", "2025-10-04"],
    ["adddrop2025_333.2", "0006", 2026, 2500, "17054", "Martinez, Damien", "2025-10-11"],
    ["adddrop2025_336.1", "0001", 2026, 6300, "14358", "Browning, Jake", "2025-10-12"],
    ["adddrop2025_364.2", "0007", 2026, 1000, "14303", "Elliss, Kaden", "2025-10-16"],
    ["adddrop2025_369.2", "0008", 2026, 1000, "15337", "Gray, Noah", "2025-10-17"],
    ["adddrop2025_370.2", "0008", 2026, 1000, "13737", "Bates, Jessie", "2025-10-17"],
    ["adddrop2025_371.2", "0008", 2026, 1000, "14153", "Allen, Zach", "2025-10-17"],
    ["adddrop2025_380.1", "0007", 2026, 4000, "16262", "White, Keion", "2025-10-18"],
    ["adddrop2025_382.1", "0003", 2026, 2000, "16688", "Guerendo, Isaac", "2025-10-19"],
    ["adddrop2025_391.2", "0003", 2026, 2000, "16643", "Sanders, Ja'Tavion", "2025-10-19"],
    ["adddrop2025_399.2", "0005", 2026, 2500, "13837", "Franklin, Zaire", "2025-10-23"],
    ["adddrop2025_425.2", "0001", 2026, 750, "13681", "Chubb, Bradley", "2025-10-25"],
    ["adddrop2025_426.2", "0010", 2026, 1000, "17269", "Chism, Efton", "2025-10-25"],
    ["adddrop2025_427.2", "0010", 2026, 2000, "15806", "Thibodeaux, Kayvon", "2025-10-25"],
    ["adddrop2025_490.1", "0012", 2026, 3000, "12187", "Lockett, Tyler", "2025-11-04"],
    ["adddrop2025_549.2", "0004", 2026, 1000, "16679", "Nubin, Tyler", "2025-11-16"],
    ["adddrop2025_594.1", "0005", 2026, 3250, "15254", "Harris, Najee", "2025-11-26"],
    ["adddrop2025_595.1", "0001", 2026, 2500, "13189", "Engram, Evan", "2025-11-27"],
    ["adddrop2025_596.2", "0005", 2026, 1000, "14909", "Winfield, Antoine", "2025-11-27"],
    ["adddrop2025_634.1", "0012", 2026, 3500, "12140", "Winston, Jameis", "2025-12-04"],
    ["adddrop2025_651.2", "0001", 2026, 1000, "14882", "Greenard, Jonathan", "2025-12-11"],
    ["adddrop2025_657.2", "0008", 2026, 2450, "16215", "Musgrave, Luke", "2025-12-11"],
    ["adddrop2025_692.2", "0005", 2026, 2800, "13189", "Engram, Evan", "2025-12-20"],
    ["adddrop2025_698.1", "0011", 2026, 2100, "15240", "Lance, Trey", "2025-12-21"]
  ];

  var BY = {};
  ROWS.forEach(function (r) { BY[r[0] + "|" + r[1] + "|" + r[2] + "|" + r[3]] = { id: r[4], name: r[5], cutDate: r[6] }; });

  // -> { id, name, cutDate } or null. All four parts must match a reviewed row exactly.
  function lookup(token, fid, season, amount) {
    if (typeof token !== "string" || typeof fid !== "string" || typeof season !== "number" || typeof amount !== "number") return null;   // no coercion: "2026" and [1000] are not 2026 and 1000
    var k = token + "|" + fid + "|" + season + "|" + amount;
    return Object.prototype.hasOwnProperty.call(BY, k) ? { id: BY[k].id, name: BY[k].name, cutDate: BY[k].cutDate } : null;
  }
  function rows() { return ROWS.map(function (r) { return r.slice(); }); }

  return { lookup: lookup, rows: rows, PROVENANCE: PROVENANCE, COUNT: ROWS.length };
});
