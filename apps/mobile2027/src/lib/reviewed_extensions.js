/* UPS 2027 beta (R10): the reviewed list of extension attributions, for current contracts whose extending team the contract text alone cannot show.

   This is a REVIEWED MAPPING, not a direct source. The app's own rule reads the extending team from the contract text's "Ext:" record (lib/contract.js
   extension). When the extension year is bound only through restructured terms, that rule is not reliable (4 of the 10 such contracts were extended
   in 2026 by a team whose name was never appended to the token), so those contracts read "extending team not verified". A row here says which team
   made the extension IN FORCE NOW and in which season, as checked against original records (D1 extension, restructure and three-way-trade rows by
   id; MFL rosters exports by season). Keith asked for supported attributions to be shown on 2026-11-23 ("Show supported attributions where
   possible ... No production contract edits yet"). Frozen data, no read, no write. The contract data itself is not changed.

   A row applies only when the player id, the contract type AND the full contract text match the player's CURRENT contract exactly, character for
   character. A changed contract (a new extension, a restructure, an edited token) never inherits a row: it falls back to the app's own rule. Nothing
   here changes the contract data; it changes only which words the screen may use.

   Adding, changing or removing a row needs a new evidence check and Keith's go; tests/mobile2027_reviewed_extensions.test.mjs compares this file row for
   row with the reviewed inventory (tests/fixtures/mobile2027/reviewed_extensions.json). */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else { root.UPS2027 = root.UPS2027 || {}; root.UPS2027.reviewedExtensions = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var PROVENANCE = {
    list: "UPS reviewed extension attributions, R10: the 10 current extension contracts whose extension year is bound only through restructured terms",
    requested: "Keith 2026-11-23: verify extension history for London, Cook, Love and Hurts; show supported attributions where possible; no production contract edits",
    verifiedOn: "2026-11-23",
    checks: [
      "Production D1 ups_extension_submissions rows (read only, 2026-11-23): London id 665 (0009), Cook id 663 (0009), Darnold id 664 (0003), Hurts id 666 (0006), Love id 669 (0002)",
      "London: D1 ups_3way_trades 72cea017-d8ca-485b-8089-4122e5dc117a extension_requests_json (0009 -> 0010, EXT1, TCV 95000): a pre-trade extension is the trading-away team's own (canon); D1 ups_restructure_submissions id 10 (0010) was a restructure of the already-extended contract",
      "D1 salary_change_log commits and ups_restructure_submissions ids 4, 9, 14, 17, 25 (the restructures that followed)",
      "MFL rosters exports 2023, 2024 and 2025 (the contract and Ext: token MFL kept each season, with its franchise): Smith-Njigba, Higgins, Mason, Sutton bracketed 2024 -> 2025; Walker III after the 2025 export and before restructure id 4 (2026-04-17)"
    ],
    key: "player id + contract type + full contract text; all three must equal the current contract exactly",
    dataNote: "display only: the contract data (the Ext: tokens that omit the 2026 extenders of London, Cook, Love and Hurts) is unchanged; token corrections await Keith",
    evidence: "R10 evidence check of 2026-11-23 (private working notes r10e_attributions.json / r10e_evidence.md, not in this repository; locators are record ids and export rows, no owner message text)",
    testNote: "the offline test compares this file with a second copy of the same reviewed table: it checks transcription and the exact-match guard, not the attribution itself; the attribution is the evidence check"
  };

  // [player id, contract type, full contract text (exact), extending franchise id, season the extension was made, MFL name]
  var ROWS = [
    ["15751", "Vet-Ext1-FL", "CL 2| TCV 95K| AAV 33K, 43K| Y1-33K, Y2-62K| GTD: 71.3K|Ext: PG| Restructured 2026", "0009", 2026, "London, Drake"],
    ["15715", "Vet-Ext1-BL", "CL 2|TCV 64K|AAV 27K, 37K|Y1-14K, Y2-50K|Ext: CBP|GTD: 48K|Restructured 2026", "0009", 2026, "Cook, James"],
    ["14782", "Vet-Ext1-BL", "CL 2|TCV 52K|AAV 21K, 31K|Y1-11K, Y2-41K|Ext: PG|GTD: 39K|Restructured 2026", "0002", 2026, "Love, Jordan"],
    ["14783", "Vet-Ext1-BL", "CL 2|TCV 119K|AAV 42K, 52K|Y1-47K, Y2-72K|Ext: Gride, Hammer|GTD: 89.3K|Restructured 2026", "0006", 2026, "Hurts, Jalen"],
    ["13592", "Vet-Ext1-FL", "CL 2| TCV 46K| AAV 18K, 28K| Y1-30K, Y2-16K| GTD: 34.5K| Ext: GRID| Restructured 2026", "0003", 2026, "Darnold, Sam"],
    ["16185", "Vet-Ext2-FL", "CL 3| TCV 70K| AAV 30K| Y1-14K, Y2-1K, Y3-55K| GTD: 52.5K| Ext: C-Town| restructure: 2025", "0009", 2025, "Smith-Njigba, Jaxon"],
    ["14835", "Vet-Ext1", "CL 2| TCV 48K| AAV 47K| Y1-24, Y2-24| GTD: 36K| Ext: Mafia, LH, C-Town| restructure: 2025", "0009", 2025, "Higgins, Tee"],
    ["15972", "Vet-Ext2-FL", "CL 3| TCV 52K| AAV 24K| Y1-14, Y2-14, Y3-24| GTD: 39K| Ext: LH| restructure: 2025", "0006", 2025, "Mason, Jordan"],
    ["15711", "Vet-Ext1-BL", "CL 2| TCV 74K| AAV 32K, 42K| Y1-15K, Y2-59K| GTD: 55.5K| Ext: PG, RealDeal| restructure: 2026", "0008", 2026, "Walker III, Kenneth"],
    ["13630", "Vet-Ext1", "CL 2| TCV 30K| AAV 20K| Y1-15K, Y2-15K| GTD: 22.5K| Ext: L.A. Looks| restructure: 2025", "0001", 2025, "Sutton, Courtland"]
  ];

  var BY = {};
  ROWS.forEach(function (r) { BY[r[0]] = r; });

  // -> { fid, season, name } or null. The id, the type and the full contract text must all equal a reviewed row exactly (no trimming, no coercion).
  function lookup(playerId, type, special) {
    if (typeof playerId !== "string" || typeof type !== "string" || typeof special !== "string") return null;
    if (!Object.prototype.hasOwnProperty.call(BY, playerId)) return null;
    var r = BY[playerId];
    return r[1] === type && r[2] === special ? { fid: r[3], season: r[4], name: r[5] } : null;
  }
  function rows() { return ROWS.map(function (r) { return r.slice(); }); }

  return { lookup: lookup, rows: rows, PROVENANCE: PROVENANCE, COUNT: ROWS.length };
});
