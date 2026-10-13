// MFL commissioner lockout: read it, and flip it for one action (Keith 2026-10-12,
// "Option 2" for reversing a trade of a forfeited pick).
//
// MFL has no API for league settings. Lockout is one radio button on the
// commissioner page options?L=<league>&O=93 ("Abilities Setup"), which ALSO carries
// every franchise's ability checkboxes. "Save Abilities" submits the whole form, so
// a careless submit could change other abilities. setLockout therefore:
//   1. loads the page with the commissioner cookie (MFL_COOKIE),
//   2. finds exactly one "Commissioner Lockout" radio pair (Yes / No) — else stops,
//   3. re-submits EVERY field exactly as loaded, with only that radio changed,
//   4. re-loads the page and confirms the radio moved AND nothing else differs.
// If anything else differs it re-submits the original fields once and reports
// failure. It never retries blindly.
//
// MFL emails every owner whenever lockout changes (MFL help, "Commissioner Lockout").
// Callers are responsible for when this may run; this module only does it safely.

import { mflCookieHeader, becomeCommissioner, sessionIdentity } from "./mfl_cookie.js";

const _s = (v) => String(v == null ? "" : v);

export function abilitiesUrl(season, leagueId) {
  return `https://www48.myfantasyleague.com/${encodeURIComponent(_s(season))}/options?L=${encodeURIComponent(_s(leagueId))}&O=93`;
}

function cookieHeader(env) {
  const raw = _s(env && env.MFL_COOKIE).trim();
  if (!raw) return "";
  return mflCookieHeader(raw);
}

const decodeEntities = (t) => _s(t)
  .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
// Every MFL page carries the league's custom-header <script> blocks, and those hold
// "<form" / "<input" text inside JS strings (seen 2026-10-13 on the live test-league
// page: 3 such "<form" openers, no closing tag). Parse markup only, or the first
// fake "<form" swallows the real form and its action/method.
export const stripNonMarkup = (html) => _s(html)
  .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
  .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
  .replace(/<!--[\s\S]*?-->/g, "");
const textOf = (html) => decodeEntities(_s(html).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

// Attributes of one start tag: name="v", name='v', name=v, or bare boolean attrs.
export function parseAttrs(tag) {
  const out = {};
  const inner = _s(tag).replace(/^<\s*[a-z0-9]+/i, "").replace(/\/?\s*>$/, "");
  const re = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(inner))) {
    const key = m[1].toLowerCase();
    const val = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : "";
    if (!(key in out)) out[key] = decodeEntities(val);
  }
  return out;
}

// The form a browser would submit, in document order, as [[name, value], ...]:
// text/hidden values; checked checkboxes/radios; each select's selected option(s);
// textareas; and the named "Save" submit control, if it has a name.
export function parseForm(formHtml) {
  const html = _s(formHtml);
  const open = /<form\b[^>]*>/i.exec(html);
  const formAttrs = open ? parseAttrs(open[0]) : {};
  const controls = [];
  const re = /<input\b[^>]*>|<select\b[^>]*>[\s\S]*?<\/select>|<textarea\b[^>]*>[\s\S]*?<\/textarea>|<button\b[^>]*>[\s\S]*?<\/button>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[0];
    const tagName = /^<\s*([a-z]+)/i.exec(raw)[1].toLowerCase();
    const startTag = tagName === "input" ? raw : /^<[^>]*>/.exec(raw)[0];
    const a = parseAttrs(startTag);
    controls.push({ tagName, attrs: a, raw, index: m.index });
  }
  const fields = [];
  const radios = {};
  for (const c of controls) {
    const a = c.attrs;
    const name = a.name;
    if (!name || "disabled" in a) continue;
    if (c.tagName === "input") {
      const type = _s(a.type || "text").toLowerCase();
      if (type === "radio") {
        (radios[name] = radios[name] || []).push({ value: _s(a.value || "on"), checked: "checked" in a, index: c.index });
        if ("checked" in a) fields.push([name, _s(a.value || "on")]);
      } else if (type === "checkbox") {
        if ("checked" in a) fields.push([name, _s(a.value || "on")]);
      } else if (type === "submit" || type === "image") {
        if (/save/i.test(_s(a.value))) fields.push([name, _s(a.value)]);
      } else if (type !== "button" && type !== "reset" && type !== "file") {
        fields.push([name, _s(a.value)]);
      }
    } else if (c.tagName === "select") {
      const opts = [...c.raw.matchAll(/<option\b[^>]*>([\s\S]*?)(?=<option\b|<\/select>)/gi)].map((o) => {
        const oa = parseAttrs(/^<option\b[^>]*>/i.exec(o[0])[0]);
        return { value: "value" in oa ? oa.value : textOf(o[1]), selected: "selected" in oa };
      });
      const sel = opts.filter((o) => o.selected);
      if ("multiple" in a) sel.forEach((o) => fields.push([name, o.value]));
      else if (opts.length) fields.push([name, (sel[0] || opts[0]).value]);
    } else if (c.tagName === "textarea") {
      fields.push([name, decodeEntities(c.raw.replace(/^<textarea\b[^>]*>/i, "").replace(/<\/textarea>$/i, ""))]);
    } else if (c.tagName === "button") {
      const type = _s(a.type || "submit").toLowerCase();
      if (type === "submit" && /save/i.test(textOf(c.raw) + " " + _s(a.value))) fields.push([name, _s(a.value)]);
    }
  }
  return { action: _s(formAttrs.action), method: _s(formAttrs.method || "GET").toUpperCase(), fields, radios };
}

