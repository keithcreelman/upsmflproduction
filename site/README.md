# Hosted Includes (Header/Footer/HPM)

Use one loader URL and choose which content to pull using `data-ups-partial`.

Use jsDelivr so you do not need GitHub Pages enabled.

## MFL Header field
```html
<script src="https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@dev/site/loader.js?v=2026.02.15.5" data-ups-partial="header"></script>
```

## MFL Footer field
```html
<script src="https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@dev/site/loader.js?v=2026.02.15.5" data-ups-partial="footer"></script>
```

## Any HPM slot (standard message)
```html
<script src="https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@dev/site/loader.js?v=2026.02.15.5" data-ups-partial="hpm-default"></script>
```

## MCM (Message 15)
```html
<script src="https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@dev/site/loader.js?v=2026.02.15.5" data-ups-partial="hpm-mcm"></script>
```

## Standings Snapshot HPM (Message slot of your choice)
```html
<script src="https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@dev/site/loader.js?v=2026.02.16.13" data-ups-partial="hpm-standings"></script>
```

## Issue Report HPM (use this for HPM 3)
```html
<script src="https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/loader.js?v=2026.03.04.4" data-ups-partial="hpm-issue-report"></script>
```

## Contract Command Center (Message 2)
```html
<script src="https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@dev/site/ccc/mfl_hpm_embed_loader.js?v=2026.02.15.5"></script>
```

## Contract Command Center HPM Partial (Message 5 or any slot)
```html
<script src="https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/loader.js?v=2026.03.04.6" data-ups-partial="hpm-ccc"></script>
```

## Owner Hub Widget HPM Partial (Countdown + Owner Activity)
```html
<script src="https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@main/site/loader.js?v=2026.03.04.7" data-ups-partial="hpm-widget"></script>
```

## Reports Module (use this for Message 9)
```html
<div id="upsReportsMount"></div>
<script>
  (function () {
    var sha = window.UPS_REPORTS_RELEASE_SHA || window.UPS_RELEASE_SHA || "main";
    var s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@" + sha + "/site/reports/mfl_hpm_embed_loader.js?v=2026.03.09.2";
    var anchor = document.currentScript;
    anchor.parentNode.insertBefore(s, anchor);
  })();
</script>
```

## Optional target node form
If you want to mount into an existing element:
```html
<div id="ups-slot-1"></div>
<script
  src="https://cdn.jsdelivr.net/gh/keithcreelman/upsmflproduction@dev/site/loader.js?v=2026.02.15.5"
  data-ups-partial="hpm-default"
  data-ups-target-id="ups-slot-1"></script>
```

## Notes
- Header pulls from `/apps/mfl_site/header_custom_v2.html`.
- Footer pulls from `/apps/mfl_site/footer_custom_v2.html`.
- HPM default pulls from `/site/hpm-default.html`.
- Reports Module HPM uses `/site/reports/mfl_hpm_embed_loader.js`.
- `/site/hpm-reports.html` remains available as a compatibility partial for the shared loader.
- Bump the `v=` value to force cache refresh in MFL.
- For production, switch `@dev` to `@main`.
