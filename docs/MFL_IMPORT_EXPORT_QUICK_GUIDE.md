# MFL Import/Export Quick Guide (UPS)

Source: https://www48.myfantasyleague.com/2026/api_info?STATE=details&L=74598
Snapshot captured: 2026-02-18 01:08 UTC

## URL formats

- Export: `https://{host}/{season}/export?TYPE={type}&{args}`
- Import: `https://{host}/{season}/import?TYPE={type}&{args}`
- Misc: `https://{host}/{season}/{command}?{args}`

## Required baseline params

- `L` league id for league-scoped requests
- `TYPE` request type for import/export
- `JSON=1` for JSON exports (default is XML if omitted)

## Auth and access

- Most private league exports require owner cookie (`MFL_USER_ID`).
- Commissioner-only imports require commissioner cookie.
- Some export endpoints can use `APIKEY` as alternate auth.
- Use HTTPS for all auth calls and any call with credentials.

## Export request types (58)

| TYPE | What it returns | Key args |
|---|---|---|
| `league` | General league setup parameters for a given league, including: league name, roster size, IR/TS size, starting and ending week, starting lineup requ... | L |
| `rules` | League scoring rules for a given league. To understand the scoring rule abbreviations in this document, see the allRules document type above. | L |
| `rosters` | The current rosters for all franchises in a league, including player status (active roster, IR, TS), as well as all salary/contract information for... | L, FRANCHISE, W |
| `freeAgents` | Fantasy free agents for a given league. Private league access restricted to league owners. | L, POSITION |
| `schedule` | The fantasy schedule for a given league/week. Weeks in the past will show the score of each matchup. Private league access restricted to league own... | L, W, F |
| `calendar` | Returns a summary of the league calendar events. Access restricted to league owners. | L |
| `playoffBrackets` | All playoff brackets for a given league. Private league access restricted to league owners. | L |
| `playoffBracket` | Returns the games (with results if available) of the specified playoff bracket. Private league access restricted to league owners. | L, BRACKET_ID |
| `transactions` | All non-pending transactions for a given league. Note that this can be a very large set, so it's recommended that you filter the result using one o... | L, W, TRANS_TYPE, FRANCHISE, DAYS, COUNT |
| `pendingWaivers` | Pending waivers that the current franchise has submitted, but have not yet been processed. Access restricted to league owners. | L, FRANCHISE_ID |
| `pendingTrades` | Pending trades that the current franchise has offered to other franchises, or has been offered to by other franchises. Access restricted to league ... | L, FRANCHISE_ID |
| `tradeBait` | The Trade Bait for all franchises in a league. Private league access restricted to league owners. | L, INCLUDE_DRAFT_PICKS |
| `assets` | All tradable assets (players, current year draft picks, future draft picks) for a given league. Access restricted to league owners. | L |
| `leagueStandings` | The current league standings for a given league. The fields returned for each franchise match the columns included in the league standings report. ... | L, COLUMN_NAMES, ALL, WEB |
| `weeklyResults` | The weekly results for a given league/week, including the scores for all starter and non-starter players for all franchises in a league. The "W" pa... | L, W, MISSING_AS_BYE |
| `liveScoring` | Live scoring for a given league and week, including each franchise's current score, how many game seconds remaining that franchise has, players who... | L, W, DETAILS |
| `playerScores` | All player scores for a given league/week, including all rostered players as well as all free agents. Private league access restricted to league ow... | L, W, YEAR, PLAYERS, POSITION, STATUS |
| `projectedScores` | Given a player ID, calculate the expected fantasy points, using that league's scoring system. The system will use the raw stats that fantasysharks.... | L, W, PLAYERS, POSITION, STATUS, COUNT |
| `draftResults` | Draft results for a given league. Note that this data may be up to 15 minutes delayed as it is meant to display draft results after a draft is comp... | L |
| `auctionResults` | Auction results for a given league. Private league access restricted to league owners. | L |
| `selectedKeepers` | Currently selected keepers. Returns only own's franchise keepers. For commissioner returns all franchises unless Lockout is on. Private league acce... | L, FRANCHISE |
| `myDraftList` | My Draft List for the current franchise. Access restricted to league owners. | L |
| `messageBoard` | Display a summary of the recent message board posts to a league message board. Access restricted to league owners. | L, COUNT |
| `messageBoardThread` | Display posts in a thread from a league message board. Access restricted to league owners. | L, THREAD |
| `polls` | All current league polls with details as to which polls the current franchise voted on. Access restricted to league owners. | L |
| `device_tokens` | Returns the device tokens for the current user. | Varies |
| `playerRosterStatus` | Get the player's current roster status. The franchise(s) the player is on are listed in the subelement. There may more than one of this for leagues... | L, P, W, F |
| `contestPlayers` | On Contest Leagues, this returns all players eligible to be in a franchise's starting lineup. While this request can be used by any league it's bes... | L, W, F |
| `myWatchList` | My Watch List for the current franchise. Access restricted to league owners. | L |
| `salaries` | The current player salaries and contract fields. Only players with values are returned. If a value is empty it means that the default value is in e... | L |
| `salaryAdjustments` | All extra salary adjustments for a given league. Private league access restricted to league owners. | L |
| `futureDraftPicks` | Future draft picks for a given league. Private league access restricted to league owners. | L |
| `accounting` | Returns a summary of the league accounting records. In the response, negative amounts are charges against the franchise while positive amounts is m... | L |
| `pool` | All NFL or fantasy pool picks for a given league. Private league access restricted to league owners. | L, POOLTYPE |
| `survivorPool` | All survivor pool picks for a given league. Private league access restricted to league owners. | L |
| `abilities` | Returns the abilities of the current franchise. A value of 0 means the franchise does not have the ability and a value of 1 means it has the abilit... | L, F, DETAILS |
| `appearance` | The skin, home page tabs, and modules within each tab set up by the commissioner for a given league. | L |
| `rss` | An RSS feed of key league data for a given league, including: league standings, current week's live scoring, last week's fantasy results, and the f... | L |
| `ics` | Returns a summary of the league calendar in .ics format, which is suitable for importing into many modern calendaring programs, like Apple's Calend... | L |
| `myleagues` | All of the leagues of the current user. Private league access restricted to league owners. Personal user information, like name and email addresses... | YEAR, FRANCHISE_NAMES |
| `leagueSearch` | Searches for leagues in our database that match either the given league id or whose name matches the specified string. Either the SEARCH or ID para... | SEARCH, ID, YEAR |
| `players` | All player IDs, names and positions that MyFantasyLeague.com has in our database for the current year. All other data types refer only to player ID... | L, DETAILS, SINCE, PLAYERS |
| `playerProfile` | Returns a summary of information regarding a player, including DOB, ADP ranking, height/weight. | P |
| `allRules` | All scoring rules that MyFantasyLeague.com currently supports, including: if the rule is scored for players, teams or coaches, as well as an abbrev... | Varies |
| `playerRanks` | This report provides overall player rankings from the experts at FantasySharks.com. These rankings can be used instead of Average Draft Position (A... | POS, SOURCE |
| `adp` | ADP results, including when the result were last updated, how many drafts the player was selected in, the average pick, minimum pick and maximum pick. | PERIOD, FCOUNT, IS_PPR, IS_KEEPER, IS_MOCK, CUTOFF |
| `aav` | AAV results, including when the result were last updated, how many auctions the player was selected in and the average auction value. Average aucti... | PERIOD, IS_PPR, IS_KEEPER |
| `topAdds` | The most added players across all MyFantasyLeague.com-hosted leagues during the current week (or the past 7 days during the pre-season), as well as... | COUNT, STATUS |
| `topDrops` | The most dropped players across all MyFantasyLeague.com-hosted leagues during the current week (or the past 7 days during the pre-season), as well ... | COUNT, STATUS |
| `topStarters` | The most started players across all MyFantasyLeague.com-hosted leagues for the current week, as well as the percentage of leagues that they've been... | COUNT, STATUS |
| `topTrades` | The most traded players across all MyFantasyLeague.com-hosted leagues in the current week (or past 7 days during the pre-season), as well as the pe... | COUNT |
| `topOwns` | The most owned players across all MyFantasyLeague.com-hosted leagues, as well as the percentage of leagues that they're owned in. Only players that... | COUNT, STATUS |
| `siteNews` | An RSS feed of MyFantayLeague.com site news. | Varies |
| `whoShouldIStart` | Site-wide 'Who Should I Start?' data - offering a comparison between any two players at the same position, letting you know what percent of all MFL... | L, WEEK, FRANCHISE, PLAYERS |
| `injuries` | The player ID, status (IR, Out, Doubtful, Questionable, Inactive, etc.) and details (i.e., 'Knee', 'Foot', 'Ribs', etc.) of all players on the NFL ... | W |
| `nflSchedule` | The NFL schedule for one week of the season, including the scheduled kickoff of the game, home team (and their score), the away team (and their sco... | W |
| `nflByeWeeks` | The bye weeks for every NFL team. | W |
| `pointsAllowed` | Fantasy points allowed by each NFL team, broken out by position. | L |

## Import request types (27)

| TYPE | What it imports | Key args |
|---|---|---|
| `lineup` | Import a franchise's starting lineup. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter. | L, W, STARTERS, COMMENTS, TIEBREAKERS, BACKUPS, FRANCHISE_ID |
| `franchises` | Loads franchise names, graphics, contact information, and more. Access Restricted: Requires cookie from league commissioner. | L, DATA, OVERLAY |
| `calendarEvent` | Import an event to a league calendar. Access Restricted: Requires cookie from league commissioner. | L, EVENT_TYPE, START_TIME, END_TIME, HAPPENS |
| `fcfsWaiver` | Import an add/drop move that will be executed immediately (also known as a first-come, first-serve move). You may also use this call to drop multip... | L, ADD, DROP, FRANCHISE_ID |
| `waiverRequest` | Import one round's worth of waiver requests. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter. | L, ROUND, PICKS, REPLACE, FRANCHISE_ID |
| `blindBidWaiverRequest` | Import blind bidding waiver requests. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter. | L, ROUND, PICKS, REPLACE, FRANCHISE_ID |
| `ir` | Import an IR (activate/deactivate) move. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter. | L, ACTIVATE, DEACTIVATE, DROP, FRANCHISE_ID |
| `taxi_squad` | Import a Taxi Squad (promote/demote) move. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter. | L, PROMOTE, DEMOTE, DROP, FRANCHISE_ID |
| `tradeProposal` | Propose a trade to another franchise. The WILL_GIVE_UP and WILL_RECEIVE parameters can also contain draft picks if the league allows draft pick tra... | L, OFFEREDTO, WILL_GIVE_UP, WILL_RECEIVE, COMMENTS, EXPIRES, FRANCHISE_ID |
| `tradeResponse` | Respond to an existing trade offer. See the tradeProposal request above for info regarding draft pick trading. Access restricted to league owners. ... | L, TRADE_ID, RESPONSE, COMMENTS, FRANCHISE_ID |
| `tradeBait` | Import an owner's trade bait, which will overwrite his previously entered trade bait. Access restricted to league owners. | L, WILL_GIVE_UP, IN_EXCHANGE_FOR |
| `draftResults` | Loads draft order and actual draft results. All previously existing draft results will be completely deleted from the system when importing draft r... | L, DATA |
| `auctionResults` | Auction results. This is meant to be used to load the results of an offline draft all at once, not to implement a live draft application. An additi... | L, DATA, CLEAR, OVERWRITE |
| `myDraftList` | Set the players in an owner's My Draft List. This will completely overwrite an owners previous My Draft List. Access restricted to league owners. | L, PLAYERS |
| `messageBoard` | Start a message board thread or reply to an existing message board thread. Access restricted to league owners. Commissioner can impersonate owner u... | L, FRANCHISE_ID, THREAD, SUBJECT, BODY |
| `pollVote` | Import a vote in a league poll. Access restricted to league owners. | L, POLL_ID, ANSWER_ID |
| `emailMessage` | Send an email message to one or all the owners in the league. Access restricted to league owners. | L, SEND_TO, SUBJECT, BODY, INVITE |
| `add_device_token` | Registers a device token for the given user. Used to send notifications via a mobile app. Accessed restricted to logged in users. | TOKEN, NAME, DELETE |
| `salaries` | XML string representing the player salaries. The format for this data is <salaries> <leagueUnit unit="LEAGUE"> <player id="9823" salary="11" contra... | L, DATA, APPEND |
| `salaryAdj` | XML string representing the salary adjustments. The format for this data is <salary_adjustments> <salary_adjustment franchise_id="0001" amount="5.7... | L, DATA |
| `playerScoreAdjustment` | Import one player score adjustment record. Access Restricted: Requires cookie from league commissioner. | L, PLAYER, WEEK, POINTS, EXPLANATION |
| `keepers` | Import an owner's keeper selections. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter. | L, KEEP, FRANCHISE_ID |
| `myWatchList` | Update the players in an owner's My Watch List. Access restricted to league owners. | L, ADD, REMOVE |
| `accounting` | Import one accounting record. Access Restricted: Requires cookie from league commissioner. | L, FRANCHISE, AMOUNT, DESCRIPTION |
| `franchiseScoreAdjustment` | Import one franchise score adjustment record. Access Restricted: Requires cookie from league commissioner. | L, FRANCHISE, WEEK, POINTS, EXPLANATION |
| `poolPicks` | Make an NFL or Fantasy pool pick. To send the actual picks you need to pass a number of PICK and RANK parameters. These have names like PICKDAL,NYG... | L, POOLTYPE, PICK, RANK, WEEK, FRANCHISE_ID |
| `survivorPoolPick` | Import a survivor pool pick. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter. | L, PICK, FRANCHISE_ID |

## Most useful extraction endpoints (typical analytics pipeline)

- `league`, `rules`, `players`, `rosters`, `salaries`
- `schedule`, `leagueStandings`, `weeklyResults`, `playerScores`
- `draftResults`, `auctionResults`, `transactions`, `futureDraftPicks`
- `salaryAdjustments`, `nflSchedule`, `nflByeWeeks`, `injuries`

## Common extraction examples

- `https://www48.myfantasyleague.com/2026/export?TYPE=league&L=74598&JSON=1`
- `https://www48.myfantasyleague.com/2026/export?TYPE=rosters&L=74598&W=1&JSON=1`
- `https://www48.myfantasyleague.com/2026/export?TYPE=salaries&L=74598&JSON=1`
- `https://www48.myfantasyleague.com/2026/export?TYPE=leagueStandings&L=74598&ALL=1&JSON=1`
- `https://www48.myfantasyleague.com/2026/export?TYPE=playerScores&L=74598&W=1&JSON=1`
