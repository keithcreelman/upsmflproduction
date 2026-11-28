#!/usr/bin/env node
// Preview 0: the team-colored profile header. This file is the ONLY place the palette is computed; it writes
// apps/mobile2027/src/team-colors.css, which is what the page loads. Nothing is computed in the browser.
//
//   node apps/mobile2027/scripts/team_colors.mjs          write src/team-colors.css
//   node apps/mobile2027/scripts/team_colors.mjs --check  fail if the committed file is not what this generates
//
// Why a generated stylesheet: the page's content policy forbids inline styles, so a header colored per team cannot set its
// colors from script or markup. Every team and skin is a CSS rule instead. The palette is the one Keith approved in the
// "UPS 2027 Player Profile Look" prototype (heroPal, ported unchanged): the team's primary color is the ground, nudged only
// as far as needed to reach a readable contrast with white or near-black text (4.5:1; 7:1 in High contrast); the secondary
// color is the stripe and the photo ring when it is readable against the ground. No logos and no helmet art.
//
// Team colors: primary and secondary hex values as published by ESPN's public team data
// (site.api.espn.com/apis/site/v2/sports/football/nfl/teams, read 2026-11-18). ESPN's WSH is stored as WAS. MFL's own
// codes (GBP, KCC, LVR, NEP, NOS, SFO, TBB, JAC) get the same colors as their common abbreviations.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const OUT = path.join(HERE, "..", "src", "team-colors.css");

export const TEAMC = {
  ARI: ["#A40227", "#FFFFFF"], ATL: ["#A71930", "#000000"], BAL: ["#29126F", "#000000"], BUF: ["#00338D", "#D50A0A"],
  CAR: ["#0085CA", "#000000"], CHI: ["#0B1C3A", "#E64100"], CIN: ["#FB4F14", "#000000"], CLE: ["#472A08", "#FF3C00"],
  DAL: ["#002A5C", "#B0B7BC"], DEN: ["#0A2343", "#FC4C02"], DET: ["#0076B6", "#BBBBBB"], GB: ["#204E32", "#FFB612"],
  HOU: ["#021018", "#EB0028"], IND: ["#003B75", "#FFFFFF"], JAX: ["#007487", "#D7A22A"], KC: ["#E31837", "#FFB612"],
  LAC: ["#0080C6", "#FFC20E"], LAR: ["#003594", "#FFD100"], LV: ["#000000", "#A5ACAF"], MIA: ["#008E97", "#FC4C02"],
  MIN: ["#4F2683", "#FFC62F"], NE: ["#002A5C", "#C60C30"], NO: ["#D3BC8D", "#000000"], NYG: ["#003C7F", "#C9243F"],
  NYJ: ["#115740", "#FFFFFF"], PHI: ["#06424D", "#000000"], PIT: ["#000000", "#FFB612"], SEA: ["#002A5C", "#69BE28"],
  SF: ["#AA0000", "#B3995D"], TB: ["#BD1C36", "#3E3A35"], TEN: ["#4495D2", "#001532"], WAS: ["#5A1414", "#FFB612"],
};
// MFL code -> the code above
export const TMAP = { GBP: "GB", KCC: "KC", LVR: "LV", NEP: "NE", NOS: "NO", SFO: "SF", TBB: "TB", JAC: "JAX", WSH: "WAS" };
export const SKINS = ["light", "dark", "hc"];

