// A deliberately tiny DOM: just enough for the shared 3-way view + the real mobile /
// desktop view code to run in Node. Elements record innerHTML, listeners and focus.
export function makeEl(id) {
  const listeners = {};
  const el = {
    id: id || "", innerHTML: "", textContent: "", hidden: false, style: {}, disabled: false,
    focused: "", __t3wBound: false,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    contains() { return true },
    querySelector(sel) { const m = /data-t3w-act="([^"]+)"/.exec(sel); return m && el.innerHTML.includes(`data-t3w-act="${m[1]}"`) ? { focus() { el.focused = m[1]; } } : null; },
    querySelectorAll() { return []; },
    // Build a synthetic element from a rendered tag's OWN attributes (any data-* attribute a
    // real getAttribute() call could ask for, not just data-t3w-act/-id) -- shared by click()
    // and check() below.
    // Build a synthetic element from a rendered tag's OWN attributes (any data-* attribute a
    // real getAttribute() call could ask for, not just data-t3w-act/-id) -- shared by click()
    // and check() below. `overrides` wins over whatever the tag itself carries (click()'s
    // tradeId parameter, when a caller wants a specific id regardless of what rendered).
    __attrsFrom(tagHtml, overrides) {
      const attrs = {};
      for (const m of tagHtml.matchAll(/([a-zA-Z0-9-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
      Object.assign(attrs, overrides || {});
      return { disabled: /\sdisabled(\s|>)/.test(tagHtml), getAttribute: (a) => (a in attrs ? attrs[a] : null) };
    },
    // Simulate a user click on the [data-t3w-act=act] button currently rendered in this element.
    click(act, tradeId) {
      if (!el.innerHTML.includes(`data-t3w-act="${act}"`)) throw new Error(`no "${act}" button is rendered (UI would not offer it)`);
      const btnHtml = new RegExp(`<button[^>]*data-t3w-act="${act}"[^>]*>`).exec(el.innerHTML)[0];
      const btn = el.__attrsFrom(btnHtml, tradeId ? { "data-t3w-id": tradeId } : null);
      const ev = { target: { closest: () => btn }, preventDefault() {} };
      (listeners.click || []).forEach((fn) => fn(ev));
    },
    // Simulate checking/unchecking a rendered <input data-t3w-drop-pid="pid">, dispatching a
    // "change" event to whatever listener(s) are bound on this element (the shared
    // renderLoadedContractDrops picker's own checkboxes -- see site/shared/trade_3way_view.js).
    check(pid, checked) {
      const re = new RegExp(`<input[^>]*data-t3w-drop-pid="${pid}"[^>]*>`);
      const m = re.exec(el.innerHTML);
      if (!m) throw new Error(`no checkbox for candidate "${pid}" is rendered`);
      const box = el.__attrsFrom(m[0]);
      box.checked = checked;
      box.closest = (sel) => (sel.includes("data-t3w-drop-pid") ? box : null);
      box.matches = (sel) => sel.includes("data-t3w-drop-pid");
      const ev = { target: box };
      (listeners.change || []).forEach((fn) => fn(ev));
    },
    has(act) { return el.innerHTML.includes(`data-t3w-act="${act}"`); },
  };
  return el;
}
export const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
