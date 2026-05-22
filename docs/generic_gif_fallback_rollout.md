# Generic GIF tone-pool fallback — cross-activity rollout plan

Planning artifact for extending the sad-NFL Pass-3 fallback (already wired for drops) to every other player-GIF-using activity type. Drops landed in commit `5a4904e` on `claude/exciting-tharp-235716`; this doc maps what it would take to bring the same pattern to extension / restructure / tag / trade / MYM, and what's already reusable.

**Status as of 2026-05-22:**
- ✅ Drops: Pass 3 active, sad-NFL pool populated, handler accepts non-strict results
- 🟡 All other activities: plumbing reusable, just need pool query strings (config-only for most)
- 🚫 Auction: out of scope — uses its own curated GIF manifest

---

## 1. Reusable plumbing already in the codebase

| Piece | Where | What it gives us |
|---|---|---|
| `pickContractActivityGifUrl()` | [worker/src/index.js:18596](../worker/src/index.js) | The shared player-GIF picker. Now has 4 fallback layers: Pass 1 (full-name strict) → Pass 2 (last-name strict) → **Pass 3 (tone-pool, non-strict)** → no-player-name generic fallback. Pass 3 is the new layer; all activities can use it just by populating the pool. |
| `TONE_POOL_QUERIES` constant | [worker/src/index.js:18681](../worker/src/index.js) | The kind-keyed map of fallback query strings. Today only `drop` is populated; adding an array of query strings for any other kind = that kind gets a Pass-3 fallback. No code change required. |
| `normalizeContractActivityKind()` | [worker/src/index.js:18504](../worker/src/index.js) | Maps the activity-type strings the call sites pass in to a stable kind enum. Recognizes `tag`, `restructure`, `mym`, `extension`, `drop`, falls through to `other`. Used both to gate per-kind logic in `contractGifQueries` and to look up the right `TONE_POOL_QUERIES` entry inside Pass 3. |
| `contractGifQueries()` | [worker/src/index.js:18541](../worker/src/index.js) | Per-kind query generator for Pass 1 / Pass 2 (still strict-matched). Already has per-kind sad/celebration biases baked in for `drop`, `extension`, `restructure`, `tag` — these participate in the strict-match passes (e.g. `"patrick mahomes celebration"` could match a strict tagged Mahomes GIF). Independent of Pass 3 pool. |
| `pickTierGif()` | [worker/src/index.js:27166](../worker/src/index.js) | The non-strict generic-pool search pattern (iterate query strings → Giphy search → random pick from any result). Currently a closure inside `/admin/drops/post-discord` for cap-penalty *reaction* GIFs. Pass 3 mirrors this shape. If we end up wanting tier-based pools elsewhere (e.g. cap-impact tiers on restructures), this is the function to hoist file-scope. |
| `normalizeForMatch()` | [worker/src/index.js:18591](../worker/src/index.js) | Lowercase / diacritic-strip / non-alphanumeric normalizer. Used by strict-match filter; not relevant to Pass 3 (no filtering). |
| `normalizePlayerNameForGif()` | [worker/src/index.js:18518](../worker/src/index.js) | `"First Last"` / `"Last, First"` parser → `{full, last, variants}`. Pre-Pass-3 (player name doesn't matter for the pool); referenced for completeness. |
| Caller filter (strict gate) | [worker/src/index.js:27328](../worker/src/index.js) (drops only) | The drop handler used to enforce `pg.strict_match` before accepting the URL — that gate was relaxed in commit `5a4904e`. **All other callers were already lenient** (they take whatever `gif_url` comes back), so they will automatically pick up Pass-3 results the moment we populate `TONE_POOL_QUERIES` for their kind. No handler changes needed for them. |

---

## 2. Per-activity-type map

For each activity type that calls `pickContractActivityGifUrl()`, what's wired today, what the tone-pool would be, and how much code it costs to add.

### 2.1 drop ✅ DONE

| Field | Value |
|---|---|
| Call sites | [worker/src/index.js:27372](../worker/src/index.js) (drops handler) |
| Activity-type strings passed in | `"drop"` |
| `kind` (post-normalize) | `drop` |
| Player-GIF logic today | Pass 1 + Pass 2 + Pass 3 sad-NFL pool. Handler accepts non-strict. |
| `TONE_POOL_QUERIES.drop` | `["nfl player dejected", "football player frustrated", "nfl bench head down", "football walk off field", "nfl disappointed"]` |
| Status | Shipped 2026-05-22, validated on Higbee + Brown test posts |

### 2.2 extension

| Field | Value |
|---|---|
| Call sites | [worker/src/index.js:19642](../worker/src/index.js), [19750](../worker/src/index.js) (dynamic, picks up extension activity via the shared contract-activity post path) |
| Activity-type strings passed in | `"Extension"` (deriveContractActivityType returns this when `isExtensionSubmission` is true, [worker/src/index.js:18499](../worker/src/index.js)) |
| `kind` (post-normalize) | `extension` |
| Player-GIF logic today | Pass 1 + Pass 2 only. If no strict match: empty `gif_url`, embed posts without a GIF. Caller already accepts non-strict. |
| Tone | **Celebration / hype / signing.** Star player just got paid + locked up. |
| Proposed `TONE_POOL_QUERIES.extension` | `["nfl celebration", "football contract signing", "nfl handshake suit", "football pen to paper", "nfl player celebrates contract", "football locker room celebration", "nfl player excited interview"]` |
| Net-new code | **Config-only** — just the array. Caller already lenient. |
| Risk notes | Watch for fan-celebration false-positives ("nfl celebration" surfaces a lot of fan/crowd footage too). Lean toward queries with `"player"` in them. |

### 2.3 restructure

| Field | Value |
|---|---|
| Call sites | [worker/src/index.js:19303](../worker/src/index.js) (restructure-specific path) + dynamic path at [19642](../worker/src/index.js)/[19750](../worker/src/index.js) |
| Activity-type strings passed in | `"restructure"` (hardcoded at 19303), or `"Restructure"` from `deriveContractActivityType` |
| `kind` (post-normalize) | `restructure` |
| Player-GIF logic today | Pass 1 + Pass 2 only. Caller already accepts non-strict. |
| Tone | **Business / money shuffle / cap relief.** Less euphoric than extension — it's an accounting move. Slight comedic potential ("creative accounting"). |
| Proposed `TONE_POOL_QUERIES.restructure` | `["football money celebration", "nfl cap restructure", "cash money fanned", "football paperwork signing", "nfl gm desk meeting", "money counting machine", "nfl player money handshake"]` |
| Net-new code | **Config-only.** |
| Risk notes | "money counting machine" is meme-y — might be too jokey for serious restructures. Consider letting Keith hand-curate after seeing first batch. |

### 2.4 tag (Franchise / Transition)

| Field | Value |
|---|---|
| Call sites | [worker/src/index.js:28373](../worker/src/index.js) (admin batch resend-tag-deadline-dm), [27083](../worker/src/index.js) (contract DM path), dynamic at [19642](../worker/src/index.js)/[19750](../worker/src/index.js) |
| Activity-type strings passed in | `"Tag"` |
| `kind` (post-normalize) | `tag` |
| Player-GIF logic today | Pass 1 + Pass 2 only. Caller already accepts non-strict. Pre-deadline tag DM has its own conditional path ([19590-19612](../worker/src/index.js)) but flows through the same `pickContractActivityGifUrl` call. |
| Tone | **Lock-in / franchise / claiming.** Player isn't celebrating — owner is asserting control. Mood: ownership/possession. |
| Proposed `TONE_POOL_QUERIES.tag` | `["nfl franchise tag", "football locked in", "nfl player staying", "football team flag claim", "nfl contract locked", "football star not going anywhere", "nfl no escape"]` |
| Net-new code | **Config-only.** |
| Risk notes | Giphy coverage of "franchise tag" specifically is THIN. Most queries will surface generic team/lock content. Probe before locking in. |

### 2.5 trade

| Field | Value |
|---|---|
| Call sites | [worker/src/index.js:19173](../worker/src/index.js) (trade notification) |
| Activity-type strings passed in | `"trade"` (lowercase, hardcoded) |
| `kind` (post-normalize) | `other` — **`normalizeContractActivityKind` does NOT recognize `trade` today.** This is the same dead-code-gate bug we fixed for `drop`. Needs a one-line addition to the normalizer. |
| Player-GIF logic today | Pass 1 + Pass 2 only. Caller already accepts non-strict. The `contractGifQueries` `else` branch (for `other`) currently fires for trade — emits `"nfl signing"` and `"football celebration"` as Pass-1/2 generic queries that get filtered out by `isPlayerSpecificQuery` anyway. |
| Tone | **Mixed — depends on side.** Left franchise loses a player (sad/movement); right franchise gains one (welcome). A *neutral* "movement/news" pool is safer than picking a side. |
| Proposed `TONE_POOL_QUERIES.trade` | `["nfl trade headline", "football breaking news", "nfl trade alert", "sports anchor breaking news", "nfl player new jersey", "football welcome to the team", "moving truck nfl"]` |
| Net-new code | **1 line of code** to add `if (activity.includes("trade")) return "trade";` to `normalizeContractActivityKind` ([worker/src/index.js:18504](../worker/src/index.js)) — same shape as the `drop` fix. **Plus** config (the array). |
| Risk notes | The featured-player perspective in [19173](../worker/src/index.js) is "most often the marquee player moving" — so a "new jersey" / "welcome" tone fits more often than "loses player" tone. But for two-team marquee swaps, neither side is purely sad/happy. Neutral-news is the right call. |

### 2.6 MYM (Multi-Year Money)

| Field | Value |
|---|---|
| Call sites | Indirect — MYM contracts post via the generic contract-activity path ([19642](../worker/src/index.js)/[19750](../worker/src/index.js)) with whatever activity-type string the caller built. The normalizer already recognizes `"mym"` ([18509](../worker/src/index.js)). |
| Activity-type strings passed in | Varies; whatever string contains `"mym"` (e.g. `"FA Contract MYM"`, `"MYM"`) |
| `kind` (post-normalize) | `mym` |
| Player-GIF logic today | Pass 1 + Pass 2 only. Caller already accepts non-strict. |
| Tone | **Big-money signing / megadeal celebration.** MYM is "this guy locked himself in for 2+ years at significant $". More celebratory than restructure, similar pitch to extension but with a "megadeal" overtone. |
| Proposed `TONE_POOL_QUERIES.mym` | `["nfl megadeal celebration", "football huge contract", "nfl player big money", "cash flying celebration", "football guaranteed money", "nfl record contract", "football player rich"]` |
| Net-new code | **Config-only.** |
| Risk notes | "guaranteed money" is meme-territory ($MJ pointing GIF). Decide if that vibe is on-brand for UPS announcements. |

### 2.7 FA Contract (catch-all)

| Field | Value |
|---|---|
| Call sites | Falls through dynamic [19642](../worker/src/index.js)/[19750](../worker/src/index.js) with `activityType = "FA Contract"` per `deriveContractActivityType` default |
| `kind` | `other` (none of the if-branches match `"fa contract"`) |
| Player-GIF logic today | Pass 1 + Pass 2. Caller lenient. |
| Tone | Same as extension (player signed/joined team). Could either share Extension's pool or get its own. |
| Proposed `TONE_POOL_QUERIES` | Either (a) add `if (activity.includes("fa")) return "extension";` to normalizer (aliasing), or (b) define `TONE_POOL_QUERIES.fa_contract` separately if Keith wants a distinct "FA-signing" tone (lower-key than star-extension). |
| Net-new code | **1 line** in normalizer (alias) OR **config-only** if defined as its own key. |
| Decision pending | Whether FA Contract shares Extension's pool or has its own. |

### 2.8 Auction (ERA picker) — OUT OF SCOPE

| Field | Value |
|---|---|
| Call sites | Doesn't use `pickContractActivityGifUrl` at all. Uses its own narrator V3/V5 GIF curation via the `curated_gifs.json` manifest at [worker/src/index.js:919](../worker/src/index.js), [946](../worker/src/index.js), [3068](../worker/src/index.js). |
| Why out of scope | Already has a hand-curated GIF system with story-driven pool selection. Different problem (curation-heavy, narrative-aware) than the strict-match-then-fallback problem this doc addresses. |
| Future overlap | If we ever decide to consolidate, the auction system's curated pools could be unified with `TONE_POOL_QUERIES` — but only if the narrative quality of curated_gifs is OK to lose. Probably keep them separate. |

---

## 3. Rollout sequencing — easiest first

Order of operations, with effort estimate per step:

| # | Step | Code change | Risk | Effort |
|---|---|---|---|---|
| 1 | **extension pool** | Just add `TONE_POOL_QUERIES.extension = [...]` | Low — caller lenient, kind already maps right | ~5 min + Giphy quality probe |
| 2 | **restructure pool** | Just add `TONE_POOL_QUERIES.restructure = [...]` | Low — same | ~5 min + probe |
| 3 | **tag pool** | Just add `TONE_POOL_QUERIES.tag = [...]` | Low (slightly higher — "franchise tag" Giphy coverage is thin) | ~5 min + probe + maybe refine |
| 4 | **mym pool** | Just add `TONE_POOL_QUERIES.mym = [...]` | Low — kind already maps right | ~5 min + probe |
| 5 | **trade pool** | Add `if (activity.includes("trade")) return "trade";` to normalizer **AND** `TONE_POOL_QUERIES.trade = [...]` | Low — same pattern as the drop fix | ~10 min + probe |
| 6 | **FA Contract decision** | Either alias to extension (1 line) or separate pool (config) | Low | ~5 min, depends on Keith's call |

**Total effort to roll out everything: ~30-45 min of editing + probe time.** No new functions, no handler refactors, no migrations.

**Recommended approach:** ship one activity at a time, eyeball the first real-world post for each in the test channel before promoting to prod — same validation loop we used for drops. Don't batch-ship all 5 pools at once; tone is qualitative and you'll want to iterate the query lists based on what Giphy actually returns.

**Reusable probe technique:** the temp `/admin/drops/_giphy-probe` endpoint pattern (see commit history on `claude/exciting-tharp-235716` 2026-05-22) is the right tool to validate pool quality before shipping. Run each candidate pool query, eyeball top 5-10 results, refine. Don't ship a pool you haven't probed.

---

## 4. Decisions pending Keith

1. **FA Contract** — share Extension's pool, or get its own?
2. **Restructure tone** — straight celebration like Extension, or distinct "cap-relief / accounting" vibe? The proposed pool above leans business-y; could go more celebratory.
3. **Trade tone** — neutral news (proposed) vs. lean toward "welcome to new team" (the more-common featured-player perspective)?
4. **MYM tone** — distinct from Extension, or share? MYM is structurally a different contract type but tonally similar.
5. **Probe-first vs. ship-first** — recommendation is probe-first; confirm the cadence is OK before rollout starts.

---

## 5. Reference — current drops implementation (for pattern matching)

The drops Pass-3 fallback is the template. To replicate for another kind X:

1. (If needed) Add `if (activity.includes("X")) return "X";` to `normalizeContractActivityKind` at [worker/src/index.js:18504](../worker/src/index.js). Skip if kind already maps.
2. Add `X: [...curated queries...]` to `TONE_POOL_QUERIES` at [worker/src/index.js:18681](../worker/src/index.js).
3. (Drops only required this) Relax the caller's `strict_match` gate. **All other current callers are already lenient — no caller change needed.**

That's it. Three steps, two of which are config.

---

*Last updated: 2026-05-22 — drops shipped on commit `5a4904e`. Rest of rollout: planning only, not implemented.*
