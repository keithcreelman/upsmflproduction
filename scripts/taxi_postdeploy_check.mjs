// READ-ONLY post-deploy check for the taxi rule (#1364). Two GETs of the live worker; never a write.
//   node scripts/taxi_postdeploy_check.mjs
// Passes when: /api/taxi-callups answers ok with the 70-player 2025 legacy set (scripts/taxi_legacy_2025_preflight.mjs);
// every /roster-workbench player carries a taxi_status and none is "could not be confirmed"; and the spot checks read
// the ruled wording (Keith 2026-10-21). A spot-check player who has since moved or been released is reported, not failed.
const W = process.env.UPS_WORKER || "https://upsmflproduction.keith-creelman.workers.dev";
const get = async (p) => { const r = await fetch(W + p); if (!r.ok) throw new Error(p + " → HTTP " + r.status); return r.json(); };
const tc = await get("/api/taxi-callups?L=74598&YEAR=2026");
const legacy = Object.values(tc.players || {}).filter((p) => p.legacy_2025 === true).length;
const rw = await get("/roster-workbench?L=74598&YEAR=2026");
const rows = [];
const walk = (o) => { if (Array.isArray(o)) return o.forEach(walk); if (o && typeof o === "object") { if ("taxi_eligible" in o && o.id) rows.push(o); Object.values(o).forEach(walk); } };
walk(rw);
const by = Object.fromEntries(rows.map((p) => [String(p.id), p]));
const SPOT = [
  ["17134", "Not eligible · active during 2025 (legacy promotion)"],
  ["17066", "Not eligible · permanently promoted after three temporary call-ups"],
];
const spots = SPOT.map(([pid, want]) => ({ pid, want, live: by[pid] && by[pid].taxi_status ? by[pid].taxi_status.text : "(not rostered)" }));
const out = {
  taxi_callups_ok: tc.ok === true, legacy_2025_players: legacy, roster_players: rows.length,
  missing_taxi_status: rows.filter((p) => !p.taxi_status).length,
  could_not_be_confirmed: rows.filter((p) => p.taxi_status && p.taxi_status.eligible === null).map((p) => p.id),
  eligible: rows.filter((p) => p.taxi_status && p.taxi_status.eligible === true).length,
  spots,
};
const ok = out.taxi_callups_ok && legacy === 70 && !out.missing_taxi_status && !out.could_not_be_confirmed.length
  && spots.every((s) => s.live === s.want || s.live === "(not rostered)");
console.log(JSON.stringify({ ok, ...out }, null, 1));
process.exit(ok ? 0 : 1);
