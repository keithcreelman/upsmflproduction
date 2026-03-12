# MFL Import/Export Detailed Reference (UPS)

Source: https://www48.myfantasyleague.com/2026/api_info?STATE=details&L=74598
Snapshot captured: 2026-02-18 01:08 UTC

This file expands each request type with purpose and arguments as listed by MFL API details.

## Global notes

- Export base: `https://{host}/{season}/export?TYPE=...`
- Import base: `https://{host}/{season}/import?TYPE=...`
- For import calls, many types require `DATA` XML payload.
- If import `APPEND`/`OVERLAY` is omitted where supported, full replace/erase behavior may happen.
- Auth/access rules vary by type; follow per-type notes from MFL.

## Export types (58)

### `league`

General league setup parameters for a given league, including: league name, roster size, IR/TS size, starting and ending week, starting lineup requirements, franchise names, division names, and more. If you pass the cookie of a user with commissioner access, it will return otherwise private owner information, like owner names, email addresses, etc. Personal user information, like name and email addresses only returned to league owners.

Arguments:

- `L`: League Id(required)

### `rules`

League scoring rules for a given league. To understand the scoring rule abbreviations in this document, see the allRules document type above.

Arguments:

- `L`: League Id(required)

### `rosters`

The current rosters for all franchises in a league, including player status (active roster, IR, TS), as well as all salary/contract information for that player.

Arguments:

- `L`: League Id(required)
- `FRANCHISE`: When set, the response will include the current roster of just the specified franchise.
- `W`: If the week is specified, it returns the roster for that week. The week must be less than or equal to the upcoming week. Changes to salary and contract info is not tracked so those fields (if used) always show the current values.

### `freeAgents`

Fantasy free agents for a given league. Private league access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `POSITION`: Return only players from this position.

### `schedule`

The fantasy schedule for a given league/week. Weeks in the past will show the score of each matchup. Private league access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `W`: Week. If a week is specified, it returns the fantasy schedule for that week, otherwise the full schedule is returned.
- `F`: Franchise ID. If a franchise id is specified, the schedule for just that franchise is returned.

### `calendar`

Returns a summary of the league calendar events. Access restricted to league owners.

Arguments:

- `L`: League Id(required)

### `playoffBrackets`

All playoff brackets for a given league. Private league access restricted to league owners.

Arguments:

- `L`: League Id(required)

### `playoffBracket`

Returns the games (with results if available) of the specified playoff bracket. Private league access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `BRACKET_ID`: The bracket id to return the info

### `transactions`

All non-pending transactions for a given league. Note that this can be a very large set, so it's recommended that you filter the result using one or more of the available parameters. If the request comes from an owner in the league, it will return the pending transactions for that owner's franchise. If it comes from the commissioner, it will return all pending transactions. Private league access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `W`: If the week is specified, it returns the transactions for that week.
- `TRANS_TYPE`: Returns only transactions of the specified type. Types are: WAIVER, BBID_WAIVER, FREE_AGENT, WAIVER_REQUEST, BBID_WAIVER_REQUEST, TRADE, IR, TAXI, AUCTION_INIT, AUCTION_BID, AUCTION_WON, SURVIVOR_PICK, POOL_PICK. You may also specify a value of * to indicate all transaction types or DEFAULT for the default transaction type set. Or you can ask for multiple types by separating them with commas.
- `FRANCHISE`: When set, returns just the transactions for the specified franchise.
- `DAYS`: When set, returns just the transactions for the number of days specified by this parameter.
- `COUNT`: Restricts the results to just this many entries. Note than when this field is specified, only transactions from the most common types are returned.

### `pendingWaivers`

Pending waivers that the current franchise has submitted, but have not yet been processed. Access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `FRANCHISE_ID`: When request comes from the league commissioner, this indicates which franchise they want.

### `pendingTrades`

Pending trades that the current franchise has offered to other franchises, or has been offered to by other franchises. Access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `FRANCHISE_ID`: When request comes from the league commissioner, this indicates which franchise they want. Pass in '0000' to get trades pending commissioner action).

### `tradeBait`

The Trade Bait for all franchises in a league. Private league access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `INCLUDE_DRAFT_PICKS`: When set, this will also return draft picks offered. Current year draft picks look like DP_02_05 which refers to the 3rd round 6th pick (the round and pick values in the string are one less than the actual round/pick). For future years picks, they are identified like FP_0005_2018_2 where 0005 referes to the franchise id who originally owns the draft pick, then the year and then the round (in this case the rounds are the actual rounds, not one less). This also includes Blind Bid dollars (in leagues that use them), which will be specified as BB_10 to indicate $10 in blind bid dollars.

### `assets`

All tradable assets (players, current year draft picks, future draft picks) for a given league. Access restricted to league owners.

Arguments:

