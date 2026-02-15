# Hosted Includes (Header/Footer/HPM)

Use one loader URL and choose which content to pull using `data-ups-partial`.

Use jsDelivr so you do not need GitHub Pages enabled.

## MFL Header field
```html
<script src="https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@dev/site/loader.js?v=2026.02.15.2" data-ups-partial="header"></script>
```

## MFL Footer field
```html
<script src="https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@dev/site/loader.js?v=2026.02.15.2" data-ups-partial="footer"></script>
```

## Any HPM slot (standard message)
```html
<script src="https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@dev/site/loader.js?v=2026.02.15.2" data-ups-partial="hpm-default"></script>
```

## MCM (Message 15)
```html
<script src="https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@dev/site/loader.js?v=2026.02.15.2" data-ups-partial="hpm-mcm"></script>
```

## Optional target node form
If you want to mount into an existing element:
```html
<div id="ups-slot-1"></div>
<script
  src="https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@dev/site/loader.js?v=2026.02.15.2"
  data-ups-partial="hpm-default"
  data-ups-target-id="ups-slot-1"></script>
```

## Notes
- Header pulls from `/apps/mfl_site/header_custom_v2.html`.
- Footer pulls from `/apps/mfl_site/footer_custom_v2.html`.
- HPM default pulls from `/site/hpm-default.html`.
- Bump the `v=` value to force cache refresh in MFL.
- For production, switch `@dev` to `@main`.
