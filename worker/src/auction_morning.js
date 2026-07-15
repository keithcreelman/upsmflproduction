// auction_morning.js — the 9 AM parent: yesterday's verdict.
//
// The morning report is the ONLY one that judges. At 9 AM the prior ET day is
// closed and its verdict is final, so this is where a miss gets named, tagged,
// and counted under §F RULE 2. It deliberately does NOT judge the day in
// progress — "no need to say these teams are out of compliance it's 9AM"
// (Keith 2026-07-14). Today's nominations are information only.
//
// Copy shaped by an editorial panel + Keith 2026-07-15. What the panel changed
// and why it stuck:
//
//   * The TEST banner is FIRST and BIG. "Test needs to be immediate and big"
//     (Keith). A reader must not absorb a bolded fine with their own name on it
//     and only afterwards learn it isn't real.
//   * Ten identical "$3K this season + $3K next" labels collapsed into ONE
//     statement. Repeating a constant per row is typesetting, not information.
//   * The ladder shows the rung ABOVE you ($7K, $15K) — the only part that
//     deters. What you already owe is stated once.
//   * ⚠️ ×10 dropped: everyone in that list is there for the same reason, so the
//     icon carried nothing.
//   * Grouped by 0/2 vs 1/2, because "I tried and still missed" is a different
//     story from "I didn't show up" — and 1/2 owners reliably think a partial
//     effort counts. It doesn't; the header says so once.

import { rule2FineK, rule2Label, RULE2_FINE_K_BY_OFFENSE, RULE2_MAX_FINED_OFFENSE } from "./auction_compliance.js";

function plural(n, one, many) { return Number(n) === 1 ? one : (many || one + "s"); }

// One line, not ten. When every miss sits on the same rung (the common case —
// most teams miss for the first time on the same day) the fine is stated once.
// It only goes per-team when the rungs genuinely differ, because then the number
// IS information rather than repetition.
function fineSummary(misses, standings) {
  const levels = [...new Set(misses.map((m) => Number((standings.get(m.fid) || {}).offense_no || 1)))];
  if (levels.length === 1) {
    const n = levels[0];
    if (n > RULE2_MAX_FINED_OFFENSE) return { shared: "**league-fit review** — no fine (§F RULE 2)", perTeam: false };
    return { shared: `${rule2Label(n)}.`, perTeam: false };
  }
  return { shared: null, perTeam: true };
}

// The rungs a franchise has NOT hit yet. Showing the whole ladder every day
// re-teaches a rule they've read 20 times; showing what's next is a deterrent.
function ladderAbove(misses, standings) {
  const highest = Math.max(1, ...misses.map((m) => Number((standings.get(m.fid) || {}).offense_no || 1)));
  const next = [];
  for (let n = highest + 1; n <= RULE2_MAX_FINED_OFFENSE; n += 1) {
    const ord = n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
    next.push(`${ord} miss $${rule2FineK(n)}K`);
  }
  if (!next.length) return null;
  return `_${next.join(" · ")} · both seasons each time._`;
}

// data      — /api/auction/fa-schedule payload (today's window)
// closed    — { day, misses[] } from closeEtDay: YESTERDAY, final
// standings — Map<fid, { offense_no, ... }>
// mentions  — Map-ish { fid: [discordId] }, ONLY for teams that missed
export function buildMorningMessage(data, closed, standings, mentionsByFid, penaltiesArmed, label) {
  const rows = data.rows || [];
  const max = Number(data.noms_max || 2);
  const used = (r) => Number(r.noms_used || 0);
  const misses = (closed && closed.misses) || [];
  const L = [];

  // FIRST and BIG, before any name or number. Suppressed once fines are real —
  // then the banner would itself be the lie.
  if (!penaltiesArmed) {
    L.push("# 🧪 TEST REPORT — NO PENALTIES ASSESSED, JUST FOR TESTING PURPOSES");
  }
  L.push(`### 🌅 FA AUCTION — ${label} · YESTERDAY (${closed?.day || "—"}) IS FINAL`);
  L.push("");

  if (!closed || !closed.day) {
    L.push("_No closed day to report yet._");
  } else if (!misses.length) {
    L.push("**✅ NOMINATIONS — CLEAN SHEET.** Everyone who owed one made it. 🎉");
  } else {
    const tag = (fid) => (mentionsByFid[fid] || []).map((id) => `<@${id}>`).join(" ");
    const fines = fineSummary(misses, standings);

    L.push("**MISSED NOMINATIONS**");
    L.push(`**${misses.length} of ${rows.length} missed.**`);
    if (fines.shared) L.push(fines.shared);
    L.push("");

    // 0/2 and 1/2 are different stories: one is absence, the other is a partial
    // effort that owners reliably assume counts.
    const zero = misses.filter((m) => Number(m.noms_used || 0) === 0);
    const partial = misses.filter((m) => Number(m.noms_used || 0) > 0);
    const line = (m) => {
      const n = Number((standings.get(m.fid) || {}).offense_no || 1);
      const per = fines.perTeam
        ? ` — ${n > RULE2_MAX_FINED_OFFENSE ? "**league-fit review**" : `**${rule2Label(n)}**`}`
        : "";
      const t = tag(m.fid);
      return `**${m.franchise_name}**${per}${t ? ` ${t}` : ""}`;
    };
    if (zero.length) {
      L.push(`**Zero of ${max}**`);
      for (const m of zero) L.push(line(m));
    }
    if (partial.length) {
      if (zero.length) L.push("");
      L.push(`**One of ${max} — a miss is a miss**`);
      for (const m of partial) L.push(line(m));
    }

    const ladder = ladderAbove(misses, standings);
    if (ladder) { L.push(""); L.push(ladder); }

    if (penaltiesArmed) {
      L.push("_Know you'll be out of pocket — travelling, no service, life? Tell the league ahead of time and it won't count against you._");
    }
  }
  L.push("");

  // ---- today: information only, never a verdict ----
  const withNoms = rows.filter((r) => used(r) > 0).sort((a, b) => used(b) - used(a));
  const done = withNoms.filter((r) => used(r) >= max);
  const yet = rows.length - withNoms.length;
  let today = "**📥 TODAY — info only, the day is open.** ";
  if (!withNoms.length) {
    today += "Nobody's nominated yet; everyone has all day.";
  } else if (done.length) {
    today += `${done.map((r) => `**${r.franchise_name}**`).join(", ")} already ${plural(done.length, "has", "have")} both in` +
      (yet > 0 ? `; the other ${yet} ${plural(yet, "has", "have")} all day.` : ".");
  } else {
    today += `${withNoms.map((r) => `**${r.franchise_name}** ${used(r)}/${max}`).join(" · ")}` +
      (yet > 0 ? ` · ${yet} yet to start.` : ".");
  }
  L.push(today);
  L.push("Open lots + what everyone still needs → **thread** 🧵");
  return L.join("\n");
}
