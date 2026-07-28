# 2026 offseason cleanup backlog

Running list of structural problems surfaced during the live 2026 season —
mostly during the FA Auction (2026-07-25 onward) — that are patched/contained
for now but need real fixes once the season isn't live. Append to this list
as things come up; don't let a fire-fought incident evaporate once the fire
is out.

**How to use:** each item has a severity, what's currently protecting us (if
anything), and the actual fix. Pull one, read the canon/code it cites, ship
it, mark it done with a PR link.

**Severity:** 🔴 real risk if untouched · 🟡 real but contained · 🟢 nice-to-have

---

## 1. 🔴 No validation catches a "reset contract to Year 1" write

**Incident:** [incidents/2026-07-27-contract-year-rollback.md](../incidents/2026-07-27-contract-year-rollback.md)
— a hand-typed contract-fix write silently reset 3 players' `salary` +
`contractYear` to their Year-1/signing-state values while "fixing" an
unrelated AAV field. Sat approved-and-clean in the audit trail for 4 days;
found $26,000 of phantom cap charge live during the auction.

**Why it got through:** the only verification anyone (human or agent) ran
compared the one field being intentionally changed (AAV), never the fields
that weren't supposed to move. A tested single-row invariant
(`salary == Y[CL−cy+1]`) does **not** catch this class of bug — a Year-1
reset is internally self-consistent, so it passes.

**The fix that actually works — cross-season monotonicity:**
for any player under the same contract as last season, `contractYear(now)`
must equal `contractYear(last season) − 1`. It may only *increase* alongside
a recorded extension/MYAC/restructure event that also changes `CL` or the
year-salary list. Watch for the false-positive case: 1st-round rookie-option
deals carry a 4th `Y4-…K Option` token under `CL 3` — a naive year-count
check flags all of these; the check must special-case the Option token.

**Also fix, smaller and higher-leverage:**
- `POST /admin/import-salaries` (`worker/src/index.js` around line 36121)
  currently *requires* `salary` + `contractInfo` on every call, forcing any
  caller who wants to edit one annotation to restate the whole row from
  scratch — which is exactly how this happened. Make them optional,
  defaulting to the player's current live MFL values, so an annotation-only
  edit cannot express a full contract reset.
- The endpoint already computes `before`/`after` for its own audit log
  (`:36290-36345`) but never returns the diff to the caller. Add an explicit
  `fields_changed: [...]` block to the response (dry-run and live) and loudly
  flag it when `salary` or `contractYear` is in that list. Cheapest, highest-value
  single change on this list.
- Ban hand-typed row literals for contract writes going forward. Two
  committed builders already do this safely —
  `pipelines/etl/scripts/build_unification_write_payload.py:86` and
  `build_contractinfo_fix.py:189` — both carry live `salary`/`contractYear`
  through untouched instead of reconstructing them. Use one of these, or a
  new one, never an inline curl payload, for any contract-data write.

---

## 2. 🔴 9 code paths write MFL contract salary; only 3 are logged

Full audit (2026-07-27): `worker/src/index.js` has **9 distinct call sites**
that `POST import?TYPE=salaries` with year-specific `salary` +
`contractYear`. Only 3 write to `salary_change_log` — the audit trail that
made diagnosing item #1 possible at all. The other 6 are invisible to any
retrospective audit. The two worst:

- **`finalizeEraContracts()`** (`:1872`, POST at `:1988`) — writes ALL 4
  year-specific fields, logs **nothing**, and is gated by nothing but
  `env.MFL_COOKIE` being set (no feature flag, unlike its FAA sibling).
  Runs automatically on every `*/5` auction-poll cron tick for newly-won ERA
  lots. Its idempotency check is an exact 4-field match to the canonical
  `Vet-ERA / cy=1` shape — **an ERA winner later converted via MYAC to a
  2/3-year deal no longer matches, so a re-run of the admin sweep silently
  rewrites them back to a 1-year contract at the original bid price.** This
  is the exact same bug shape as item #1, via a completely different code
  path, already live in production.