- `L`: League Id(required)

### `leagueStandings`

The current league standings for a given league. The fields returned for each franchise match the columns included in the league standings report. Private league access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `COLUMN_NAMES`: When set to a non-zero value, returns a mapping of column keys to column names. This also shows the proper order of the standings columns.
- `ALL`: When set to a non-zero value, returns additional standings field values that are not part of the league standings report but are important for sorting league standings. Note that some of these extra fields may not be relevant for all leagues and may include duplicate info from the basic set.
- `WEB`: When set to a non-zero value, returns the columns shown on the web site only. This is in case the app wants to just replicate the report from the web site. This parameter is ignored if ALL is set.

### `weeklyResults`

The weekly results for a given league/week, including the scores for all starter and non-starter players for all franchises in a league. The "W" parameter can be "YTD" to give all year-to-date weekly results. Private league access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `W`: If the week is specified, it returns the data for that week, otherwise the most current data is returned. If the value is 'YTD', then it returns year-to-date data (or the entire season when called on historical leagues).
- `MISSING_AS_BYE`: If set to 1, fantasy teams with no scheduled opponents will be shown as playing vs a BYE opponent.

### `liveScoring`

Live scoring for a given league and week, including each franchise's current score, how many game seconds remaining that franchise has, players who have yet to play, and players who are currently playing.

Arguments:

- `L`: League Id(required)
- `W`: If the week is specified, it returns the data for that week, otherwise the most current data is returned.
- `DETAILS`: Setting this argument to 1 will return data for non-starters as well

### `playerScores`

All player scores for a given league/week, including all rostered players as well as all free agents. Private league access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `W`: If the week is specified, it returns the data for that week, otherwise the current week data is returned. If the value is 'YTD', then it returns year-to-date data. If the value is 'AVG', then it returns a weekly average.
- `YEAR`: The year for the data to be returned.
- `PLAYERS`: Pass a list of player ids separated by commas (or just a single player id) to receive back just the info on those players.
- `POSITION`: Return only players from this position.
- `STATUS`: If set to 'freeagent', returns only players that are fantasy league free agents.
- `RULES`: If set, and a league id passed, it re-calculates the fantasy score for each player according to that league's rules. This is only valid when specifying the current year and current week.
- `COUNT`: Limit the result to this many players.

### `projectedScores`

Given a player ID, calculate the expected fantasy points, using that league's scoring system. The system will use the raw stats that fantasysharks.com projects. Private league access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `W`: If the week is specified, it returns the projected scores for that week, otherwise the upcoming week is used.
- `PLAYERS`: Pass a list of player ids separated by commas (or just a single player id) to receive back just the info on those players.
- `POSITION`: Return only players from this position.
- `STATUS`: If set to 'freeagent', returns only players that are fantasy league free agents (note that this refers to players that current free agents, not that were free agents during the specified week).
- `COUNT`: Limit the result to this many players.

### `draftResults`

Draft results for a given league. Note that this data may be up to 15 minutes delayed as it is meant to display draft results after a draft is completed. To access this data while drafts are in progress, check out this FAQ . Private league access restricted to league owners.

Arguments:

- `L`: League Id(required)

### `auctionResults`

Auction results for a given league. Private league access restricted to league owners.

Arguments:

- `L`: League Id(required)

### `selectedKeepers`

Currently selected keepers. Returns only own's franchise keepers. For commissioner returns all franchises unless Lockout is on. Private league access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `FRANCHISE`: When set, returns just the keepers for the specified franchise (only for commissioner).

### `myDraftList`

My Draft List for the current franchise. Access restricted to league owners.

Arguments:

- `L`: League Id(required)

### `messageBoard`

Display a summary of the recent message board posts to a league message board. Access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `COUNT`: If specified, limit the number of threads to display to this value. Default is 10.

### `messageBoardThread`

Display posts in a thread from a league message board. Access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `THREAD`: Thread id (required).

### `polls`

All current league polls with details as to which polls the current franchise voted on. Access restricted to league owners.

Arguments:

- `L`: League Id(required)

### `device_tokens`

Returns the device tokens for the current user.

Arguments: varies by endpoint; use MFL tester for live schema checks.

### `playerRosterStatus`

Get the player's current roster status. The franchise(s) the player is on are listed in the subelement. There may more than one of this for leagues that have multiple copies of players. Each of this elements will have a franchise id and status attribute. The status attribute can be one of: R (roster), S (starter), NS (non-starter), IR (injured reserve) or TS (taxi squad). The R value is only provided when there's no lineup submitted or the caller has no visibility into the lineup. If the player is a free agent, there will be a 'is_fa' attribute on the parent element. In those cases the elements 'cant_add' and 'locked' attributes may be set indicating whether a player can't be added or is locked.

Arguments:

