# UPS Center broadcast mode: proof of concept

**Status:** CLOSED (2026-10-14). Keith's ruling:
- Week 5 stays silent.
- Use only those two exact clips. No generic or generated music, no separate YouTube play buttons, no ads, and no change to the MFL sandbox.
- No embedding, downloading, extracting or rehosting of the clips.
- Audio is tracked as a future enhancement that needs licensed local files for the two transitions.

The YouTube check page was removed. The findings below are the record.

Earlier status:
- Keith rejected the synthesized cues (clinks, stings, closing music).
- He asked for two YouTube excerpts instead. They cannot be embedded reliably where the league reads the issue (see "YouTube excerpts" below), so per his instruction that work stopped at the findings.
- Nothing here is merged, published or deployed.

## What a reader gets

1. **▶ Start UPS Center** under the dek. Tapping it plays the opening cue and runs a short title transition (scale plus a light sweep). The page then moves to The Big Story and lights Stuart's and Rich's first lines in turn.
2. **Segment cues, once each.**
   - The Playoff Picture and Heat Check get a sting.
   - Boomer's first highlight gets a fast hi-hat and blip run into a hit.
   - The first chat receipt Kenny reads in a segment gets a cup clink and a falling third.
   - The sign-off gets the closing theme.

   Cues fire when their spot comes on screen. Scrolling back never replays one, and a cue reached while muted is spent silently.
3. **A sound switch that stays on screen** (bottom right) once the show starts. A caption chip names each cue as it plays, so the report works with sound off.
4. **The choice is remembered.** After a reload, Start returns and nothing plays until the reader taps again; browsers require that.
5. **Audio stops** when the tab is hidden or the page is left. The issue never waits on audio.

## Audio rights: the two lawful options

| | Option 1: Keith supplies licensed audio | Option 2: original UPS Center stingers |
|---|---|---|
| **What** | Recordings Keith has written permission to use: commissioned, or royalty-free under a license that allows web use | Cues composed for UPS Center: no copied melody, no sampled recording, no imitation of a real announcer's voice |
| **This preview** | Not used | **Used:** temporary originals, synthesized in the page and labeled "temporary original cues" on screen |
| **Not allowed** | ESPN's SportsCenter theme, Chris Berman's highlight music, or any audio pulled from YouTube. They are copyrighted, and YouTube's terms forbid downloading. | The same |
| **To finish** | Keith provides the files and the license. Each cue name (opening, boomer, transition, kenny, closing) can take a file instead of the synthesized version. | Keep the synthesized cues, or commission five 1–3 second stingers |

The current cues are original material:
- a stepwise rising stab figure over a drum fill (opening);
- a hi-hat and blip run into one hit (Boomer);
- a whoosh and tom pickup (sting);
- a cup clink and a falling minor third (Kenny);
- the opening figure turned downward into a long chord (closing).

## Where it runs and what is verified

| Surface | Behavior | Verified |
|---|---|---|
| Standalone page / Claude Artifact | Full: fixed switch, remembered choice (localStorage) | Playwright Chromium 1280 px and WebKit with iPhone emulation at 375 and 320 px, plus a framed Artifact-style page: 72 of 72 checks (`docs/wire/2026-wk05/build/bcast_check.js`) |
| Inside MFL (sandboxed frame; detected by the loader's `UPS_WIRE_ROUTE`, as the runtime does) | A switch in every segment label, because a fixed control cannot follow the reader in an auto-sized frame. The choice lasts for the page view. Playwright WebKit with the route set: 9 label switches, inline dock. | macOS Safari 26.5.2 in a framed page: module runs, no errors, no audio before a tap, and a scripted click leaves audio "interrupted", never running |
| Real iPhone Safari | Should match WebKit | **Not verified here** (no iOS Simulator on this Mac). Keith's phone test is the check. |

**iPhone note:** with the ringer switch on silent, iOS mutes web audio by design. The cues then show only as captions, which is the intended fallback.

**MFL follow-up (not built):** remembering the choice inside MFL needs about 10 lines in `mfl_hpm_embed_loader.js`. The frame already posts `{type: "wire-pref", key: "sound"}`; the loader would store it and inject `UPS_WIRE_PREFS` into the next article. That is a header-side change for a separate PR.

## How to apply it to an issue

```bash
python pipelines/etl/wire/wire.py broadcast --article 2026-wk05-ups-center --transition odds,heat --closing survival
python pipelines/etl/wire/wire.py restyle
python pipelines/etl/wire/wire.py index
python pipelines/etl/wire/wire.py verify
```


## YouTube excerpts: findings (2026-10-14)

Keith asked for two YouTube clips, using YouTube's visible player, with nothing downloaded or rehosted:
- the SportsCenter opening, `LBkoVMYrzho`;
- Chris Berman's Fastest Three Minutes entrance, `_qqFKcRcyJA`.

He set one condition first: stop if either cannot be embedded reliably.

| Question | Finding |
|---|---|
| Uploader allows embedding? | **Yes, both.** oEmbed answers, and the player reports `playableInEmbed: true`. Both are **fan uploads of ESPN broadcasts**, not ESPN's channel ("Sir Mix-A-Lot Rare Music"; "Pro Football Daily"), so either can disappear or be blocked at any time. |
| Excerpt timing (provisional, picked by picture; Keith confirms by ear) | **Opening 0:00–0:45:** the open runs to the ESPN SportsCenter logo; anchors appear by 0:46. **Boomer 0:14–0:23:** Berman's toss to the "Fastest 3 Minutes" graphic and the first matchup card; NFL game footage starts about 0:23. |
| Claude Artifact | **No.** The Artifact viewer blocks every external frame, YouTube included. |
| Standalone UPS Wire page (Pages) | **Yes, with a tap on the player.** In Chrome, a tap on the page's own Start button started the clip on one host and was blocked on another (htmlpreview, a site the browser had no history with). A tap on YouTube's own play button always works. |
| MFL frame | **No.** The loader sandboxes every article (`allow-scripts allow-popups allow-popups-to-escape-sandbox`, no same-origin access). Inside that sandbox the YouTube player stays black and ignores taps, in both Chromium and WebKit; the same embed outside the sandbox works. Fixing it means either giving articles same-origin access, which the loader forbids for security, or hosting the player in the MFL page itself through a loader change. |
| iPhone Safari, second clip without a new tap | **Not verified here** (no iOS Simulator on this Mac). WebKit requires a tap inside the player's own frame for sound, so on iPhone the Boomer clip very likely needs its own tap. |
| Ads and overlays | **The opening video is monetized**: its player data lists ad placements, so a pre-roll ad can play before the theme. **Overlays damage both clips:** <br>- From about 0:42 the uploader's end-screen card (an unrelated "Apple iPhone 4 Antennagate" video) covers the opening, inside the excerpt.<br>- YouTube shows its title bar, "More videos" and, on the Boomer clip, auto-captions. |

**Check page (removed at closing):** `docs/wire/youtube-embed-check.html` was a test page, never deployed. It lets Keith:
- hear both excerpts on his phone and adjust start and stop;
- see whether the Boomer clip starts without a second tap;
- see the MFL-sandbox failure.

**Long-term options (Keith's call):**
1. Keith provides licensed audio files.
2. Original UPS Center music.
3. A loader change that hosts a YouTube player in the MFL page, outside the article sandbox. This is technically possible but keeps the ad, overlay and fan-upload risks.
