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
    // Simulate a user click on the [data-t3w-act=act] button currently rendered in this element.
    click(act, tradeId) {
      if (!el.innerHTML.includes(`data-t3w-act="${act}"`)) throw new Error(`no "${act}" button is rendered (UI would not offer it)`);
      const btnHtml = new RegExp(`<button[^>]*data-t3w-act="${act}"[^>]*>`).exec(el.innerHTML)[0];
      const btn = { disabled: /\sdisabled(\s|>)/.test(btnHtml), getAttribute: (a) => (a === "data-t3w-act" ? act : a === "data-t3w-id" ? (tradeId || (/data-t3w-id="([^"]+)"/.exec(btnHtml) || [])[1] || "") : null) };
      const ev = { target: { closest: () => btn }, preventDefault() {} };
      (listeners.click || []).forEach((fn) => fn(ev));
    },
    has(act) { return el.innerHTML.includes(`data-t3w-act="${act}"`); },
  };
  return el;
}
export const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
