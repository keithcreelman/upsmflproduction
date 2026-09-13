/* Manual patch list for player status MFL's own injuries export hasn't
 * caught up on yet. Live Scoring (site/shared/live_scoring.js) layers this on
 * top of MFL's export via withInjuryOverride() -- an entry here always wins,
 * since it only ever gets added for a status MFL is already behind on.
 *
 * How to add an entry:
 *   1. Confirm the status against real, independent reporting (multiple
 *      sources beats one) -- never invent or guess a status.
 *   2. Look up the player's MFL id (export?TYPE=players&JSON=1&DETAILS=1).
 *   3. Add an entry below with a real source URL and today's date.
 *   4. Prune the entry once MFL's own export reflects it, or the player's
 *      status resolves (activated, cleared protocol, etc.) -- this list is a
 *      temporary patch, not a permanent record.
 *
 * Status strings match MFL's own vocabulary (OUT / IR / IR-PUP / IR-NFI /
 * IR-R / SUSPENDED / RETIRED / HOLDOUT / DOUBTFUL / QUESTIONABLE) so they
 * flow through injuryFactor()/injuryShort() exactly like a real MFL entry.
 */
window.UPS_INJURY_OVERRIDES = {
  "14056": {   // Murray, Kyler -- QB, MIN
    status: "OUT",
    note: "Concussion protocol -- ruled out for the remainder of Week 1 vs. Green Bay",
    source: "https://www.vikings.com/news/kyler-murray-quarterback-injury-concussion-evaluation-week-1-packers",
    added: "2026-09-13"
  }
};
