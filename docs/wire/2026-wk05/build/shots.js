const { webkit, chromium, devices } = require('playwright');
const SP = process.env.SP, OUT = SP + '/w5data/shots';
const AFTER = 'file://' + SP + '/wt5/site/wire/articles/2026/2026-wk05-ups-center.html';
const BEFORE = 'file://' + SP + '/w5data/auto_draft.html';
const SHOW = `.wire-sec,.wire-gamepage{display:block!important}.wire-rail{display:none!important}`;
(async () => {
  const report = {};
  for (const [label, browserType, ctxOpts] of [
    ['320', webkit, { ...devices['iPhone SE'], viewport: { width: 320, height: 640 } }],
    ['375', webkit, { ...devices['iPhone 13 mini'], viewport: { width: 375, height: 760 } }],
    ['desktop', chromium, { viewport: { width: 1280, height: 900 } }]]) {
    const b = await browserType.launch(); const ctx = await b.newContext(ctxOpts);
    for (const [which, url] of [['before', BEFORE], ['after', AFTER]]) {
      const p = await ctx.newPage(); await p.goto(url, { waitUntil: 'load' }); await p.waitForTimeout(1500);
      await p.screenshot({ path: `${OUT}/${which}_${label}_firstview.png` });
      await p.addStyleTag({ content: SHOW }); await p.waitForTimeout(500);
      const r = await p.evaluate(() => {
        const vw = document.documentElement.clientWidth, out = { vw, docScroll: document.documentElement.scrollWidth, secs: {} };
        document.querySelectorAll('section.wire-sec').forEach(s => {
          const wide = [...s.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > vw + 1 && !el.closest('.tablebox'))
            .slice(0, 4).map(el => el.tagName + '.' + (el.className || '') + ' ' + Math.round(el.getBoundingClientRect().right));
          const tables = [...s.querySelectorAll('.tablebox')].map(t => t.scrollWidth > t.clientWidth + 1 ? (t.scrollWidth + '>' + t.clientWidth) : 'fits');
          out.secs[s.id] = { height: Math.round(s.getBoundingClientRect().height), overflow: wide, tables };
        });
        return out;
      });
      report[`${which}_${label}`] = r;
      if (which === 'after' && label !== 'desktop') {
        for (const id of Object.keys(r.secs)) {
          const el = await p.$('#' + id);
          if (el) await el.screenshot({ path: `${OUT}/after_${label}_${id}.png` });
        }
      }
      await p.close();
    }
    await b.close();
  }
  require('fs').writeFileSync(OUT + '/layout_report.json', JSON.stringify(report, null, 1));
  for (const [k, v] of Object.entries(report)) {
    console.log(k, 'viewport', v.vw, 'docScroll', v.docScroll);
    for (const [id, s] of Object.entries(v.secs)) if (s.overflow.length || s.tables.some(t => t !== 'fits')) console.log('   ', id, JSON.stringify(s));
  }
})().catch(e => { console.error(e); process.exit(1); });