// The Abilities Setup page → its form, plus the lockout radio pair. Fails closed
// (ok:false) unless there is exactly one form mentioning "Commissioner Lockout" and
// exactly one radio group right after that label with one "Yes…" and one "No…".
export function parseAbilitiesPage(html) {
  const page = stripNonMarkup(html);
  const forms = [...page.matchAll(/<form\b[\s\S]*?<\/form>/gi)].map((m) => m[0]).filter((f) => /Commissioner\s+Lockout/i.test(textOf(f)));
  if (forms.length !== 1) return { ok: false, error: forms.length ? "several_lockout_forms" : "lockout_form_not_found" };
  const formHtml = forms[0];
  const form = parseForm(formHtml);
  const labelAt = formHtml.search(/Commissioner\s+Lockout/i);
  const rowEnd = (() => {
    const tail = formHtml.slice(labelAt);
    const stop = tail.search(/<\/tr>|<\/table>|<\/form>/i);
    return labelAt + (stop < 0 ? tail.length : stop);
  })();
  const segment = formHtml.slice(labelAt, rowEnd);
  const radioTags = [...segment.matchAll(/<input\b[^>]*>/gi)]
    .map((m) => ({ a: parseAttrs(m[0]), at: m.index, len: m[0].length }))
    .filter((x) => _s(x.a.type).toLowerCase() === "radio");
  const names = [...new Set(radioTags.map((x) => x.a.name).filter(Boolean))];
  if (radioTags.length !== 2 || names.length !== 1) return { ok: false, error: "lockout_radio_pair_not_found", found: radioTags.length };
  const labelled = radioTags.map((x, i) => {
    const next = i + 1 < radioTags.length ? radioTags[i + 1].at : segment.length;
    return { value: _s(x.a.value || "on"), checked: "checked" in x.a, label: textOf(segment.slice(x.at + x.len, next)) };
  });
  const yes = labelled.filter((r) => /^yes\b/i.test(r.label));
  const no = labelled.filter((r) => /^no\b/i.test(r.label));
  if (yes.length !== 1 || no.length !== 1) return { ok: false, error: "lockout_labels_unrecognised", labels: labelled.map((r) => r.label.slice(0, 40)) };
  const checked = labelled.filter((r) => r.checked);
  if (checked.length !== 1) return { ok: false, error: "lockout_state_unreadable" };
  return {
    ok: true, form,
    lockout: { name: names[0], yesValue: yes[0].value, noValue: no[0].value, current: checked[0].value === yes[0].value ? "Yes" : "No" },
  };
}

// name → sorted values, for every field except `excludeName`.
function fieldMap(fields, excludeName) {
  const m = new Map();
  for (const [k, v] of fields) if (k !== excludeName) m.set(k, [...(m.get(k) || []), v]);
  for (const [k, v] of m) m.set(k, v.slice().sort());
  return m;
}
export function diffFields(beforeFields, afterFields, excludeName) {
  const a = fieldMap(beforeFields, excludeName), b = fieldMap(afterFields, excludeName);
  const out = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = JSON.stringify(a.get(k) || []), y = JSON.stringify(b.get(k) || []);
    if (x !== y) out.push({ field: k, before: a.get(k) || [], after: b.get(k) || [] });
  }
  return out;
}

