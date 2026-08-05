# DISCORD REDESIGN — UPS Dynasty FFL (2026)

**Generated:** 2026-08-05 · **Status:** PROPOSAL — nothing has been changed in Discord.
**Supersedes the target-state sections of** `docs/DISCORD_INVENTORY.md` (2026-05-29), which this
audit found to be partly drifted from live code.

**Method.** Full read-only pull of the live guild (`1057655884475531324`) via the Discord API:
27 channels, 8 roles, 547 channels+threads, **31,817 messages** — the complete server. Content
analysed by 7 parallel corpus agents; 3 independent architectures produced and scored by 3
judges on different axes; API capabilities verified against Discord's docs and live probes.
A complete JSON dump of every message exists (see §0) — no proposal here risks data.

---

## 0. MEASURED BASELINE (facts, not estimates)

| | |
|---|---|
| Members | 20 = **13 human accounts** (two are Keith: `ups_commish`, `upscommish`) + 7 bots |
| Roles | **8 — every one is a bot.** There is no Commish role and no Owner role. |
| `MENTION_EVERYONE` | held by **@everyone** at guild level → all 20 members can ping everyone, anywhere |
| Messages | the-coffee-shop 11,652 · transactions 4,886 (+280 threads/1,112) · keiths-test 1,754 · contract-activity 1,084 · slack-history 15 (+22 threads/7,578) · league-announcements 53 (+55 threads/2,149) · otb 371 · on-the-sofa 142 · rules-discussion 33 (+18 threads/282) · **all others under 60** |
| Dead channels | **11 of 19 text channels dead 4+ months; 8 dead a year or more** |
| Engagement | reactions/msg: contract-activity **0.35** · the-coffee-shop 0.30 · transactions 0.11 · league-announcements 0.02 · keiths-test **0.00** |

### The three findings that drive the whole design

**1. The Coffee Shop is not the problem.** Only **3.9%** of its 11,652 messages contain any
league-business vocabulary (cap/contract/trade/auction/deadline/rule/vote/dues/taxi/MYM/roster).
It is a genuinely social channel doing its job. The leak runs the *other* way — chit-chat into
transactional space.

**2. `contract-activity` is the unfixed half of a problem Keith already half-fixed.**

| Channel | Bot | Human | State |
|---|---|---|---|
| `contract-activity` | 288 | **796 (73%)** | still explicitly grants `SEND_MESSAGES` to @everyone; human posts through **2026-08-02** |
| `transactions` | 3,872 | 1,014 | **locked ~2026-07-14** — member posts stop; July 2026 = 57 human, August = **0** |

The lock demonstrably works. `contract-activity` needs exactly the same overwrite.
Note it also has the *highest reaction rate in the server* — members engage with contract posts
more than anything else. They are not misbehaving; they have nowhere to put the reaction.

**3. `@everyone` is completely debased.** 445 pings ever; **370 of them in 2026**:

```
2026-07-30  ################################################### 51
2026-07-28  ################################################ 48
2026-07-31  ########################################### 43
2026-07-29  ####################################### 39
```

**27.2 pings/day for 12 straight days** during the FA auction — 180 from nominations
(`worker/src/index.js:4197`) and 183 from wins (`worker/src/index.js:4229`), both emitting a
literal `@everyone`. When a $1K punter's auction win pings everyone, a commish directive carries
identical weight. **This is the mechanism defeating the signal separation Keith wants**, and it is
independent of channel layout. A `SILENT_NARRATION` switch that rewrites `@everyone` → "the league"
already exists at `index.js:4636`.

### Four verified code landmines (all confirmed by reading the source)

| Location | Issue |
|---|---|
| `worker/src/index.js:29134` | `DISCORD_REMINDER_CHANNEL_ID \|\| "1087157907419840644"` — **deadline reminders fall back to the Coffee Shop**, the social room |
| `worker/src/index.js:11312` | `DISCORD_DRAFT_CHANNEL_ID \|\| "1498680803419357234"` — **that channel ID does not exist in the guild.** Orphan fallback, today |
| `worker/src/index.js:27418`, `:38855` | hardcoded `1059113303059730494` (contract-activity) fallback — so that channel **must not be deleted** before these move |
| `grep '<@&' worker/src/` | **zero hits**; `allowed_mentions` is never passed a `roles` array. Role-mention plumbing is **unbuilt** — "@Owner replaces @everyone" is code that does not exist yet |

### The forum constraint (decisive, and counter-intuitive)

Discord *does* natively support "bot creates threads, members can only reply": in a **forum
channel**, `SEND_MESSAGES` gates creating posts while `SEND_MESSAGES_IN_THREADS` gates replying.

**But this codebase cannot use forums.** Every thread creation in the worker is either the
message-anchor pattern (`POST /channels/{cid}/messages/{mid}/threads` — 6 call sites) or a bare
`type: 11` create (`index.js:4411`, `:2842`, `:11384`). **Both are invalid against a forum
parent.** Pointing any live send site at a forum breaks it.

It is also unnecessary: a plain **text** channel achieves the identical outcome by denying
`SEND_MESSAGES` + `CREATE_PUBLIC_THREADS` + `CREATE_PRIVATE_THREADS` and allowing
`SEND_MESSAGES_IN_THREADS` — and `#transactions` has been the working proof of this since
2026-07-14. **No channel that any bot posts to should be a forum.**

---

# UPS Dynasty FFL — Recommended Target-State Discord Architecture

**Basis:** P1 ("three rooms and an archive") wins 2 of 3 judges and wins decisively on operability and durability. It is grafted with P2's three-voice **category** split (the one thing P1 got wrong: Keith named three voices and P1's sidebar showed two), P3's sealed-season archive ritual and always-open degraded path, and every judge-identified repair. Two hard engineering constraints from the judges are treated as non-negotiable and shape the whole design:

1. **The worker has no Discord forum support.** Zero hits for `applied_tags` / `available_tags` / `GUILD_FORUM` in `worker/src`. Every thread creation is either the message-anchor pattern (`index.js:4426, 12849, 23196, 28913, 40411, 41793`) or bare `type:11` (`index.js:4411, 2842, 11384`). Both are invalid against a forum parent. **Therefore: no channel that any bot posts to is a forum.** Exactly one forum exists in this design and no send site points at it.
2. **Role-mention plumbing does not exist.** `grep '<@&'` across `worker/src` returns zero hits and `allowed_mentions` is never passed a `roles` array. Every proposal's central claim — "@Owner replaces @everyone" — is unbuilt code at every send site. This is budgeted explicitly below as Wave 0.

---

## 1. Categories and channels

**11 channels in 4 categories** (down from 27 in 6). 9 text, 1 forum, 1 voice. Members see 10 (keiths-test is invisible to them). Sidebar objects: 33 → 15.

Five of the eleven are existing channels **renamed in place**, keeping their IDs — so every permalink Keith has ever cited still resolves, and the four highest-volume automated senders need **zero configuration change**.

Optional: prefix channel names with a per-tier emoji so the tier survives search results and permalinks. Cosmetic, adopt or skip.

---

### CATEGORY 1 — THE COFFEE SHOP (social; nothing here is official)

The only category where a member can start a message from scratch. Channel topic on both text channels reads: *"Nothing posted here is official."*

| # | Channel | Type | Who can post | Who can create threads | From old |
|---|---|---|---|---|---|
| 1 | **the-coffee-shop** | text | @everyone, unrestricted, unmoderated, profane. MENTION_EVERYONE denied to **every role including @Commish**. | @everyone (public threads only) | **KEEP id 1087157907419840644.** All 11,652 messages. Absorbs `this-day-in-history` as a cron-posted pinned thread. Absorbs the untethered banter evicted from `transactions` (~30%) and `contract-activity` (~19%). |
| 2 | **on-the-sofa** | text | @everyone, unrestricted | @everyone | **KEEP id 1291737646665699420.** Unchanged. **Deliberately not demoted to a thread** — this reverses P1. It is the only small channel with a self-sustaining organic identity (142 msgs / 22 months / 100% human / still active 2026-07-26) and the named bit is the entire mechanism. Cost of keeping: one sidebar line. |
| 3 | **Voice & Video Hangout** | voice | @everyone (connect/speak/video) | n/a | **KEEP id 1057655884936925228.** Absorbs `test_audio` (deleted). New bot behavior: when the first person connects, post one line into #the-coffee-shop. This is the cheapest fix in the entire redesign — *"You guys had a call. WTF. / I feel like I'm not getting half of my discord messages"* (cutting4987, 2026-05-12). |

---

### CATEGORY 2 — FROM THE COMMISH (directive; binding)

If it is here, it is binding and it came from Keith. This is the **only** category where @everyone is legal. No member originates anything.