- `L`: League Id(required)
- `P`: Player id or list of player ids separated by commas (required).
- `W`: Week. If a week is specified, it returns the player status for that week. The default is the current Live Scoring week.
- `F`: Franchise it. If present it uses the franchise id to determine which conference or division to use for the purposes of identifying free agents. If not present it uses the user's franchise id. Only matters on deluxe leagues.

### `contestPlayers`

On Contest Leagues, this returns all players eligible to be in a franchise's starting lineup. While this request can be used by any league it's best suited for leagues with the loadRosters setting set to either 'contest' or 'setem'. Access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `W`: Week. If a week is specified, it returns the players for that week. The default is the upcoming week.
- `F`: Franchise it. If present it returns the players eligible for that franchise. Only matters when called by the commissioner. When called by an owner, this parameter is ignored and the owner's franchise is used.

### `myWatchList`

My Watch List for the current franchise. Access restricted to league owners.

Arguments:

- `L`: League Id(required)

### `salaries`

The current player salaries and contract fields. Only players with values are returned. If a value is empty it means that the default value is in effect. The default values are specified under the player id '0000'. Private league access restricted to league owners.

Arguments:

- `L`: League Id(required)

### `salaryAdjustments`

All extra salary adjustments for a given league. Private league access restricted to league owners.

Operational notes for the UPS site:

- The live export is still read for franchise-level adjustment totals.
- Trade and cut adjustments posted by the UPS import flow include a canonical `ref=...` token inside `explanation`.
- Front Office treats canonical trade and cut rows as report-owned ledger entries and uses live `salaryAdjustments` export only for manual or otherwise unclassified `other` adjustments.

Arguments:

- `L`: League Id(required)

### `futureDraftPicks`

Future draft picks for a given league. Private league access restricted to league owners.

Arguments:

- `L`: League Id(required)

### `accounting`

Returns a summary of the league accounting records. In the response, negative amounts are charges against the franchise while positive amounts is money paid by the franchise or owed to the franchise. Private league access restricted to league owners.

Arguments:

- `L`: League Id(required)

### `pool`

All NFL or fantasy pool picks for a given league. Private league access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `POOLTYPE`: Which pool picks to return. Valid values are "NFL" (default) or "Fantasy".

### `survivorPool`

All survivor pool picks for a given league. Private league access restricted to league owners.

Arguments:

- `L`: League Id(required)

### `abilities`

Returns the abilities of the current franchise. A value of 0 means the franchise does not have the ability and a value of 1 means it has the ability. Access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `F`: Franchise ID. When the request comes from the commissioner, this indicates which franchise's abilities to return. It's ignored if the request comes from an owner.
- `DETAILS`: If set to a non-zero/empty value, includes the abilities descriptions.

### `appearance`

The skin, home page tabs, and modules within each tab set up by the commissioner for a given league.

Arguments:

- `L`: League Id(required)

### `rss`

An RSS feed of key league data for a given league, including: league standings, current week's live scoring, last week's fantasy results, and the five newest message board topics. Private league access restricted to league owners.

Arguments:

- `L`: League Id(required)

### `ics`

Returns a summary of the league calendar in .ics format, which is suitable for importing into many modern calendaring programs, like Apple's Calendar, Google Calendar, Microsoft Outlook, and more. Access restricted to league owners.

Arguments:

- `L`: League Id(required)

### `myleagues`

All of the leagues of the current user. Private league access restricted to league owners. Personal user information, like name and email addresses only returned to league owners.

Arguments:

- `YEAR`: Returns the data for the specified year. Default is current year.
- `FRANCHISE_NAMES`: Set this argument to 1 to include the franchise names in the response. Note that when this parameter is set, and the user has a lot of leagues, this response may take a long time to process and time out.

### `leagueSearch`

Searches for leagues in our database that match either the given league id or whose name matches the specified string. Either the SEARCH or ID paramater must be specified, but not both.

Arguments:

- `SEARCH`: Case-insensitive string to search for. Must be at least 3 characters long.
- `ID`: 4 or 5-digit number to return the league with this id.
- `YEAR`: Year to search, default is the year in the URL.

### `players`

All player IDs, names and positions that MyFantasyLeague.com has in our database for the current year. All other data types refer only to player IDs, so if you'd like to later present any data to people, you'll need this data type for translating player IDs to player names. Our player database is updated at most once per day, and it contains more than 2,000 players - in other words, you're strongly encouraged to read this data type no more than once per day, and store it locally as needed, to optimize your system performance.

Arguments:

- `L`: League Id(optional)
- `DETAILS`: Set this value to 1 to return complete player details, including player IDs from other sources.
- `SINCE`: Pass a unix timestamp via this parameter to receive only changes to the player database since that time.
- `PLAYERS`: Pass a list of player ids separated by commas (or just a single player id) to receive back just the info on those players.

