// TEMPORARY local check harness (deleted before finishing): drives headless Chrome over a pipe (no sockets, no network).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { writeFileSync } from "node:fs";
import path from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const prof = path.resolve(".tmp_chrome_profile");
const shots = path.resolve(".tmp_shots");
mkdirSync(shots, { recursive: true });
const url = process.argv[2];
const scenario = process.argv[3] || "layout";

const child = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-pipe", `--user-data-dir=${prof}`, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
const toChrome = child.stdio[3], fromChrome = child.stdio[4];
let id = 0, buf = "";
const pending = new Map(), listeners = [];
fromChrome.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\0")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
    else listeners.forEach((l) => l(msg));
  }
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const n = ++id; pending.set(n, { res, rej }); toChrome.write(JSON.stringify({ id: n, method, params, sessionId }) + "\0"); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S("Page.enable"); await S("Runtime.enable");
const ev = async (expr) => { const r = await S("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
async function view(w, h, dark) {
  await S("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: w < 700 });
  await S("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
}
async function load() { await S("Page.navigate", { url }); await sleep(900); }
async function shot(name) {
  const m = await S("Page.getLayoutMetrics");
  const h = Math.ceil(m.cssContentSize.height), w = Math.ceil(m.cssContentSize.width);
  const r = await S("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: Math.min(h, 6000), scale: 1 } });
  writeFileSync(path.join(shots, name + ".png"), Buffer.from(r.data, "base64"));
}
const show = (name) => ev(`(function(){var g=document.getElementById('pv-gallery');g.value=${JSON.stringify(name)};g.dispatchEvent(new Event('change'));return document.querySelector('.ud-card')?document.querySelector('.ud-card').dataset.state:'none'})()`);

const AUDIT = `(function(){
  var out={sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,small:[]};
  document.querySelectorAll('.ud-root button, .ud-root summary, .ud-root select, .ud-root input, .ud-root textarea').forEach(function(b){
    if(b.classList.contains('ud-fact')) return;
    var r=b.getBoundingClientRect(); if(r.width===0&&r.height===0) return;
    if(r.height<43.5||r.width<43.5) out.small.push((b.className||b.tagName)+' '+Math.round(r.width)+'x'+Math.round(r.height)+' '+(b.textContent||'').slice(0,20));
  });
  var over=[]; document.querySelectorAll('.ud-card *').forEach(function(e){var r=e.getBoundingClientRect(); if(r.right>document.documentElement.clientWidth+1 && !e.closest('.ud-scroll')) over.push(e.className+' '+Math.round(r.right));});
  out.over=over.slice(0,5);
  return out;})()`;

try {
  if (scenario === "layout") {
    const names = JSON.parse(await (async () => { await view(375, 900, false); await load(); return ev(`JSON.stringify(Array.from(document.querySelectorAll('#pv-gallery option')).map(o=>o.value).filter(Boolean))`); })());
    for (const w of [320, 375]) {
      for (const dark of [false, true]) {
        await view(w, 900, dark); await load();
        let bad = 0;
        for (const n of names) {
          const st = await show(n); await sleep(30);
          const a = await ev(AUDIT);
          if (a.sw > a.cw || a.small.length || a.over.length) { bad++; console.log(w, dark ? "dark" : "light", n, JSON.stringify(a)); }
          if (!dark && (n === "answer_with_gap" || n === "partial" || n === "needs_ruling" || n === "answer_with_conflict" || n === "cap_penalty_quote" || n === "tool_failure")) await shot(`${w}_${n}`);
          if (dark && (n === "partial" || n === "needs_ruling")) await shot(`${w}_dark_${n}`);
        }
        console.log(`width ${w} ${dark ? "dark" : "light"}: ${names.length} cards audited, ${bad} with findings`);
      }
    }
    await view(375, 900, false); await load(); await shot("375_home");
  } else if (scenario === "wide") {
    await view(320, 900, false); await load();
    console.log(await ev(`(function(){var o=[];document.querySelectorAll('body *').forEach(function(e){var r=e.getBoundingClientRect();if(r.right>321)o.push(e.tagName+'.'+e.className+' '+Math.round(r.left)+'-'+Math.round(r.right))});return o.slice(0,12).join('\\n')})()`));
  } else if (scenario === "flow") {
    await view(375, 900, false); await load();
    console.log("suggest buttons:", await ev(`document.querySelectorAll('[data-act=suggest]').length`));
    await ev(`document.querySelector('[data-act=suggest]').click()`);
    await sleep(300);
    console.log("busy:", await ev(`JSON.stringify({ask:document.querySelector('[data-role=ask]').disabled, sug:document.querySelector('[data-act=suggest]').disabled, prog:!document.querySelector('[data-role=progress]').hidden, aria:document.querySelector('.ud-root').getAttribute('aria-busy')})`));
    await shot("flow_busy");
    await sleep(1700);
    console.log("after:", await ev(`JSON.stringify({state:document.querySelector('.ud-card').dataset.state, ask:document.querySelector('[data-role=ask]').disabled, hist:document.querySelectorAll('.ud-hist').length, prog:document.querySelector('[data-role=progress]').hidden})`));
    // chip -> drawer
    await ev(`document.querySelector('.ud-fact').click()`);
    console.log("drawer:", await ev(`JSON.stringify({open:!document.querySelector('[data-role=drawer]').hidden, title:document.querySelector('#ud-drawer-t')&&document.querySelector('#ud-drawer-t').textContent, text:document.querySelector('.ud-prov').textContent.slice(0,200), focus:document.activeElement.className})`));
    await shot("flow_drawer");
    await ev(`document.querySelector('.ud-drawer-x').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    console.log("drawer closed:", await ev(`document.querySelector('[data-role=drawer]').hidden`));
    // free text
    await ev(`var q=document.querySelector('[data-role=q]');q.value='what happened to the zebra population';document.querySelector('[data-role=form]').dispatchEvent(new Event('submit',{cancelable:true}))`);
    await sleep(2000);
    console.log("free text:", await ev(`document.querySelector('.ud-card').dataset.state`));
    // keyword
    await ev(`var q=document.querySelector('[data-role=q]');q.value='cap penalty if we cut Chris Olave';document.querySelector('[data-role=form]').dispatchEvent(new Event('submit',{cancelable:true}))`);
    await sleep(2000);
    console.log("keyword:", await ev(`document.querySelector('.ud-card').dataset.state+' '+document.querySelector('.ud-lead').textContent.slice(0,80)`));
    // history open
    await ev(`document.querySelectorAll('.ud-hist')[document.querySelectorAll('.ud-hist').length-1].click()`);
    await sleep(200);
    console.log("hist open:", await ev(`document.querySelector('.ud-card').dataset.state+' '+document.querySelector('.ud-qline').textContent`));
    // report
    await ev(`document.querySelector('[data-act=report]').click()`);
    await ev(`document.querySelector('[data-role=note]').value='test'; document.querySelector('[data-act=report-send]').click()`);
    await sleep(100);
    console.log("report:", await ev(`document.querySelector('[data-role=rmsg]').textContent`));
    // as-of date
    await ev(`var s=document.querySelector('[data-role=asof]');s.value='date';s.dispatchEvent(new Event('change'));document.querySelector('[data-role=q]').value='x y z';document.querySelector('[data-role=form]').dispatchEvent(new Event('submit',{cancelable:true}))`);
    console.log("asof msg:", await ev(`document.querySelector('[data-role=msg]').textContent`));
    console.log("errors:", await ev(`String(window.__errs||'none')`));
  }
} finally {
  await send("Browser.close").catch(() => {});
  child.kill();
}
