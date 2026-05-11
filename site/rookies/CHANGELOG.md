# Rookie Draft Hub — Methodology Changelog

All changes to the Draft Hub's analytics methodology are documented here.
The visible **version badge** in the hub header is sourced from `VERSION.json`
(same directory). The two must be kept in sync when updating.

## Versioning scheme

- **MAJOR** (V1 → V2): methodology overhaul that changes what the classifier
  itself measures (e.g. replacing the NET formula, swapping the tier metric).
- **MINOR** (V1.0 → V1.1): threshold tuning, added metric, or new feature that
  extends the model without breaking comparability.
- **PATCH** (V1.0.0 → V1.0.1): bug fixes that affect output (e.g. a data-source
  correction, attribution fix).

**Bump the version only on GitHub commit**, not on local tweaks. When a change
lands, update both:

1. `VERSION.json` — bump `version`, add an entry to `changes` (type: `major` /
   `minor` / `patch` / `initial`), and update `released` + `label` / `description`.
2. This file (`CHANGELOG.md`) — add a matching narrative entry.

Update `methodology_signature` in `VERSION.json` whenever the change alters the
mathematical pipeline (so anyone loading the hub sees exactly what the current
logic is doing without digging into code).

---

## v1.7.17 — 2026-05-11 — Recover from MFL "Duplicate trade offer" error

Direct fallout from Keith's lockout-blocked trade attempt: the earlier attempt
proposed successfully but the accept step got rejected (lockout was on).
That left an **orphaned pending trade offer** sitting in MFL. Now every
retry of the same trade gets blocked by `Duplicate trade offer` because MFL
sees the existing proposal.

Fix: `/api/trade/process` now detects this case automatically.

1. Propose returns "duplicate" → don't error out
2. Fetch `pendingTrades` for the receiving franchise
3. Match by sender + receiver + normalized asset equivalence
4. Pull the existing trade_id from the match
5. Skip straight to ACCEPT using that trade_id

Response includes `recovered_from_duplicate: true` and the success toast
mentions it explicitly so you know what happened.

If the lookup yields no match (e.g. the pending offer has different
assets), falls through to a clearer error message pointing you to
**Commissioner → Trades → Pending Trades** to clean up manually.

---

## v1.7.16 — 2026-05-11 — Pick clock survives page refresh (resets only on pick/trade)

Keith hit two related bugs in LIVE mode:

1. **Refresh reset the clock.** `activePickStartedAt` was an in-memory-only
   field. Reload the page mid-pick and the countdown jumped back to 10:00.
2. **Authoritative timestamp wasn't winning.** The live-state poller passes
   MFL's actual pick timestamp into `_pickClockEnsureStarted`, but the helper
   bailed if the slot key hadn't changed — so a bootstrap `Date.now()` stamp
   would never get corrected by the more accurate MFL value.

Fixes:

- **Persistence**: `activePickStartedAt` + `activePickClockKey` written to
  sessionStorage on every change, restored on STATE init. A refresh keeps
  the same countdown intact.
- **Authoritative wins**: when called with `opts.startedAtMs`, the helper
  now ALWAYS prefers that value — corrects stale Date.now() bootstraps.
- **Trade triggers immediate refresh**: after a successful commish Process
  Trade in LIVE, fire `_refreshLiveDraftState` so the clock resets to the
  new on-clock owner's full time instead of waiting for the 20s poll.

Net behavior: refresh in LIVE = clock keeps running. Pick or trade = clock
resets. Cold load = stamps now until poller corrects with MFL timestamp.

---

## v1.7.15 — 2026-05-11 — Surface the real MFL error on trade failure

Keith hit "Error: api returned 502 application/json" trying to process a
trade and had no way to tell whether it was a Commish Lockout issue, a
trade-deadline issue, or a bad asset_id. The worker WAS returning the MFL
error in the JSON body, but the frontend threw before reading it.

