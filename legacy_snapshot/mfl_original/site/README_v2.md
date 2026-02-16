# UPS MFL v2 Integration

## Files
- `/Users/keithcreelman/Documents/New project/mfl/site/header_v2_redesign.html`
- `/Users/keithcreelman/Documents/New project/mfl/site/footer_v2_redesign.html`
- `/Users/keithcreelman/Documents/New project/mfl/site/ccc_bridge.js`
- `/Users/keithcreelman/Documents/New project/mfl/site/ccc_hpm16_loader_patch.html`

## Apply in MFL
1. In MFL commissioner setup, replace your custom Header with:
   - `/Users/keithcreelman/Documents/New project/mfl/site/header_v2_redesign.html`
2. Replace your custom Footer with:
   - `/Users/keithcreelman/Documents/New project/mfl/site/footer_v2_redesign.html`

## Enable popup + roster contract actions
1. Publish `ccc_bridge.js` to your GitHub Pages path:
   - `https://keithcreelman.github.io/ups-league-data/ccc_bridge.js`
2. In `mfl_hpm16_contractcommandcenter.html`, replace the current loader script with:
   - `/Users/keithcreelman/Documents/New project/mfl/site/ccc_hpm16_loader_patch.html`

## What this enables
- A consistent new color system and layout across header/footer.
- De-bloated config with preserved core MFL scripts.
- Roster page (`O=07`) quick action buttons per eligible player:
  - `Extension`
  - `Restructure`
- Player popup on roster page gets the same actions.
- Clicking either action opens `MESSAGE16` and auto-opens the correct player action modal in Contract Command Center.