### `playerProfile`

Returns a summary of information regarding a player, including DOB, ADP ranking, height/weight.

Arguments:

- `P`: Player id or list of player ids separated by commas (required).

### `allRules`

All scoring rules that MyFantasyLeague.com currently supports, including: if the rule is scored for players, teams or coaches, as well as an abbreviation of the scoring rule, a short description, and a detailed description. If you plan on using the 'rules' data type, you'll also need this data type to look up the abbreviations to translate them to their detailed description for people.

Arguments: varies by endpoint; use MFL tester for live schema checks.

### `playerRanks`

This report provides overall player rankings from the experts at FantasySharks.com. These rankings can be used instead of Average Draft Position (ADP) rankings for guidance during your draft, or when generating your own draft list.

Arguments:

- `POS`: Return only players at this position.
- `SOURCE`: Which player ranks source to use, default is 'sharks')

### `adp`

ADP results, including when the result were last updated, how many drafts the player was selected in, the average pick, minimum pick and maximum pick.

Arguments:

- `PERIOD`: This returns draft data for just drafts that started after the specified period. Valid values are ALL, RECENT, DRAFT, JUNE, JULY, AUG1, AUG15, START, MID, PLAYOFF. This option is not valid for previous seasons.
- `FCOUNT`: This returns draft data from just leagues with this number of franchises. Valid values are 8, 10, 12, 14 or 16. If the value is 8, it returns data from leagues with 8 or less franchises. If the value is 16 it returns data from leagues with 16 or more franchises.
- `IS_PPR`: Filters the data returned as follows: If set to 0, data is from leagues that not use a PPR scoring system; if set to 1, only from PPR scoring system; if set to -1 (or not set), all leagues.
- `IS_KEEPER`: Pass a string with some combination of N, K and R: if N specified, returns data from redraft leagues, if 'K' is specified, returns data for keeper leagues and if 'R' is specified, return data from rookie-only drafts. You can combine these. If you specify 'KR' it will return rookie and keeper drafts only. Default is 'NKR'.
- `IS_MOCK`: If set to 1, returns data from mock draft leagues only. If set to 0, excludes data from mock draft leagues. If set to -1, returns all
- `CUTOFF`: Only returns data for players selected in at least this percentage of drafts. So if you pass 10, it means that players selected in less than 10% of all drafts will not be returned. Note that if the value is less than 5, the results may be unpredicatble.
- `DETAILS`: If set to 1, it returns the leagues that were included in the results. This option only works for the current season.

### `aav`

AAV results, including when the result were last updated, how many auctions the player was selected in and the average auction value. Average auction value is relative to an auction where a total of $1000 is available across all franchises.

Arguments:

- `PERIOD`: This returns auction data for just auctions that started after the specified period. Valid values are ALL, RECENT, DRAFT, JUNE, JULY, AUG1, AUG15, START, MID, PLAYOFF. This option is not valid for previous seasons.
- `IS_PPR`: Filters the data returned as follows: If set to 0, data is from leagues that not use a PPR scoring system; if set to 1, only from PPR scoring system; if set to -1 (or not set), all leagues.
- `IS_KEEPER`: Pass a string with some combination of N, K and R: if N specified, returns data from redraft leagues, if 'K' is specified, returns data for keeper leagues and if 'R' is specified, return data from rookie-only drafts. You can combine these. If you specify 'KR' it will return rookie and keeper drafts only. Default is 'NKR'.

### `topAdds`

The most added players across all MyFantasyLeague.com-hosted leagues during the current week (or the past 7 days during the pre-season), as well as the percentage of leagues that they've been added in. Only players that have been added in at least 1% of our leagues will be returned. This data would be helpful in creating some sort of "Who's Hot?" list.

Arguments:

- `COUNT`: Limits the result to this many players.
- `STATUS`: Set this value to FA to only return available free agents. This option is not available for deluxe leagues.

### `topDrops`

The most dropped players across all MyFantasyLeague.com-hosted leagues during the current week (or the past 7 days during the pre-season), as well as the percentage of leagues that they've been dropped in. Only players that have been dropped in at least 1% of our leagues will be displayed. This data would be helpful in creating some sort of "Who's Cold?" list.

Arguments:

- `COUNT`: Limits the result to this many players.
- `STATUS`: Set this value to FA to only return available free agents. This option is not available for deluxe leagues.

### `topStarters`

The most started players across all MyFantasyLeague.com-hosted leagues for the current week, as well as the percentage of leagues that they've been started in. Only players that have been started in at least 1% of our leagues will be displayed.

Arguments:

- `COUNT`: Limits the result to this many players.
- `STATUS`: Set this value to FA to only return available free agents. This option is not available for deluxe leagues.

### `topTrades`

