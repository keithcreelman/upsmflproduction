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

// EVERY player this move displaced, in render order: the one MFL paired to the
// add, then any EXTRA drops that rode the same transaction (one add, two drops
// — "13952,|15271,16252,"). Those extras used to stop at the route's JSON
// response, so their dead money never reached the parent's "Cap penalties"
// total and a run could announce "None — $0" while a KNOWN drop carried a real
// charge. A drop we know about is always shown and always counted.
export function moveDrops(move) {
  const out = [];
  if (move && move.dropped) out.push({ player: move.dropped, penalty: move.penalty || null });
  const extra = Array.isArray(move && move.also_dropped) ? move.also_dropped : [];
  for (const x of extra) {
    if (x) out.push({ player: x, penalty: x.penalty || null });
  }
  return out;
}

// One heading for a move that shed several players. UNKNOWN IS ABSORBING: if
// any one of them could not be priced, the move is unpriced — a partial sum
// rendered as a confident total is exactly the failure this file exists to
// avoid. Only when every drop priced do we add them up.
function combineDropPenalties(drops) {
  if (!drops.length) return null;
  if (drops.some((d) => !d.penalty || d.penalty.known === false)) return { known: false };
  return {
    known: true,
    penalty: drops.reduce((sum, d) => sum + (Number(d.penalty.penalty) || 0), 0),
    exempt: drops.every((d) => !!d.penalty.exempt),
  };
}

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
  const drops = moveDrops(move);
  const pen = drops.length ? capPenaltyDisplay(combineDropPenalties(drops)) : null;
  const lines = [playerLine("＋", move.added)];
  if (drops.length) {
    for (const d of drops) lines.push(playerLine("－", d.player));
    lines.push(pen.heading);
  } else if (move.pairing_known === false) {
    // We do NOT know whether this add displaced anyone — either the add is not
    // in MFL's transaction log at all, or the row that carries it did not have
    // the field count its type requires, which puts the drop (and, for a BBID
    // row, the bid) somewhere we cannot read. "No corresponding drop" would be
    // a claim about someone's roster that we are in no position to make, so
    // name the actual reason instead.
    lines.push(move.transaction_matched && move.transaction_shape_known === false
      ? "⚠️ _drop unknown — MFL's transaction had an unexpected field count; needs review_"
      : "⚠️ _drop unknown — no matching transaction found; needs review_");
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
  // With more than one drop the basis is ambiguous unless it is attributed, so
  // the player's name leads each line; a single drop keeps the bare label.
  if (drops.length) {
    const basisLines = drops.map((d) => {
      const label = _s(d.penalty && (d.penalty.basis_label || d.penalty.basis))
        || (d.penalty && d.penalty.known === false
          ? (_s(d.penalty.unknown_reason) || "Pre-drop contract could not be resolved — this drop has NOT been priced.")
          : (!d.penalty ? "Pre-drop contract could not be resolved — this drop has NOT been priced." : ""));
      if (!label) return "";
      return drops.length > 1 ? `**${_s(d.player && d.player.name) || "Unknown player"}** — ${label}` : label;
    }).filter(Boolean);
    if (basisLines.length) {
      fields.push({ name: "Penalty basis", value: clampField(basisLines.join("\n")), inline: false });
    }
  }
  const embed = {
    description: clampDesc(lines.join("\n")),
    color: drops.length ? pen.color : (move.pairing_known === false ? 0xf0a020 : 0x25c37d),
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
//                penalty, also_dropped: [ { ...player, penalty } ],
//                eligibility } ] }
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

  // Count DROPS, not moves that happen to have one — a single transaction can
  // shed two players and both charge the cap.
  const dropped = moves.reduce((acc, m) => acc.concat(moveDrops(m)), []);
  const unpaired = moves.filter((m) => !moveDrops(m).length && m.pairing_known === false);
  const unknownPenalties = dropped.filter((d) => !d.penalty || d.penalty.known === false);
  const knownPenaltyTotal = dropped.reduce(
    (sum, d) => sum + (d.penalty && d.penalty.known !== false ? (Number(d.penalty.penalty) || 0) : 0),
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
    capValue = `${fmtK(knownPenaltyTotal)} priced · ⚠️ ${unresolved} unpriced — needs review`;
  } else if (knownPenaltyTotal === 0) {
    capValue = "None — $0";
  } else {
    capValue = fmtK(knownPenaltyTotal);
  }

  let bidValue;
  if (!knownAmounts.length) bidValue = "amount unknown";
  else bidValue = `${fmtK(bidTotal)}${unknownAmounts ? ` · ${unknownAmounts} unknown` : ""}`;

  // A bare "0" next to "⚠️ 1 unpriced" reads as "nobody was dropped", which is
  // the opposite of what an unpaired add means. Qualify the count whenever the
  // pairing is not fully known.
  const droppedValue = unpaired.length
    ? `${dropped.length} known · ${unpaired.length} unknown`
    : String(dropped.length);

  // The figure is only a "bid" when every row is a blind-bid claim. An FCFS add
  // carries a price, not a bid — the label follows the rows the same way the
  // "Claims won"/"Adds" label does.
  const amountLabel = allBbid ? "Total bid" : (noBbid ? "Total spent" : "Total bids + adds");

  const parentEmbed = {
    title: `${franchise} — ${n} ${moveNoun}${n === 1 ? "" : "s"}`,
    description: clampDesc(`${processedLine}${processedAt ? ` ${processedAt}` : ""}.`),
    color: capPenaltyDisplay(
      unresolved ? { known: false } : { known: true, penalty: knownPenaltyTotal, exempt: false }
    ).color,
    fields: [
      { name: allBbid ? "Claims won" : "Adds", value: String(n), inline: true },
      { name: amountLabel, value: clampField(bidValue), inline: true },
      { name: "Players dropped", value: clampField(droppedValue), inline: true },
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
