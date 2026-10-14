# UPS Center broadcast mode: proof of concept

**Status:** draft for Keith's review (2026-10-14). Stacked on draft #1244 (Week 5). Not merged, published or deployed.

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
| Standalone page / Claude Artifact | Full: fixed switch, remembered choice (localStorage) | Playwright Chromium 1280 px and WebKit with iPhone emulation at 375 and 320 px: 66 of 66 checks (`docs/wire/2026-wk05/build/bcast_check.js`) |
| Inside MFL (sandboxed frame) | A switch in every segment label, because a fixed control cannot follow the reader in an auto-sized frame. The choice lasts for the page view. | macOS Safari 26.5.2 in a framed page: module runs, no errors, no audio before a tap, and a scripted click leaves audio "interrupted", never running |
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
