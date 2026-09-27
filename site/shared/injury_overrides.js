/* Manual patch list for a player's game-week designation that MFL's own
 * injuries export hasn't caught up on yet. Live Scoring
 * (site/shared/live_scoring.js) layers this on top of MFL's export via
 * withInjuryOverride().
 *
 * EVERY ENTRY IS A STATEMENT ABOUT ONE GAME WEEK. It must carry the `season`
 * and `week` it is true for, and it applies to exactly that week -- from the
 * moment the calendar moves on it applies to nobody, so it can never carry a
 * designation into a week it was not made for. An entry without a numeric
 * season AND week is ignored outright (the loader treats it as MFL having no
 * override), and tests/gameday_player_status.test.mjs fails the build for one.
 *
 * How to add an entry:
 *   1. Confirm the status against real, independent reporting (multiple
 *      sources beats one) -- never invent or guess a status.
 *   2. Look up the player's MFL id (export?TYPE=players&JSON=1&DETAILS=1).
 *   3. Add an entry below with the season, the week it applies to, a real
 *      source URL and today's date:
 *
 *        "<mfl player id>": {
 *          status: "OUT",            // MFL vocabulary, see below
 *          season: 2026, week: 3,    // REQUIRED -- the one week this is about
 *          note: "what the reporting said",
 *          source: "https://...",
 *          added: "YYYY-MM-DD"
 *        }
 *
 *   4. Prune the entry once MFL's own export reflects it. It stops applying
 *      by itself when its week ends; leaving it only adds noise.
 *
 * Status strings match MFL's own vocabulary (OUT / IR / IR-PUP / IR-NFI /
 * IR-R / SUSPENDED / RETIRED / HOLDOUT / DOUBTFUL / QUESTIONABLE) so they
 * flow through injuryFactor()/injuryShort() exactly like a real MFL entry.
 */
window.UPS_INJURY_OVERRIDES = {
  // (empty) -- the one standing entry was a Week 1 designation; it expired with
  // Week 1 and was removed rather than left to outlive its week.
};
