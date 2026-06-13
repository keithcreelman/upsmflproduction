-- 0079: pre-trade extensions on 3-way trades.
--
-- A player moving in a 3-way can be extended by the franchise giving it up
-- (canon §C4), exactly like the 2-party builders. The selected extensions are
-- stored as a JSON array of extension_request entries (same shape the 2-party
-- payload uses: player_id, from/to franchise, option_key, preview_contract_info_string,
-- new_contract_status, etc.) and applied AFTER the legs execute via the worker's
-- existing applyExtensionsFromPayload (a cookie-only salaries import).
ALTER TABLE ups_3way_trades ADD COLUMN extension_requests_json TEXT;
