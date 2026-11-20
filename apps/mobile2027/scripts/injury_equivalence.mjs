// Runs the classic injury resolver and the beta's derived copy side by side over a generated matrix of reads and requires
// identical answers. Used by tests/mobile2027_injury_resolver.test.mjs (on the committed reviewed copy) and by check_shared.mjs (on
// the real classic file). Pure: nothing here touches the network or the disk beyond what the caller passes in.
import vm from "node:vm";

export function loadResolver(text, filename) {
  const ctx = vm.createContext({}); ctx.window = ctx;
  vm.runInContext(text, ctx, { filename });
  return ctx.UPSInjuryStatus;
}

const NOW = Date.UTC(2026, 10, 20, 17, 0, 0);
const ROSTER = [
  null,
  { status: "IR", chip: "IR", label: "Injured reserve", detail: "Knee", exp_return: "Nov 29, 2026" },
  { status: "IR-R", chip: "IR-R", label: "Injured reserve – designated to return", detail: null, exp_return: null },
  { status: "IR-PUP", chip: "PUP", label: "Physically unable to perform", detail: "Foot", exp_return: "Feb 15, 2027" },
  { status: "IR-NFI", chip: "NFI", label: "Non-football injury list", detail: null, exp_return: "Nov 1, 2026" },
  { status: "SUSPENDED", chip: "SUSP", label: "Suspended", detail: "Conduct", exp_return: "Week 14" },
  { status: "HOLDOUT", chip: "HOLD", label: "Holdout", detail: null, exp_return: "x".repeat(40) },
  { status: "RETIRED", chip: "RET", label: "Retired", detail: "Personal", exp_return: "Feb 15, 2027" },
];
const MFL = [null, { status: "Questionable", week: 11, details: "Neck", exp_return: "Nov 22, 2026" }, { status: "Doubtful", week: 11, details: null, exp_return: null }, { status: "Out", week: 11, details: "Hamstring", exp_return: "Nov 29, 2026" }];
const REPORT = [
  null,
  { status: "Questionable", injury: "Hamstring", practice: "Limited Participation in Practice", team: "DEN" },
  { status: "Doubtful", injury: "Ankle", practice: "Did Not Participate In Practice", team: "DEN" },
  { status: "Out", injury: "Knee", practice: "Did Not Participate In Practice", team: "DEN" },
  { status: null, injury: "Not injury related - resting player", practice: "Full Participation in Practice", team: "DEN" },
];
const PRIOR = [null, { week: 10, status: "Out", injury: "Knee" }];
const REPORT_FEEDS = [
  { ok: true, current: true, week: 11, teams_mfl: ["DEN", "KCC"], reason: null },
  { ok: true, current: false, week: 11, teams_mfl: [], reason: "Week 11 not out yet" },
  { ok: false, current: false, week: null, teams_mfl: [], reason: "HTTP 500" },
];
const MFL_FEEDS = [{ ok: true, week: 11 }, { ok: false, week: null, reason: "HTTP 500" }, null];
const ROSTER_FEEDS = [{ ok: true, week: 11 }, { ok: false, week: null, reason: "HTTP 500" }];
const MAPPED = [["1"], null];
const TEAMS = ["DEN", "KC", "KCC", "JAX", "FA", "FA*", ""];
const FALLBACKS = [null, { mfl: { status: "Out", details: "Calf" } }, { roster: { chip: "IR", label: "Injured reserve", detail: null, exp_return: "Nov 29, 2026" } }, { none: true, week: 11 }];
const EXP = ["Nov 29, 2026", "Nov 1, 2026", "Week 14", "", null, "x".repeat(60), "November 29, 2026", "Jan 3, 2027"];

function readOf(state, at, data) { return state === "ok" ? { state, at, data } : { state, at, data: null }; }