Fix:
- Frontend always reads the response body before throwing.
- Error display now reads: `⚠ <hint> · step: <step> · MFL: <response excerpt> · MFL HTTP <status>`.
- Worker pattern-matches the MFL response on failure and ships a one-line
  `hint` covering the common modes:
  - `lockout|locked|disabled` → "MFL Commissioner Lockout enabled. Disable in League → Commissioner Tools."
  - `deadline|past|closed` → "Trade deadline has passed."
  - `invalid|not own|asset` → "One of the give/receive asset_ids is invalid or doesn't belong to the listed franchise."
  - `apikey|authentication` → "MFL APIKEY missing or unauthorized."

So next time a trade fails, the toast tells you what to fix.

---

## v1.7.14 — 2026-05-11 — DRY-RUN mode (rehearse LIVE without writing)

Keith's pre-draft concern: he wants to rehearse the full LIVE pick submission
flow on a test site without risking a fat-finger that lands a real pick on
the real league. SIM mode wasn't enough — he wanted to feel the EXACT
draft-day workflow: red banner, confirm dialog, button click, success toast,
board update.

**Activate:** append `?dryrun=1` to the hub URL on the test site. Flag persists
across refreshes (sessionStorage). Append `?dryrun=0` to clear.

What it does:
- **Frontend**: passes `dry_run: true` in `/api/pick`, `/api/trade`,
  `/api/trade/process` payloads when LIVE mode is active.
- **Banner**: pill reads **LIVE • 🧪 DRY-RUN** on a red+amber 45° striped
  background — visually unmistakable.
- **Worker `/api/pick`**: short-circuits the MFL fetch. Returns the request
  preview (API key redacted) + posts `[DRY-RUN — would have posted to #live]`
  to the test Discord channel.
- **Worker `/api/trade`**: skips the MFL `tradeProposal` POST.
- **Worker `/api/trade/process`**: skips BOTH the propose and accept fetches.
- **UI toasts/results**: 🧪 DRY-RUN messaging instead of the LIVE success copy.
- **Confirm dialog**: rewords completely when dryRun is on so you know what
  you're about to rehearse.

This way the test site can exercise every line of UI code, every API
roundtrip, every error-state branch — without writing anything to MFL
or to the production Discord channel.

---

## v1.7.13 — 2026-05-11 — Commish broker mode in the trade modal

When two owners verbally agree on a trade during the live draft, the commish
needs to be able to pick **both** sides and process it. Previously the trade
modal locked the from-side to whoever was logged in — and Keith hits this
hard when logged in as MFL's pseudo-franchise 0000 (no roster), where the
modal showed an empty "PICK FROM 0000'S ASSETS" column.

When `STATE.me.is_commish` is true, the trade modal now shows:

- **🔨 COMMISH BROKER · pick both sides** header
- **From:** dropdown — every franchise alphabetically
- **To:** dropdown — every franchise except the from-side (auto-rebuilds)
- Basket titles become team-aware: *"BLAKE BOMBERS OFFERS"* / *"KEITH RECEIVES"*
- Picker headers say *"Pick from Blake Bombers's assets"*
- Switching the From dropdown clears both baskets and reloads both pickers

Audit field `requested_by` carries the commish's true franchise_id (not the
from-team) so MFL + Discord still show who ran the action.

For non-commish owners, the modal is unchanged.

---

## v1.7.12 — 2026-05-11 — Pick clock is LIVE-mode only

The per-pick countdown was auto-starting on page load, which meant owners
running a mock draft saw a phantom 10:00 ticking down even in SIM mode
(where the auto-sim already has its own per-pick countdown).

The clock is now strictly a LIVE-mode tool:
- **SIM (default)**: clock hidden entirely.
- **Page load → flip to LIVE**: clock starts from now (overwritten by the
  MFL pick timestamp on the next live-state refresh).
- **LIVE → SIM**: clock state cleared.

The 1Hz repaint timer still runs but no-ops cleanly when SIM is active.

---

## v1.7.11 — 2026-05-11 — SIM mode no longer posts to Discord

