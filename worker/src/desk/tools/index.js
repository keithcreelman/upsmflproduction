// The Commissioner Desk's Phase 1 tool set: exactly these 14 tools, registered in one reviewed place.
// Importing a tool file registers it with the registry (defineTool is called at import). A tool that is not imported here does not exist.
// Adding a tool means editing this list AND tests/ai_desk_tool_inventory.test.mjs, so the inventory cannot change silently.
import rulesSearch from "./rules_search.js";
import rulesGet from "./rules_get.js";
import glossaryLookup from "./glossary_lookup.js";
import coverageCheck from "./coverage_check.js";
import rosterCurrent from "./roster_current.js";
import capPosition from "./cap_position.js";
import capPenaltyQuote from "./cap_penalty_quote.js";
import capAdjustments from "./cap_adjustments.js";
import extensionPrice from "./extension_price.js";
import calendarEvents from "./calendar_events.js";
import standingsGet from "./standings_get.js";
import historyFinishes from "./history_finishes.js";
import playerTransactions from "./player_transactions.js";
import dataFreshness from "./data_freshness.js";

export const PHASE1_TOOL_IDS = Object.freeze([
  "rules.search", "rules.get", "glossary.lookup", "coverage.check",
  "roster.current", "cap.position", "cap.penalty_quote", "cap.adjustments", "extension.price", "calendar.events",
  "standings.get", "history.finishes", "player.transactions", "data.freshness",
]);

export const PHASE1_TOOLS = Object.freeze([
  rulesSearch, rulesGet, glossaryLookup, coverageCheck,
  rosterCurrent, capPosition, capPenaltyQuote, capAdjustments, extensionPrice, calendarEvents,
  standingsGet, historyFinishes, playerTransactions, dataFreshness,
]);