// Commissioner setup pages this module may read or change. Only "abilities" holds the
// lockout radio; "trades" (Trades Setup, csetup C=TRADES) holds future-pick trading.
export const PAGES = {
  abilities: { url: (season, leagueId) => abilitiesUrl(season, leagueId), formText: /Commissioner\s+Lockout/i },
  trades: { url: (season, leagueId) => `https://www48.myfantasyleague.com/${encodeURIComponent(_s(season))}/csetup?L=${encodeURIComponent(_s(leagueId))}&C=TRADES`, formText: /Future\s+Draft\s+Pick|Trade/i },
};

// The stored session, switched to the league's COMMISSIONER identity for this call
// only (an MFL session starts in owner mode; setup pages refuse it).
async function commissionerCookie(env, { season, leagueId, fetchImpl }) {
  const base = cookieHeader(env);
  if (!base) return { ok: false, error: "no_commissioner_cookie" };
  const r = await becomeCommissioner(base, { season, leagueId, fetchImpl });
  // Everything here but `cookieFor` is sanitized (names, scopes, attributes, lengths,
  // fingerprints); `cookieFor` builds the per-URL header and is never returned.
  const elevation = { set_cookie_names: r.set_cookie_names, set_cookies: r.set_cookies, session_cookie: r.session_cookie,
    user_id_changed: r.user_id_changed, identity_after_switch: r.identity_after_switch, hops: r.hops, hop_log: r.hop_log, attempts: r.attempts };
  return r.ok ? { ok: true, cookieFor: r.cookieFor, elevation } : { ok: false, error: r.error, elevation };
}