Every simulated pick + simulated trade was pinging the test Discord channel
with a `[SIM]` prefix. During owner mock-drafts the channel was getting
flooded — and the noise wasn't useful, since the hub already shows the
planned message in the confirm modal.

Removed the Discord post from:
- `/api/pick` simulate path
- `/api/trade` simulate path

Both still return the formatted `discord_message` in the response so the
client can preview what the LIVE post would look like.

LIVE paths unchanged: real picks + processed trades still announce in
the live channel.

---

## v1.7.10 — 2026-05-11 — Reword LIVE-mode dialogs (picks are recoverable)

The LIVE-mode confirm dialog called picks "irreversible" — that's wrong. The
hub itself has no undo button, but the underlying actions are recoverable:

- **A pick** that hit MFL → undo via *Commissioner → Modify Draft Results*.
- **A Discord announcement** → delete the message.
- **A processed trade** → punch in the reverse trade (messier, but doable).

Updated copy:
- `flipLiveMode()` confirm now spells out the actual effects + recovery paths.
- Trade-process confirm: "IRREVERSIBLE without manual cleanup" → "Recovery
  requires punching in a reverse trade manually".
- Mode-help modal gained a "What if I make a mistake in LIVE?" subsection.

So: be deliberate, but don't panic if you fat-finger.

---

## v1.7.9 — 2026-05-11 — Commish detection handles MFL pseudo-franchise 0000

When Keith logs into MFL through the **commissioner dashboard** (rather than as
his own team Real Deal Creel / fid 0008), MFL routes him in as pseudo-franchise
**0000** — a special "league owner" login that doesn't have its own roster. The
v1.7.6 / v1.7.8 commish allowlist only knew about real-team fids, so the
**Go LIVE** toggle stayed hidden in this case.

This release fixes that with three changes:

1. **HPM loader sniffs `ISMFLCOMMISH` cookie** on the outer MFL page (where
   MFL cookies are readable) and forwards an explicit
   `window.UPS_DRAFT_HUB_IS_COMMISH` flag into the iframe. This is the
   cleanest signal because MFL only sets that cookie for accounts with
   commish privileges.
2. **Frontend** now treats fid `0000` as a commish indicator in the
   client-side allowlist; falls back to `"Commissioner"` for the banner
   greeting when no real franchise name is known.
3. **Worker** default `COMMISH_FRANCHISE_IDS` expanded from `"0008,0001"` to
   `"0008,0000,0001"`.

---

## v1.7.8 — 2026-05-11 — Defensive commish detection for the Go LIVE toggle

The v1.7.6 fix made the worker default `COMMISH_FRANCHISE_IDS` include `0008`,
but the **Go LIVE** toggle still wasn't reliably appearing for Keith because
the frontend's `/api/me` call could race the HPM franchise-id injection (or
fail entirely on workers.dev preview / direct page loads).

Three layers of belt-and-suspenders:

1. **Client-side commish allowlist.** After `/api/me` + HPM overlay, the hub
   cross-checks `STATE.me.franchise_id` against `["0008","0001"]` and forces
   `is_commish:true` on match. So the toggle appears as long as the hub
   knows your franchise — regardless of whether the worker round-tripped it.
2. **`?commish=1` URL override.** Append to the URL to force-show the
   toggle (or `?commish=0` to hide). Useful for testing on workers.dev.
3. **`console.info("[draft-hub] me:", ...)`** debug log on every load — open
   DevTools and you can see exactly what `STATE.me` resolved to.

---

## v1.7.7 — 2026-05-11 — Per-pick countdown clock in the banner

A real-time pick countdown now sits next to the on-the-clock headline.

- **Default 10 minutes** (UPS slow-draft cadence). Configurable from a small
  selector in the banner right column: Off / 2m / 5m / 10m / 15m / 30m / 1h / 4h / 8h.
  Saved to `localStorage` so it persists across refreshes.
- **Color bands**: green >2min, amber 1–2min, red <60s, blinking-red OT
  (over time, owner is past the limit).