// -> { cases, diffs: [string] }
export function compareResolvers(originalText, derivedText) {
  const A = loadResolver(originalText, "original"), B = loadResolver(derivedText, "derived");
  const diffs = []; let cases = 0;
  const same = (label, a, b) => { cases++; if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(label + ": " + JSON.stringify(a).slice(0, 120) + " != " + JSON.stringify(b).slice(0, 120)); };
  const keysA = Object.keys(A).sort(), keysB = Object.keys(B).sort();
  same("exports", keysA.filter((k) => k !== "createLoader"), keysB);
  same("the derived copy has no loader", typeof B.createLoader, "undefined");
  same("TTL", A.TTL, B.TTL); same("aboutText", A.aboutText(), B.aboutText());
  EXP.forEach((e) => [NOW, NOW + 3 * 864e5, NOW - 40 * 864e5].forEach((n) => same("backText " + String(e).slice(0, 12), A.backText(e, n), B.backText(e, n))));
  const stores = [null, { status: () => "OUT", detail: () => "Knee", known: () => true }, { status: () => "IR", detail: () => null, known: () => true }, { status: () => "", detail: () => "", known: () => true }, { status: () => "Q", known: () => false }];
  stores.forEach((st, i) => [0, 11].forEach((wk) => same("fromMflStore " + i + "/" + wk, A.fromMflStore(st, 2026, wk, "1"), B.fromMflStore(st, 2026, wk, "1"))));
  // the matrix of fresh reads
  for (const ro of ROSTER) for (const m of MFL) for (const rp of REPORT) for (const pr of PRIOR) for (const rf of REPORT_FEEDS) for (const mf of MFL_FEEDS) {
    const players = { 1: Object.assign({}, ro ? { roster: ro } : {}, m ? { mfl: m } : {}, rp ? { report: rp } : {}, pr ? { prior: pr } : {}) };
    for (const mapped of MAPPED) {
      const data = { report_feed: rf, roster_feed: ROSTER_FEEDS[ro ? 0 : 1], mfl_feed: mf, players, mapped_mfl_ids: mapped };
      const read = readOf("ok", NOW - 60000, data);
      for (const team of TEAMS) {
        const ra = A.resolve(read, "1", team, { now: NOW }), rb = B.resolve(read, "1", team, { now: NOW });
        same("resolve " + [ro && ro.chip, m && m.status, rp && rp.status, pr ? "p" : "", rf.reason, mf && mf.ok, mapped ? "m" : "u", team].join("/"), ra, rb);
        if (team === "DEN") same("optText", A.optText(ra), B.optText(rb));
      }
      same("noteText", A.noteText(read, { now: NOW }), B.noteText(read, { now: NOW }));
    }
  }
  // not fresh, error, idle, loading, with every fallback
  for (const [st, at] of [["ok", NOW - 10 * 60 * 1000], ["error", NOW], ["idle", 0], ["loading", NOW]]) for (const fb of FALLBACKS) for (const team of ["DEN", "FA"]) {
    const read = readOf(st, at, { report_feed: REPORT_FEEDS[0], roster_feed: ROSTER_FEEDS[0], mfl_feed: MFL_FEEDS[0], players: {}, mapped_mfl_ids: ["1"] });
    same("resolve " + st + "/" + (fb ? Object.keys(fb)[0] : "no fallback") + "/" + team, A.resolve(read, "1", team, { now: NOW, fallback: fb }), B.resolve(read, "1", team, { now: NOW, fallback: fb }));
    same("noteText " + st + "/" + (fb ? Object.keys(fb)[0] : "none"), A.noteText(read, { now: NOW, fallback: fb }), B.noteText(read, { now: NOW, fallback: fb }));
    same("fresh " + st, A.fresh(read, NOW), B.fresh(read, NOW));
  }
  same("resolve with no read at all", A.resolve(null, "1", "DEN", { now: NOW }), B.resolve(null, "1", "DEN", { now: NOW }));
  same("noteText with no read", A.noteText(null, { now: NOW }), B.noteText(null, { now: NOW }));
  return { cases, diffs };
}
