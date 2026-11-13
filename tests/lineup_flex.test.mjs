// Lineup: Flex / SuperFlex are the LATEST games of the starters you pick, derived and never declared; and every submit ends in a
// big pop-up that needs an OK (Keith 2026-11-13). site/shared/lineup_flex.js + site/shared/lineup_result_modal.js, used by the
// phone app (site/m/views/lineup.js) and Game Day (site/gameday/gameday.html).
//   node scripts/safe_tests/run.mjs --only lineup_flex
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";

const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const load = (file, name, extra = {}) => { const c = vm.createContext({ ...extra }); c.window = c; vm.runInContext(read(file), c); return c[name]; };
const FLEX = load("site/shared/lineup_flex.js", "UPS_LINEUP_FLEX");
const FO = (() => { const c = vm.createContext({}); c.window = c; vm.runInContext(read("site/shared/lineup_flex.js"), c); vm.runInContext(read("site/m/front_office_lineup.js"), c); return c.UPS_FRONT_OFFICE_LINEUP; })();
const SLOTS = FO.LINEUP_SLOTS;

// kickoff = day * 100000 (Thu = 1 ... Mon = 5) + hour, in the same unit everywhere
const KO = { THU: 1_000_000, SUN1: 2_000_000, SUN4: 2_030_000, SNF: 2_080_000, MNF: 3_000_000 };
let n = 0;
const P = (name, pos, ko) => ({ id: "p" + ++n, name, pos, group: FO.posGroup(pos), ko });
const rowOfFor = (rows) => { const m = Object.fromEntries(rows.map((r) => [r.id, r])); return (pid) => m[pid] || null; };
const koOf = (r) => r.ko;
const byName = (rows) => Object.fromEntries(rows.map((r) => [r.name, r]));
const draftOf = (slotToRow) => Object.fromEntries(Object.entries(slotToRow).map(([s, r]) => [s, r.id]));
const who = (d, rows) => Object.fromEntries(Object.entries(d).map(([s, pid]) => [s, rows.find((r) => r.id === pid).name]));

