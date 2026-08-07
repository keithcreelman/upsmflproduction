// worker/src/lib/waiver_run_post.js
//
// Discord payload builder for POST /admin/adds/post-discord.
//
// The commish's shape (2026-08-07): one PARENT message per team per waiver
// run, a thread hung off it, and ONE MESSAGE PER MOVE inside that thread —
// each add paired to the player it displaced. The previous design posted one
// top-level embed per add, so a three-claim run read as three unrelated
// signings with no drops and no cap consequence anywhere in sight.
//
// This module is PURE: no fetch, no D1, no Discord. Every fact it renders —
// the paired drop, the cap penalty, the eligibility dates — is resolved by the
// route and handed in. That is what makes the dry-run output trustworthy (it
// is the same code path the live post uses) and what lets a local harness
// prove the output without touching MFL or Discord.

// Money format. BYTE-IDENTICAL to the drop announcement's fmtK (index.js
// ~line 41019) on purpose: adds and drops land in the same channel, so
// "$13.5K" must not become "$14K" depending on which poster wrote it.
export const fmtK = (v) => {
  const n = Number(v) || 0;
  if (n >= 1000) {
    const k = n / 1000;
    return `$${Number.isInteger(k) ? k : Math.round(k * 10) / 10}K`;
  }
  return `$${n}`;
};

const _s = (v) => String(v == null ? "" : v).trim();

// Discord hard caps. Silent truncation by Discord is worse than ours — a
// 400 on a 1025-char field kills the whole move message.
const clampField = (v) => _s(v).slice(0, 1024);
const clampDesc = (v) => _s(v).slice(0, 4096);

// Cap-penalty heading + embed colour. MIRRORS the drop announcement exactly
// (index.js ~line 41132) — same wording, same fmtK, same thresholds. Adds and
// drops are one feed; a reader must not have to learn two vocabularies for
// the same number.
//
// The one state the drop poster never has is UNKNOWN. A waiver drop whose
// pre-drop contract we could not resolve is NOT a $0 drop — per
// rule_no_fail_open_guards an unreadable input is never "empty" — so it gets
// its own heading and rides the amber tier rather than the green one.
export function capPenaltyDisplay(pen) {
  if (!pen || pen.known === false) {
    return { known: false, heading: "# ⚠️ Cap penalty: unknown — needs review", color: 0xf0a020 };
  }
  const penalty = Number(pen.penalty) || 0;
  const exempt = !!pen.exempt;
  if (exempt || penalty === 0) {
    return { known: true, heading: "# ✅ No Cap Penalty", color: 0x25c37d };
  }
  return {
    known: true,
    heading: `# 💰 Cap Penalty: ${fmtK(penalty)}`,
    color: penalty >= 16000 ? 0xd9433a : (penalty >= 9000 ? 0xf0a020 : (penalty >= 5000 ? 0xf0c465 : 0x6c7a8a)),
  };
}

// Plain-English penalty basis. Same wording as the drop announcement's
// humanizeBasis (index.js ~line 41052) — keep the two in sync — plus the two
// bases that map has never needed (it only ever renders bases the drop
// scanner stored; we re-run _computeDropPenalty live and can hit either).
const BASIS_LABELS = {
  tcv_under_5k_fixed_1k: "Sub-$5K TCV, multi-year contract",
  tcv_under_5k_final_year_exempt: "Sub-$5K TCV, final year of contract",
  tcv_under_5k_guarantee: "Sub-$5K TCV, accrued guarantee minus earned",
  one_year_under_5k_exempt: "1-year contract under $5K",
  ww_under_5k_exempt: "WW pickup at $4K or below",
  taxi_exempt: "Taxi squad (cap-free)",
  tag_pre_auction_exempt: "Tagged player dropped before the auction deadline",
  guarantee_minus_earned: "75% guarantee minus earned-to-date",
  no_penalty_zero: "Earned already exceeds guarantee",
  no_pre_drop_contract: "Pre-drop contract not found",
};
export function humanizeDropBasis(basis) {
  const key = _s(basis);
  return BASIS_LABELS[key] || key;
}