The most traded players across all MyFantasyLeague.com-hosted leagues in the current week (or past 7 days during the pre-season), as well as the percentage of leagues that they have been traded in. Only players that are traded in more than 0.25% of our leagues will be displayed.

Arguments:

- `COUNT`: Limits the result to this many players.

### `topOwns`

The most owned players across all MyFantasyLeague.com-hosted leagues, as well as the percentage of leagues that they're owned in. Only players that are owned in more than 2% of our leagues will be displayed.

Arguments:

- `COUNT`: Limits the result to this many players.
- `STATUS`: Set this value to FA to only return available free agents. This option is not available for deluxe leagues.

### `siteNews`

An RSS feed of MyFantayLeague.com site news.

Arguments: varies by endpoint; use MFL tester for live schema checks.

### `whoShouldIStart`

Site-wide 'Who Should I Start?' data - offering a comparison between any two players at the same position, letting you know what percent of all MFL customers would choose one player over another player. There's two versions of this API. When specifying a league id (and franchise id) it will return the data for the given franchise. When a league id is not specified, use the PLAYERS parameter to pass a list of players to return. Access restricted to league owners.

Arguments:

- `L`: League Id(optional)
- `WEEK`: Show the results for the specified week.
- `FRANCHISE`: If a league id is specified, show the results for the given franchise's roster, otherwise the caller's franchise.
- `PLAYERS`: If specified and FRANCHISE not specified, filter the results to the passed player ids (separated by commas).

### `injuries`

The player ID, status (IR, Out, Doubtful, Questionable, Inactive, etc.) and details (i.e., 'Knee', 'Foot', 'Ribs', etc.) of all players on the NFL injury report. The report data is updated daily during the season and pre-season. The timestamp attribute tells you the last time this data was updated.

Arguments:

- `W`: If the week is not specified, it defaults to the most recent week that injury data is available.

### `nflSchedule`

The NFL schedule for one week of the season, including the scheduled kickoff of the game, home team (and their score), the away team (and their score). Starting with the 2020 season, this request will no longer update while games are in progress and it's meant to be used to get the NFL schedule. To obtain the current scores of games, please check out this FAQ .

Arguments:

- `W`: If the week is not specified, it defaults to the current week. If set to 'ALL', it returns the full season schedule.

### `nflByeWeeks`

The bye weeks for every NFL team.

Arguments:

- `W`: If the week is specified, it returns just the teams with a bye in that week.

### `pointsAllowed`

Fantasy points allowed by each NFL team, broken out by position.

Arguments:

- `L`: League Id(required)

## Import types (27)

### `lineup`

Import a franchise's starting lineup. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter.

Arguments:

- `L`: League Id(required)
- `W`: The week you are setting the lineup for (required).
- `STARTERS`: A comma-separated list of players to use as the starters (required).
- `COMMENTS`: A short message to be save as the comments for this starting lineup (optional).
- `TIEBREAKERS`: For leagues that use tiebreaker player(s), specify them via this field.
- `BACKUPS`: For leagues that use backup player(s), specify them via this field. Note that this feature is no longer supported.
- `FRANCHISE_ID`: When called by the Commissioner, you must pass this parameter to indicate on which franchise behalf to do the request.

### `franchises`

Loads franchise names, graphics, contact information, and more. Access Restricted: Requires cookie from league commissioner.

Arguments:

- `L`: League Id(required)
- `DATA`: XML string representing the franchises' data. Data format is the same as the contents of <franchises> element in the export league API. See Import Data details .
- `OVERLAY`: If this parameter is set, the passed in data will overlay the existing data. Fields not uploaded will be left as is. If this parameter is not set, all the data not passed in will be erased.

### `calendarEvent`

Import an event to a league calendar. Access Restricted: Requires cookie from league commissioner.

Arguments:

- `L`: League Id(required)
- `EVENT_TYPE`: The id of the event type being added to the calendar. The more commont event types are "DRAFT_START", "AUCTION_START", "TRADE" (for trade deadline), "WAIVER_REVERSE", "WAIVER_BBID", "WAIVER_UNLOCK", "WAIVER_LOCK", and "CUSTOM" (required).
- `START_TIME`: The Unix time of when the event starts (required).
- `END_TIME`: The Unix time of when the event ends (optional).
- `HAPPENS`: If specified, the event is added at the same time each week for the following this many weeks.

### `fcfsWaiver`

Import an add/drop move that will be executed immediately (also known as a first-come, first-serve move). You may also use this call to drop multiple players at once. At least one player to be added or dropped is required. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter.

Arguments:

- `L`: League Id(required)
- `ADD`: The player id to add.
- `DROP`: A comma-separated list of player ids to drop.
- `FRANCHISE_ID`: When called by the Commissioner, you must pass this parameter to indicate on which franchise behalf to do the request.