test("the latest games are Flex / SuperFlex, however the lineup was entered", () => {
  const rows = [P("QB", "QB", KO.SUN1), P("RB-thu", "RB", KO.THU), P("RB-sun", "RB", KO.SUN1), P("WR-thu", "WR", KO.THU), P("WR-sun", "WR", KO.SUN4),
    P("WR-snf", "WR", KO.SNF), P("WR-mnf", "WR", KO.MNF), P("TE", "TE", KO.SUN1), P("RB-mnf", "RB", KO.MNF), P("K", "PK", KO.SUN1), P("P", "PN", KO.SUN1)];
  // entered the "wrong" way round: the Thursday WR sits in the Flex, a Monday WR in a plain WR slot
  const entered = draftOf({ QB1: rows[0], RB1: rows[1], RB2: rows[2], WR1: rows[6], WR2: rows[3], TE1: rows[7], OF1: rows[4], OF2: rows[8], SF1: rows[5], PK1: rows[9], PN1: rows[10] });
  const out = FLEX.arrange(entered, rowOfFor(rows), koOf, SLOTS);
  const w = who(out, rows);
  t.deepEqual(new Set(Object.values(out)), new Set(Object.values(entered)), "the same 11 players start: only the labels moved");
  t.equal(w.WR1, "WR-thu"); t.equal(w.WR2, "WR-sun", "the two WR slots hold the earliest WR games");
  t.equal(new Set([w.OF1, w.OF2, w.SF1]).size, 3);
  t.deepEqual([w.OF1, w.OF2, w.SF1].sort(), ["RB-mnf", "WR-mnf", "WR-snf"].sort(), "Flex, Flex and SuperFlex are the three latest games");
  t.equal(w.SF1, "RB-mnf", "the very last game is the SuperFlex (ties on Monday: the Monday RB and WR; stable by id)");
  t.deepEqual(who(FLEX.arrange(out, rowOfFor(rows), koOf, SLOTS), rows), w, "idempotent: arranging an arranged lineup changes nothing");
});
test("a QB can only be the SuperFlex; with one QB he stays in his own slot", () => {
  const rows = [P("QB-a", "QB", KO.THU), P("QB-b", "QB", KO.MNF), P("RB1", "RB", KO.SUN1), P("RB2", "RB", KO.SUN1), P("WR1", "WR", KO.SUN1), P("WR2", "WR", KO.SUN4),
    P("TE", "TE", KO.SUN1), P("WR3", "WR", KO.SNF), P("RB3", "RB", KO.SUN4), P("K", "PK", KO.SUN1), P("P", "PN", KO.SUN1)];
  const entered = draftOf({ QB1: rows[1], RB1: rows[2], RB2: rows[3], WR1: rows[4], WR2: rows[5], TE1: rows[6], OF1: rows[7], OF2: rows[8], SF1: rows[0], PK1: rows[9], PN1: rows[10] });
  const w = who(FLEX.arrange(entered, rowOfFor(rows), koOf, SLOTS), rows);
  t.equal(w.QB1, "QB-a", "the earlier QB game is the starting QB");
  t.equal(w.SF1, "QB-b", "the later QB game is the SuperFlex (the only slot that takes a QB)");
  const one = rows.filter((r) => r.name !== "QB-b");
  const solo = FLEX.arrange(draftOf({ QB1: rows[0], RB1: rows[2], RB2: rows[3], WR1: rows[4], WR2: rows[5], TE1: rows[6], OF1: rows[7], OF2: rows[8], PK1: rows[9], PN1: rows[10] }), rowOfFor(one), koOf, SLOTS);
  t.equal(who(solo, one).QB1, "QB-a"); t.ok(!solo.SF1, "no second QB: nothing is forced into the SuperFlex");
});
test("defense: the 7th starter with the latest game is the Flex", () => {
  const rows = [P("DL1", "DE", KO.SUN1), P("DL2", "DT", KO.SUN1), P("LB1", "LB", KO.THU), P("LB2", "LB", KO.SUN1), P("DB1", "CB", KO.SUN4), P("DB2", "S", KO.SUN1), P("LB3", "LB", KO.MNF)];
  const entered = draftOf({ DL1: rows[0], DL2: rows[1], LB1: rows[6], LB2: rows[3], DB1: rows[4], DB2: rows[5], DF1: rows[2] });
  const w = who(FLEX.arrange(entered, rowOfFor(rows), koOf, SLOTS), rows);
  t.equal(w.DF1, "LB3", "the Monday linebacker is the Flex; the Thursday one holds a fixed LB slot");
  t.deepEqual([w.LB1, w.LB2].sort(), ["LB1", "LB2"]);
  // 3 DL: the latest DL is the Flex
  const dl = [P("a", "DE", KO.SUN1), P("b", "DT", KO.SNF), P("c", "DE", KO.THU), P("l1", "LB", KO.SUN1), P("l2", "LB", KO.SUN1), P("d1", "CB", KO.SUN1), P("d2", "S", KO.SUN1)];
  const w2 = who(FLEX.arrange(draftOf({ DL1: dl[0], DL2: dl[1], DF1: dl[2], LB1: dl[3], LB2: dl[4], DB1: dl[5], DB2: dl[6] }), rowOfFor(dl), koOf, SLOTS), dl);
  t.equal(w2.DF1, "b"); t.deepEqual([w2.DL1, w2.DL2].sort(), ["a", "c"]);
});
test("a player whose game has started (the earliest kickoff) never lands in a Flex slot, so a lock never moves", () => {
  const rows = [P("QB", "QB", KO.SUN1), P("RB1", "RB", KO.SUN1), P("RB2", "RB", KO.SUN4), P("WR-started", "WR", KO.THU), P("WR2", "WR", KO.SUN1), P("TE", "TE", KO.SUN1),
    P("WR3", "WR", KO.SNF), P("WR4", "WR", KO.MNF), P("RB3", "RB", KO.MNF), P("K", "PK", KO.SUN1), P("P", "PN", KO.SUN1)];
  const entered = draftOf({ QB1: rows[0], RB1: rows[1], RB2: rows[2], WR1: rows[1] && rows[4], WR2: rows[5 - 2], TE1: rows[5], OF1: rows[6], OF2: rows[7], SF1: rows[8], PK1: rows[9], PN1: rows[10] });
  const out = FLEX.arrange(entered, rowOfFor(rows), koOf, SLOTS);
  t.ok(["WR1", "WR2"].some((s) => out[s] === rows[3].id), "the started WR holds a fixed WR slot");
  t.ok(!["OF1", "OF2", "SF1"].some((s) => out[s] === rows[3].id));
});
test("partial lineups: nothing is invented, nobody is dropped, a slot with too few players is not given to a Flex", () => {
  const rows = [P("RB", "RB", KO.SNF), P("WR1", "WR", KO.THU), P("WR2", "WR", KO.SUN1), P("WR3", "WR", KO.MNF)];
  const out = FLEX.arrange(draftOf({ RB1: rows[0], WR1: rows[1], WR2: rows[2], OF1: rows[3] }), rowOfFor(rows), koOf, SLOTS);
  t.deepEqual(new Set(Object.values(out)), new Set(rows.map((r) => r.id)));
  t.equal(who(out, rows).RB1, "RB", "one RB is below the 2 needed, so he keeps a fixed slot");
  t.equal(who(out, rows).OF1, "WR3", "the 3rd WR (the latest game) is the Flex");
  t.equal(JSON.stringify(FLEX.arrange({}, rowOfFor([]), koOf, SLOTS)), "{}");
});
test("unknown players, duplicates and a K in a skill slot are left alone for the validator, never hidden or moved", () => {
  const rows = [P("RB", "RB", KO.SUN1)];
  const d = { RB1: rows[0].id, RB2: "ghost" };
  t.equal(JSON.stringify(FLEX.arrange(d, rowOfFor(rows), koOf, SLOTS)), JSON.stringify(d));
  const dup = { RB1: rows[0].id, RB2: rows[0].id };
  t.equal(JSON.stringify(FLEX.arrange(dup, rowOfFor(rows), koOf, SLOTS)), JSON.stringify(dup));
});
test("K and P stay exactly where they are", () => {
  const rows = [P("K", "PK", KO.MNF), P("P", "PN", KO.THU), P("QB", "QB", KO.SUN1)];
  const out = FLEX.arrange(draftOf({ QB1: rows[2], PK1: rows[0], PN1: rows[1] }), rowOfFor(rows), koOf, SLOTS);
  t.equal(out.PK1, rows[0].id); t.equal(out.PN1, rows[1].id);
});
test("more players of a position than MFL allows stay visible (the validator names it)", () => {
  const rows = [P("a", "QB", KO.SUN1), P("b", "QB", KO.SNF), P("c", "QB", KO.MNF), P("d", "RB", KO.SUN1), P("e", "RB", KO.SUN1), P("f", "WR", KO.SUN1), P("g", "WR", KO.SUN1), P("h", "TE", KO.SUN1), P("k", "PK", KO.SUN1), P("p", "PN", KO.SUN1)];
  const entered = draftOf({ QB1: rows[0], OF1: rows[1], SF1: rows[2], RB1: rows[3], RB2: rows[4], WR1: rows[5], WR2: rows[6], TE1: rows[7], PK1: rows[8], PN1: rows[9] });
  const out = FLEX.arrange(entered, rowOfFor(rows), koOf, SLOTS);
  t.equal(Object.values(out).length, 10, "all ten still on screen");
  const rp = FLEX.rangeProblems(out, rowOfFor(rows), SLOTS);
  t.ok(rp.errors.some((e) => /At most 2 QB/.test(e)), rp.errors.join("|"));
});

