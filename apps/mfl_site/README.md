# UPS MFL Site Package

## Files
- `header_custom_v2.html`: custom MFL header skin and quick actions.
- `footer_custom_v2.html`: custom MFL footer modules and league links.
- `contract_command_center_bridge.js`: bridge script for popup/roster actions.
- `contract_command_center_loader_patch.html`: loader replacement for `MESSAGE16`.

## MFL Application Steps
1. In MFL commissioner setup, replace custom header with `header_custom_v2.html`.
2. Replace custom footer with `footer_custom_v2.html`.
3. Publish `contract_command_center_bridge.js` to your static host.
4. In the Contract Command Center template, replace the loader script block with `contract_command_center_loader_patch.html`.

## Expected Behavior
- Consistent league skin across pages.
- Extension and restructure quick actions on roster pages.
- Popup action routing into Contract Command Center.