### `waiverRequest`

Import one round's worth of waiver requests. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter.

Arguments:

- `L`: League Id(required)
- `ROUND`: Specifies the waiver round this request is for (required).
- `PICKS`: A comma delimited list of player waiver claims. Each claim is two player ids separated by an underscore. The first player id is the player to ask for and the second is the one to drop if the waiver claim is awarded. For example, the value "1111_2222,3333_4444" means that the first priority is to acquired player id 1111 dropping 2222, but if that's not possible, add 3333 and drop 4444 (required). In order to clear the whole round, pass an empty value for PICKS.
- `REPLACE`: If there are already picks for that round, the ones specified via the PICKS parameter are added to the existing request unless this parameter is set in which case it replaces the current entries.
- `FRANCHISE_ID`: When called by the Commissioner, you must pass this parameter to indicate on which franchise behalf to do the request.

### `blindBidWaiverRequest`

Import blind bidding waiver requests. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter.

Arguments:

- `L`: League Id(required)
- `ROUND`: Specifies the waiver round this request is for (required only if the league uses conditional blind bidding).
- `PICKS`: A comma delimited list of bids. Each bid consists of the player id to bid on, the bid amount and the player to drop if the claim is awarded, separated by underscores. For example, the value "1111_5_2222,3333_2_4444" means that the first priority is to acquired player id 1111 for $5, dropping 2222, but if that's not possible, add 3333 for $2 and drop 4444 (required). Specify "0000" as the player id when not dropping a player. In order to clear the whole round, pass an empty value for PICKS.
- `REPLACE`: If there are already picks for that round, the ones specified via the PICKS parameter are added to the existing request unless this parameter is set in which case it replaces the current entries.
- `FRANCHISE_ID`: When called by the Commissioner, you must pass this parameter to indicate on which franchise behalf to do the request.

### `ir`

Import an IR (activate/deactivate) move. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter.

Arguments:

- `L`: League Id(required)
- `ACTIVATE`: Comma-separated list of player ids to activate (move from Injured Reserve to Active Roster).
- `DEACTIVATE`: Comma-separated list of player ids to deactivate (move from Active Roster to Injured Reserve).
- `DROP`: Comma-separated list of player ids to drop from the roster. This applies to all players on the roster, regardeless of roster status.
- `FRANCHISE_ID`: When called by the Commissioner, you must pass this parameter to indicate on which franchise behalf to do the request.

### `taxi_squad`

Import a Taxi Squad (promote/demote) move. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter.

Arguments:

- `L`: League Id(required)
- `PROMOTE`: Comma-separated list of player ids to promote (move from Taxi Squad to Active Roster).
- `DEMOTE`: Comma-separated list of player ids to demote (move from Active Roster to Taxi Squad).
- `DROP`: Comma-separated list of player ids to drop from the roster. This applies to all players on the roster, regardeless of roster status.
- `FRANCHISE_ID`: When called by the Commissioner, you must pass this parameter to indicate on which franchise behalf to do the request.

### `tradeProposal`

Propose a trade to another franchise. The WILL_GIVE_UP and WILL_RECEIVE parameters can also contain draft picks if the league allows draft pick trading. Current year draft picks are specified like DP_02_05 which refers to the 3rd round 6th pick (the round and pick values in the string are one less than the actual round/pick). For future years picks, they are identified like FP_0005_2018_2 where 0005 referes to the franchise id who originally owns the draft pick, then the year and then the round (in this case the rounds are the actual rounds, not one less). If the league uses Blind Bidding and allows trading of blind bid dollars, you can specify like BB_10.50, which means $10.50 worth of blind bid dollars. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter.

Arguments:

- `L`: League Id(required)
- `OFFEREDTO`: Target franchise id of the trade proposal (required).
- `WILL_GIVE_UP`: Comma-separated list of player ids or other assets (see description) being offered (required).
- `WILL_RECEIVE`: Comma-separated list of player ids or other assets (see description) being asked for (required).
- `COMMENTS`: Short message to send to the target of the trade proposal (optional).
- `EXPIRES`: Unix time specifying when the trade proposal expires (default is one week from when offered).
- `FRANCHISE_ID`: When called by the Commissioner, you must pass this parameter to indicate on which franchise behalf to do the request.

### `tradeResponse`

Respond to an existing trade offer. See the tradeProposal request above for info regarding draft pick trading. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter.

Arguments:

- `L`: League Id(required)
- `TRADE_ID`: Trade id as returned by the pending Trades export API (required).
- `RESPONSE`: Whether the trade proposal is accepted or rejected. Valid values are 'accept', 'reject' or 'revoke' (required). The 'revoke' response is only allowed if the request is made by the originator of the trade proposal. The other two options are allowed only if the request is made by the target of the trade proposal.
- `COMMENTS`: Short message to send to the originator of the trade proposal when the trade is rejected (optional).
- `FRANCHISE_ID`: When called by the Commissioner, you must pass this parameter to indicate on which franchise behalf to do the request.