- **LIVE mode**: seeds from the MFL timestamp of the most recent pick (the
  moment the previous pick was recorded IS when the next slot started).
  Falls back to "first time we observed this slot" for pick #1.
- **SIM mode**: stamps now whenever the auto-sim or a manual pick advances
  active_pick. Revert + Reset both restart the clock cleanly.
- **↺ reset button**: commish-friendly do-over — restarts the current pick's
  clock from the moment of click (e.g. after a connectivity blip).
- **Mobile**: countdown stays visible (smaller); selector + reset hidden.

The clock does NOT auto-submit picks. MFL is still the authority on what
happens at expiry — the on-clock owner sees a flashing red OT and the
commish can intervene.

---

## v1.7.6 — 2026-05-11 — Commish toggle visible in prod + slow-draft speeds

- Worker default `COMMISH_FRANCHISE_IDS` now `"0008,0001"` (was `"0001"` only).
  Keith's franchise (0008 — Real Deal Creel) now sees the **Go LIVE** button on
  the live-mode banner without needing a Cloudflare secret. Override via env
  still wins.
- Auto-sim **Speed** dropdown gains `1 min / pick`, `5 min / pick`, and
  `10 min / pick` options for slow real-time drafts. Existing fast options
  (5s / 10s / 20s / Instant) unchanged. Tick progress bar already uses an
  elapsed-ratio fill so it scales correctly to multi-minute intervals.

---

## v1.1.0 — 2026-05-10 — Live Draft tab built out (simulate + LIVE modes)

The Live Draft tab is no longer a placeholder. Owners can now run picks and
trades from the hub itself, with a default-ON SIMULATE mode for risk-free
rehearsal before draft day.

**UI**
- Modern 3-column live layout (prospects | board | on-the-clock).
- Sticky mode banner at top — SIMULATE (amber, default) vs LIVE (red,
  commissioner-only flip with a confirmation dialog). Mode persists across
  refreshes.
- Filter chips (status) + segmented control (ADP source) replace dropdown
  soup. Visible-count badge on the prospect rail. Empty-state hint when
  filters yield zero results.
- Keyboard: `/` focuses search, `Esc` closes modals, `?` opens help.
- Reduced-motion media query honored; mobile/tablet collapses gracefully.

**Auth**
- Auto-login via MFL HPM context — when an owner opens the hub from MFL's
  homepage iframe, FRANCHISE_ID is detected from URL params (no cookie
  paste in the happy path). Cookie fallback retained for non-HPM contexts.

**Submit a pick**
- Confirm modal shows the rookie contract MFL will apply (Y1 AAV, 3yr TCV,
  length, taxi/IDP/option-year notes) computed per slot from
  `docs/league_context_v1.md` §A1.
- Simulate mode: validates + previews + posts to test Discord channel.
- Live mode: POSTs to MFL `draftResults` import + announces in
  #1498680803419357234.

**Propose a trade**
- Existing trade modal carries the simulate flag through to the worker —
  simulate validates, live POSTs to MFL `tradeProposal`.

**Player search**
- New collapsible panel — searches the entire MFL player pool by name and
  opens the same rich profile card used by Front Office.

**Worker**
- 6 new endpoints: `/api/me`, `/api/settings`, `/api/pick`, `/api/trade`,
  `/api/franchise-assets`, `/api/players-search` (under
  `worker/src/index.js` near `/api/player-bundle`).
- Discord posting reuses the existing bot-token + allowed-mentions
  pattern. Channels controlled by env vars
  `DISCORD_DRAFT_CHANNEL_ID` and `DISCORD_DRAFT_TEST_CHANNEL_ID`.
- Commish gate driven by `COMMISH_FRANCHISE_IDS` env var.

---

## v1.0.1 — 2026-04-20 — Best/Worst → NET; Bang-for-$ → Draft Rating

**Patch** — methodology realignment to the NET-centric model.

