// Brute-force oracle for the clinching letters (site/shared/standings_clinch.js). It plays out EVERY way the
// remaining weeks can score (every weak order of the teams, ties included) with the games' real coupling, and for
// each finish keeps every seeding a tie could still produce (a tie on H2H win % may go to any tied team; a tie on
// All-Play wins may be ordered either way, because the deeper tiebreakers need points). For each team it returns
// the set of outcomes it can reach: a seed 1..k, or OUT.
export const OUT = 0;

export function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// format: { divisions: [[team idx...]], byes, wildCards }
export function emptyRecords(n) { return Array.from({ length: n }, () => ({ h: { w: 0, l: 0, t: 0 }, ap: { w: 0, l: 0, t: 0 }, games: 0 })); }

export function playWeek(recs, scores, games) {
  const n = scores.length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) {
    const r = recs[i].ap; if (scores[i] > scores[j]) r.w++; else if (scores[i] < scores[j]) r.l++; else r.t++;
  }
  for (const [a, b] of games) {
    recs[a].games++; recs[b].games++;
    if (scores[a] > scores[b]) { recs[a].h.w++; recs[b].h.l++; }
    else if (scores[a] < scores[b]) { recs[a].h.l++; recs[b].h.w++; }
    else { recs[a].h.t++; recs[b].h.t++; }
  }
}
const clone = (recs) => recs.map((r) => ({ h: { ...r.h }, ap: { ...r.ap }, games: r.games }));

// every outcome mask for one finished season's records
export function seedingsOf(recs, format, onOutcome) {
  const n = recs.length;
  const pct = recs.map((r) => (r.h.w + r.h.t / 2) / r.games);
  const apw = recs.map((r) => 2 * r.ap.w + r.ap.t);
  // division winner choices: every team tied at the top H2H win %
  const choices = format.divisions.map((d) => {
    const best = Math.max(...d.map((i) => pct[i]));
    return d.filter((i) => Math.abs(pct[i] - best) < 1e-9);
  });
  // All-Play orders: every permutation inside each group tied on All-Play wins
  const idx = [...Array(n).keys()].sort((a, b) => apw[b] - apw[a]);
  const groups = []; for (const i of idx) { const g = groups[groups.length - 1]; if (g && apw[g[0]] === apw[i]) g.push(i); else groups.push([i]); }
  const perms = (arr) => arr.length <= 1 ? [arr] : arr.flatMap((x, k) => perms([...arr.slice(0, k), ...arr.slice(k + 1)]).map((p) => [x, ...p]));
  let orders = [[]];
  for (const g of groups) { const ps = perms(g); orders = orders.flatMap((o) => ps.map((p) => o.concat(p))); }
  let assigns = [[]];
  for (const c of choices) assigns = assigns.flatMap((a) => c.map((x) => a.concat([x])));
  for (const order of orders) {
    const pos = new Array(n); order.forEach((t, k) => { pos[t] = k; });
    for (const a of assigns) {
      const dw = new Set(a);
      const dws = order.filter((t) => dw.has(t)), rest = order.filter((t) => !dw.has(t));
      const seed = new Array(n).fill(OUT);
      let s = 0;
      dws.slice(0, format.byes).forEach((t) => { seed[t] = ++s; });
      dws.slice(format.byes).concat(rest.slice(0, format.wildCards)).sort((u, v) => pos[u] - pos[v]).forEach((t) => { seed[t] = ++s; });
      onOutcome(seed, dw);
    }
  }
}

// reach[t] = { seeds:Set, dwAlways, dwNever }
export function reachable(recs, format, weeksLeft /* [{games}] */, levels) {
  const n = recs.length;
  const reach = Array.from({ length: n }, () => ({ seeds: new Set(), dw: new Set() }));
  const scores = new Array(n).fill(0);
  function rec(w, cur) {
    if (w === weeksLeft.length) {
      seedingsOf(cur, format, (seed, dw) => { for (let t = 0; t < n; t++) { reach[t].seeds.add(seed[t]); reach[t].dw.add(dw.has(t)); } });
      return;
    }
    const walk = (i) => {
      if (i === n) { const next = clone(cur); playWeek(next, scores, weeksLeft[w].games); rec(w + 1, next); return; }
      for (let v = 0; v < levels; v++) { scores[i] = v; walk(i + 1); }
    };
    // scores are reused across weeks, so snapshot per week
    const saved = scores.slice();
    walk(0);
    for (let i = 0; i < n; i++) scores[i] = saved[i];
  }
  rec(0, recs);
  return reach;
}

export function toInput(recs, format, weeksLeft, allGames) {
  const n = recs.length;
  const total = new Array(n).fill(0);
  for (const g of allGames) { total[g[0]]++; total[g[1]]++; }
  const divOf = {}; format.divisions.forEach((d, k) => d.forEach((t) => { divOf[t] = k; }));
  return {
    teams: recs.map((r, i) => ({ fid: String(i), division: String(divOf[i]), h2h: { ...r.h }, ap: { ...r.ap } })),
    h2hGames: Object.fromEntries(total.map((g, i) => [String(i), g])),
    apGamesLeft: (n - 1) * weeksLeft.length,
    byes: format.byes, wildCards: format.wildCards
  };
}
