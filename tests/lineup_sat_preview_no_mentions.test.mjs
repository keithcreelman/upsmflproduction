// A Saturday Injury Report PREVIEW (or dry run) never looks up, renders or
// pings an owner mention — only the real weekly post does.
//   node tests/lineup_sat_preview_no_mentions.test.mjs
//
// Keith 2026-10-11: "Do not tag CBP, its owner or any other team during
// testing, dry runs, previews or verification."
import fs from "node:fs";
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import * as wiring from "../worker/src/lineup_wiring.js";

const SEASON = 2026, L = "74598", WEEK = 5;
const SUN1 = 1791738000, MNF = 1791850500, POLL_FROM = 1791507952, SAT8AM = 1791633900;
const FIDS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(4, "0"));
const STARTERS = Object.fromEntries(FIDS.map((f) => [f, Array.from({ length: 18 }, (_, i) => `9${f}${String(i).padStart(2, "0")}`)]));
STARTERS["0002"][0] = "14303";   // an OUT starter, so CBP is flagged

function install() {
  const posts = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
    if (u.startsWith("https://discord.com/")) {
      const body = init && init.body ? JSON.parse(init.body) : null;
      posts.push({ url: u, body });
      return json(u.endsWith("/threads") ? { id: "1599999999999999999" } : { id: String(posts.length) });
    }
    if (u.includes("TYPE=nflSchedule")) return json({ nflSchedule: { matchup: [{ kickoff: String(SUN1), team: [{ id: "NOS", isHome: "1" }, { id: "MIN" }] }, { kickoff: String(MNF), team: [{ id: "LAR", isHome: "1" }, { id: "BUF" }] }] } });
    if (u.includes("TYPE=nflByeWeeks")) return json({ nflByeWeeks: { team: [] } });
    if (u.includes("TYPE=players")) return json({ players: { player: FIDS.flatMap((f) => STARTERS[f].map((id) => ({ id, name: id === "14303" ? "Elliss, Kaden" : `P ${id}`, team: id === "14303" ? "NOS" : "MIN", position: "LB" }))) } });
    if (u.includes("TYPE=rosters")) return json({ rosters: { franchise: FIDS.map((f) => ({ id: f, player: STARTERS[f].map((id) => ({ id, status: "ROSTER" })) })) } });
    if (u.includes("TYPE=playerRosterStatus")) {
      const ids = new URL(u).searchParams.get("P").split(",");
      return json({ playerRosterStatuses: { playerStatus: ids.map((id) => ({ id, roster_franchise: { franchise_id: FIDS.find((f) => STARTERS[f].includes(id)), status: "S" } })) } });
    }
    if (u.includes("TYPE=league")) return json({ league: { franchises: { franchise: FIDS.map((id) => ({ id, name: id === "0002" ? "CBP" : `Team ${id}` })) } } });
    return json(null, 404);
  };
  return posts;
}
function env() {
  const d = makeD1({});
  applyMigrations(d, ["0093_ups_bot_heartbeat.sql", "0129_lineup_compliance.sql", "0149_lineup_sat_announce_log.sql"]);
  d.raw.prepare("INSERT INTO ups_injury_polls (season, week, polled_unix, rows_seen) VALUES (?, ?, ?, 1)").run(SEASON, WEEK, POLL_FROM);
  d.raw.prepare("INSERT INTO ups_injury_status (season, week, player_id, status, first_seen_unix, last_seen_unix) VALUES (?, ?, '14303', 'OUT', 1791579952, ?)").run(SEASON, WEEK, MNF);
  return { UPS_MFL_DB: d, DISCORD_BOT_TOKEN: "t", DISCORD_LINEUP_ANNOUNCE_CHANNEL_ID: "1550849538229534760" };
}
let lookups = 0;
const mentions = async (_e, fids) => { lookups += 1; return new Map(fids.map((f) => [f, ["111111111111111111"]])); };

test("PREVIEW (skipLog) to a test channel: CBP flagged by NAME only; no mention lookup; nothing can ping", async () => {
  const e = env(); const posts = install(); lookups = 0;
  const r = await wiring.runLineupSaturdayAnnounce(e, { season: SEASON, leagueId: L, week: WEEK, nowUnix: SAT8AM, channelId: "1089538054236160010", skipLog: true, resolveMentions: mentions });
  t.equal(r.ok, true); t.match(r.body, /\*\*CBP\*\*/);
  t.equal(lookups, 0, "mention resolver never called");
  t.equal(JSON.stringify(r).includes("<@"), false);
  const msgs = posts.filter((p) => p.url.endsWith("/messages"));
  t.ok(msgs.length >= 1);
  for (const m of msgs) {
    t.equal(m.body.content.includes("<@"), false, "no rendered mention");
    t.deepEqual(m.body.allowed_mentions, { parse: [] }, "Discord told to ping nobody");
  }
});

test("DRY RUN: nothing sent to Discord at all, no mention lookup", async () => {
  const e = env(); const posts = install(); lookups = 0;
  const r = await wiring.runLineupSaturdayAnnounce(e, { season: SEASON, leagueId: L, week: WEEK, nowUnix: SAT8AM, dryRun: true, skipLog: true, resolveMentions: mentions });
  t.equal(r.ok, true); t.equal(posts.length, 0); t.equal(lookups, 0);
});

test("the REAL weekly post (not a preview) still mentions flagged owners", async () => {
  const e = env(); const posts = install(); lookups = 0;
  await wiring.runLineupSaturdayAnnounce(e, { season: SEASON, leagueId: L, week: WEEK, nowUnix: SAT8AM, resolveMentions: mentions });
  t.equal(lookups, 1);
  const first = posts.find((p) => p.url.endsWith("/messages"));
  t.match(first.body.content, /<@111111111111111111>/); t.deepEqual(first.body.allowed_mentions, { parse: ["users"] });
});

test("the preview route passes no mention resolver", () => {
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  const i = src.indexOf('if (path === "/admin/lineup/preview-announce"');
  const block = src.slice(i, src.indexOf("return jsonOut(200, pRes);", i));
  t.equal(/resolveMentions:\s*resolveFranchiseMentions/.test(block), false);
});

await run("lineup_sat_preview_no_mentions");