// ── property check over random legal lineups ──
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
test("random legal lineups: same starters, every slot legal, and no swap would put a later game in a fixed slot", () => {
  const R = rng(11);
  const KOS = [KO.THU, KO.SUN1, KO.SUN4, KO.SNF, KO.MNF];
  let checked = 0;
  for (let trial = 0; trial < 400; trial++) {
    // a legal offense mix of 9 skill players and a legal defense mix of 7
    const q = 1 + Math.floor(R() * 2), tMax = 4;
    let rb = 2, wr = 2, te = 1, left = 9 - q - rb - wr - te;
    const cap = { RB: 5, WR: 5, TE: tMax };
    const cnt = { RB: rb, WR: wr, TE: te };
    while (left > 0) { const g = ["RB", "WR", "TE"][Math.floor(R() * 3)]; if (cnt[g] < cap[g]) { cnt[g]++; left--; } }
    let dl = 2, lb = 2, db = 2; const dx = ["DL", "LB", "DB"][Math.floor(R() * 3)]; if (dx === "DL") dl++; else if (dx === "LB") lb++; else db++;
    const rows = [];
    const add = (pos, k) => { for (let i = 0; i < k; i++) rows.push(P(pos + i, pos, KOS[Math.floor(R() * KOS.length)])); };
    add("QB", q); add("RB", cnt.RB); add("WR", cnt.WR); add("TE", cnt.TE); add("DE", dl); add("LB", lb); add("CB", db); rows.push(P("K", "PK", KOS[0]), P("P", "PN", KOS[1]));
    // enter them in a random order into any legal slots
    const shuffled = rows.slice().sort(() => R() - 0.5);
    const entered = {};
    const free = (side) => SLOTS.filter((s) => s.side === side && !entered[s.id]);
    for (const r of shuffled) {
      const side = ["DL", "LB", "DB"].includes(r.group) ? "D" : "O";
      const slot = r.group === "PK" ? SLOTS.find((s) => s.id === "PK1") : r.group === "PN" ? SLOTS.find((s) => s.id === "PN1") : free(side).find((s) => !["PK1", "PN1"].includes(s.id) && FLEX.pickAccepts(s, r.group));
      entered[slot.id] = r.id;
    }
    const rowOf = rowOfFor(rows);
    const out = FLEX.arrange(entered, rowOf, koOf, SLOTS);
    t.deepEqual(new Set(Object.values(out)), new Set(Object.values(entered)));
    // every slot is legal under the ORIGINAL slot labels: a fixed slot holds its own position, Flex takes its listed positions
    for (const s of SLOTS) if (out[s.id]) t.ok(FO.slotAccepts(s, rowOf(out[s.id]).group), s.id + " holds " + rowOf(out[s.id]).group);
    t.equal(FLEX.rangeProblems(out, rowOf, SLOTS).count, 0);
    // no better arrangement: swapping a flex player f and a fixed player x (both still legal) must not move a later game into the fixed slot
    const flexSlots = SLOTS.filter((s) => s.flex && out[s.id]), fixedSlots = SLOTS.filter((s) => !s.flex && out[s.id] && !["PK1", "PN1"].includes(s.id));
    for (const fs of flexSlots) for (const xs of fixedSlots) {
      if (fs.side !== xs.side) continue;
      const f = rowOf(out[fs.id]), x = rowOf(out[xs.id]);
      if (FO.slotAccepts(fs, x.group) && FO.slotAccepts(xs, f.group)) { t.ok(f.ko >= x.ko, "flex " + f.ko + " >= fixed " + x.ko); checked++; }
    }
  }
  t.ok(checked > 1000, "checked " + checked + " swaps");
});