| # | Channel | Type | Who can post | Who can create threads | From old |
|---|---|---|---|---|---|
| 4 | **from-the-commish** | text | @Commish + @League Bot only. @everyone: SEND_MESSAGES denied, SEND_MESSAGES_IN_THREADS allowed. **The only channel in the server where MENTION_EVERYONE exists, and only @Commish holds it.** | @Commish + @League Bot. Every top-level post auto-opens its discussion thread. | **RENAME `league-announcements` (1057657441011109898) in place.** Keeps 53 posts / 55 threads / 2,149 messages and every permalink. Encodes a norm the league has honored voluntarily since 2023-03-20 (52 of 53 top-level posts are Keith's; one member exception, rybo4591 2024-08-18). Absorbs deadline reminders, rulings, precedent, season bookends, dues, onboarding, release notes, Hall sentiment items. |
| 5 | **rulebook** | text | @Commish + @League Bot only. @everyone: SEND denied, SEND_IN_THREADS allowed, ADD_REACTIONS allowed (reaction voting is real governance here). | @Commish + @League Bot | **RENAME `rules-discussion` (1066399931574779914) in place.** Preserves `DISCORD_RULES_CHANNEL_ID` unchanged — the most-referenced channel var in the codebase (12 refs across `discord_round.js`, `discord_rule_proposal.js`, `rule_draft_agent.js`, `rule_integrator.js`, `anthropic_explain.js`) touches nothing. Preserves the six 2026 verdict threads that are currently the closest thing to a browsable rulebook. Absorbs `rules-important-links` (pinned) and `league-voting`. |

**Text, not announcement-type, for #from-the-commish.** Announcement channels add a publish step and a crosspost surface nobody in a 20-person private server needs, and they change nothing about how the bot posts. Skip the complexity.

**No separate #rulings channel, and no #league-calendar channel.** Both were tempting and both were rejected on volume:

- **Rulings** (~20–40/year) get a mandatory thread-title schema inside #from-the-commish: `2026-09-28 · RULING · Van Ginkel illegal start — Hawks — WARNING`, plus a single pinned **Precedent Index** post Keith appends one line to per ruling. If after one full season the interleaving with deadlines and release notes proves unbrowsable, splitting #rulings out is cheap — it is commish-authored, so no env var and no code moves.
- **Calendar** becomes a single **pinned message in #from-the-commish that the deadline cron EDITS in place** (`PATCH /channels/{id}/messages/{mid}`), carrying date + exact clock time + **timezone** + who it applies to + the penalty. That is P3's best idea with none of P3's channel cost, and it is the standing answer to *"I've seen 8am, 9pm, and EOD for this deadline throughout the offseason"* (rybo4591, 2026-05-21) and *"Doesn't say what time zone tho so I can see some debate"* (shawnblake, 2026-07-22).

---

### CATEGORY 3 — FROM THE LEAGUE (fact; machine-authored)

Machine-authored, no opinions, no directives. Members reply to anything and originate nothing — **except in #help-desk**, which is the deliberate, load-bearing exception.

| # | Channel | Type | Who can post | Who can create threads | From old |
|---|---|---|---|---|---|
| 6 | **the-wire** | text | @League Bot + @Commish only. @everyone: SEND denied, SEND_IN_THREADS allowed, ADD_REACTIONS allowed. MENTION_EVERYONE denied to bots here. | @League Bot + @Commish only. Every post IS a thread starter — no empty leading bot message (30+ occurrences today). | **RENAME `transactions` (1059111651846131833) in place.** This is the load-bearing decision: it keeps 4,886 messages + 280 threads + 1,112 thread messages, it is **already** the production default for `DISCORD_AUCTION_CHANNEL_ID`, `DISCORD_DRAFT_CHANNEL_ID`, `DISCORD_PICKS_THREAD_PARENT_CHANNEL_ID` and `DISCORD_DROPS_CHANNEL_ID`, and it is already member-locked (2026-07-14). Absorbs `contract-activity` output, `cap-penalty-announcements`, `otb`, and the traderoast lane. |
| 7 | **help-desk** | text | **@everyone can post AND create threads.** @League Bot posts too. | @everyone | **RENAME `website_bugs` (1481001757667754014) in place** — so `DISCORD_BUG_CHANNEL_ID` needs zero change. Topic: *"Bugs, questions, rule ideas, and where you submit when the bot is down. The only business channel you can start a message in."* |

**#help-desk is the single most important addition to the winning design, and it repairs three separate judge-identified fatal flaws at once:**

- It is the **always-open degraded-mode submission path**, which every judge made a hard gate on locking anything. The corpus is unambiguous: *"Bot seems dead. / Xavier Watts mym #1 3 years x1"* (2025-09-30), *"I have not been able to wake up the bot"* (briancross0914, 2025-05-30), *"Bot going to be back up for auction contracts I don't want to start putting them somewhere"* (2025-08-19). A member typing a contract into an open room beats a member missing a deadline.
- It is the **member intake path for rule ideas without requiring a slash command**. P1 routed intake through unbuilt `/propose` and `/ask`; judge 3 correctly called that a bet on command uptake by a population that types contracts as free text. An idea is not a transaction. Keith triages: promote to a #rulebook proposal thread, or close with a stated reason. Nothing dies silently the way papabear4110's 2025-12-21 turnover-yards proposal did (zero replies, no pipeline).
- It is the **ticket surface** for the support load that currently runs as chat — effectively all of March 2026 in the coffee shop, plus the 2026-08-02 cap-corruption incident (five owners reporting, six hours open, resolved with an image attachment in a social scroll).

It also absorbs the **bot-liveness surface** that judges 2 and 3 both wanted: the bot posts **state changes only** (up→down, down→up, auction-poll stall, `silent_fallback` config warnings) into #help-desk. Not heartbeats — state changes. This puts the answer next to the question and converts *"Bot 🤖 dead?"* (sexmanther, 2026-07-11) from a guess into a glance. If alert volume ever drowns tickets, split it to its own read-only channel; that is a five-minute change.

**The one-channel-transaction-tier decision, stated honestly.** #the-wire carries auction lots + drops + adds/waivers + trades + roasts + contracts + rookie picks + OTB. For roughly ten days each August it is ~90% auction cards. I am **not** splitting #the-floor out at launch, for three reasons: it re-creates the sprawl this design exists to kill; the split forces `DISCORD_AUCTION_CHANNEL_ID`, `DISCORD_DRAFT_CHANNEL_ID` and `DISCORD_PICKS_THREAD_PARENT_CHANNEL_ID` to move simultaneously; and the digest rule (below) removes roughly half the volume by itself. **Decision rule for 2027:** if, after the 2027 FA auction, the digest rule is live and #the-wire still runs over ~150 channel-level cards in any 48-hour window, split auction + rookie draft into a second text channel before August 2028. Env-var change only, no code — the fallback lands in a live channel with correct permissions, not a dead one.

---

### CATEGORY 4 — THE VAULT (finished; read-only)

Everything that is over. Read-only, plus the commissioner's private workshop.

| # | Channel | Type | Who can post | Who can create threads | From old |
|---|---|---|---|---|---|
| 8 | **the-vault** | **forum** (the only one) | @Commish only. @everyone: VIEW + READ_HISTORY only — no posts, no replies, no reactions. | @Commish only | **NEW.** No send site points at it, so the codebase's lack of forum support is irrelevant. The post list IS the index; tags do the sorting (Slack Era / Email Era / Draft / Auction / Governance / Retired Channel / Sealed Season). One curated, attributed, locked post per historical unit. |
| 9 | **slack-archive** | text | Nobody. Locked. | Nobody | **KEEP id 1063835430878969886** (`slack-history`), renamed and locked, moved under this category. **Not re-migrated at launch** — see §6. |
| 10 | **contract-activity-archive** | text | Nobody (@Commish retains for corrections). @everyone: read + history only. | Nobody | **KEEP id 1059113303059730494**, renamed, locked, moved here, with a pinned redirect to #the-wire. **This channel is NOT deleted**, and the reason is a fail-open landmine: the contract sender hardcodes `1059113303059730494` as its fallback at `index.js:27418` and `index.js:38855`. Deleting it before those literals move means a wiped env var silently posts real contracts into a dead channel — exactly the class of failure the repo banned after 2026-08-02. Revisit the delete decision after one full contract cycle (post-July 2027) confirms nothing resolves to it. |
| 11 | **keiths-test** | text | @Commish + all bot roles. **@everyone: VIEW_CHANNEL DENIED** (it is visible today). | @Commish + bots | **KEEP id 1089538054236160010.** Every `DISCORD_*_TEST_CHANNEL_ID` and `OTB_TEST_CHANNEL_ID` already defaults here, so nothing moves. Fixes `_probe_DELETEME` landing in the governance channel (2026-05-25), *"Going to be testing some items here. By no means intending to sign these deals"* in the production contract ledger (2026-05-16), and the permanent Keith Abney / Joe Burrow test lots sitting among real auction threads. |

**No @Archivist role, and the Vault stays visible to everyone.** Judge 1 liked P3's hidden archive for sprawl; judge 3 correctly pointed out that hiding history directly worsens the documented failure *"Somehow couldn't find the auction history posts"* (shawnblake, 2026-07-30). Four read-only channels is not the sprawl problem. Findability is.

---

## 2. Permission model

**One rule, applied at the guild level, then four exceptions.** This is P1's model verbatim, which judge 1 explicitly recommended importing over P2's per-tier overwrite matrix: identical outcome, a fraction of the surface to get wrong, and the version Keith can restate from memory.

### Guild-level @everyone baseline (inherited everywhere)

| Permission | Setting |
|---|---|
| VIEW_CHANNEL | allow |
| READ_MESSAGE_HISTORY | allow |
| ADD_REACTIONS | allow |
| ATTACH_FILES / EMBED_LINKS / USE_EXTERNAL_EMOJIS | allow |
| USE_APPLICATION_COMMANDS | allow |
| CONNECT / SPEAK / STREAM / USE_VOICE_ACTIVITY | allow |
| **SEND_MESSAGES** | **DENY** |
| **CREATE_PUBLIC_THREADS** | **DENY** |
| **CREATE_PRIVATE_THREADS** | **DENY** |
| **SEND_MESSAGES_IN_THREADS** | **ALLOW** |
| **MENTION_EVERYONE** | **DENY** |

> **Reply everywhere, originate nowhere. Social is the exception; authority is the default.**

That inversion is the design, and it is why it holds without ongoing attention: **every channel created after the redesign inherits the intent automatically.** (P3 was disqualified partly for getting this backwards — denying per-category means every new channel defaults to member-postable forever.)

### The four channel overrides

- **#the-coffee-shop** — @everyone: +SEND_MESSAGES, +CREATE_PUBLIC_THREADS. **@Commish: MENTION_EVERYONE explicitly DENIED** so the noisiest room in the server can never again be the broadcast surface.
- **#on-the-sofa** — @everyone: +SEND_MESSAGES, +CREATE_PUBLIC_THREADS.
- **#help-desk** — @everyone: +SEND_MESSAGES, +CREATE_PUBLIC_THREADS.
- **#the-vault / #slack-archive / #contract-activity-archive** — @everyone: −SEND_MESSAGES_IN_THREADS, −ADD_REACTIONS (fully inert, so nothing in them can ever be mistaken for live). **#keiths-test** — @everyone: −VIEW_CHANNEL.

### Role overrides

- **@Commish** — +SEND_MESSAGES, +CREATE_PUBLIC_THREADS, +MANAGE_THREADS, +MANAGE_MESSAGES in all non-social channels. +MENTION_EVERYONE in **#from-the-commish only**.
- **@League Bot** — +SEND_MESSAGES, +CREATE_PUBLIC_THREADS, +MANAGE_THREADS, +EMBED_LINKS, +ATTACH_FILES in #the-wire, #from-the-commish, #rulebook, #help-desk, #keiths-test.
- **@Owner** — no extra channel permissions. The baseline already grants replying everywhere.

---

## 3. Role model (there are currently zero human roles)

| Role | Members | Mentionable by | Purpose |
|---|---|---|---|
| **@Commish** | **BOTH of Keith's accounts** — ups_commish `1057654821638897715` and upscommish `621530026831118346` (both already in `COMMISH_DISCORD_USER_ID`) | anyone | Hoisted, distinct color, top of the member list. This is the single highest-leverage fix in the design. *"Fuck you Nacua."* (2024-12-01T23:35) and *"-1st offense warning for starting Van Ginkel, declared out Friday"* (2025-09-28T14:12) are the same author, same room, same visual weight, posted under two interchangeable usernames. Sole holder of MENTION_EVERYONE (in #from-the-commish only), sole holder of MANAGE_THREADS. |
| **@Owner** | the **12** franchise holders | **@Commish and @League Bot only** — set "Allow anyone to @mention this role" **OFF** | The real governance population (`Threshold: 7 yes to pass · pool 12` on every 2026 rule item), not the 20 server members. The default notify target for every bot ping carrying a deadline or a penalty. Replaces the workaround where Keith pasted ten raw user IDs to notify the league (2024-08-30). |
| **@League Bot** | UPS Contracts Hub Bot + any successor | n/a | One consolidated permissions role. Holds MENTION_EVERYONE **as a technical requirement** (see gotcha below), constrained in code, never used for @everyone. |
| **@Draft Night** *(optional)* | self-assign, zero permissions, mentionable | anyone | Purely a mention target for the in-person crew. Exists solely to delete a documented manual workaround: *"OK getting a private thread for the group that is keeping the very fabric of the league alive and well"* + five hand-typed mentions (2026-05-22). Cut it if four roles feels like one too many. |

### Deliberately NOT created: @Alumni

P2 and P3 both proposed an @Alumni role for the ~8 non-franchise members. **It is redundant and it has a real social cost.** If @Owner exists and is the ping target, non-owners simply do not hold @Owner — no second role is needed to exclude them. Creating @Alumni converts an invisible 12-of-20 split into a colored, hoisted second class inside a friend group that has run since 2012. P2 conceded *"some of the eight will notice."* Skip it; get the identical notification outcome for free.

### Also deliberately NOT created at launch: @On The Clock / @In The Auction

Both losers proposed a self-assign auction role. Judge 3's counter is correct and decisive: **partial uptake on a self-assign role means the server's single best conversation surface reaches fewer phones than it does today** (Josh Allen lot: 71 msgs / 57 human; CMC 35 / 26). The ping-ladder fix below (per-lot events ping only the affected owners; @Owner gets one nomination-window ping and one final-hour ping per day) cuts 33 mass-pings to roughly two role pings per day plus targeted DMs-by-mention, without betting on adoption. Add an opt-in role later only if @Owner volume proves intolerable.

### The MENTION_EVERYONE gotcha (state this to Keith before he sees it in the audit log)

Discord requires the **MENTION_EVERYONE** permission to ping a role whose "Allow anyone to @mention" toggle is off. So @League Bot must hold MENTION_EVERYONE in order to ping @Owner at all. **The guard is in code, not in permissions:** every send site passes an explicit `allowed_mentions` allowlist. The good pattern already exists in this codebase — `auction_nudge.js:667` sends `{parse: [], users: mentionIds}`. The bad pattern is the auction win post, which sends `parse: ["everyone"]`. Make the good pattern a grep-able invariant: **`parse: ["everyone"]` must appear at zero send sites.**

### Bot role audit (do this while you are in there)

All 8 current roles are bots and several are dead integrations still holding server-wide send rights. Verify then **remove**: `LeagueHubBot2` (2023-era transactions feed, superseded by the current bot), `slack_download` (one-time import, complete), `DiceParser` (no evidence of use in any corpus), the 4for4 RSS feed (~360 posts 2024-08-26→2024-10-12, drew exactly **one** human message in the channel's entire life), and the now-`Deleted User` poll bot whose orphaned embeds are all that survives of the 2024 vote record. Stripping channel access is not enough; a dead integration holding send rights is a live permission surface.

---

## 4. Full channel disposition map (all 27)

The measured server shape confirms that every channel **not** individually named below has **under 60 messages**. They are covered by the default rule at the bottom, and that rule is safe precisely because none of them carry meaningful history.

| Existing channel | ID | Disposition |
|---|---|---|
| the-coffee-shop | 1087157907419840644 | **KEEP** — unchanged, same ID |
| on-the-sofa | 1291737646665699420 | **KEEP** — unchanged, same ID |
| Voice & Video Hangout | 1057655884936925228 | **KEEP** — + voice-join notice |
| transactions | 1059111651846131833 | **RENAME → #the-wire** (same ID) |
| league-announcements | 1057657441011109898 | **RENAME → #from-the-commish** (same ID) |
| rules-discussion | 1066399931574779914 | **RENAME → #rulebook** (same ID) |
| website_bugs | 1481001757667754014 | **RENAME → #help-desk** (same ID); re-permission to member-postable |
| keiths-test | 1089538054236160010 | **KEEP** (same ID); VIEW_CHANNEL denied to @everyone |
| slack-history | 1063835430878969886 | **KEEP → #slack-archive**, locked, moved to THE VAULT. Rebuild deferred (§6) |
| contract-activity | 1059113303059730494 | **KEEP-LOCKED → #contract-activity-archive.** Do **NOT** delete — hardcoded fallback at `index.js:27418` and `index.js:38855`. Delete decision revisited post-July-2027 |
| cap-penalty-announcements | 1066390675207233618 | **MERGE INTO #the-wire.** Export → Vault post → delete |
| otb | 1277369023880757412 | **MERGE INTO #the-wire.** The 2024 4for4 RSS era (~360 bot posts, one human reply ever) is dropped, not migrated. Export → Vault post → delete |
| contract-links | 1091737155111497768 | **MERGE INTO #the-vault.** Declared dead 2024-07-24 and *still receiving real contract submissions 13 months later* — proof that deprecating by announcement does not work. Export → Vault post → delete |
| league-voting | 1066400287864131734 | **MERGE INTO #the-vault.** Dead since 2024-02-28; orphaned embeds from a now-deleted bot. Export → Vault post → delete |
| rules-important-links | 1066388928254459965 | **MERGE INTO #rulebook** as pinned. Retires the OneDrive .docx marked "Updated for '24" and the separate Superflex Google Doc. Delete |
| roster-analysis | 1057658732596690965 | **DELETE** after export (2 posts pointing at retired Google Sheets) |
| league_history | 1089383338919350322 | **MERGE INTO #the-vault.** Includes the Richard & Nieber Dismissal thread — the one good migration precedent in the server and the mandatory template. Delete after |
| new_prospective_owners | 1276508920814370898 | **MERGE INTO #the-vault** (the onboarding assessment template is genuinely strong and reusable). Delete after |
| private_league_discussion | 1267959349641478155 | **MERGE INTO #the-vault.** Delete after |
| this-day-in-history | 1311457324816273479 | **CONVERT TO A CRON-POSTED PINNED THREAD in #the-coffee-shop.** 58 msgs, 100% commish, high reply rate, dormant since 2026-02-08. The `#tdis` hashtag on the first post (2024-11-27) signals a series Keith intended and never automated. It needs a cron, not a channel. Export → delete channel |
| test_audio | 1376227231495622695 | **DELETE.** A test surface sitting in a member-visible category |
| **All remaining channels (each under 60 messages)** | — | **DEFAULT RULE:** if it has no active send site → export to repo, one Vault post if the content is worth reading, delete. If it has an active send site → set read-only with a pinned redirect and leave it in place until the send site is repointed *and* any hardcoded literal naming it is changed. **Never delete before both.** |

**Sequencing law (this is the league's own `rule_no_fail_open_guards` applied to Discord):** export → repoint env var → change the hardcoded literal → verify → *then* delete. An unreadable or missing channel target is never "post it somewhere"; it is a refusal plus an alert.

---

## 5. Automated send-site map

### Unchanged — the channel is renamed underneath them, zero config change

| Send site | Resolves to |
|---|---|
| `DISCORD_AUCTION_CHANNEL_ID` | `1059111651846131833` → **#the-wire** |
| `DISCORD_DRAFT_CHANNEL_ID` | `1059111651846131833` → **#the-wire** |
| `DISCORD_PICKS_THREAD_PARENT_CHANNEL_ID` | `1059111651846131833` → **#the-wire** |
| `DISCORD_DROPS_CHANNEL_ID` | `1059111651846131833` → **#the-wire** |
| `DISCORD_RULES_CHANNEL_ID` (12 refs, most interconnected subsystem in the bot) | `1066399931574779914` → **#rulebook** |
| `DISCORD_BUG_CHANNEL_ID` | `1481001757667754014` → **#help-desk** |
| All `DISCORD_*_TEST_CHANNEL_ID` + `OTB_TEST_CHANNEL_ID` | `1089538054236160010` → **#keiths-test** |
| `DISCORD_DM_USER_IDS`; `trade_dm.js`, `trade_dm_cadence.js`, `trade_sentinel.js` DM cadence; non-voter DM nudges | DMs — unaffected |

### Repointed (env var only)

| Send site | New destination |
|---|---|
| `DISCORD_CONTRACT_CHANNEL_ID` / `DISCORD_CONTRACTS_CHANNEL_ID` (all `DISCORD_ROUTING_DEFAULTS` keys: extension, restructure, tag, mym, myac/FA) | **#the-wire** `1059111651846131833` — **only after** `index.js:27418` and `index.js:38855` are fixed |
| `DISCORD_CAP_PENALTY_CHANNEL_ID` | **#the-wire** |
| `OTB_CHANNEL_ID` (`postOtbDiscord`, `index.js:12736`) | **#the-wire** — and changed from "new post per edit" to "post into the franchise's existing standing thread" |
| `traderoast` routing key (currently `test` after the 2026-06-01 incident) | **#the-wire** |
| `ADD_TRACKER_DISCORD_TARGET` (currently `test`) | **#the-wire** |
| **`DISCORD_REMINDER_CHANNEL_ID`** — *the single most important repoint* | **#from-the-commish** `1057657441011109898`. It currently hardcode-defaults to `1087157907419840644` — **the coffee shop** (`index.js:29134`). Every deadline reminder fires into the social room by design |

### Set for the first time

| Var | Destination | Why |
|---|---|---|
| `DISCORD_ANNOUNCE_CHANNEL_ID` | `1057657441011109898` → **#from-the-commish** | Currently falls back to the rules channel, which is why five "Rule PASSED" one-liners landed as bare pointers |
| `DISCORD_HALL_CHANNEL_ID` | `1066399931574779914` → **#rulebook** | Currently falls back to REMINDER (= the coffee shop). Hall decision items (🟦 FYI / 🟥 Vote required / 🟨 Sentiment check) are governance, not announcements |
| **`DISCORD_COMPLIANCE_CHANNEL_ID`** *(new var)* | `1059111651846131833` → **#the-wire** | Splits the 9:30 PM nightly out-of-compliance report **off** `DISCORD_REMINDER_CHANNEL_ID`. 365 posts/year would bury the ~53 real announcements. This is P2's fact/consequence line implemented as one env var instead of a second channel: **the nightly report states your state (fact, #the-wire); a deadline with a penalty is a directive (#from-the-commish).** Never let a consequence render as a fact |
| **`DISCORD_OWNER_ROLE_ID`** *(new var)* | the @Owner role ID | Required for `allowed_mentions.roles` |
| **`DISCORD_STATUS_CHANNEL_ID`** *(new var)* | `1481001757667754014` → **#help-desk** | `ups_bot_heartbeat` state changes, auction-poll stall alerts, env-config-audit `silent_fallback` warnings (`index.js:18226-18280` — the mechanism that let `DISCORD_DROPS_CHANNEL_ID` sit unset for months) |

### Code changes required (Wave 0 — none of this is optional)

1. **`index.js:27418` and `index.js:38855`** — hardcoded `1059113303059730494` contract fallback. Change to fail-closed: refuse the send, alert @Commish in #help-desk. Do not substitute a default destination.
2. **`index.js:29134`** — hardcoded `1087157907419840644` reminder fallback → `1057657441011109898`, then fail-closed.
3. **`index.js:11312` / `11313`** — hardcoded `1498680803419357234` as the live rookie-draft channel fallback. **That channel ID does not exist in the guild.** It is an orphan *today*. Fail-closed.
4. **`index.js:11321`** — hardcoded `1059111651846131833` (still valid, becomes #the-wire). Convert to fail-closed for consistency.
5. **Role-mention plumbing.** `<@&{DISCORD_OWNER_ROLE_ID}>` in message bodies + `allowed_mentions: {parse: [], roles: [OWNER_ROLE_ID], users: [...]}` at every send site. **This is the largest single line item and it is unbuilt in all three proposals.** Budget it honestly.
6. **`parse: ["everyone"]` deleted from every send site**, starting with the auction win post (33 of 33 win posts currently open `@EVERYONE @everyone`).
7. **Threading is end-to-end or it fails loudly.** Once channel posting is locked, a bot post that fails to open a thread is read-only and silences the league — this already happened live: *"Sorry Rybo, this isn't a thread that you could reply into. I didn't give you a chance to offer a rebuttal. I just realize this now."* (ups_commish, 2026-07-19T13:12). Every send site must create its thread, retry once, then post a failure line into #help-desk and ping @Commish. The existing self-heal path (`index.js:2676-2890`, anchor rebuild at `:2839`/`:2842`) and `createStandaloneThread` (`index.js:4411`) already do this for auctions — generalize them.
8. **Pinned-message edit** for the League Calendar (`PATCH /channels/{id}/messages/{mid}`).

**What is NOT required: any forum work.** Every automated destination in this design is a text channel. `createStandaloneThread`'s `type:11` payload and the message-anchor pattern at six call sites both keep working untouched. That helper is the auction self-heal net that was needed live on 5 lots during the 2026 FAA, and it runs on a Cloudflare Free plan with a 10ms CPU budget that has already produced an `exceededCpu` crash mid-narration. This design does not go near it.

**What is NOT required: any new slash commands.** P2 needed ~9 and conceded *"Absent that discipline, nothing here holds."* P1 needed 2 (`/propose`, `/ask`). This design needs **zero** — #help-desk absorbs both intake paths as plain posts. Slash commands remain a nice-to-have power path, never a dependency.

---

## 6. Thread policy

**The thread is the record. The channel is only a notification surface.**

1. **One transaction = one thread.** Never multi-transaction. Eight contracts in one message (rybo4591, 2025-09-01T03:20) and nine in another (shawnblake, 2025-08-31T13:04) are unprocessable and uncountable, and this exact defect produced the corpus's only confirmed ledger corruption: two MYMs in one chat message made the commissioner miscount and then publicly correct himself five days later — *"correction the answer is that it was your 3rd since you entered Wentz & Deshon Elliot in the same message"* (2025-12-20T15:02).
2. **The first message IS the card.** No empty leading bot post (30+ occurrences today). The thread starter carries the full self-describing payload — owner, player, terms, timestamp, amount — written so it survives being ripped out of Discord with zero metadata. The Slack migration proved that is the only content that survives a platform move.
3. **Title schema:** `YYYY-MM-DD · TYPE · Subject — STATE`. Examples: `2026-07-25 · Auction · Josh Allen (QB BUF) — SOLD $88K`; `2026-08-02 · Ruling · Cap reversal (18 contracts) — CLOSED`; `2026-05-08 · Rule · Salary Depreciation — PASSED`. This is the tag system, in the one place Discord always renders and always searches — and it works in text channels, which forum tags do not. Fixes two threads both titled "Rookie Draft", two titled "Welcome", and *"Somehow couldn't find the auction history posts"* (shawnblake, 2026-07-30).
4. **Terminal state, always.** The bot renames on resolution. Promote Keith's **73 contentless acknowledgement messages** into an explicit thread state (SUBMITTED → PROCESSED) carrying the computed counter he currently keeps in his head — "Restructure 1 of 3", "MYM 2 of 4", "max restructures hit", "Zaire would be your 7th 3yr deal". A blank message must never again carry meaning only by scroll position.
5. **Every thread ends in plain text.** Any vote, button flow, poll or interactive widget **must** terminate in a plain-text result post naming the outcome and the voters. The Slack migration preserved 24 "This polly is closed" stubs and 16 "Your results are in!" stubs with the question *and* the result both destroyed. This is a live threat to the current button-based rule voting. Two related mandatory fixes: the canon card must print the **final** tally, not the count frozen at verdict-lock (cards currently read "7–0–0" while the tally block in the same thread reads "Yes (10)"), and "Item 1 of ?" must print the real count.
6. **Thread ≠ notification.** Three separate owners across three separate years reported never seeing a thread — *"Yeah I didn't even know this thread existed. Hence why I was nominating"* (papabear4110, 2023-08-08); *"Wonder how many of us know this is here"* (sexmanther, 2024-03-12); *"Hmm somehow missed it"* (shawnblake, 2026-04-07). **The parent card always posts at channel level, and anything with a deadline or a penalty pings @Owner at channel level, not inside the thread.**
7. **Ping ladder.** @everyone: @Commish only, #from-the-commish only, ~4–6 times a year (matching actual observed use). @Owner: nomination window open (once per day), final hour (once per day), deadline T-24h and T-1h, rule round open, vote closing, season bookends. Direct @user: rulings, penalties, compliance, outbid, win, trade parties. **Nothing else pings — and per-lot auction events never ping @Owner.**
8. **No thread for uncontested lots.** Thread on the **2nd bid or $5K, whichever comes first**; everything below rolls into one daily **Lot Digest** thread. 18 of 40 sampled auction threads drew zero human replies; Ryan Eckley took 70h34m and 3 bids to produce two human lines, one of which was *"Cunts."*
9. **Same batching rule for drops.** One post per franchise per waiver run, never one per player. The 2023 firehose fired 13 separate DROP lines in a single minute.
10. **Archive, never delete.** Auto-archive 7 days on #the-wire and #from-the-commish. Archived threads stay searchable. The "2023 Mangina Championship" thread was still being posted into 343 days later; "2025 Tagging Values" 257 days later.
11. **OTB is one standing thread per franchise, and the OWNER writes in it.** The bot opens twelve threads at season open (`Trade Block · Blake Bombers`); the owner posts his list into his own thread using SEND_MESSAGES_IN_THREADS; the bot renames the thread with `— updated YYYY-MM-DD`. This adopts judge 3's instinct (posting your block is a social act; it should feel like posting, not filing) inside the permission model, and it kills the Blake Bombers bug — 6 near-identical announcements and 6 empty threads in ten days.
12. **Roast posts only after trade-direction validation passes**, append into the trade's existing thread rather than becoming a separate object, and cap the rebuttal chain at 3 exchanges with a cooldown. The bot inverted trade direction twice (`2026-07-18T12:22` "CORRECTION — I ran this trade backwards"; `2026-05-25T12:24` "I misread the direction and roasted the WINNER for winning") and one chain ran 21 messages before *"Keith. It's off the rails!"* Keep the clap-back button — humans use it more than native replies (20 relayed vs ~6 native across 5 threads).

---

## 7. History conversion — the honest answer to Keith's second question

**Mostly you should not convert anything, and that is the good news.**

- **Discord history in kept channels (the-coffee-shop, transactions, league-announcements, rules-discussion, contract-activity, slack-history, on-the-sofa, keiths-test, website_bugs): DO NOT re-post.** Renaming and re-permissioning preserves everything for free — every message keeps its real author, its real timestamp, and its permalink. Nine of the eleven channels in this design are existing channels kept by ID. The 2025 Slack import is the cautionary tale: re-posting **re-authored 7,183 messages to a bot** and collapsed every timestamp into one 3h51m window. An index that points at real messages beats a copy that destroys them.
- **Channels being deleted (all under 60 messages, plus league_history and contract-links):** export to the repo first (JSON + markdown), then one curated, attributed, **locked** Vault post per unit — using the format Keith invented himself: attribution carried *inside* the message body as `**Author (orig date):**`, exactly as he did for the 2018 Nieber war on 2025-08-17, which the league read and replied to seven years after the fact. Delete only after the export is verified and every hardcoded literal has moved.
- **The Slack corpus is the ONLY thing worth rebuilding, because it is the only part that is already broken.** 7,183 bot-authored messages, all timestamps in one 3h51m window, 352 unresolved raw `<@U…>` tokens across 17 accounts, 620 join/lifecycle noise messages (8.2%) arriving as an 11-to-12-message wall at the top of every thread, 375 empty poll/file shells, and the polls channel imported **three times** (41/80/80, two byte-identical). Rebuild rules, all derived from that failure: idempotent (run marker + content-hash dedupe); noise-filtered; **Slack-ID→Discord map that HARD FAILS on an unmapped ID** rather than emitting the raw token; author + original ISO timestamp written in-body; empty shells replaced by a counted footer ("N attachments did not survive migration"); posted as a completed, locked thread rather than a live typing session (*"jesus ryan can you let me post"*, 2025-08-17). **This is a project, not a channel decision. #slack-archive stays exactly as it is until the rebuild ships. The redesign does not block on it and does not pretend to solve it.**
- **Do NOT bulk-convert coffee-shop history into threads.** 11,652 messages, aggressively NSFW, zero retrieval value, and a real risk of promoting locker-room content into an authoritative-looking format.

**Season retirement (P3's one genuinely best-in-class idea, kept as a ritual instead of a taxonomy).** Each December, one bot-written **SEASON SEALED** post goes into #the-vault: champion, payout ledger, message and thread counts, date range, and a permalink index into that season's threads. Threads auto-archive; nothing moves; every permalink resolves. **Critically, this is an annual nicety, not a structural dependency** — if Keith skips it in year two, nothing breaks and no channel is half-rotated. That is exactly why P3 was rejected and this version is kept.

---

## 8. Day in the life

### Scenario A — a trade posts

1. Trade executes in MFL / Front Office. `trade_sentinel.js` / `trade_3way.js` detects it.
2. Bot posts **one self-describing card at channel level in #the-wire**: both franchises, every player and pick, cap deltas, date. It immediately calls `createThreadOnMessage` on that message. Thread title: `2026-09-14 · Trade · Bombers ↔ HammerTime (3 players, 2 picks)`. **No empty leading message.**
3. `allowed_mentions: {parse: [], users: [both owner IDs]}`. No @everyone. No @Owner — a two-team trade is not league business with a deadline.
4. Trade Roast runs **after** direction validation passes and appends **into the same thread**. The clap-back button lives there. Rebuttal chain capped at 3 exchanges, then cooldown.
5. Any of the 20 members can reply in the thread — reply latency in this league is currently sub-10-minutes and it is the healthiest behavior in the entire corpus. **Nobody can start a new top-level post in #the-wire.**
6. Wrong grade? The correction posts in the same thread and the title gets ` — CORRECTED` appended. The commissioner's public self-correction habit — *"yes...commish fucked up here"* (2024-09-12), *"just posting for transparency"* (2025-10-14) — is load-bearing to league trust and stays first-class.
7. Thread auto-archives at 7 days, still searchable.
8. **Failure path:** if thread creation fails, the bot retries once, then posts a state line into #help-desk and pings @Commish. It does **not** leave a silent orphan card that nobody can reply to.

### Scenario B — the commish announces the auction date

1. Keith types a plain message in **#from-the-commish** — the only channel where he holds MENTION_EVERYONE. **No slash command.** He does not have to change how he writes.
2. A pinned template (not a command) asks for the shape he already uses naturally: title, effective date + **exact clock time + timezone**, who it applies to, the consequence, the rationale. His 2023-07-29 auction post is already exactly this shape.
3. The bot auto-opens the discussion thread: `2027-07-20 · Announcement · FA Auction opens Sat 7/24 2:00 PM ET`. Members reply in the thread. Nobody posts at channel level.
4. The deadline cron **edits the pinned League Calendar message in place** to add the row, and schedules T-24h and T-1h reminders that post at channel level pinging **@Owner**.
5. **He does not cross-link into the coffee shop.** He does not need to — @Owner reached the 12 people it applies to on their phones. The 16 bare `discord.com/channels` permalinks he dropped into the social scroll in ten months (escalating from 3 in Nov 2025–Feb 2026 to 13 in Mar–Aug 2026) disappear, because that behavior was the measurable symptom of the structure failing.
6. @everyone stays available to him here for the 4–6 real broadcasts a year — and it stops being typed twice, because the mention now actually works. All four of his real broadcasts in eleven months are typed `@EVERYONE @everyone` because the first token is dead text and there was no role to address.
7. Nobody re-derives the mechanics in chat this year: *"I assume 7 start?"*, *"1 nom today correct?"*, *"remind me what the minimum cap number was to exit auction"* all have a pinned, dated, timezone-stamped answer.

### Scenario C — a member wants to complain about scoring

Two shapes, both handled by the same door.

**Shape 1 — a rules/scoring question** (*"Points for 1st downs not a thing anymore?"* 2025-09-05; *"No points for a blocked field goal?"* 2025-09-28):
1. He posts in **#help-desk**. He can — it is one of three channels in the server where a member can start a message, and it needs no slash command.
2. Keith or the bot answers in the thread. Thread gets a terminal state: `RESOLVED`.
3. If the answer is canon, Keith promotes it into **#rulebook** as a titled thread. This is the direct fix for *"While I can't find the exact verbiage in the rulebook"* (2025-12-25) — a commissioner resolving a live Christmas Day dispute by citing a two-year-old Discord message because his own rulebook failed.
4. The third time someone asks the live-scoring cache question (asked 2024-12-02, 2025-09-07, 2025-09-12 with the same answer every time), it is a search in #help-desk that hits the first two threads.

**Shape 2 — a scoring bug** (*"Defensive Pick 6 for this guy is counting twice"*, 2025-09-09):
1. Same channel, same intake. Ticket carries OPEN → RESOLVED.
2. The resolution posts **in-thread as plain text**, not as an image attachment in a chat scroll — which is how the 2026-08-02 cap-corruption incident was actually closed, six hours after five owners reported it, with *"List of players impacted and reverted back is attached"* as a JPEG in the social room.
3. Keith actively wants this traffic — *"Keep them coming though. I want to find as many glitches as possible now"* (2026-03-11). It just needs a state.

**What he cannot do:** start a top-level post in #the-wire, #from-the-commish or #rulebook. **What nothing stops him from doing:** complaining in the coffee shop anyway. The coffee shop is unmoderated by design and that is not changing. The difference is that Keith now answers with a link to a #help-desk thread instead of answering inline, and after a season the muscle memory moves. **This is the one behavior the architecture cannot enforce, only make easier — say so out loud rather than pretending otherwise.**

---

## 9. Rollout, with a stop condition

| Wave | Contents | Precondition |
|---|---|---|
| **0 — code** | Role-mention plumbing + `allowed_mentions` allowlists at every send site; fail-closed the four hardcoded literals (`27418`, `38855`, `29134`, `11312/11313`); new env vars; pinned-calendar edit; bot state-change posting; threading fail-closed path | none |
| **1 — roles + mentions, zero channel change** | Create @Commish / @Owner / @League Bot; assign @Commish to **both** Keith accounts; revoke MENTION_EVERYONE from @everyone at guild level; repoint `DISCORD_REMINDER_CHANNEL_ID` off the coffee shop; set `ANNOUNCE`, `HALL`, `COMPLIANCE`, `STATUS`. Audit and remove dead bot roles | Wave 0 shipped |
| **2 — the lock** | Guild baseline flip (SEND / CREATE_THREADS denied) + the four channel exceptions | **#help-desk exists, is member-postable, and has been announced as the degraded-mode path.** Non-negotiable gate |
| **3 — renames + categories + merges** | Rename the five channels; create the four categories; lock the dead ones with pinned redirects; batch drops; digest rule for uncontested lots; OTB standing threads | Wave 2 stable for 2 weeks |
| **4 — archive, rolling** | Export → Vault posts → deletes; season-sealed ritual; Slack rebuild if and when someone wants to do it | Wave 3; every literal repointed |

**Timing.** Never ship Wave 2 between July 1 and August 15 (contract deadline + FA auction) or within 48 hours of cutdown day. The 2026 auction closed ~August 5, so Waves 0–1 can go now and Wave 2 can go in the August–September pre-Week-1 window; the Feb–March dead zone (Feb 2026 = 88 msgs, Apr 2026 = 76) is the fallback.

**Stop condition — measure this, do not eyeball it.** Contract-post reply latency is currently sub-10-minutes and is the single healthiest behavior in the corpus. Track it, plus human replies per #the-wire thread, for four weeks after Wave 2. **If reply latency degrades materially, unwind the lock. Do not push on.** The thing being protected is more valuable than the thing being built.

---

## 10. Real tradeoffs, and what Keith may dislike

Honest, not salesy. Every one of these is a genuine cost.

1. **Role-mention plumbing is unbuilt code, and the notification model does not work on day one.** `grep '<@&'` returns zero hits; `allowed_mentions` has never been passed a `roles` array. This is the largest engineering line item in the redesign, it is unavoidable in **any** of the three designs, and none of them budgeted for it. Until it ships, "@Owner replaces @everyone" is a diagram, not a behavior.

2. **Keith loses his routing escape hatch.** He currently hand-routes by typing *"post in contract activity"* (2025-08-30) and *"whomever is giving extension post in Contract Activity"* (2025-11-12). After this, there is nowhere to route **to** — every transactional surface is bot-originated. #help-desk is the replacement, and it is a downgrade in his control. He will notice the first time he wants to tell someone to put something somewhere.

3. **#the-wire will feel like an auction firehose for about ten days each August.** With the digest rule live it is roughly half of today's card volume, and the rational member response is still to mute it — in a server where three owners across three separate years are on record saying they never saw a thread. The mitigation is that muting #the-wire during the auction costs you transaction *color*, not *deadlines* — deadlines live in #from-the-commish and ping @Owner. But he should be told in advance rather than discovering it on August 3.

4. **Rulings share a channel with deadlines, release notes and season bookends.** The title schema plus a pinned Precedent Index makes them greppable, but this is genuinely weaker than a dedicated #rulings surface, and both losing proposals wanted one. It is a deliberate bet against a channel that would receive ~30 posts a year. If a season of use proves the interleaving unbrowsable, split it — cheap, commish-authored, no env vars.

5. **`this-day-in-history` loses its channel.** It becomes a cron-posted pinned thread in the coffee shop. It is 100% commish-authored with a high reply rate and it is the natural consumer of the archive; a thread in an 11,652-message room is a demotion. The bet is that a **cron** keeps it alive where a channel did not (dormant since 2026-02-08). If the cron never gets written, this is a straight loss.

6. **Revoking MENTION_EVERYONE strips a permission all 20 members currently hold.** The real cost is approximately zero — only Keith has ever used it, four times in eleven months — but it is a **visible removal of a right** in a league whose commissioner is deliberately and permanently roastable (*"Sounds like a me rule"*). Announce it as a phone-notification fix, lead with what members gain, and never frame it as discipline.

7. **@Owner is 12 people; the server is 20.** Eight members stop receiving league-business pings. That is correct — they hold no franchise and cannot act on a cap deadline — but at least one will read it as being pushed out. Not creating @Alumni keeps it invisible rather than colored, which is the better version of a bad option, but it does not make the gap disappear.

8. **The tier separation is only as real as Keith's own posting habits.** He is the loudest voice in the social room *and* the only authority. Nothing in this design stops him from issuing a ruling in the coffee shop — he holds MANAGE permissions everywhere. What it does is remove the eight-slash-command dependency P2 needed and reduce the ask to **one behavior change: rulings go in #from-the-commish.** That is a realistic ask. Eight was not.

9. **The Slack archive stays broken.** 7,578 messages, bot-authored, timestamps collapsed, 352 raw IDs, triple-imported polls. This design **defers** the rebuild rather than solving it, on the reasoning that indexing real messages beats re-posting them and the Slack corpus is the only part already destroyed. That is the right call and it is still an open project sitting in the sidebar.

10. **Some permalinks die.** Every high-traffic channel is kept by ID, and `contract-activity` is kept-locked rather than deleted precisely so its 1,084 messages stay linkable. But the sub-60-message channels being deleted (`roster-analysis`, `league-voting`, `contract-links`, `league_history`, `new_prospective_owners`, `private_league_discussion`, `rules-important-links`, `test_audio`, and the unnamed remainder) take their permalinks with them. Export first; accept the loss knowingly.

11. **Muting is still unsolved and no architecture fixes it.** A member who mutes the entire server misses deadlines regardless — and muting is already a known league state (*"Gerardi, this'll teach you not to mute our Discord"*, rybo4591, 2026-03-12). @Owner pings plus banning @everyone from the coffee shop make muting *survivable* for the first time, but only for someone who mutes the channel rather than the server.

12. **Members will still DM Keith.** *"That's why I'm always texting Keith for clarification"* (papabear4110, 2024-09-17). Bear routes trades to DMs by preference. Trade bait already leaks to group SMS. Structure reduces this; it does not end it.

13. **Cross-season querying gets no better and no worse.** *"Who's been on the board the longest over the years"* (sexmanther, 2026-07-29) is a D1 question, not a Discord search. This design deliberately does **not** try to make Discord the query layer — that is what killed P3.

14. **This design does less than the runners-up on purpose.** No forums on live send paths, no slash-command suite, no annual rollover, no phase gating, no seasonal roles, no permission crons. Every one of those was a genuinely good idea that a judge killed for the same reason: it puts load on the most fragile machinery in the system (a Cloudflare Free worker with a 10ms CPU budget that has already crashed mid-auction-narration) or on the commissioner's memory in March. **The thing this architecture is optimized for is surviving six months of Keith going quiet with nothing degrading.** If he wants more, every addition here is additive and cheap — a #rulings split, an opt-in auction role, a #the-floor carve-out, slash commands. None of them require redoing this.

---

# PART II — # MIGRATION PLAN — UPS Dynasty FFL Discord

## 0. THE ONE FACT THAT DECIDES EVERYTHING

`POST /channels/{cid}/messages/{mid}/threads` creates a thread **on** a message. It does **not** move any other message **into** that thread. There is no endpoint that relocates a message — `channel_id` is not editable, and that applies to moving a message into a thread just as much as into another channel.

So the literal answer to Keith's question — *"can we group messages from the past into threads as they should be?"* — is **NO**. You can create the labeled container retroactively; you cannot put the historical conversation inside it. The conversation stays exactly where it is, in the channel body, and the new thread sits above it empty.

I measured what that would actually produce against the full local dump (31,817 messages, `/private/tmp/claude-501/.../scratchpad/dump/`):

**In `#transactions` (4,886 top-level msgs, 3,872 bot / 1,014 human):**
- Only **471 of 3,872 bot posts (12.2%)** were followed by any human message within 60 minutes.
- Retro-threading the bot backlog therefore creates **~3,400 permanently empty threads** to hold zero messages, plus 471 threads that would *also* be empty because the replies can't be moved.
- **4,610 of 4,886** messages are currently unthreaded. Auto-threading only began 2026-05 (22 threaded in May, 14 in June, 207 in July, 33 in Aug).

The content that *should* be grouped is real and is exactly what Keith describes — it just isn't movable:

> **2023-04-08 18:18** `LeagueHubBot2` posts a trade →
> **18:45** `sexmanther`: "whata. baby dick deal" (2 reactions) →
> **18:47** `whitman8352`: "I won't argue with you. You are the expert of young penis in this league" →
> **18:49** `rybo4591`: "Oh my" *(native reply)*

> **2023-10-06 15:16** `LeagueHubBot2`: "**HammerTime Tradebait**" →
> **15:38** `cutting4987` *(native reply)*: "If I knew you were giving away Herbert I would have been all over him" →
> **16:11** `emart7733`: "That return gave me ED"

Threading that bot post in 2026 produces an empty thread named "Trade …" sitting on top of six loose roast messages. Strictly worse than doing nothing.

---

## 1. IN-PLACE vs RE-POST — capability ledger

**Lossless, in place, safe:**
| Operation | Endpoint | Applies to |
|---|---|---|
| Create thread on existing message (no age limit) | `POST /channels/{cid}/messages/{mid}/threads` | any non-forum message |
| Rename a thread after creation | `PATCH /channels/{thread_id}` | any thread |
| Move channel between categories | `PATCH /channels/{cid}` `parent_id` | all 19 text channels |
| Rename channel / set topic | `PATCH /channels/{cid}` (throttled ~2 edits/10min/channel) | all |
| Flip who can post / create threads | `PUT /channels/{cid}/permissions/{oid}` | all |
| Pin a message | `PUT /channels/{cid}/pins/{mid}` | all |

**Requires re-posting, and therefore destroys fidelity:**
- Getting any *existing human message* into a thread.
- Getting any message into a different channel.
- Consolidating two channels into one.

**Fidelity-loss surface across the whole server if anything is re-posted** (measured):
- **3,350 messages carry reactions** — a bot can only re-react as itself; reactor identities and counts are gone.
- **3,017 messages are native replies** (`message_reference`) — Execute Webhook has **no** `message_reference` param; every one flattens.
- **1,144 attachment files across 965 messages** — every CDN URL sampled is signed and expiring (`ex=`/`is=`/`hm=`); bytes must be downloaded and re-uploaded inside the signature window, and every URL changes.
- **Every timestamp** — Execute Webhook has no timestamp param. Full stop.

**Structurally impossible at any price:** move a message; reparent a thread (`thread.id == message.id`, verified live: msg `1534530397378056204` → thread `1534530397378056204` "Drop · Daiyan Henley"); convert text→forum; convert text→announcement (guild features are `['CHANNEL_ICON_EMOJIS_GENERATED','SOUNDBOARD','TIERLESS_BOOSTING_SYSTEM_MESSAGE']` — no `COMMUNITY`, no `NEWS`).

---

## 2. TIERED RECOMMENDATION — justified by measured reference frequency

I counted every in-server permalink (`discord.com/channels/…`) posted anywhere in the corpus. **130 total over 3.5 years.** Rolled up to the channel being *linked to*:

| Target of link | Count |
|---|---|
| `league-announcements` threads | 64 |
| `rules-discussion` threads | 25 |
| `keiths-test` threads | 11 |
| `league-announcements` (channel) | 6 |
| `the-coffee-shop` | 5 |
| `contract-activity` | 4 |
| `league_history` / `new_prospective_owners` / `cap-penalty-announcements` threads | 6 |
| **`transactions` (4,886 msgs)** | **0** |
| **`slack-history` (7,578 msgs)** | **1** |

**89 of 130 references (68%) point at `league-announcements` + `rules-discussion` threads.** Transactional history is written once and referred back to literally never. That is the entire justification for the tiers below.

### TIER A — LEAVE COMPLETELY ALONE (≈24,000 msgs, 75% of corpus)
`the-coffee-shop` (11,652), `transactions` backlog (4,610 unthreaded), `keiths-test` (1,754 + 367 in 90 threads), `on-the-sofa` (142), `otb` (371), `this-day-in-history` (58).

Justification: zero permalinks into transactions; the coffee shop is the *referrer* (68 of the 130 links were posted **from** it) not the referent; `keiths-test` is 1,674/1,754 bot output with **0 reactions on any message**. No migration, no threading, no deletion. Touch only the container.

### TIER B — FREEZE READ-ONLY IN PLACE, MOVE TO ARCHIVE CATEGORY (no content edits)
Last activity (channel + its threads):

```
(never)     private_league_discussion    0
2023-05-18  roster-analysis              2 (+3 threads)
2024-02-28  league-voting               13 (+6)
2024-08-31  new_prospective_owners       1 (+31)
2025-01-02  slack-history               15 (+7,578)
2025-08-18  league_history               2 (+37)
2025-08-23  contract-links              21 (+44)
2025-12-25  rules-important-links        2 (+6)
2026-02-08  this-day-in-history         58
2026-03-15  website_bugs                 3 (+5)
2026-04-17  cap-penalty-announcements   16 (+30)
```
**11 of 19 text channels have been dead for 4+ months; 8 for a year or more.** Revoke `SEND_MESSAGES` + `SEND_MESSAGES_IN_THREADS`, keep `VIEW_CHANNEL`, move under `archived_channels`. This is the fix for the documented failure mode:

> **2024-07-24 10:47** `upscommish`: "will move this over to correct thread. But just for awareness…form is dead see post"
> **2024-07-30 07:31** `rybo4591`: "Please set Evan Engram's contract at 2 years...8/18."
> **2024-07-30 09:59** `emart7733`: "Wrong thread again haha"
> **2025-08-22 23:50** `cutting4987`: "Restructure Chris Olave year 1 51k, year 2 11k."

Thirteen months of real contract submissions into a channel declared dead. Announcements don't deprecate; **locks do**.

### TIER C — HAND-CURATE, ~20–40 MESSAGES TOTAL (the only content worth "migrating")
The governance record that (a) people actually link to and (b) currently lives in the wrong place. Concretely: the ~24 commish `@everyone` posts sitting in `the-coffee-shop`. Most are already just pointers —

> **2025-08-02 21:53** `ups_commish`: "@everyone - Not everyone was at the Rookie Draft or on the Discord Call. We did discuss an important league matter on QB Limits and there was an amendment to the current rule… See link for more details" + permalink

— so the record already lives in `league-announcements`. Only a handful are *standalone* authoritative content (e.g. **2025-02-18 23:04** "MFL has been upgraded for 2025. I've pushed rosters forward and updated their contracts", **2025-07-28 11:04** the 3-point auction deadline post, 4 reactions).

**Do not re-post these.** Write a single curated index post in `league-announcements` that *links* to each one, using the `league_history` format that demonstrably works:

> **2025-08-17 13:54** `ups_commish`: `**Aj Balderelli (Dec 9, 2018, 4:41 PM):** We offered multiple picks and players…`

Attribution inside the body, original date inside the body, link to the original. Zero data touched.

### TIER D — NEVER RE-MIGRATE
`slack-history`. It is already the worst-case outcome and re-running any import against it makes it worse (the import was non-idempotent — "Official League Polls Thread" exists **three times** at 41/80/80 messages, two byte-identical). It gets 1 permalink out of 7,578 messages. Freeze it, prefix the channel name, and never touch it again.

---

## 3. THE SLACK-IMPORT FAILURE MODE — the specific things not to repeat

The 2025-01-02 import is the control experiment. What it destroyed, and the rule each failure generates:

| Damage observed | Rule for any future migration |
|---|---|
| 7,183 of 7,593 messages authored by "UPS Contracts Hub Bot"; every human author gone | **Never migrate where the importing bot becomes author of record.** If you must re-post, write `**Name (date, time):**` as the first line of the body — the 2023 `slack_download` format `5/6/2021 3:40 PM - Josh Martel: Let's get the trade talks going!` survived perfectly and is machine-parseable today |
| All 7,183 embeds stamped `2025-01-02` within a 3h51m window; grep for any `m/d/yyyy` in the 2025 League News import returns **zero** hits | **The date must be written into the body.** Discord will always stamp the import time. You cannot ask this archive "when did the league decide X" |
| 352 raw `<@U…>` tokens across 17 Slack accounts, rendered as dead text | Apply a Slack-ID → Discord-member map before writing, and **fail loudly on an unmapped ID** rather than emitting the raw token (this is the same fail-open pattern as the contract incidents) |
| 620 noise messages (8.2%): 179 "has joined the channel", 5 channel-lifecycle events, 25 calendar bookkeeping, 19 empty summaries — concentrated as an **11–12 message wall at the top of every thread** | Filter lifecycle events before writing. The first screen decides whether anyone reads the second |
| 375 empty shells: 183 empty embeds, 146 "This content can't be displayed", 46 poll stubs. 24 × "This polly is closed… has a polly for you!" with no question; 16 × "Your results are in! 🎉" with no results | **Interactive widgets are not a record.** The archive preserves *that* a vote happened and destroys *what it decided*. This is a live threat to the current button-based rule-proposal voting — every vote must terminate in a plain-text result post like Keith's own: "The poll on League Dues increase to $200 was approved 10 to 2 meeting the 75% requirement" |
| Non-idempotent: polls channel imported 3×, League News 2× (241 of 256 bodies overlap between the attributed 2023 run and the unattributed 2025 run); 615+ redundant copies | Any script needs a run marker + dedupe key + dry-run. Nobody noticed the tripling for 19 months |
| Field-level silent loss: every 2023-dated cap-penalty record has an empty `Team - ` field; some nominations carry the bid in the Player field ("New Nomination: C-Town Chivalry / Player: 1000") | A migration that renders missing data as normal-looking output is a **fail-open archive** |

The single most damning artifact: the Violations Thread is a ~100-message governance argument containing an actual proposal — *"Keith, name a league czar to monitor all the violations shit"* — and the author is unrecoverable. In a league whose entire culture is named-personality roasting, de-attributed content is not degraded, it is **worthless**.

---

## 4. RUNBOOK — sequenced, with estimates

**Phase 0 — Backup (DONE, re-verify before any write).** 31,817 messages / 17 MB already at `/private/tmp/claude-501/-Users-keithcreelman-Code-MFL-upsmflproduction--claude-worktrees-discord-channel-redesign-7d228c/1336c348-abcc-4609-a349-1202413590ea/scratchpad/dump/`. Move this out of scratchpad into the repo or durable storage **before** any mutation. Re-running costs ~20 min (5 GET/sec/channel bucket, measured: `x-ratelimit-bucket f9f85e747f3e8c1f8f7728d616c030bf`, `limit=5`, `reset-after=1.000`). Note: attachment *bytes* are NOT backed up — 1,144 signed CDN URLs will expire. If archival matters, download them now.

**Phase 1 — Roles (5 min, ~25 API calls, fully reversible).** Create `@Owner` (all 20) and `@Commish`. Clear `MENTION_EVERYONE` from `@everyone` at guild base level and from the overwrites in `transactions`, `contract-activity`, `league-announcements`. Currently there are **8 roles and all 8 are bots** — the commish has to hand-paste 10 raw user IDs to notify the league, and it still fails:
> **2024-08-31 10:58** `shawnblake`: "doesn't look everyone is a part of this thread so may miss this"

Thread-first architecture has a hard dependency on a mentionable human role. Do this first or the rest doesn't land.

**Phase 2 — Permissions (5 min, ~12 API calls, fully reversible).** Copy the `#transactions` overwrite verbatim onto `#contract-activity`: remove `SEND_MESSAGES`, keep `SEND_MESSAGES_IN_THREADS`, keep `CREATE_PUBLIC_THREADS`/`CREATE_PRIVATE_THREADS` denied.

Evidence this works: `#transactions` was locked ~2026-07-14. July 2026 = 271 bot / **57 human**. August 2026 = 34 bot / **0 human**.

But note the *other* half of the diagnosis — `#contract-activity` is 73% chatter partly because **the bot went silent**: zero bot messages from 2025-07 through 2026-02 while humans posted 308 (149 in 2025-08 alone). `#transactions` shows the same inversion in 2026-03/04 (1 bot / 7 human, then 4 bot / 33 human). **A bot-only channel becomes a chat channel the moment the feed dies** unless permissions prevent it. Fix both.

**Phase 3 — Containers (30–60 min, ~40 API calls, fully reversible).** Move the 11 Tier-B channels under `archived_channels` and revoke send. Rename with a legible convention. `parent_id`/`position` edits are fast; **name/topic edits are throttled ~2 per 10 min per channel**, but the bucket is per-channel so 11 renames run in parallel in one pass. Do NOT use "sync permissions to category" blindly — `private_league_discussion` carries 12 hand-tuned overwrites, `keiths-test` 6, `transactions` 4, `contract-activity` 4.

**Phase 4 — Index posts (60–90 min of writing, ~10 API calls).** One pinned "what goes where / where everything is" post per surviving channel, linking the ~40 threads people actually reference. This is the whole Tier-C migration.

**Phase 5 — Retro-threading (OPTIONAL, and I recommend skipping it entirely).** If Keith insists after seeing §0: cap it at **≤200 hand-picked messages**, never a bulk run. Constraints: ~1 POST/sec ⇒ 4,610 messages ≈ 77 min of API time, but the guild is at **309 active threads against a ~1,000 cap**, so a bulk run must batch ~500 at a time with `auto_archive_duration=60` and wait for archival — days of babysitting, to produce ~3,400 empty threads and 20 members' thread-browsers flooded with new entries.

Global limits to honor throughout: 50 req/s/bot ceiling; **10,000 invalid requests (401/403/429) per 10 minutes triggers a Cloudflare IP ban** — honor `Retry-After`, read `X-RateLimit-Bucket/Remaining/Reset-After`, never hardcode.

**Total for Phases 1–4: one afternoon, ~90 API calls, zero data risk, fully reversible.**

---

## 5. "DELETE THE OLD MESSAGES AFTERWARD?" — NO. Do not delete anything.

Decisive, four reasons:

1. **The math is absurd.** Bulk-delete hard-refuses anything >14 days old (error `50034`); the corpus spans 2023-01-01 to now, so effectively **0%** qualifies. Fallback is one DELETE per message: 26,000 messages at an optimistic 1/sec = **7.2 hours**; at the observed 4–6s throttle on aged messages = **~36 hours** unattended.
2. **It is the only irreversible operation in this entire plan.** Everything else — renames, moves, permission flips, category redesign — is undoable in seconds.
3. **It buys nothing Keith wants.** His stated goals are containment and legibility. Deleting messages in a channel nobody opens improves neither. Deleting a *channel* is one instant call; moving and locking it is one instant call and destroys nothing. There is no scenario in this redesign where per-message deletion is the right tool.
4. **The precedent argues the other way.** The one piece of migrated history the league genuinely engaged with was 7-year-old material:
> **2025-08-17 13:53** `rybo4591`: "Well, there goes the rest of my Sunday" → `ups_commish`: "jesus ryan can you let me post" → `rybo4591`: "Nope. I'm faster than automation still."

Old junk has near-zero carrying cost. Deleted junk is gone.

**The one narrow exception:** the ~615 provably duplicate `slack-history` messages (the two byte-identical 80-message poll copies and the 241 overlapping League News bodies). Even here — do **not** delete. Rename the duplicate threads to `[DUPLICATE — see …]` and archive them. A rename is reversible; a delete is not.

---

## 6. THE 80/20 — DO THIS ONE THING

**Reorganize the containers, not the content: move the 11 dead channels into a locked `archived_channels` category, strip `SEND_MESSAGES` from `#contract-activity`, and create the `@Owner`/`@Commish` roles.**

~90 API calls. One afternoon. Zero irreversible operations. Not one message is copied, moved, edited or deleted.

Why this is 80% of the *perceived* benefit: what a member experiences as sprawl is the sidebar and the "where does this go" ambiguity — not the contents of a 2023 scrollback nobody opens. Eleven of nineteen text channels are dead, and the league has been asking the routing question out loud for years:

> **2023-04-27 14:00** `sexmanther`: "post Tagged players here?"
> **2024-07-04 14:43** `emart7733`: "We posting BL etc in discord?"

Two owners, 15 months apart, in the same channel. And Keith has been fighting this since Slack in 2021 — *"To keep the Channels clean, please keep reply to original message to ensure the message is captured within the thread as opposed to creating a new message as a reply"* — which is a five-year-old **unenforced norm**. Structure is currently implemented as commish labor ("will move this over to correct thread"). Permissions convert that labor into architecture.

Meanwhile the target state already exists in two places and needs nothing done to it: `#league-announcements` is **52 of 53 top-level messages threaded, 0 bot messages, 2,149 messages living inside 55 threads** (top: "2023 New Owner Dispersal Draft Discussion" 419, "2026 UPS Rookie Draft" 248, "Free Agent Auction" 215). `#transactions` since 2026-05 is producing exactly the shape Keith described — "Auction · Josh Allen (QB · BUF)" 71 msgs, "Trade Roast — The Long Haulers ↔ L.A. Looks" 21 msgs. **The forward-looking problem is already solved.** The backlog is not a problem worth solving; it's a problem worth freezing.

---

## IRREVERSIBLE — FLAGGED

1. **Message deletion.** No undo, no undelete, 8–36 hours to execute. Recommendation: never.
2. **Thread creation is one-shot per message, forever.** `thread.id == message.id`, so a message can carry exactly one thread ever. A botched bulk retro-thread run with bad auto-generated names permanently consumes that slot on 4,610 messages. The thread can be *renamed*, but a second thread can never be created. Any retro-threading must be dry-run and name-reviewed first.
3. **Channel deletion** takes all its threads and messages with it in one instant call. Move-and-lock instead.
4. **Attachment bytes.** 1,144 files behind signed expiring URLs. Not backed up today. If they matter, download before anything else — expiry is a clock already running.
5. **Enabling Community** (the only route to forum channels) forces verification level MEDIUM+, explicit content filter on, and designated Rules + Community Updates channels, server-wide. Don't — §9 of the capability audit proves plain text channels already deliver the exact behavior, and `#transactions` is the working proof.
6. **Any re-post run** is irreversible in the sense that the fidelity (timestamp, author, reactions, reply graph) cannot be recovered afterward even if you delete the copies — 3,350 reaction-bearing and 3,017 reply-bearing messages are the exposure.