Changes:
- **Best Pick** on Team Tendencies cards now = highest 3yr NET (was: tier-ranked
  composite of tier × 1000 + Draft Rating). NET correlates with AP% at +0.850
  across 192 team-seasons, making it the authoritative "impact on winning"
  metric.
- **Worst Pick** now = lowest 3yr NET. Same reasoning.
- **Bang-for-$** now = highest Draft Rating (NET Δ vs slot-expected). Was:
  raw points above slot-median. Lavonte David 2012 3.04 (Draft Rating +77.4)
  correctly surfaces as Keith Creelman's Bang-for-$.
- **Cell-level popup definitions** now resolve by per-cell SEMANTIC, not by the
  current metric view. Clicking Slot-Exp NET always shows Slot-Exp NET's
  definition regardless of whether you're in Draft Rating view or somewhere
  else. Fixes a reported bug where 3yr NET and Draft Rating popups returned
  the same description.
- Added **Slot Percentile** field per pick — 0-100 rank of this pick's 3yr NET
  within the exact (round, slot) population. TRich 2012 1.01 = 0 (worst 1.01
  ever); Zeke 2016 1.01 = 92.9 (best 1.01 nearly ever). More interpretable
  than raw Draft Rating for individual picks.
- Introduced **VERSION.json** + **CHANGELOG.md** + visible version badge in
  hub header with click-through methodology history.
- Per-year positional rank averaging switched from simple average to
  games-weighted (matches existing 3yr E+P / Dud / NET behavior).
- **Tier popup** and **metric-cell popup** now lead with a "In plain English"
  block before the technical definition.
- **Shrinkage explanation** in the Draft Rating audit popup rewritten with
  plain-English first, then technical, then a concrete walk-through of what
  "raw +X / shrunk +Y / 0-100 scale Z" mean for the specific owner.

---

## v1.0.0 — 2026-04-20 — Initial release

**Baseline methodology locked.** This is the V1 reference point for all future
Draft Hub analytics.

Key components as shipped:

- **Tier classifier**: `NET = 3yr-games-weighted E+P rate − 0.5 × 3yr-games-weighted Dud rate`
  - Smash ≥ +30, Hit +15 to +30, Contrib 0 to +15, Bust < 0
  - No "Injury Bust" tier — games-played context surfaced separately
- **Weekly grading**: z-score against rostered-starter baseline at that
  (season, position). Elite (z≥1.0), Plus (0.25≤z<1.0), Neutral (−0.5≤z<0.25),
  Dud (z<−0.5).
- **Baselines**: rostered-starter methodology applied uniformly 2011-2025
  (ignoring stored `metadata_positionalwinprofile` values that used a different
  methodology and caused era drift).
- **Draft Rating**: per-pick Δ = actual 3yr NET − slot-expected NET, averaged
  per owner, shrunk via 20-pick Bayesian prior at league mean (0), then scaled
  0-100 anchored to the observed distribution.
- **Pick ownership**: resolved via `franchises` table + `transactions_adddrop`
  fallback + normalized team-name lookup; pre-2017 weekly ownership inferred by
  replaying drafts + adds + trades + drops chronologically.
- **Future pick projection**: 10yr owner-tracked reg-season AP% base + bracket-
  aware playoff-Δ adjustment; brackets sealed; `FINISH_TO_SLOT` mapping
  7→1.01 … 1→1.12.
- **R6**: random drawing (not projected), IDP-only.
- **Contract parsing**: MFL `contractStatus="TAG"` alone is not authoritative;
  only the literal `Tag` chunk inside `contractInfo` pipe-string marks a
  franchise tag.

Validation (correlations with All-Play%, n=192 team-seasons 2010-2025):

| Metric | r |
|---|---|
| Overall NET | +0.850 |
| Offense E+P | +0.844 |
| Offense Dud | −0.790 |
| Defense E+P | +0.319 |
| Defense Dud | −0.336 |
| Raw Points For | +0.505 |
| Lineup Efficiency | +0.012 |
