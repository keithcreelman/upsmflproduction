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

## v1.7.29 — 2026-05-11 — Hide Trades tab on mobile

Per Keith: the **Draft-Day Trades** tab (historical trade-history reference)
isn't draft-day-relevant when drafting from a phone. Hidden on mobile via a
`MOBILE_HIDE_TABS` set in the mobile shell setup. Kept visible on desktop.

If you want to add or remove other tabs from the mobile nav later, just
edit that one Set.

---

## v1.7.28 — 2026-05-11 — Mobile icon tabs + trade picker timeout + Esc-anywhere

Two changes from Keith.

### UX: top tabs use icon-style on mobile
The top tab nav now renders as compact icon + 1-word labels on mobile
(same `MOBILE_TAB_META` that powered the now-hidden bottom nav):
- 🎯 LIVE · 📜 HISTORY · 👥 TEAMS · 🔄 TRADES · 🎲 R6 · 📅 PICKS · 📊 CALCS
- 56px wide, 9px label, 16px icon. All 7 tabs fit cleanly.
- Desktop full-text labels restored on resize back above 768px.

### Fix: trade modal can no longer lock up
Trade picker had no timeout — if the worker hangs (CF cold-start, MFL
slowness), the columns spun forever with no recovery.
- Added 15s `AbortController` timeout on `/api/franchise-assets`.
- On timeout, if the local stub fallback also yields nothing usable, the
  picker shows a `↻ Retry` button instead of empty columns.

### Escape hatches for any stuck modal
- **Esc-to-close** now works on every tab (was Live-tab-only).
- **Backdrop click** dismisses any modal — important on mobile where the
  ✕ button can be tiny.

---

## v1.7.27 — 2026-05-11 — Taxi pill + salary universal across My Team + Profile card

Per Keith: the universal taxi rule from v1.7.26 (trade modal) now applies
everywhere a player is rendered.

