// #1370 gate 1: the Standings Forecast's Week 6 companion is bound to the EXACT published UPS Wire file
// (UPS Center Week 6, #1367). A republished or edited Week 6 Wire file fails here before it can pair with
// counts from a different run (the page also refuses it at run time: forecastDetail()).
//   node scripts/safe_tests/run.mjs --only standings_forecast_wk06_binding
import fs from "node:fs";
import crypto from "node:crypto";
import { test, t, run } from "./fixtures/mini_test.mjs";

const read = (rel) => fs.readFileSync(new URL("../" + rel, import.meta.url));
const WIRE = read("site/wire/data/season_sim_2026_live_wk06.json");
const sim = JSON.parse(WIRE);
const comp = JSON.parse(read("site/wire/data/standings_forecast_2026_wk06.json"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

test("the companion names the published Week 6 file and its sha256", () => {
  t.equal(comp.wire.file, "season_sim_2026_live_wk06.json");
  t.equal(comp.wire.sha256, sha(WIRE));
  t.equal(comp.wire.sha256.slice(0, 8), "c70c8fc9");
});

test("run identity and every team's four odds match the published file (what the page checks)", () => {
  t.equal(comp.season, sim.season); t.equal(comp.throughWeek, sim.throughWeek); t.equal(sim.throughWeek, 6);
  t.equal(comp.wire.generatedAtUtc, sim.generatedAtUtc);
  t.equal(comp.wire.runs, sim.runs); t.equal(comp.wire.seed, sim.seed);
  t.equal(Object.keys(comp.wire.teams).length, sim.teams.length);
  for (const x of sim.teams) {
    t.deepEqual(comp.wire.teams[x.franchiseId], [x.currentPlayoffOdds, x.currentByeOdds, x.currentDivisionOdds, x.currentTitleOdds]);
  }
});

test("the test fixture of the Week 6 Wire file is byte-identical to the published one", () => {
  t.equal(sha(read("tests/fixtures/wire_season_sim_2026_live_wk06.json")), sha(WIRE));
});

test("the published Week 6 file carries no standingsForecast of its own (the companion supplies it)", () => {
  t.equal("standingsForecast" in sim, false);
  t.ok(comp.standingsForecast && comp.standingsForecast.teams);
});

await run("standings_forecast_wk06_binding");
