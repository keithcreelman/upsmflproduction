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

## MCM (MESSAGE15)
1. In MFL `Setup → Appearance → Home Page Messages → Message 15`, paste the embed snippet from `site/README.md` (`hpm-mcm`).
2. Header/footer include an `MCM` link to `MODULE=MESSAGE15`.

## Reports Module (MESSAGE9)
1. In MFL `Setup → Appearance → Home Page Messages → Message 9`, paste the embed snippet from `site/README.md` (`hpm-reports`).
2. The message stays centrally managed through the Reports Module partial instead of a hand-pasted iframe block.

## Expected Behavior
- Consistent league skin across pages.
- Extension and restructure quick actions on roster pages.
- Popup action routing into Contract Command Center.