// ── MFL's ranges instead of slot labels ──
test("a lineup MFL already holds is shown the way Keith expects on refresh (11-13 screenshots)", () => {
  // Dak Sun 4:25 at QB, Cousins Sun 1pm in SuperFlex -> the earlier game is the QB, the later one the SuperFlex
  const rows = [P("Dak", "QB", KO.SUN4), P("Cousins", "QB", KO.SUN1), P("Ekeler", "RB", KO.THU), P("Bijan", "RB", KO.SUN1), P("Parker", "WR", KO.SUN1), P("Diggs", "WR", KO.THU),
    P("Chiggy", "TE", KO.THU), P("Higbee", "TE", KO.SUN4), P("Lamb", "WR", KO.SUN4), P("K", "PK", KO.SUN1), P("P", "PN", KO.SUN1),
    P("Styles", "LB", KO.THU), P("Bolton", "LB", KO.SUN1), P("Carter", "LB", KO.SNF), P("DL1", "DE", KO.SUN1), P("DL2", "DT", KO.SNF), P("DB1", "CB", KO.SUN1), P("DB2", "S", KO.SUN1)];
  const R = byName(rows);
  const held = draftOf({ QB1: R.Dak, SF1: R.Cousins, RB1: R.Ekeler, RB2: R.Bijan, WR1: R.Parker, WR2: R.Diggs, TE1: R.Higbee, OF1: R.Chiggy, OF2: R.Lamb, PK1: R.K, PN1: R.P,
    LB1: R.Bolton, LB2: R.Carter, DF1: R.Styles, DL1: R.DL1, DL2: R.DL2, DB1: R.DB1, DB2: R.DB2 });
  const w = who(FLEX.arrange(held, rowOfFor(rows), koOf, SLOTS), rows);
  t.equal(w.QB1, "Cousins"); t.equal(w.SF1, "Dak");
  t.equal(w.TE1, "Chiggy", "the Thursday TE holds the TE slot, not a Flex");
  t.ok(w.OF1 === "Higbee" || w.OF2 === "Higbee", "the later TE is a Flex");
  t.deepEqual([w.LB1, w.LB2].sort(), ["Bolton", "Styles"], "the two earliest LB games hold the LB slots");
  t.equal(w.DF1, "Carter", "the latest LB game is the D-Flex, not the one who already played");
});
test("pickers are the original ones (no TE for QB); the ranges are MFL's", () => {
  const slot = (id) => SLOTS.find((s) => s.id === id);
  t.ok(FLEX.pickAccepts(slot("QB1"), "QB") && !FLEX.pickAccepts(slot("QB1"), "TE") && !FLEX.pickAccepts(slot("QB1"), "RB"), "QB1 takes only a QB");
  t.ok(FLEX.pickAccepts(slot("SF1"), "QB") && FLEX.pickAccepts(slot("SF1"), "TE") && FLEX.pickAccepts(slot("OF1"), "WR") && !FLEX.pickAccepts(slot("OF1"), "QB"), "SF takes QB/RB/WR/TE; Flex takes RB/WR/TE");
  t.ok(!FLEX.pickAccepts(slot("RB1"), "WR") && !FLEX.pickAccepts(slot("DL1"), "LB"), "fixed slots stay fixed");
  t.ok(FLEX.pickAccepts(slot("PK1"), "PK") && !FLEX.pickAccepts(slot("PK1"), "PN"));
  t.match(read("site/m/views/lineup.js"), /function inFlexSlot\(pid\)/); t.match(read("site/gameday/gameday.html"), /function inFlexSlot\(pid\)/);
  // 5 WR is legal on MFL ("2-5"), and expressible
  const rows = [P("QB", "QB", 1), ...[1, 2, 3, 4, 5].map((i) => P("WR" + i, "WR", i)), P("RB1", "RB", 1), P("RB2", "RB", 1), P("TE", "TE", 1), P("K", "PK", 1), P("P", "PN", 1)];
  const arranged = FLEX.arrange(draftOf({ QB1: rows[0], WR1: rows[1], WR2: rows[2], OF1: rows[3], OF2: rows[4], SF1: rows[5], RB1: rows[6], RB2: rows[7], TE1: rows[8], PK1: rows[9], PN1: rows[10] }), rowOfFor(rows), koOf, SLOTS);
  const v = FO.validateSlots(arranged, Object.fromEntries(rows.map((r) => [r.id, { id: r.id, name: r.name, pos: r.pos, team: "AAA" }])));
  t.equal(v.problems, 0, v.errors.join("|"));
  // 0 QB, 6 WR, 3 QB are not
  const bad = FO.validateSlots(draftOf({ QB1: rows[0], OF1: P("QBx", "QB", 1), SF1: P("QBy", "QB", 1) }), { });
  t.ok(bad.problems > 0);
});
test("the shared validators report MFL's ranges the same way on both surfaces", () => {
  const mk = (pos, i) => ({ id: pos + i, name: pos + i, pos, team: "AAA" });
  const rowsArr = [mk("QB", 1), mk("QB", 2), mk("QB", 3), mk("RB", 1), mk("RB", 2), mk("WR", 1), mk("WR", 2), mk("TE", 1), mk("PK", 1), mk("PN", 1)];
  const byId = Object.fromEntries(rowsArr.map((r) => [r.id, r]));
  const d = { QB1: "QB1", SF1: "QB2", OF1: "QB3", RB1: "RB1", RB2: "RB2", WR1: "WR1", WR2: "WR2", TE1: "TE1", PK1: "PK1", PN1: "PN1" };
  t.ok(FO.validateSlots(d, byId).errors.some((e) => /At most 2 QB can start \(you have 3\)/.test(e)));
  // Game Day's validate() is a copy: its source must call the same shared function
  const gd = read("site/gameday/gameday.html");
  t.match(gd, /FLEX\.rangeProblems\(draft,/); t.match(gd, /pickAccepts\(sl, posGroup\(r\.pos\)\)/);
  const mobile = read("site/m/views/lineup.js");
  t.match(mobile, /FLEX\.arrange\(draft, function \(pid\)/); t.match(mobile, /FLEX \? FLEX\.pickAccepts\(slot, r\.group\)/);
  // shown arranged on refresh (what MFL holds), left alone once the owner edits a slot, and arranged again at submit
  t.match(gd, /arrangeDraft\(STATE\.slots \|\| \{\}, byIdS\)/); t.match(mobile, /arrangeDraft\(M\.state\.lineupSlots \|\| \{\}, buildRows\(\)\)/);
  t.match(gd, /if \(!STATE\.slotsEdited\) STATE\.slots = arrangeDraft\(STATE\.slots, byId\)/);
  t.match(mobile, /if \(M\.state\.lineupSeed !== "user"\) M\.state\.lineupSlots = arrangeDraft\(M\.state\.lineupSlots, rows\)/);
});
test("the unsaved-changes check compares the set of starters, so a Flex relabel never reads as an edit", () => {
  const mobile = read("site/m/views/lineup.js");
  t.match(mobile, /function draftSig\(d\) \{ return SLOTS\.map\(function \(s\) \{ return \(d && d\[s\.id\]\) \|\| ""; \}\)\.filter\(Boolean\)\.sort\(\)\.join\(","\); \}/);
});

// ── the big result pop-up ──
function fakeDom() {
  const listeners = {}, mounted = [];
  const mkEl = (tag) => {
    const el = { tag, className: "", id: "", style: {}, _html: "", children: [], parentNode: null, listeners: {}, offsetHeight: 300, textContent: "",
      set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
      appendChild(c) { c.parentNode = el; el.children.push(c); if (el === doc.body) mounted.push(c); return c; },
      removeChild(c) { el.children = el.children.filter((x) => x !== c); c.parentNode = null; if (el === doc.body) mounted.splice(mounted.indexOf(c), 1); },
      addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
      querySelector(sel) {
        if (sel === ".ups-lrm") return (el._dlg = el._dlg || mkEl("dlg"));
        if (sel === ".ups-lrm-ok") return (el._ok = el._ok || Object.assign(mkEl("button"), { focused: false, focus() { this.focused = true; } }));
        return null;
      }, scrollIntoView() {}, getBoundingClientRect() { return { top: 400 }; } };
    return el;
  };
  const doc = { body: mkEl("body"), head: mkEl("head"), createElement: mkEl, getElementById: (id) => (doc.head.children.concat(doc.body.children).find((c) => c.id === id) || null),
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }, removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); } };
  return { doc, listeners, mounted };
}
const modal = () => { const d = fakeDom(); const c = vm.createContext({ document: d.doc }); c.window = c; vm.runInContext(read("site/shared/lineup_result_modal.js"), c); return { RM: c.UPS_LINEUP_RESULT_MODAL, ...d }; };
test("success pop-up: big, says submitted, one OK that must be pressed; the background does not dismiss it", () => {
  const { RM, mounted, listeners } = modal();
  let closed = 0;
  RM.show({ ok: true, title: "Lineup submitted", body: "MFL has your 18 starters for Week 10.", onClose: () => closed++ });
  t.equal(mounted.length, 1);
  const html = mounted[0].innerHTML;
  t.match(html, /ups-lrm ok/); t.match(html, /Lineup submitted/); t.match(html, /MFL has your 18 starters for Week 10\./); t.match(html, /<button type="button" class="ups-lrm-ok">OK<\/button>/);
  t.match(html, /role="alertdialog" aria-modal="true"/);
  t.equal((mounted[0].listeners.click || []).length, 0, "no click handler on the dimmed background");
  t.equal(mounted[0].querySelector(".ups-lrm-ok").focused, true, "OK is focused (Enter closes it)");
  t.equal(closed, 0);
  mounted[0].querySelector(".ups-lrm-ok").listeners.click[0]();
  t.equal(mounted.length, 0, "OK closes it"); t.equal(closed, 1);
  t.equal((listeners.keydown || []).length, 0, "the key handler is removed with it");
});
test("failure pop-up: red, says NOT submitted, shows the reason and what to do, Escape or OK closes", () => {
  const { RM, mounted, listeners } = modal();
  const why = RM.explain("League rules forbid starting players on a Bye week - Bolton, Nick KCC LB is on a bye on week 5");
  RM.show({ ok: false, title: "Lineup NOT submitted", body: "MFL did not accept this lineup.", reason: why.reason, hint: why.hint });
  const html = mounted[0].innerHTML;
  t.match(html, /ups-lrm err/); t.match(html, /Lineup NOT submitted/); t.match(html, /Why: /); t.match(html, /League rules forbid starting players on a Bye week/);
  t.match(html, /Bench the player on a bye and submit again\./);
  listeners.keydown[0]({ key: "Escape", preventDefault() {} });
  t.equal(mounted.length, 0);
  // a second result replaces the first (never two pop-ups)
  RM.show({ ok: false, title: "a", body: "b" }); RM.show({ ok: true, title: "c", body: "d" });
  t.equal(mounted.length, 1); t.match(mounted[0].innerHTML, /ups-lrm ok/);
});
test("failure reasons are explained in words; the raw reason is always kept; hostile text is escaped", () => {
  const { RM, mounted } = modal();
  t.match(RM.explain("HTTP 403").hint, /Sign in to MFL again/);
  t.match(RM.explain("MFL_USER_ID does not match this franchise").hint, /Sign in/);
  t.match(RM.explain("a player is locked after kickoff").hint, /can't be moved/);
  t.equal(RM.explain("").reason, "MFL did not say why.");
  RM.show({ ok: false, title: "<b>x</b>", body: "<img src=x onerror=1>", reason: "<script>1</script>" });
  t.ok(!/<script>|<img|<b>/.test(mounted[0].innerHTML), "no raw markup from a server message");
});
test("both surfaces show the pop-up after every submit outcome (success, MFL says no, no answer at all)", () => {
  const mobile = read("site/m/views/lineup.js"), gd = read("site/gameday/gameday.html");
  t.match(mobile, /outcome = \{ ok: true, title: "Lineup submitted"/); t.match(mobile, /title: "Lineup NOT submitted"/); t.match(mobile, /title: "Couldn't reach MFL"/);
  t.match(mobile, /if \(outcome && RM\) RM\.show\(outcome\);/);
  t.match(gd, /RM\.show\(\{ ok: ok, title: title/); t.match(gd, /title: "Lineup NOT submitted"/); t.match(gd, /title: "Couldn't reach MFL"/);
  for (const src of [read("site/m/index.html"), gd]) { t.match(src, /lineup_flex\.js/); t.match(src, /lineup_result_modal\.js/); }
});

await run("lineup_flex");
