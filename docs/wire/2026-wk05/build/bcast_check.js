// Broadcast-mode behavior check for the Week 5 UPS Center draft.
// Runs the same script in Chromium (desktop) and WebKit with iPhone emulation
// (320 and 375 wide). Every assertion is about what a reader would notice.
//   BASE=http://127.0.0.1:8790 NODE_PATH=<node_modules with playwright> node bcast_check.js
const { chromium, webkit, devices } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8790';
const URL = BASE + '/articles/2026/2026-wk05-ups-center.html';
const OUT = process.env.OUT || '.';
const results = [];
function ok(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? '' : JSON.stringify(detail || '').slice(0, 300) });
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(detail || '').slice(0, 300)));
}
const state = (p) => p.evaluate(() => window.__upsBcast.state());
const cues = (p) => p.evaluate(() => window.__upsBcast.events.filter(e => e.type === 'cue' || e.type === 'cue-silent').map(e => e.type + ':' + e.detail));
async function gotoSection(p, i) { await p.click(`.wire-rail-pill >> nth=${i}`); await p.waitForTimeout(250); }
async function scrollTo(p, sel) { await p.evaluate(s => document.querySelector(s).scrollIntoView({ block: 'center' }), sel); await p.waitForTimeout(450); }

async function run(label, browserType, ctxOpts) {
  console.log(`\n== ${label}`);
  const b = await browserType.launch();
  const ctx = await b.newContext(ctxOpts);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  // 1. Nothing happens without a tap; the issue is complete with sound off.
  const t0 = Date.now();
  await p.goto(URL, { waitUntil: 'load' });
  const loadMs = Date.now() - t0;
  await p.waitForTimeout(600);
  let s = await state(p);
  ok(`${label}: no audio before a tap (no AudioContext, nothing armed)`, s.ctx === 'none' && !s.started, s);
  const vis = await p.evaluate(() => ({ start: !!document.querySelector('[data-bcast-start]') && getComputedStyle(document.querySelector('[data-bcast-start]')).display !== 'none',
    secs: document.querySelectorAll('.wire-sec').length, words: [...document.querySelectorAll('.wire-sec')].map(s => s.textContent).join(' ').split(/\s+/).length,
    docScroll: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
  ok(`${label}: Start is visible, all ${vis.secs} segments present, page loaded in ${loadMs} ms`, vis.start && vis.secs === 9 && vis.words > 4000, vis);
  ok(`${label}: no horizontal page overflow with the controls (${vis.docScroll} <= ${vis.vw})`, vis.docScroll <= vis.vw, vis);
  await p.screenshot({ path: `${OUT}/bcast_${label}_1_before.png` });
  // The whole report with sound never touched: "Read all" shows every segment, no audio exists.
  await p.click('.wire-rail-all'); await p.waitForTimeout(200);
  const all = await p.evaluate(() => ({ shown: [...document.querySelectorAll('.wire-sec')].filter(s => getComputedStyle(s).display !== 'none').length,
    ctx: window.__upsBcast.state().ctx, words: document.body.innerText.split(/\s+/).length }));
  ok(`${label}: with sound never touched, Read all shows all 9 segments (${all.words} words on screen), no audio`, all.shown === 9 && all.ctx === 'none' && all.words > 4000, all);
  await p.click('.wire-rail-all'); await p.waitForTimeout(200);

  // 2. Start: opening cue, title transition, then the first segment on air.
  await p.click('[data-bcast-start]');
  await p.waitForTimeout(250);
  s = await state(p);
  const intro = await p.evaluate(() => document.querySelector('.wire-hero').classList.contains('bcast-intro'));
  ok(`${label}: Start creates the audio context inside the tap and plays the opening (ctx ${s.ctx})`, s.started && s.ctx !== 'none' && (await cues(p))[0] === 'cue:opening', { s, c: await cues(p) });
  ok(`${label}: title transition runs`, intro);
  await p.screenshot({ path: `${OUT}/bcast_${label}_2_title.png` });
  await p.waitForTimeout(1700);
  const onair = await p.evaluate(() => [...document.querySelectorAll('#story .lt.bcast-onair .who')].map(x => x.textContent));
  const active = await p.evaluate(() => document.querySelector('.wire-sec.wire-on').id);
  ok(`${label}: moves to The Big Story and lights Stuart then Rich`, active === 'story' && onair.join() === 'Stuart,Rich', { active, onair });
  const dockShown = await p.evaluate(() => { const d = document.querySelector('[data-bcast-dock]'); return !d.hidden && getComputedStyle(d).position; });
  ok(`${label}: the sound switch is pinned on screen after Start`, dockShown === 'fixed', dockShown);
  await p.screenshot({ path: `${OUT}/bcast_${label}_3_onair.png` });

  // 3. Segment sting on entering the Playoff Picture; never twice.
  await gotoSection(p, 1);
  await scrollTo(p, '#odds .label');
  ok(`${label}: Playoff Picture plays the segment sting`, (await cues(p)).includes('cue:transition'), await cues(p));
  await scrollTo(p, '#odds .lt.kenny');
  await gotoSection(p, 0); await gotoSection(p, 1); await scrollTo(p, '#odds .label'); await scrollTo(p, '#odds .lt.kenny');
  let c = await cues(p);
  ok(`${label}: going back and forward does not replay (one sting, one Kenny clink in odds)`, c.filter(x => x === 'cue:transition').length === 1 && c.filter(x => x === 'cue:kenny').length === 1, c);

  // 4. Into Boomer: Heat Check sting, then the highlight package once.
  await gotoSection(p, 2); await scrollTo(p, '#heat .label');
  await gotoSection(p, 3); await scrollTo(p, '#brief .lt.boomer');
  c = await cues(p);
  ok(`${label}: Heat Check sting then Boomer's highlight cue`, c.filter(x => x === 'cue:transition').length === 2 && c.includes('cue:boomer'), c);
  const cap = await p.evaluate(() => document.querySelector('[data-bcast-caption]').textContent);
  ok(`${label}: the cue is captioned on screen ("${cap}")`, /Highlight/.test(cap), cap);
  await p.screenshot({ path: `${OUT}/bcast_${label}_4_boomer.png` });
  await scrollTo(p, '#brief .lt.boomer >> nth=3').catch(() => {});
  await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(300);
  await scrollTo(p, '#brief .lt.boomer');
  ok(`${label}: scrolling back up past Boomer does not replay`, (await cues(p)).filter(x => x === 'cue:boomer').length === 1, await cues(p));

  // 5. Mute: remembered, and cues reached while muted are spent silently.
  await p.click('[data-bcast-dock] [data-bcast-toggle]');
  s = await state(p);
  const pref = await p.evaluate(() => localStorage.getItem('upsWire.sound'));
  ok(`${label}: mute takes effect and is stored`, s.muted && pref === 'off', { s, pref });
  await gotoSection(p, 7); await scrollTo(p, '#survival .lt.kenny');
  await p.evaluate(() => { const l = document.querySelectorAll('#survival .lt'); l[l.length - 1].scrollIntoView({ block: 'center' }); }); await p.waitForTimeout(450);
  c = await cues(p);
  ok(`${label}: while muted, Kenny and the closing theme are captioned but silent`, c.includes('cue-silent:kenny') && c.includes('cue-silent:closing'), c);
  await p.click('[data-bcast-dock] [data-bcast-toggle]');
  s = await state(p);
  ok(`${label}: unmute does not replay anything already reached`, !s.muted && (await cues(p)).length === c.length, { s, c: await cues(p) });

  // 6. Leaving the tab stops sound.
  await p.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await p.waitForTimeout(150);
  ok(`${label}: hiding the page suspends audio`, (await p.evaluate(() => window.__upsBcast.events.map(e => e.type))).includes('suspended') && (await state(p)).ctx !== 'running', await state(p));
  await p.evaluate(() => { delete document.hidden; });

  // 7. Reload: preference remembered, nothing plays, Start returns.
  await p.click('[data-bcast-dock] [data-bcast-toggle]');           // mute again so the stored choice is "off"
  const closed = [];
  p.on('console', m => { if (m.text().startsWith('BCAST-PAGEHIDE')) closed.push(m.text()); });
  await p.evaluate(() => window.addEventListener('pagehide', () => console.log('BCAST-PAGEHIDE ' + JSON.stringify(window.__upsBcast.state()))));
  await p.reload({ waitUntil: 'load' });
  await p.waitForTimeout(500);
  ok(`${label}: leaving the page releases the audio context`, closed.length && /"ctx":"none"/.test(closed[0]), closed);
  s = await state(p);
  const startBack = await p.evaluate(() => getComputedStyle(document.querySelector('[data-bcast-start]')).display !== 'none');
  ok(`${label}: after reload the sound-off choice is remembered, nothing plays, Start is back`, s.muted && !s.started && s.ctx === 'none' && startBack, { s, startBack });
  const pressed = await p.evaluate(() => document.querySelector('[data-bcast-toggle]').getAttribute('aria-pressed'));
  ok(`${label}: the switch shows Sound off`, pressed === 'false', pressed);
  await p.screenshot({ path: `${OUT}/bcast_${label}_5_reload_muted.png` });

  // 8. Sound switch instead of Start, mid-article: nothing already on screen fires.
  await p.click('[data-bcast-toggle]');   // turn sound on from the masthead
  await gotoSection(p, 3); await scrollTo(p, '#brief .lt.boomer');
  c = await cues(p);
  ok(`${label}: arming by the switch, then reaching Boomer plays it once`, c.filter(x => x === 'cue:boomer').length === 1 && !c.includes('cue:opening'), c);

  ok(`${label}: no script errors`, errors.length === 0, errors);
  await b.close();
}

// Framed: inside MFL (the loader sets UPS_WIRE_ROUTE) the switch moves into every
// segment label; in an Artifact-style frame (no route) it stays pinned.
async function framed(label, mfl) {
  console.log(`\n== ${label}`);
  const b = await webkit.launch();
  const ctx = await b.newContext({ ...devices['iPhone 13 mini'], viewport: { width: 375, height: 760 } });
  if (mfl) await ctx.addInitScript(() => { window.UPS_WIRE_ROUTE = '/a/2026-wk05-ups-center'; });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(String(e)));
  await p.goto(BASE + '/');
  await p.setContent(`<iframe src="${URL}" style="width:375px;height:740px;border:0"></iframe>`);
  await p.waitForTimeout(1500);
  const f = p.frames().find(x => x.url().includes('2026-wk05-ups-center'));
  let s = await f.evaluate(() => window.__upsBcast.state());
  ok(`${label}: framed page detected (embedded ${s.embedded}, MFL ${s.inMfl}), no audio before a tap`, s.embedded && s.inMfl === mfl && s.ctx === 'none', s);
  await f.click('[data-bcast-start]');
  await p.waitForTimeout(400);
  const ui = await f.evaluate(() => ({ minis: [...document.querySelectorAll('.wire-bcast-mini')].filter(x => getComputedStyle(x).display !== 'none').length,
    dock: getComputedStyle(document.querySelector('[data-bcast-dock]')).position, ctx: window.__upsBcast.state().ctx }));
  if (mfl) ok(`${label}: a sound switch in each of the 9 segment labels, dock inline`, ui.minis === 9 && ui.dock === 'static', ui);
  else ok(`${label}: switch stays pinned (fixed), no label copies`, ui.minis === 0 && ui.dock === 'fixed', ui);
  ok(`${label}: no script errors`, errors.length === 0, errors);
  await b.close();
}

(async () => {
  await framed('mfl-frame', true);
  await framed('artifact-frame', false);
  await run('desktop', chromium, { viewport: { width: 1280, height: 900 } });
  await run('iphone375', webkit, { ...devices['iPhone 13 mini'], viewport: { width: 375, height: 760 } });
  await run('iphone320', webkit, { ...devices['iPhone SE'], viewport: { width: 320, height: 640 } });
  const fails = results.filter(r => !r.ok);
  require('fs').writeFileSync(OUT + '/bcast_check.json', JSON.stringify(results, null, 1));
  console.log(`\n${results.length} checks, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
})();