// "Frankie Luvu  `LB · CAR`" — position/team in code ticks so the eye can
// separate the two names on the ＋/－ pair without a second line.
const playerLine = (mark, p) => {
  const name = _s(p && p.name) || (p && p.player_id ? `Player ${_s(p.player_id)}` : "Unknown player");
  const pos = _s(p && p.position);
  const team = _s(p && p.nfl_team);
  const tag = [pos, team].filter(Boolean).join(" · ");
  return `${mark} **${name}**${tag ? `  \`${tag}\`` : ""}`;
};

// Eligibility windows. Canon §C3/§C4 — and the branch matters: the 14/28-day
// clocks are an IN-SEASON rule. The old poster hardcoded "MYM-eligible for 14
// days." on every add, which was flatly wrong for the pre-season claims it was
// actually announcing; those run to the September contract deadline and the
// Week 3 / Week 5 kickoffs instead.
//
// Every date arrives pre-formatted from the route. A label with no date means
// the schedule could not be read — we print the label alone rather than a
// guessed date, because a wrong deadline is what owners plan against.
export function buildEligibilityLines(elig) {
  const e = elig || {};
  const through = (label, date) => `**${label}** — ${date ? `through ${date}` : "date unavailable"}`;
  if (e.in_season) {
    return [
      `${through("Mid-Year Multi (MYM)", _s(e.mym_deadline_label))} (days 1–14 from pickup)`,
      `${through("Extension", _s(e.extension_deadline_label))} (days 15–28 from pickup)`,
    ];
  }
  const deadline = _s(e.contract_deadline_label);
  const wk3 = _s(e.week3_kickoff_label);
  const wk5 = _s(e.week5_kickoff_label);
  return [
    `${through("Multi-Year Contract", deadline)} (contract deadline)`,
    `**Mid-Year Multi (MYM)** — ${deadline && wk3 ? `${deadline} → ${wk3}` : "dates unavailable"} (contract deadline → Week 3 kickoff)`,
    `${through("Extension", wk5)} (Week 5 kickoff)`,
  ];
}

// Acquisition + contract lines. The dollar figure is the BID, never MFL's
// salary field — see the route for why (salary came back empty for all three
// 2026-08-07 claims). `amount_dollars === null` means BOTH the bid and the
// salaries export were silent, and we say "amount unknown" rather than print
// a $0 that nobody bid.
function moneyLines(move) {
  const amount = move.amount_dollars == null ? null : Number(move.amount_dollars) || 0;
  const money = amount == null ? "amount unknown" : fmtK(amount);
  const acquisition = move.source === "bbid"
    ? `Waiver claim — ${amount == null ? "amount unknown" : `${money} bid`}`
    : `FCFS add — ${money}`;
  const contract = [
    `1 yr · **WW** · ${money}`,
    amount != null && amount > 0 && amount <= 4000 ? "cap-free cut at $4K or less" : null,
  ].filter(Boolean).join(" · ");
  return { acquisition, contract };
}

// One thread message per move: ＋added / －dropped + penalty / money / windows.
export function buildMoveMessage(move) {
  const pen = move.dropped ? capPenaltyDisplay(move.penalty) : null;
  const lines = [playerLine("＋", move.added)];
  if (move.dropped) {
    lines.push(playerLine("－", move.dropped));
    lines.push(pen.heading);
  } else if (move.pairing_known === false) {
    // We could not find this add in MFL's transaction log, so we do NOT know
    // whether it displaced anyone. "No corresponding drop" would be a claim
    // about someone's roster that we cannot make.
    lines.push("⚠️ _drop unknown — no matching transaction found; needs review_");
  } else {
    // No drop is not a $0 penalty — there is simply nothing to charge.
    lines.push("_no corresponding drop_");
  }
  const { acquisition, contract } = moneyLines(move);
  const fields = [
    { name: "Acquisition", value: clampField(acquisition), inline: false },
    { name: "Contract", value: clampField(contract), inline: false },
    { name: "Eligibility", value: clampField(buildEligibilityLines(move.eligibility).join("\n")), inline: false },
  ];
  // The penalty BASIS earns a line only when there is a penalty story to tell;
  // "1-year contract under $5K" under a green ✅ is the answer to the question
  // an owner is about to ask in this very thread.
  if (move.dropped && pen.known) {
    const basis = _s(move.penalty && (move.penalty.basis_label || move.penalty.basis));
    if (basis) fields.push({ name: "Penalty basis", value: clampField(basis), inline: false });
  } else if (move.dropped && !pen.known) {
    fields.push({
      name: "Penalty basis",
      value: clampField(_s(move.penalty && move.penalty.unknown_reason)
        || "Pre-drop contract could not be resolved — this drop has NOT been priced."),
      inline: false,
    });
  }
  const embed = {
    description: clampDesc(lines.join("\n")),
    color: move.dropped ? pen.color : (move.pairing_known === false ? 0xf0a020 : 0x25c37d),
    fields,
  };
  return {
    row_id: move.row_id,
    player_id: move.player_id,
    player_name: _s(move.added && move.added.name),
    body: { content: "", embeds: [embed], allowed_mentions: { parse: [] } },
  };
}

// The whole run: parent summary embed + thread name + one message per move.
//
// `run` (everything pre-resolved by the route):
//   { franchise_name, franchise_id, icon_url, processed_at_et, run_date_label,
//     moves: [ { row_id, player_id, source, amount_dollars, added, dropped,
//                penalty, eligibility } ] }
export function buildWaiverRunPlan(run) {
  const moves = Array.isArray(run && run.moves) ? run.moves : [];
  const franchise = _s(run && run.franchise_name) || `Team ${_s(run && run.franchise_id)}`;
  const n = moves.length;

  // The commish specified the waiver-run wording, which is what these batches
  // always are in practice. An all-FCFS batch would still be titled a "waiver
  // run" it never was, so the noun follows the rows rather than the assumption.
  const bbidCount = moves.filter((m) => _s(m.source) === "bbid").length;
  const allBbid = n > 0 && bbidCount === n;
  const noBbid = bbidCount === 0;
  const moveNoun = allBbid ? "waiver claim" : (noBbid ? "free-agent add" : "roster move");
  const runNoun = allBbid ? "Waivers" : (noBbid ? "Adds" : "Moves");
  const processedAt = _s(run && run.processed_at_et);
  const processedLine = allBbid
    ? "Blind-bid waivers processed"
    : (noBbid ? "Free-agent adds processed" : "Waiver claims and free-agent adds processed");

  const dropped = moves.filter((m) => !!m.dropped);
  const unpaired = moves.filter((m) => !m.dropped && m.pairing_known === false);
  const unknownPenalties = dropped.filter((m) => !m.penalty || m.penalty.known === false);
  const knownPenaltyTotal = dropped.reduce(
    (sum, m) => sum + (m.penalty && m.penalty.known !== false ? (Number(m.penalty.penalty) || 0) : 0),
    0
  );
  const knownAmounts = moves.filter((m) => m.amount_dollars != null);
  const bidTotal = knownAmounts.reduce((sum, m) => sum + (Number(m.amount_dollars) || 0), 0);
  const unknownAmounts = n - knownAmounts.length;

  // Silence is not zero. If any drop went unpriced — or any add could not be
  // paired at all — the summary says so here, not only in the one thread
  // message the commish might scroll past.
  const unresolved = unknownPenalties.length + unpaired.length;
  let capValue;
  if (unresolved) {
    capValue = `${fmtK(knownPenaltyTotal)} priced · ⚠️ ${unresolved} move${unresolved === 1 ? "" : "s"} unpriced — needs review`;
  } else if (knownPenaltyTotal === 0) {
    capValue = "None — $0";
  } else {
    capValue = fmtK(knownPenaltyTotal);
  }

  let bidValue;
  if (!knownAmounts.length) bidValue = "amount unknown";
  else bidValue = `${fmtK(bidTotal)}${unknownAmounts ? ` · ${unknownAmounts} unknown` : ""}`;

  const parentEmbed = {
    title: `${franchise} — ${n} ${moveNoun}${n === 1 ? "" : "s"}`,
    description: clampDesc(`${processedLine}${processedAt ? ` ${processedAt}` : ""}.`),
    color: capPenaltyDisplay(
      unresolved ? { known: false } : { known: true, penalty: knownPenaltyTotal, exempt: false }
    ).color,
    fields: [
      { name: allBbid ? "Claims won" : "Adds", value: String(n), inline: true },
      { name: "Total bid", value: clampField(bidValue), inline: true },
      { name: "Players dropped", value: String(dropped.length), inline: true },
      { name: "Cap penalties", value: clampField(capValue), inline: true },
    ],
  };
  if (_s(run && run.icon_url)) parentEmbed.thumbnail = { url: _s(run.icon_url) };

  // Discord caps thread names at 100 chars.
  const threadName = `${franchise} · ${_s(run && run.run_date_label)} ${runNoun}`.replace(/\s+/g, " ").trim().slice(0, 100);

  return {
    thread_name: threadName,
    parent_body: { content: "", embeds: [parentEmbed], allowed_mentions: { parse: [] } },
    parent_embed: parentEmbed,
    move_messages: moves.map(buildMoveMessage),
  };
}