async function loadPage(env, { season, leagueId, page, fetchImpl, cookie }) {
  const cfg = PAGES[page];
  if (!cfg) return { ok: false, error: "unknown_page" };
  let ck = cookie, elevation;
  if (!ck) {
    const c = await commissionerCookie(env, { season, leagueId, fetchImpl });
    if (!c.ok) return { ok: false, error: c.error, elevation: c.elevation };
    ck = c.cookieFor; elevation = c.elevation;
  }
  const url = cfg.url(season, leagueId);
  let status = 0, html = "", location = "";
  try {
    // Never follow a redirect: MFL sends a signed-out request to its login page, which
    // must read as "not signed in", not as a page whose form is missing.
    const r = await (fetchImpl || fetch)(url, { headers: { Cookie: typeof ck === "function" ? ck(url) : ck, "User-Agent": "upsmflproduction-worker" }, redirect: "manual" });
    status = r.status;
    location = _s(r.headers && typeof r.headers.get === "function" ? r.headers.get("location") : "");
    html = status >= 300 && status < 400 ? "" : await r.text();
  } catch (e) { return { ok: false, error: `fetch_failed: ${e && e.message}` }; }
  if (status >= 300 && status < 400) {
    let to = ""; try { to = new URL(location, url).pathname; } catch (_) { to = ""; }
    return { ok: false, error: /\/login\b/i.test(to) ? "redirected_to_login" : "redirected", http: status, location_path: to, elevation };
  }
  if (status !== 200) return { ok: false, error: `http_${status}` };
  const markup = stripNonMarkup(html);
  const text = textOf(markup);
  const identity = sessionIdentity(html);
  if (/Commissioner\s+Access\s+Required/i.test(text)) return { ok: false, error: "commissioner_access_required", identity, elevation };
  if (/<input\b[^>]*type\s*=\s*["']?password/i.test(markup) && /\blog\s*in\b/i.test(text) && !cfg.formText.test(text)) return { ok: false, error: "login_page", identity, elevation };
  if (page === "abilities") {
    const p = parseAbilitiesPage(markup);
    return p.ok ? { ok: true, url, form: p.form, lockout: p.lockout, cookie: ck, identity, elevation } : { ok: false, error: p.error, identity, elevation };
  }
  const forms = [...markup.matchAll(/<form\b[\s\S]*?<\/form>/gi)].map((m) => m[0]).filter((f) => cfg.formText.test(textOf(f)) && /save/i.test(f));
  if (forms.length !== 1) return { ok: false, error: forms.length ? "several_forms" : "form_not_found", identity, elevation };
  return { ok: true, url, form: parseForm(forms[0]), cookie: ck, identity, elevation };
}

// Read-only: the Abilities Setup page's lockout state + a summary of the form (no submit).
export async function inspectAbilities(env, { season, leagueId, fetchImpl }) {
  // BEFORE the switch: who MFL serves the stored session as, from the league home page
  // (a plain read — no redirect followed, nothing submitted).
  let before = { identity: "no_cookie" };
  const base = cookieHeader(env);
  if (base) {
    try {
      const r = await (fetchImpl || fetch)(`https://www48.myfantasyleague.com/${encodeURIComponent(_s(season))}/home/${encodeURIComponent(_s(leagueId))}`,
        { headers: { Cookie: base, "User-Agent": "upsmflproduction-worker" }, redirect: "manual" });
      before = r.status >= 300 && r.status < 400 ? { http: r.status, identity: "redirected" } : { http: r.status, identity: sessionIdentity(await r.text()) };
    } catch (e) { before = { identity: "unreadable" }; }
  }
  const p = await loadPage(env, { season, leagueId, page: "abilities", fetchImpl });
  if (!p.ok) return { ok: false, error: p.error, http: p.http, location_path: p.location_path, identity_before: before, identity: p.identity, elevation: p.elevation };
  return { ok: true, identity_before: before, identity: p.identity, elevation: p.elevation, lockout: p.lockout.current, form_action: p.form.action, method: p.form.method, field_count: p.form.fields.length,
    lockout_field: p.lockout.name, radio_groups: Object.keys(p.form.radios).length };
}

// A fingerprint of the page's whole field list (order included), and one that ignores
// the lockout radio — so "the page is exactly as snapshotted" can be checked before a write.
async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function pageDigest(fields, exceptName) {
  return sha256(JSON.stringify((fields || []).filter(([k]) => k !== exceptName)));
}
// Values that could be session material are never returned: shown as a short hash.
const SECRETISH_NAME = /session|token|key|cookie|user_?id|csrf|auth|pass/i;
const SECRETISH_VALUE = /^[A-Za-z0-9+/=_-]{24,}$/;
async function redact(fields) {
  const out = [];
  for (const [k, v] of fields) out.push([k, SECRETISH_NAME.test(k) || SECRETISH_VALUE.test(v) ? `sha256:${(await sha256(v)).slice(0, 12)}` : v]);
  return out;
}

// Read-only snapshot of a setup page: every field as a browser would submit it
// (session-like values hashed), the page fingerprint, and the radio choices.
export async function snapshotPage(env, { season, leagueId, page, fetchImpl }) {
  const p = await loadPage(env, { season, leagueId, page, fetchImpl });
  if (!p.ok) return p;   // failure results never carry the cookie
  const radios = {};
  for (const [k, opts] of Object.entries(p.form.radios)) radios[k] = opts.map((o) => ({ value: o.value, checked: o.checked }));
  return { ok: true, page, field_count: p.form.fields.length, digest: await pageDigest(p.form.fields),
    digest_except_lockout: p.lockout ? await pageDigest(p.form.fields, p.lockout.name) : undefined,
    fields: await redact(p.form.fields), radios, method: p.form.method, lockout: p.lockout ? p.lockout.current : undefined };
}

// Change ONLY the named fields on a setup page (changes: {name: value}; a value of
// null leaves a checkbox unchecked). Every other field is re-sent exactly as loaded.
// Verified by re-reading the page: the changed fields hold their new values and NOTHING
// else differs — otherwise the original form is re-sent once and ok:false comes back.
// expectDigest (optional): the page must match this fingerprint right before the write,
// else nothing is written (Keith 2026-10-12: stop if a page differs from its snapshot).
export async function setPageFields(env, { season, leagueId, page, changes, fetchImpl, expectDigest }) {
  const f = fetchImpl || fetch;
  const before = await loadPage(env, { season, leagueId, page, fetchImpl: f });
  if (!before.ok) return { ok: false, step: "load", error: before.error };
  if (expectDigest && (await pageDigest(before.form.fields)) !== expectDigest) return { ok: false, step: "precheck", error: "page_differs_from_snapshot" };
  const names = Object.keys(changes || {});
  if (!names.length) return { ok: false, step: "validate", error: "no_changes" };
  const known = new Set([...before.form.fields.map(([k]) => k), ...Object.keys(before.form.radios)]);
  const unknown = names.filter((n) => !known.has(n) && changes[n] !== null);
  if (unknown.length && page !== "abilities") return { ok: false, step: "validate", error: "unknown_fields", fields: unknown };
  const want = (fields) => {
    const out = [];
    const placed = new Set();
    for (const [k, v] of fields) {
      if (!names.includes(k)) { out.push([k, v]); continue; }
      if (!placed.has(k)) { placed.add(k); if (changes[k] !== null) out.push([k, String(changes[k])]); }
    }
    for (const k of names) if (!placed.has(k) && changes[k] !== null) out.push([k, String(changes[k])]);
    return out;
  };
  const target = want(before.form.fields);
  if (!diffFields(before.form.fields, target, "").length) return { ok: true, changed: false };
  const action = new URL(before.form.action || before.url, before.url);
  if (!/(^|\.)myfantasyleague\.com$/i.test(action.hostname)) return { ok: false, step: "validate", error: "form_action_off_site" };
  const ck = before.cookie;   // the commissioner session from the load above (per-URL header builder)
  const submit = async (fields) => {
    const body = new URLSearchParams(); for (const [k, v] of fields) body.append(k, v);
    const headers = { Cookie: typeof ck === "function" ? ck(action.toString()) : ck, "User-Agent": "upsmflproduction-worker" };
    if (before.form.method === "POST") {
      return f(action.toString(), { method: "POST", headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
    }
    const u = new URL(action.toString()); for (const [k, v] of body) u.searchParams.append(k, v);
    return f(u.toString(), { headers });
  };
  try { await submit(target); } catch (e) { return { ok: false, step: "submit", error: `fetch_failed: ${e && e.message}` }; }
  const after = await loadPage(env, { season, leagueId, page, fetchImpl: f, cookie: ck });
  if (!after.ok) return { ok: false, step: "verify", error: `reload_failed: ${after.error}` };
  const others = names.reduce((acc, n) => acc.filter(([k]) => k !== n), before.form.fields);
  const othersAfter = names.reduce((acc, n) => acc.filter(([k]) => k !== n), after.form.fields);
  const diff = diffFields(others, othersAfter, "");
  if (diff.length) {
    let restored = false;
    try {
      await submit(before.form.fields);
      const again = await loadPage(env, { season, leagueId, page, fetchImpl: f, cookie: ck });
      restored = !!(again.ok && !diffFields(before.form.fields, again.form.fields, "").length);
    } catch (_) { restored = false; }
    return { ok: false, step: "verify", error: "other_settings_changed", diff: diff.slice(0, 20), restored };
  }
  const wrong = diffFields(target, after.form.fields, "");
  if (wrong.length) return { ok: false, step: "verify", error: "change_did_not_take", diff: wrong.slice(0, 20) };
  return { ok: true, changed: true, page, before: before.form.fields.filter(([k]) => names.includes(k)), after: after.form.fields.filter(([k]) => names.includes(k)),
    digest_after: await pageDigest(after.form.fields) };
}

// Set lockout to `on` (true = Yes). { ok, changed, from, to } or { ok:false, error, ... }.
export async function setLockout(env, { season, leagueId, on, fetchImpl, expectDigest }) {
  const before = await loadPage(env, { season, leagueId, page: "abilities", fetchImpl });
  if (!before.ok) return { ok: false, step: "load", error: before.error };
  const want = on ? "Yes" : "No";
  if (before.lockout.current === want) return { ok: true, changed: false, from: want, to: want };
  const r = await setPageFields(env, { season, leagueId, page: "abilities", fetchImpl, expectDigest,
    changes: { [before.lockout.name]: on ? before.lockout.yesValue : before.lockout.noValue } });
  if (!r.ok) return r;
  return { ok: true, changed: true, from: before.lockout.current, to: want, digest_after: r.digest_after };
}