**My Team panel:**
- Per-player row: TAXI badge next to player name, salary always shown
  (yellow-tinted on taxi rows so it reads as "real money but separate
  category").
- Per-position bucket header: `Active cap $X + $Y taxi` callout when the
  bucket has taxi players.
- Roster summary: `Roster · N players · $X cap + $Y taxi (N)` so the
  cap-relevant payroll is the lead number with taxi as a parenthetical.

**Player profile card:**
- Contract card surfaces TAXI badge when the contract data carries the
  flag (or roster/contract status contains "TAXI").

**Snapshot script:**
- `snapshot_franchise_assets.py` now emits `taxi: bool` + `roster_status`
  on each player. Sorts non-taxi first within each franchise. Future
  regenerations of `franchise_assets_2026.json` will include taxi data
  automatically — no script changes needed elsewhere.

---

## v1.7.26 — 2026-05-11 — Mobile polish round 1 (5 fixes from first phone test)

1. **Tabs back at the top.** Bottom nav was removed (DOM kept, hidden via
   CSS so it's easy to revive if needed). Top nav becomes `position: sticky`
   on mobile so it stays accessible while scrolling.
2. **Trade modal header tightened.** Two stacked rows with their own labels
   collapsed to ONE compact row: `[From-select] → [To-select] [✕]`.
3. **Universal TAXI pill** wherever a player is rendered (trade picker
   rows, basket rows, anywhere new). Yellow-tinted 9px badge.
4. **Taxi salary always shown** even though it doesn't count vs cap —
   it's still real money for trade-value comparisons.
5. **Pagination at 20/page** on Historical Picks and Future Picks tables,
   with prev/next buttons + "X-Y of Z · page N/M" summary. Filters reset
   to page 0.

New worker behavior:
- `/api/franchise-assets` now returns `taxi: bool` on each player and
  sorts non-taxi-first.

New util:
- `paginate(rows, keyName, opts)` — drop-in pagination helper. Mounts
  controls below any table.

---

## v1.7.25 — 2026-05-11 — Mobile app shell (Option B from the mobile plan)

Below 768px viewport, the hub swaps in a phone-friendly layout:

- **Bottom tab nav** — always within thumb reach. Mirrors the desktop top
  tabs (auto-discovers any future tab additions). Each tab gets an emoji
  icon + 1-word label. Horizontally scrollable.
- **Single-column live view** — on-clock card pinned at top, prospects
  below. Mock Draft Simulation card hidden entirely on mobile.
- **Full-screen modal sheets** — pick confirm + trade builder slide up
  from the bottom (`100dvh`), primary action button sticks to bottom
  above the iOS home indicator (safe-area-inset).
- **44px touch targets** floor on every button. Inputs sized at 16px
  to defeat iOS auto-zoom on focus.
- **Compact live banner** — pill + headline + clock only on mobile.
  Greeting / clock-config / reset / Trade DM toggle hidden (commish desk
  tools).
- **Toast sticks above the bottom nav** so notifications stay visible.

Activated by `body.is-mobile` via `matchMedia('(max-width: 768px)')` with
a change listener so orientation flips re-evaluate without a reload.
Desktop layout is bit-identical — all changes gated on `.is-mobile`.

---

## v1.7.24 — 2026-05-11 — R6 final order writes to MFL + parent-URL fix

Two things from Keith's first test of v1.7.23:

### 1. Kickoff Discord link was `about:srcdoc`
The hub runs in a `srcdoc` iframe so `window.location.href` inside it
resolves to `about:srcdoc` — useless as a clickable link.

The outer HPM loader (which runs on the actual MFL page) now injects
`window.UPS_DRAFT_HUB_PARENT_URL` so the Discord announcement link
points at the real MFL page. Frontend skips `about:srcdoc` entirely
and falls back to a hardcoded league URL if both injected + own URL
are unusable.

(The earlier bad-link kickoff post is still in Discord — delete it
manually and re-click 📢 Announce Kickoff to repost with the correct URL.)

### 2. R6 final order goes to MFL, not Discord
Per Keith: skip the Discord publish modal, write the order directly
to MFL instead and leave the on-screen R6 table as the visible record.

After the official drawing completes, hub auto-opens an **Apply R6
Order to MFL** modal. Confirm and the worker:

1. Fetches current `draftResults`
2. Checks no picks have been made anywhere (refuses with 409 if any have
   — destructive `draftResults` import would wipe them)
3. Builds new XML preserving R1-R5 ownership exactly as MFL has it +
   updating R6 slot ownership per the drawn order
4. POSTs `import?TYPE=draftResults`
5. Returns success (or detailed error)

Toast on success: `✓ R6 order applied to MFL`. Verify in **MFL →
Commissioner → Draft Setup**.

If anything goes wrong, the on-screen table is still the canonical
record — apply manually as a fallback.

---

## v1.7.23 — 2026-05-11 — R6 drawing tonight + Discord publish + R6 untradeable

Three things for tonight's R6 random drawing:

### 1. Countdown rescheduled
- Target time moved from `May 2, 2026 @ 6:00 PM ET` → `May 11, 2026 @ 9:00 PM ET`.
- Hub label updated to match. Countdown ticks down to the new time.

### 2. Discord kickoff + final-order publish (commish-only, idempotent)
- New **📢 Announce Kickoff to Discord** button next to the R6 controls
  (commish only). Posts a one-time announcement to `#live` (channel id
  `1498680803419357234`):
  > 🎲 **6th Round Rookie Draft Order — Live Drawing tonight at 9:00 PM ET**
  > Tune in to watch the random slot order get drawn live...
  > Watch live → `<hub URL>`
- After the **official drawing completes**, the hub auto-opens a publish
  modal showing the final ordered list, ready to post to `#live`.
- **Two-step flow** for both: worker dry-run returns the EXACT message
  text → modal previews on screen → commish confirms → worker posts.
- **Idempotency**: worker scans the last 100 channel messages for marker
  tags (`[r6-kickoff-2026]`, `[r6-final-order-2026]`) and refuses to
  duplicate. Re-clicks are no-ops.

### 3. R6 picks are now hidden from the trade modal
- Per UPS rules, R6 picks aren't tradeable. The asset picker now filters
  `round === 6` from both current-year and future picks so they can't be
  accidentally added to a basket.

---

## v1.7.22 — 2026-05-11 — Honor MFL's actual field names in pendingTrades + picks-first

The v1.7.21 diagnostic dump revealed two real causes:

1. **MFL's tradeProposal response is literally just `<status>OK</status>`** —
   no trade_id at all. None of the 6 regex patterns can match what isn't
   there. The pendingTrades fallback is the ONLY path forward for this MFL
   response shape.
2. **MFL's pendingTrades JSON uses field names** `offeringteam`, `offeredto`,
   `will_give_up`, `will_receive`, `trade_id` — none of which the v1.7.21
   lookup looked for. That's why `candidates_found: 0` despite 2 pending
   trades being in the response.

Fixed both:
- Sender reader prepended with `offeringteam` (current MFL JSON name).
- Asset readers accept `will_give_up` / `will_receive` (snake_case) alongside
  the camel-lowered + legacy variants.
- trade_id reader prioritizes the snake_case `trade_id`.
- When match still fails, diagnostic shows ALL pending offers (not just
  direction-matched), so we can see what fields/values MFL actually returned.

**UX**: trade asset picker now shows **Draft Picks** above Players on both
sides of the basket. Picks are the dominant trade currency on draft day.

---

## v1.7.21 — 2026-05-11 — Robust pendingTrades lookup applied to BOTH paths

After v1.7.20, Keith's trade-process still failed with `step: extract_trade_id`.
Root cause: the v1.7.20 robust lookup was only wired into the duplicate-recovery
path (propose returns "Duplicate trade offer"). When propose SUCCEEDED but
MFL didn't echo a parseable trade_id, the OLDER narrower lookup ran — and
missed for the same reasons (fetched only the receiver, fragile field names).

Refactored into one shared `_findPendingTradeId()` helper used by both
paths. Same robust behavior either way.

Also: the `extract_trade_id` error response now dumps `propose_response`
(truncated to 1500 chars) so we can see exactly what MFL returned and
why none of the 6 regex patterns matched. Plus the same `recovery: {...}`
diagnostics block we added in v1.7.20.

Frontend appends both to the error toast so it's visible without DevTools.

---

## v1.7.20 — 2026-05-11 — Tougher duplicate-trade recovery + diagnostics

The v1.7.17 duplicate-recovery first cut was failing for Keith because:
- MFL's `pendingTrades` JSON uses different field names per league
- A pending offer from A→B can show up under EITHER franchise's
  `pendingTrades` but we were only fetching one side
- We had no diagnostic when matching failed — error just said "couldn't
  find a matching pending offer"

Tightened the recovery and made the failure case visible:

- **Fetch both sides** of the trade in parallel; merge + dedupe by trade_id.
- **Lower-case all field reads** so MFL's casing variance doesn't matter.
- **Match either direction** (sender=fromFid+receiver=toFid OR the reverse).
- **Strict asset equivalence first**, fall back to freshest by timestamp.
- **Surface candidate diagnostics** when recovery still fails — error now
  includes `recovery: { candidates_found, total_pending_for_to,
  total_pending_for_from, wanted_give, wanted_receive,
  candidate_summaries[] }`. Frontend appends this to the error toast so
  we can see exactly what MFL returned.

Next time a "Duplicate trade offer" recovery fails, the toast will show
the candidate list so we can pinpoint why matching missed.

---

## v1.7.19 — 2026-05-11 — DM toggle is now a master Discord mute (picks + trades)

The v1.7.18 toggle only silenced trade announcements. Per Keith: it should
cover picks too. Renamed and rescoped:

- Button label: **📢 DM: ON** / **🔕 DM: OFF** (was "Trade DM").
- When OFF, both `/api/pick` LIVE and `/api/trade/process` LIVE skip the
  Discord post. MFL writes happen in both cases — only the announcement is
  silenced.
- Pick success message gains the same "🔕 Discord muted (per your DM
  toggle)" trailer the trade success path already had.
- localStorage key unchanged (`rdh_silence_trade_announce`) so any prior
  setting carries over.

---

## v1.7.18 — 2026-05-11 — Trade-process robust trade_id + Trade DM toggle

**Bug**: Process Trade failed with `extract_trade_id · Trade was proposed but
MFL response didn't include a parseable trade_id`. The propose actually
worked but our 3 regex patterns missed MFL's response format.

**Fix**:
- Expanded to 6 regex patterns covering XML attrs (`<trade id="...">`,
  `<tradeProposal tradeId="...">`), JSON shapes, generic `id=...` attrs.
- New fallback: when no regex matches, fetch `pendingTrades` for the
  receiver, find the matching sender→receiver offer (asset equivalence
  preferred, freshest timestamp as tiebreaker), use its trade_id.
- Same lookup logic powers v1.7.17 duplicate recovery, just used as a
  positive lookup here.

**Feature**: Commish-only **🔕 Trade DM: ON/OFF** toggle in the banner
right column. When OFF, Process Trade still completes in MFL but skips the
live Discord post. Picks always announce regardless. Toggle persists in
localStorage. Toast/result inline says "🔕 Discord muted (per your toggle)"
when applied.

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
