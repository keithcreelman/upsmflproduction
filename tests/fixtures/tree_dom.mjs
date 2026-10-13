// A small TREE DOM for running real mobile view code in Node with no dependency:
// innerHTML is parsed into elements, so querySelector(All), closest, getElementById,
// bubbling clicks/keys, focus and <select> values behave like a browser for the
// markup our views generate. Selectors: tag, .class, #id, [attr], [attr="v"],
// compounds of those, and descendant chains ("a .b"). No layout (rects are 0).
const VOID = new Set(["br", "img", "input", "meta", "link", "hr", "source", "wbr"]);
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", rsaquo: "›", larr: "←", nbsp: " " };
const decode = (s) => s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => ENT[e] != null ? ENT[e] : (e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : m));

export function makeDocument() {
  const doc = { activeElement: null, focusLog: [] };
  class Node {
    constructor(tag, attrs) {
      this.tagName = (tag || "#text").toUpperCase(); this.attrs = attrs || {}; this.children = []; this.childNodes = [];
      this.parentNode = null; this.listeners = {}; this.style = { setProperty() {} }; this.text = "";
      this.disabled = "disabled" in this.attrs; this.__props = {};
    }
    get id() { return this.attrs.id || ""; }
    get className() { return this.attrs.class || ""; }
    get classList() { const c = (this.attrs.class || "").split(/\s+/).filter(Boolean); return { contains: (x) => c.indexOf(x) >= 0 }; }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    hasAttribute(k) { return k in this.attrs; }
    get innerText() { return this.textContent; }
    get textContent() { return this.tagName === "#TEXT" ? this.text : this.childNodes.map((n) => n.textContent).join(""); }
    get innerHTML() { return this.__html || ""; }
    set innerHTML(h) {
      this.__html = String(h);
      this.children = []; this.childNodes = [];
      parseInto(this, this.__html);
      if (doc.activeElement && !isIn(doc.activeElement)) doc.activeElement = null;
    }
    set outerHTML(h) {
      const p = this.parentNode; if (!p) return;
      const tmp = new Node("div", {}); parseInto(tmp, h);
      const i = p.childNodes.indexOf(this);
      p.childNodes.splice(i, 1, ...tmp.childNodes); tmp.childNodes.forEach((n) => (n.parentNode = p));
      p.children = p.childNodes.filter((n) => n.tagName !== "#TEXT");
    }
    get value() {
      if (this.tagName === "SELECT") { if ("v" in this.__props) return this.__props.v; const o = this.querySelectorAll("option"); const s = o.find((x) => "selected" in x.attrs) || o[0]; return s ? (s.attrs.value != null ? s.attrs.value : s.textContent) : ""; }
      return "v" in this.__props ? this.__props.v : (this.attrs.value || "");
    }
    set value(v) { this.__props.v = String(v); }
    get options() { return this.querySelectorAll("option"); }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
    matches(sel) { return matchChain(this, parseSel(sel)); }
    closest(sel) { const ch = parseSel(sel); for (let n = this; n && n.tagName !== "#ROOT"; n = n.parentNode) if (n.tagName !== "#TEXT" && matchChain(n, ch)) return n; return null; }
    querySelectorAll(sel) {
      const groups = sel.split(",").map((s) => parseSel(s.trim())); const out = [];
      walk(this, (n) => { if (groups.some((g) => matchChain(n, g))) out.push(n); });
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    focus() { doc.activeElement = this; doc.focusLog.push(this); }
    blur() { if (doc.activeElement === this) doc.activeElement = null; }
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
    get offsetHeight() { return 0; }
    get scrollWidth() { return 0; }
    get clientWidth() { return 0; }
    dispatch(type, extra) {
      const ev = Object.assign({ type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.__stop = true; } }, extra || {});
      for (let n = this; n; n = n.parentNode) { (n.listeners[type] || []).slice().forEach((fn) => fn.call(n, ev)); if (ev.__stop) break; }
      return ev;
    }
    click() { return this.dispatch("click"); }
  }
  function isIn(n) { for (; n; n = n.parentNode) if (n === root) return true; return false; }
  function walk(n, fn) { for (const c of n.children) { fn(c); walk(c, fn); } }
  function parseInto(parent, html) {
    const stack = [parent]; const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^\s=>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/g;
    let m;
    while ((m = re.exec(html))) {
      const top = stack[stack.length - 1];
      if (m[4] != null) { const t = new Node("#text"); t.text = decode(m[4]); t.parentNode = top; top.childNodes.push(t); continue; }
      if (m[1]) { for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === m[1].toUpperCase()) { stack.length = i; break; } continue; }
      if (!m[2]) continue;
      const attrs = {};
      for (const a of (m[3] || "").matchAll(/([^\s=>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1]] = decode(a[2] != null ? a[2] : a[3] != null ? a[3] : a[4] != null ? a[4] : "");
      const el = new Node(m[2], attrs); el.parentNode = top; top.children.push(el); top.childNodes.push(el);
      if (!VOID.has(m[2].toLowerCase()) && !/\/>$/.test(m[0])) stack.push(el);
    }
  }
  function parseSel(sel) {
    return sel.trim().split(/\s+/).map((part) => {
      const s = { tag: null, cls: [], attrs: [] };
      const t = /^[a-zA-Z][a-zA-Z0-9]*/.exec(part); if (t) s.tag = t[0].toUpperCase();
      for (const x of part.matchAll(/\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|([^\]]*)))?\]|#([\w-]+)/g)) {
        if (x[1]) s.cls.push(x[1]); else if (x[2]) s.attrs.push([x[2], x[3] != null ? x[3] : x[4]]); else if (x[5]) s.attrs.push(["id", x[5]]);
      }
      return s;
    });
  }
  function matchOne(n, s) {
    if (!n || n.tagName === "#TEXT" || n.tagName === "#ROOT") return false;
    if (s.tag && n.tagName !== s.tag) return false;
    const c = (n.attrs.class || "").split(/\s+/);
    return s.cls.every((x) => c.indexOf(x) >= 0) && s.attrs.every(([k, v]) => k in n.attrs && (v == null || n.attrs[k] === v));
  }
  function matchChain(n, chain, scope) {
    if (!matchOne(n, chain[chain.length - 1])) return false;
    let i = chain.length - 2, p = n.parentNode;
    while (i >= 0 && p && p !== scope) { if (matchOne(p, chain[i])) i--; p = p.parentNode; }
    return i < 0;
  }
  const root = new Node("#root", {});
  const body = new Node("body", {}); body.parentNode = root; root.children.push(body); root.childNodes.push(body);
  doc.body = body;
  doc.createElement = (t) => new Node(t, {});
  doc.getElementById = (id) => { let f = null; walk(root, (n) => { if (!f && n.attrs.id === id) f = n; }); return f; };
  doc.querySelector = (s) => root.querySelector(s);
  doc.querySelectorAll = (s) => root.querySelectorAll(s);
  doc.addEventListener = () => {};
  doc.mount = (id) => { const el = new Node("main", { id }); el.parentNode = body; body.children.push(el); body.childNodes.push(el); return el; };
  return doc;
}
export const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