### `tradeBait`

Import an owner's trade bait, which will overwrite his previously entered trade bait. Access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `WILL_GIVE_UP`: Comma-separated list of player ids being offered (required). Draft picks are also allowed assuming the league supports draft pick trading (see tradeProposal request for details on how to format them).
- `IN_EXCHANGE_FOR`: A description of what the team is interested in getting back in a trade. This can be a string of no more than 256 characters. Spaces and all other special characters should be properly escaped.

### `draftResults`

Loads draft order and actual draft results. All previously existing draft results will be completely deleted from the system when importing draft results. Note that this is meant to be used to load the results of an offline draft all at once, not to implement a live draft application. An additional attribute called 'status' is supported on each draft pick element, allowing you to indicate the status of the player upon import. The valid values are: ROSTER, TAXI_SQUAD, or INJURED_RESERVE. If no status is indicated, it defaults to ROSTER. Access Restricted: Requires cookie from league commissioner.

Arguments:

- `L`: League Id(required)
- `DATA`: XML string representing the draft results data. See Import Data details .

### `auctionResults`

Auction results. This is meant to be used to load the results of an offline draft all at once, not to implement a live draft application. An additional attribute called 'status' is supported on each auction element, allowing you to indicate the status of the player upon import. Valid values are: ROSTER, TAXI_SQUAD, or INJURED_RESERVE. If no status is indicated, it defaults to ROSTER. Access Restricted: Requires cookie from league commissioner.

Arguments:

- `L`: League Id(required)
- `DATA`: XML string representing the auction results data. See Import Data details .
- `CLEAR`: If set to 1, it will clear out any current auction results. This is a cosmetic info only, that affects what's displayed in the Action Results report but leaves the current rosters as they area.
- `OVERWRITE`: If set to 1, it will overwrite the current rosters with the new ones. The default is to append the new players to existing rosters. Note that if set it may result in multiple copies of the same player. Note that setting OVERWRITE=1 without setting CLEAR=1 may result in an inconsistent state regarding available funds.

### `myDraftList`

Set the players in an owner's My Draft List. This will completely overwrite an owners previous My Draft List. Access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `PLAYERS`: Comma-separated list of player IDs to set the list to (required).

### `messageBoard`

Start a message board thread or reply to an existing message board thread. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter.

Arguments:

- `L`: League Id(required)
- `FRANCHISE_ID`: The franchise id posting this message. Only valid when the request comes from the league commissioner. Use "0000" as the value to indicate the posting should be from the Commissioner, not an owner.
- `THREAD`: Message board thread id. If set it assumes the post is a reply to this thread.
- `SUBJECT`: When starting a new thread (i.e. ehe THREAD parameter is not specified), this parameter specifies the subject of the thread.
- `BODY`: The body of the message (required).

### `pollVote`

Import a vote in a league poll. Access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `POLL_ID`: The poll id that the vote is for (required).
- `ANSWER_ID`: The id of the selected poll choice (required). If the poll allows multiple answers, separate them with commas.

### `emailMessage`

Send an email message to one or all the owners in the league. Access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `SEND_TO`: If specified, send the message just to this franchise. Leave this parameter out if you want the email to go to all league owners.
- `SUBJECT`: Specifies the subject of the email message (required).
- `BODY`: Specifies the body of the email message (required).
- `INVITE`: If set, this causes the franchise-specific league invite link to be included in each email message body.

### `add_device_token`

Registers a device token for the given user. Used to send notifications via a mobile app. Accessed restricted to logged in users.

Arguments:

- `TOKEN`: The device token to add.
- `NAME`: The name for this device, must be less than 36 characters.
- `DELETE`: If set to ALL, it clears out all the tokens for this user, otherwise it deletes the token with the given name.

### `salaries`

XML string representing the player salaries. The format for this data is <salaries> <leagueUnit unit="LEAGUE"> <player id="9823" salary="11" contractStatus="A" contractYear="1" contractInfo="info" /> <player id="8670" salary="7.56" contractYear="2" contractInfo="more info" /> ... </leagueUnit> </salaries> The valid attributes in the player elements depend on the league salary settings. If a setting is turned off in the Salary Cap Setup page, it will not be imported. Access Restricted: Requires cookie from league commissioner.

Arguments:

- `L`: League Id(required)
- `DATA`: XML string representing the league salaries data. See Import Data details .
- `APPEND`: If this parameter is set to any non-zero value, the passed in data will overlay the existing data. Salaries not uploaded will be left as is. If this parameter is not set, the salaries not passed in will be erased. .

### `salaryAdj`

