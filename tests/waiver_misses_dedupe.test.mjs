// The waiver report's "Not granted" section lists each team's missed player ONCE (Keith 2026-10-16).
//   node tests/waiver_misses_dedupe.test.mjs
//
// The 2026-10-16 report said "16 not granted" for five real misses:
//   - Real Deal Creel's Demario Davis and Akeem Davis-Gaither were each posted SIX times. MFL's Previously Processed
//     Waivers report repeats a request in every round it re-evaluates, and every repeated denied row became a card.
//   - Blake Bombers' Tanner McKee (outbid) was posted twice, for the same reason.
//   - "✖ Christian Kirk — Not Granted … fell through to ✅ Christian Kirk": a denied row for a player that same team WON
//     in the run is not a miss.
// Rows below have the report's shape — Round | Franchise | Player Added | Player Dropped | Original Request | Reason.
import { parseWaiverMisses, buildWaiverReportPlan } from "../worker/src/lib/waiver_run_post.js";
import { t, test, run } from "./fixtures/mini_test.mjs";

const RDC_REQ = "Add Davis, Demario NYJ LB for $1,000.00 and drop None Add Davis-Gaither, Akeem IND LB for $1,000.00 and drop None "
  + "Add Sherwood, Jamien NYJ LB for $1,000.00 and drop None Add Williams, Quincy CLE LB for $1,000.00 and drop None Submitted Oct 15";
const BB_REQ = "Add McKee, Tanner PHI QB for $4,000.00 and drop Flournoy, Ryan DAL WR Add Kirk, Christian SFO WR for $1,000.00 and drop Flournoy, Ryan DAL WR Submitted Oct 15";
const PG_REQ = "Add Sanker, Jonas NOS S for $1,000.00 and drop Thomas, Drake SEA LB Submitted Oct 15";
const SM_REQ = "Add McKee, Tanner PHI QB for $12,000.00 and drop Bourne, Kendrick ARI WR Submitted Oct 14";
const HEADER = ["Round", "Franchise", "Player Added", "Player Dropped", "Original Waiver Request", "Reason Not Granted"];
const ROWS = [HEADER,
  ["1", "Sex Manther", "McKee, Tanner PHI QB ($12000.00)", "Bourne, Kendrick ARI WR", SM_REQ, ""],
  ["1", "Blake Bombers", "None", "Flournoy, Ryan DAL WR", BB_REQ, "McKee, Tanner PHI QB Cannot Be Added Because Is Not Available."],
  ["1", "Blake Bombers", "Kirk, Christian SFO WR ($1000.00)", "Flournoy, Ryan DAL WR", BB_REQ, ""],
  ["1", "Pure Greatness", "None", "Thomas, Drake SEA LB", PG_REQ, "Sanker, Jonas NOS S Cannot Be Added Because Cannot Add/Drop Thomas, Drake SEA LB After His Game Has Kicked Off"],
];
// Real Deal Creel's request, re-evaluated in rounds 1–6: both locked players denied every round; Sherwood lands in round 6.
for (let r = 1; r <= 6; r += 1) {
  ROWS.push([String(r), "Real Deal Creel", "None", "None", RDC_REQ, "Davis, Demario NYJ LB Cannot Be Added Because Player Is Locked"]);
  ROWS.push([String(r), "Real Deal Creel", "None", "None", RDC_REQ, "Davis-Gaither, Akeem IND LB Cannot Be Added Because Player Is Locked"]);
}
ROWS.push(["6", "Real Deal Creel", "Sherwood, Jamien NYJ LB ($1000.00)", "None", RDC_REQ, ""]);
// …and Blake Bombers' request comes up again in round 2: McKee still gone, and the Kirk option now fails because the
// round-1 claim already dropped Flournoy.
ROWS.push(["2", "Blake Bombers", "None", "Flournoy, Ryan DAL WR", BB_REQ, "McKee, Tanner PHI QB Cannot Be Added Because Is Not Available."]);
ROWS.push(["2", "Blake Bombers", "Kirk, Christian SFO WR ($1000.00)", "Flournoy, Ryan DAL WR", BB_REQ, "Flournoy, Ryan DAL WR Cannot Be Dropped Because Is Not On Franchise Blake Bombers"]);

const misses = parseWaiverMisses(ROWS);
const who = misses.map((m) => `${m.franchise_name}: ${m.player && m.player.name}`).sort();

test("one miss per team and player: 4 misses, not 16", () => {
  t.deepEqual(who, ["Blake Bombers: Tanner McKee", "Pure Greatness: Jonas Sanker", "Real Deal Creel: Akeem Davis-Gaither", "Real Deal Creel: Demario Davis"]);
});
test("a player the same team won in this run is never 'not granted' (Christian Kirk)", () => {
  t.ok(!misses.some((m) => m.player && m.player.name === "Christian Kirk"));
});
test("each kept miss still says why: locked, outbid by Sex Manther $12K to $4K, kicked-off drop; and what the team got instead", () => {
  const by = Object.fromEntries(misses.map((m) => [m.player.name, m]));
  t.equal(by["Demario Davis"].reason, "Player Is Locked");
  t.equal(by["Demario Davis"].granted_instead.name, "Jamien Sherwood");
  t.deepEqual([by["Tanner McKee"].lost_to, by["Tanner McKee"].loss_kind, by["Tanner McKee"].winning_bid_dollars, by["Tanner McKee"].bid_dollars], ["Sex Manther", "outbid", 12000, 4000]);
  t.equal(by["Tanner McKee"].granted_instead.name, "Christian Kirk");
  t.match(by["Jonas Sanker"].reason, /After His Game Has Kicked Off/);
});
test("the report's counts follow: 'Not granted 4', Real Deal Creel '2 missed', Blake Bombers '1 missed'", () => {
  const plan = buildWaiverReportPlan({ run_date_label: "Oct 16", processed_at_et: "Oct 16, 2026, 9:00:00 AM EDT", season: "2026", misses,
    teams: [{ franchise_id: "0008", franchise_name: "Real Deal Creel", moves: [] }, { franchise_id: "0010", franchise_name: "Blake Bombers", moves: [] }] });
  const fields = Object.fromEntries(plan.parent_embed.fields.map((f) => [f.name, f.value]));
  t.equal(fields["Not granted"], "4");
  t.match(fields["By team"], /Real Deal Creel\*\* — [^\n]*2 missed/);
  t.match(fields["By team"], /Blake Bombers\*\* — [^\n]*1 missed/);
  t.equal(plan.move_messages.filter((m) => m.is_miss).length, 4);
});

await run("waiver_misses_dedupe");