function h2r(h) { h = h.replace("#", ""); return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)]; }
function r2h(r) { return "#" + r.map((v) => ("0" + Math.round(v).toString(16)).slice(-2)).join(""); }
function mixc(a, b, t) { const x = h2r(a), y = h2r(b); return r2h([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]); }
export function lumn(h) { const c = h2r(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
export function crat(a, b) { let l1 = lumn(a), l2 = lumn(b); if (l1 < l2) { const t = l1; l1 = l2; l2 = t; } return (l1 + 0.05) / (l2 + 0.05); }
const HW = "#ffffff", HINK = "#0b0f18", HNEU = ["#3b4a63", "#9fb2ce"];

// The header palette for a team in a skin. `team` is a code in TEAMC (or "" for no team).
export function heroPal(team, skin) {
  const tc = TEAMC[team] || null, base = tc ? tc[0] : HNEU[0], sec = tc ? tc[1] : HNEU[1], min = skin === "hc" ? 7 : 4.5;
  let g1, txt, t, u, g;
  if (skin === "hc") {
    let acc = "#ffffff";
    if (tc) acc = crat(tc[0], "#000000") >= 3 ? tc[0] : (crat(tc[1], "#000000") >= 3 ? tc[1] : "#ffffff");
    return { g1: "#000000", g2: "#000000", t: HW, m: "#e6ebf5", av: "#1a1a1a", pill: HW, pillt: "#000000", stripe: acc, ring: acc, team: !!tc };
  }
  const t0 = skin === "dark" ? 0.3 : 0;
  let cw = null, ci = null;
  for (t = t0; t <= 0.8; t += 0.05) { g = mixc(base, "#000000", t); if (crat(HW, g) >= min) { cw = t; break; } }
  if (skin !== "dark") { for (u = 0; u <= 0.6; u += 0.05) { g = mixc(base, "#ffffff", u); if (crat(HINK, g) >= min) { ci = u; break; } } }
  if (cw !== null && (skin === "dark" || cw - t0 <= 0.25 || ci === null || ci > 0.3)) { g1 = mixc(base, "#000000", cw); txt = HW; }
  else { g1 = mixc(base, "#ffffff", ci); txt = HINK; }
  const far = txt === HW ? "#000000" : "#ffffff", g2 = mixc(g1, far, 0.22);
  let m = mixc(txt, g1, 0.18);
  if (crat(m, g1) < min || crat(m, g2) < min) m = txt;
  const line = crat(sec, g1) >= 3 ? sec : txt;
  return { g1, g2, t: txt, m, av: mixc(g1, txt, 0.16), pill: txt, pillt: txt === HW ? HINK : HW, stripe: sec, ring: line, team: !!tc };
}

const vars = (p) => `--h1:${p.g1};--h2:${p.g2};--ht:${p.t};--hm:${p.m};--hav:${p.av};--hp:${p.pill};--hpt:${p.pillt};--hs:${p.stripe};--hr:${p.ring}`;

// every class that selects a team: its code, plus the MFL codes that map to it
export function teamClasses(code) {
  return [code, ...Object.keys(TMAP).filter((k) => TMAP[k] === code)].map((c) => `.hero.tm-${c}`);
}

export function generate() {
  const out = [];
  out.push("/* GENERATED by apps/mobile2027/scripts/team_colors.mjs from the approved profile-header palette. Do not edit by hand:");
  out.push("   run the script again. The page's content policy forbids inline styles, so each team and skin is a rule here.");
  out.push("   Team colors: ESPN public team data, read 2026-11-18. No logos and no helmet art. */");
  for (const skin of SKINS) {
    out.push(`/* ${skin} */`);
    out.push(`:root[data-skin="${skin}"] .hero{${vars(heroPal("", skin))}}`);
    for (const code of Object.keys(TEAMC).sort()) {
      out.push(`${teamClasses(code).map((c) => `:root[data-skin="${skin}"] ${c}`).join(",")}{${vars(heroPal(code, skin))}}`);
    }
  }
  return out.join("\n") + "\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const css = generate();
  if (process.argv.includes("--check")) {
    const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
    if (have !== css) { console.error("src/team-colors.css is not what team_colors.mjs generates. Run: node apps/mobile2027/scripts/team_colors.mjs"); process.exit(1); }
    console.log("team-colors.css is up to date");
  } else {
    fs.writeFileSync(OUT, css);
    console.log(`wrote ${path.relative(process.cwd(), OUT)} (${css.length} bytes)`);
  }
}