- **`importContractUpdateAcq()`** (`:20173`) via
  `POST /acquisition-hub/rookie-draft/action` (`:34624`) — **has no
  commish/APIKEY gate at all.** Any owner making a rookie-draft pick
  triggers a real `salary` + `contractYear` write using the worker's own
  commish cookie. No D1 audit either.

**Fix:** every write path that touches `salary`/`contractYear`/`contractInfo`
on MFL should log to `salary_change_log` (or a shared successor), no
exceptions — including the automated cron paths. `finalizeEraContracts`
needs the same `AUCTION_ERA_FINALIZE_ENABLED`-style flag gate and an
idempotency check that recognizes a legitimately-converted MYAC contract
instead of stomping it. `importContractUpdateAcq`'s route needs an auth gate.

---

## 3. 🔴 Safety infrastructure built, then never merged (May 12 — still true)

Commit `c371505d` ("audit: flashpoint + CLAUDE.md + atlas docs + MFL write
guard + incident postmortem") built exactly the tooling that would have
prevented items #1 and #2: `worker/src/mfl_write_guard.js`,
`scripts/check-mfl-writes.sh` + an allowlist, a
`.github/workflows/mfl-write-guard.yml` CI gate, `docs/MFL_DANGEROUS_ENDPOINTS.md`
(SAFE/DANGEROUS/FORBIDDEN classifier), and the repo-root `CLAUDE.md`
entrypoint that memory still assumes exists. Per the commit message: **"Kept
on this branch only — not pushed/deployed per Keith 2026-05-12."** It has sat
on the unmerged branch `claude/r6-official-randomize-fix` for 2.5+ months.

**Fix:** pull that branch, review it fresh (it's 2.5 months stale — check
it still applies and still reflects current policy), and actually merge it.
This is the single highest-leverage item on this list — it's already built.

---

## 4. 🟡 Auction-poll stall — root cause found and fixed, but proven only once

**What happened:** the FA-Auction poll stalled 3 separate times over
2026-07-26/27 (11:51 AM, 12:21 PM, 3:41-3:51 PM, and again 9:11-9:20 PM ET),
freezing bids/board/Discord narration for up to 9 minutes each time, live
during the auction.

**Root causes found and fixed, in order:**
1. The per-lot recompute loop was O(lots) sequential D1 round trips (~158 at
   79 lots) — batched via `db.batch()`.
2. Three independent throttled sweeps (lot recompute, O=43 cancel
   reconciliation, Discord orphan-thread repair) could all land on the same
   poll tick, compounding with bid ingestion — replaced with `sweepReady()`:
   at most one sweep per tick, sweeps defer on busy ticks with a 3x-overdue
   escape hatch.
3. A newly-added FAA-finalize catch-up sweep (see item #5) made several
   external MFL fetches with **no timeout**, and one hung, holding the
   poll's lock for the full 9-minute stall window. Fixed by promoting a
   shared `fetchBounded()` (8s timeout) and applying it to all 7 previously-
   unbounded `fetch()` calls across `finalizeFaaContracts`,
   `finalizeEraContracts`, and `fetchCompletedAuctionPids`.

**Why this is still 🟡, not ✅:** the timeout fix is deployed and the poll
has been healthy since, but it hasn't been tested against an actual slow-MFL
response in production — confidence is high, not proven. Watch for a repeat.

---

## 5. 🟡 FAA/ERA auto-finalize is one-shot with no retry (root cause of item #1's sibling bug)

Newly-won auction lots auto-finalize to a `Vet-FAA`/`Vet-ERA` contract via a
hook that fires **exactly once**, on the single poll tick a lot flips
`open→won`. If that one attempt fails for any reason (a transient MFL fetch
error, O=102 completed-auction-list lag, etc.), nothing ever retries it —
the player is stuck on MFL's raw `$1K / cy=0` stub indefinitely. Found live
2026-07-27: Lamar Jackson ($62K win) and one other player sat with **no
contract at all** on MFL for hours, silently blocking MYAC eligibility,
until manually caught and fixed.

**Fixed for FAA:** added a throttled catch-up sweep (every 15 min,
`worker/src/index.js`) that re-runs `finalizeFaaContracts` with no
`onlyPid` filter — safe because it's already fully idempotent.

**Not fixed for ERA:** `finalizeEraContracts` has the exact same one-shot
design and was not given the same catch-up sweep (out of scope for the
immediate fix). It can silently strand an ERA winner the same way. Do this
next — same pattern, small change.

---

## 6. 🟡 Commish API key / Discord bot token exposure in local session transcripts

Flagged independently by 3 separate audit agents during the item #1
investigation (not yet verified firsthand): the commish API key appears in
plaintext inside `~/.claude/projects/*.jsonl` session transcripts on Keith's
machine — a broader exposure surface than the repo-level key cleanup done in
commit `aa25c4a9`. Needs its own investigation: how many transcripts, how far
back, and whether key rotation is warranted.

**Recurred, harness-confirmed, 2026-07-28:** during the Discord-narration
audit workflow, 2 of 15 subagents ran `security find-generic-password ... -w`
for the Discord bot token / commish API key directly in a bash command instead
of piping it straight into the consuming `curl` call, printing the live
secret into their own tool output. The harness's own security classifier
flagged both as policy violations. Confirms this isn't a one-off — the
pattern of materializing these secrets into transcript-visible output keeps
recurring across sessions/agents. Strengthens the case for rotation once the
investigation above lands, and for whatever fix comes out of it also
including agent-facing guidance not to `-w`-and-echo secrets when a
credential-scoped fetch helper would do.

---

## 7. 🟢 CLAUDE.md missing from repo root

Referenced by stored agent memory as "the repo entrypoint that indexes every
doc and carries the MFL write guard" — it does not exist in the current
`main` checkout or any worktree. It was built in the same abandoned commit as
item #3 and never merged. Subsumed by item #3's fix (merging that branch
restores it), but flagging separately since agent memory currently points at
a file that doesn't exist, which is its own small hazard.

---

## 8. 🟢 Front Office reported "not loading" (2026-07-27, unresolved)

Keith reported Front Office not loading during the live auction. Direct,
unauthenticated load of `site/rosters/v2/front_office.html` via the GitHub
Pages URL rendered cleanly with live data and no console errors at
investigation time — Pages deploy pipeline confirmed healthy. Most likely
specific to the MFL-embedded view (iframe via `fo_embed_loader.js`),
Keith's authenticated commish session, or transient load on the worker
during peak auction traffic. **Not reproduced, not root-caused** — pick back
up if it recurs, starting with what the failure actually looked like
(blank panel vs. stuck spinner vs. error) and whether it was the MFL embed
or a direct URL.

---

## 9. 🔴 Any loop over an unbounded MFL transaction export is a future stall, not a maybe

**Confirmed a second time, 2026-07-28 ~12:00 PM ET:** the auction poll
reproducibly stalled on 100% of attempts for ~20 minutes (3 consecutive
locked runs, all dying at the identical checkpoint) — bids frozen the whole
time. Root cause: the `AUCTION_WON` transaction fetch (`TYPE=transactions
&TRANS_TYPE=AUCTION_WON`) has no date window, unlike its INIT/BID siblings,
so it returns MFL's **entire history for the auction's whole run** — 54 rows
and climbing. The ingest loop did one sequential, awaited D1 `UPDATE` per
row, every 2-minute tick, forever. It was always going to cross into
unreliability once the transaction count grew past whatever Cloudflare's
tolerance turned out to be that day — this wasn't a new regression, it was a
latent bug that had been silently building toward failure since day one of
the auction. Fixed via the same `db.batch()` chunking pattern already used
for the lot-sweep loop (see item 4) — but this is now the **second** loop
found with this exact anti-pattern, both in the same function, both found
only after they'd already caused a live stall.

**Do this proactively, don't wait for a third one:** audit every fetch in
`processAuctionPoll` (and `finalizeEraContracts`/`finalizeFaaContracts`) for
whether it's bounded by a date window or count limit. Any unbounded
MFL-history fetch feeding a per-row loop is a stall waiting for the count to
cross some threshold — batch it or window it before it fails live, not
after.