XML string representing the salary adjustments. The format for this data is <salary_adjustments> <salary_adjustment franchise_id="0001" amount="5.75" explanation="$5.75 fine for being late to draft."/> <salary_adjustment franchise_id="0007" amount="-3.00" explanation="$3 credit for some reason."/> ... </salary_adjustments> For all adjustments, the franchise_id, amount and explanation fields are required and must not be empty. Use a negative amount to credit the franchise (i.e. reduce their salary). The data will always be added to the existing salary adjustments. Access Restricted: Requires cookie from league commissioner.

UPS site import notes:

- Static ETL output now includes `pipelines/etl/artifacts/mfl_salary_adjustments_<season>.xml`.
- The Salary Adjustments report can also generate filtered XML client-side from selected report rows.
- The worker exposes `POST /salary-adjustments/import` to post normalized ledger rows after de-duping against existing `salaryAdjustments` export rows by `ref=...`.
- Canonical explanations follow this pattern so later imports can skip duplicates deterministically:
  - trade: `UPS cap adjustment | type=trade | season=2025 | trade_id=29 | ref=trade:2025:trade2025_29:0006:-4000 | amount=-4000`
  - cut: `UPS cap adjustment | type=cut | season=2026 | player=Player Name | ref=cut:2026:adddrop2025_624.1:0008:39750 | amount=39750`

Arguments:

- `L`: League Id(required)
- `DATA`: XML string representing the salary adjustments to be made. See Import Data details .

### `playerScoreAdjustment`

Import one player score adjustment record. Access Restricted: Requires cookie from league commissioner.

Arguments:

- `L`: League Id(required)
- `PLAYER`: The player id whose score is being adjusted (required).
- `WEEK`: The week number of the score being adjusted (required).
- `POINTS`: The point adjustment (required).
- `EXPLANATION`: A short message describing the reason for the adjustment (required).

### `keepers`

Import an owner's keeper selections. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter.

Arguments:

- `L`: League Id(required)
- `KEEP`: Comma-separated list of player IDs to keep. Players not listed here and previously marked as kept will be removed from the players to keep. Passing an empty list will result in all keepers being unselected.
- `FRANCHISE_ID`: The franchise to which this keepers list applies. Only valid when the request comes from the league commissioner.

### `myWatchList`

Update the players in an owner's My Watch List. Access restricted to league owners.

Arguments:

- `L`: League Id(required)
- `ADD`: Comma-separated list of player IDs to add to the list.
- `REMOVE`: Comma-separated list of player IDs to remove from the list.

### `accounting`

Import one accounting record. Access Restricted: Requires cookie from league commissioner.

Arguments:

- `L`: League Id(required)
- `FRANCHISE`: The franchise id of the new record (required).
- `AMOUNT`: The amount being credited or debited. Positive values will increase the franchise's balance, while negative values will subtract from it (required).
- `DESCRIPTION`: A short message describing the transaction (required).

### `franchiseScoreAdjustment`

Import one franchise score adjustment record. Access Restricted: Requires cookie from league commissioner.

Arguments:

- `L`: League Id(required)
- `FRANCHISE`: The franchise id whose score is being adjusted (required).
- `WEEK`: The week number of the score being adjusted (required).
- `POINTS`: The point adjustment (required).
- `EXPLANATION`: A short message describing the reason for the adjustment (required).

### `poolPicks`

Make an NFL or Fantasy pool pick. To send the actual picks you need to pass a number of PICK and RANK parameters. These have names like PICKDAL,NYG and RANKDAL,NYG. For example, in a game where the Cowboys are playing at the Giants, and you want to indicate with a confidence level of 16 that the Giants will win, the two name/value pairs that must be passed in are PICKDAL,NYG=NYG and RANKDAL,NYG=16. This needs to be repeated for all matchups (fantasy or NFL) for the week in question. For fantasy pool picks, the franchise ids are used instead of NFL team abbreviations. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter.

Arguments:

- `L`: League Id(required)
- `POOLTYPE`: Pool type of picks being imported. Must be either "NFL" or "Fantasy". If not specified, the default is "NFL".
- `PICK`: See description (required).
- `RANK`: See description (required).
- `WEEK`: The week being submitted (only for the commissioner).
- `FRANCHISE_ID`: When called by the Commissioner, you must pass this parameter to indicate on which franchise behalf to do the request.

### `survivorPoolPick`

Import a survivor pool pick. Access restricted to league owners. Commissioner can impersonate owner using FRANCHISE_ID paramter.

Arguments:

- `L`: League Id(required)
- `PICK`: Survivor pick, the MyFantasyLeague.com 3-letter NFL abbreviation (required).
- `FRANCHISE_ID`: When called by the Commissioner, you must pass this parameter to indicate on which franchise behalf to do the request.
