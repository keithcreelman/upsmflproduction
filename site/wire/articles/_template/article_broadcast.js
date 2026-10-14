/* UPS Wire -- broadcast mode for UPS Center issues. OPT-IN. CANONICAL SOURCE.
 *
 * Inlined verbatim (by `wire.py restyle`) only into articles that carry the
 * [data-wire-bcast] control block, which `wire.py broadcast` inserts from
 * article_broadcast.html.tmpl. Every other article is untouched. Like
 * article_runtime.js it is byte-identical wherever it appears and contains
 * ZERO prose: every label and caption is read from that markup and written
 * with textContent. Non-ASCII is written as \u escapes.
 *
 * Keith 2026-10-14 ("Add a broadcast-style opening experience"):
 *   - Nothing happens until the reader taps Start or the sound switch: no
 *     AudioContext, no sound, no layout change. The issue is complete without
 *     this file, and no audible autoplay is ever attempted.
 *   - Start plays the opening cue, runs the title transition, moves to the
 *     first segment and lights its first two desk lines.
 *   - Later cues fire as their anchor comes into view, ONCE each per page view:
 *     scrolling back never replays one, and a cue reached while muted is spent
 *     silently. Every cue shows a caption, so sound is never required.
 *   - One sound switch, remembered across reloads (localStorage; inside the
 *     sandboxed MFL frame, where storage is unavailable, the choice is posted
 *     to the loader and read back from UPS_WIRE_PREFS). After a reload the
 *     browser needs a fresh tap, so Start returns; nothing plays on its own.
 *   - Audio stops when the page is hidden and is released when it is left.
 *
 * All sound is synthesized here with Web Audio: original cues, no files, no
 * network, nothing to license. The cue names (opening, boomer, transition,
 * kenny, closing) are the seam where licensed recordings could replace them.
 *
 * window.__upsBcast exposes state() and an event list for the layout and
 * behavior checks in docs/wire/2026-wk05/build/; it changes nothing.
 */
(function () {
  "use strict";

  var root = document.querySelector("[data-wire-bcast]");
  if (!root) return;

  var AC = window.AudioContext || window.webkitAudioContext;
  var embedded = false;
  try { embedded = window.parent !== window; } catch (e) { embedded = true; }
  // The MFL loader sets UPS_WIRE_ROUTE when it injects an article (the same
  // test article_runtime.js uses). Only that frame is sized to its content, so
  // only there can a fixed control not follow the reader. A Claude Artifact is
  // framed too, but it scrolls itself and keeps the pinned switch.
  var inMfl = embedded && typeof window.UPS_WIRE_ROUTE === "string";
  var reduce = false;
  try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  var events = [];
  function note(type, detail) { events.push({ at: Date.now(), type: type, detail: detail || "" }); }

  // ---- the reader's sound choice ------------------------------------------
  var KEY = "upsWire.sound";
  function readPref() {
    try {
      var v = window.localStorage.getItem(KEY);
      if (v === "on" || v === "off") return v;
    } catch (e) {}
    var p = window.UPS_WIRE_PREFS;
    if (p && (p.sound === "on" || p.sound === "off")) return p.sound;
    return "on";
  }
  function writePref(v) {
    try { window.localStorage.setItem(KEY, v); } catch (e) {}
    if (embedded) {
      try { window.parent.postMessage({ type: "wire-pref", key: "sound", value: v }, "*"); } catch (e) {}
    }
  }

  var muted = readPref() === "off";
  var started = false;
  var ctx = null, master = null, noiseBuf = null, current = null;
  var played = {}, visible = {};

  window.__upsBcast = {
    events: events,
    state: function () {
      return { started: started, muted: muted, ctx: ctx ? ctx.state : "none",
               played: Object.keys(played), embedded: embedded, inMfl: inMfl };
    }
  };

  // ---- markup --------------------------------------------------------------
  var startBtn = root.querySelector("[data-bcast-start]");
  var dock = root.querySelector("[data-bcast-dock]");
  var caption = root.querySelector("[data-bcast-caption]");
  var toggles = [].slice.call(root.querySelectorAll("[data-bcast-toggle]"));
  var captions = {};
  var capTmpl = root.querySelector("template[data-bcast-captions]");
  if (capTmpl && capTmpl.content) {
    [].slice.call(capTmpl.content.querySelectorAll("[data-cap]")).forEach(function (el) {
      captions[el.getAttribute("data-cap")] = el.textContent;
    });
  }
  var secs = [].slice.call(document.querySelectorAll(".wire-sec"));

  var docEl = document.documentElement;
  function render() {
    // On <html>, not the block: the switch also appears in segment labels.
    docEl.classList.toggle("bcast-muted", muted);
    docEl.classList.toggle("bcast-on", started);
    toggles.forEach(function (b) { b.setAttribute("aria-pressed", muted ? "false" : "true"); });
    if (dock) {
      if (started) dock.removeAttribute("hidden"); else dock.setAttribute("hidden", "");
    }
  }

  // ---- audio engine --------------------------------------------------------
  function unlock() {
    if (!AC) { note("no-webaudio"); return; }
    if (!ctx) {
      try { ctx = new AC(); } catch (e) { ctx = null; note("ctx-failed"); return; }
      master = ctx.createGain();
      master.gain.value = 0.55;
      var comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      master.connect(comp);
      comp.connect(ctx.destination);
      // iOS Safari: playing one silent sample inside the tap unlocks output.
      try {
        var b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource();
        s.buffer = b; s.connect(ctx.destination); s.start(0);
      } catch (e) {}
      note("ctx-created");
    }
    if (ctx.state !== "running") {
      try { var p = ctx.resume(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
    }
  }

  function m2f(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  function noise() {
    if (noiseBuf) return noiseBuf;
    var len = Math.floor(ctx.sampleRate * 2), b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
    var seed = 12345;
    for (var i = 0; i < len; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; d[i] = seed / 0x3fffffff - 1; }
    noiseBuf = b;
    return b;
  }
  function amp(out) { var g = ctx.createGain(); g.gain.value = 0.0001; g.connect(out); return g; }
  function hit(g, t, peak, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  }
  function noiseThrough(t, dur, filterType, freq, q, out) {
    var f = ctx.createBiquadFilter();
    f.type = filterType; f.frequency.value = freq; f.Q.value = q;
    var s = ctx.createBufferSource();
    s.buffer = noise(); s.connect(f); f.connect(out);
    s.start(t); s.stop(t + dur);
    return f;
  }
  function kick(t, out, v) {
    var o = ctx.createOscillator(), g = amp(out);
    o.type = "sine";
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    hit(g, t, 0.9 * (v || 1), 0.38);
    o.connect(g); o.start(t); o.stop(t + 0.42);
  }
  function snare(t, out, v) {
    var g = amp(out);
    noiseThrough(t, 0.22, "bandpass", 1900, 0.7, g);
    hit(g, t, 0.5 * (v || 1), 0.2);
    var o = ctx.createOscillator(), g2 = amp(out);
    o.type = "triangle"; o.frequency.value = 190;
    hit(g2, t, 0.3 * (v || 1), 0.09);
    o.connect(g2); o.start(t); o.stop(t + 0.11);
  }
  function hat(t, out, v) {
    var g = amp(out);
    noiseThrough(t, 0.06, "highpass", 7000, 0.7, g);
    hit(g, t, 0.18 * (v || 1), 0.05);
  }
  function crash(t, out, len) {
    var g = amp(out);
    noiseThrough(t, len + 0.05, "highpass", 3500, 0.5, g);
    hit(g, t, 0.32, len);
  }
  function whoosh(t, out, dur, up) {
    var g = amp(out);
    var f = noiseThrough(t, dur + 0.05, "bandpass", up ? 300 : 3500, 1.4, g);
    f.frequency.setValueAtTime(up ? 300 : 3500, t);
    f.frequency.exponentialRampToValueAtTime(up ? 3500 : 300, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + dur * 0.85);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  function tom(t, out, f0) {
    var o = ctx.createOscillator(), g = amp(out);
    o.type = "sine";
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.6, t + 0.25);
    hit(g, t, 0.7, 0.3);
    o.connect(g); o.start(t); o.stop(t + 0.32);
  }
  function blip(t, out, f1, f2, dur) {
    var o = ctx.createOscillator(), g = amp(out);
    o.type = "square";
    o.frequency.setValueAtTime(f1, t);
    o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    hit(g, t, 0.08, dur);
    o.connect(g); o.start(t); o.stop(t + dur + 0.02);
  }
  function brass(t, out, notes, dur, v) {
    var f = ctx.createBiquadFilter();
    f.type = "lowpass"; f.Q.value = 1.2;
    f.frequency.setValueAtTime(350, t);
    f.frequency.exponentialRampToValueAtTime(2600, t + 0.05);
    f.frequency.exponentialRampToValueAtTime(1100, t + Math.max(0.1, Math.min(dur, 0.5)));
    var g = amp(out);
    f.connect(g);
    var peak = 0.22 * (v || 1) / Math.sqrt(notes.length);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.018);
    g.gain.linearRampToValueAtTime(peak * 0.75, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.25);
    notes.forEach(function (m) {
      [-7, 7].forEach(function (cents) {
        var o = ctx.createOscillator();
        o.type = "sawtooth"; o.frequency.value = m2f(m); o.detune.value = cents;
        o.connect(f); o.start(t); o.stop(t + dur + 0.3);
      });
    });
  }
  function clink(t, out, v) {
    [[2637, 0.25], [4186, 0.18], [5274, 0.12]].forEach(function (p) {
      var o = ctx.createOscillator(), g = amp(out);
      o.type = "sine"; o.frequency.value = p[0];
      hit(g, t, 0.12 * (v || 1), p[1]);
      o.connect(g); o.start(t); o.stop(t + p[1] + 0.02);
    });
  }
  function pluck(t, out, freq) {
    var o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = amp(out);
    o.type = "triangle"; o.frequency.value = freq;
    f.type = "lowpass"; f.frequency.value = 1800;
    hit(g, t, 0.3, 0.35);
    o.connect(f); f.connect(g); o.start(t); o.stop(t + 0.38);
  }

  // Each cue schedules itself from t and returns its end time. Original
  // material: a stepwise rising stab figure over a drum fill (opening), a
  // rapid hi-hat/blip run into a hit (Boomer), a whoosh and tom pickup into
  // one stab (transition), a cup clink and a falling minor third (Kenny), and
  // the opening figure turned downward into a long final chord (closing).
  var CUES = {
    opening: function (t, out) {
      kick(t, out); crash(t, out, 1.0); brass(t, out, [48, 55, 60, 64], 0.22, 1);
      brass(t + 0.30, out, [50, 57, 62, 65], 0.12, 0.85); snare(t + 0.30, out, 0.7);
      brass(t + 0.45, out, [52, 59, 64, 67], 0.12, 0.9);
      kick(t + 0.60, out, 0.8);
      for (var i = 0; i < 8; i++) snare(t + 0.75 + i * 0.075, out, 0.35 + i * 0.08);
      whoosh(t + 0.70, out, 0.7, true);
      kick(t + 1.40, out); crash(t + 1.40, out, 0.9); brass(t + 1.40, out, [53, 60, 65, 69, 72], 0.42, 1);
      brass(t + 1.95, out, [55, 62, 67, 71, 74], 0.16, 0.9); snare(t + 1.95, out, 0.8);
      kick(t + 2.20, out); crash(t + 2.20, out, 1.6); brass(t + 2.20, out, [48, 55, 60, 64, 67, 72], 0.9, 1.1);
      return t + 3.4;
    },
    boomer: function (t, out) {
      for (var i = 0; i < 17; i++) hat(t + i * 0.07, out, i % 2 ? 0.5 : 0.9);
      [0, 0.28, 0.56, 0.84].forEach(function (d) { kick(t + d, out, 0.8); });
      [0, 0.28, 0.56].forEach(function (d, i) { blip(t + d + 0.02, out, 330 * (i + 1), 600 * (i + 1), 0.16); });
      [1.05, 1.12, 1.19, 1.26].forEach(function (d, i) { snare(t + d, out, 0.6 + i * 0.1); });
      whoosh(t + 0.85, out, 0.5, true);
      kick(t + 1.36, out); crash(t + 1.36, out, 0.8); brass(t + 1.36, out, [57, 64, 69, 73], 0.25, 1);
      return t + 2.2;
    },
    transition: function (t, out) {
      whoosh(t, out, 0.45, true); tom(t + 0.05, out, 150); tom(t + 0.22, out, 110);
      kick(t + 0.42, out); crash(t + 0.42, out, 0.7); brass(t + 0.42, out, [50, 57, 62, 65], 0.3, 0.9);
      return t + 1.4;
    },
    kenny: function (t, out) {
      clink(t, out, 1); clink(t + 0.12, out, 0.7);
      pluck(t + 0.32, out, m2f(76)); pluck(t + 0.50, out, m2f(73));
      return t + 1.0;
    },
    closing: function (t, out) {
      brass(t, out, [55, 62, 67, 71], 0.22, 0.9); kick(t, out, 0.7);
      brass(t + 0.35, out, [53, 60, 65, 69], 0.22, 0.9); kick(t + 0.35, out, 0.7);
      brass(t + 0.70, out, [52, 59, 64, 67], 0.22, 0.9); snare(t + 0.70, out, 0.7);
      whoosh(t + 0.60, out, 0.45, true);
      kick(t + 1.05, out); crash(t + 1.05, out, 2.2); brass(t + 1.05, out, [48, 55, 60, 64, 67, 72], 1.4, 1.1);
      return t + 3.2;
    }
  };

  function stopCurrent() {
    if (!current || !ctx) { current = null; return; }
    var bus = current.bus, now = ctx.currentTime;
    try {
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(bus.gain.value, now);
      bus.gain.linearRampToValueAtTime(0, now + 0.08);
    } catch (e) {}
    setTimeout(function () { try { bus.disconnect(); } catch (e) {} }, 200);
    current = null;
  }

  var capTimer = 0;
  function showCaption(name, seconds) {
    if (!caption) return;
    caption.textContent = captions[name] || "";
    caption.classList.add("on");
    clearTimeout(capTimer);
    capTimer = setTimeout(function () { caption.classList.remove("on"); }, Math.round(seconds * 1000) + 600);
  }

  var LENGTH = { opening: 3.4, boomer: 2.2, transition: 1.4, kenny: 1.0, closing: 3.2 };
  function playCue(name) {
    showCaption(name, LENGTH[name] || 1.5);
    if (muted || !ctx || !CUES[name]) { note("cue-silent", name); return; }
    unlock();
    stopCurrent();
    var bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(master);
    var end = CUES[name](ctx.currentTime + 0.03, bus);
    current = { bus: bus, end: end };
    note("cue", name);
  }

  // ---- where cues live ------------------------------------------------------
  var anchors = {};
  function anchor(el, cue, id) {
    if (!el || anchors[id]) return;
    anchors[id] = { el: el, cue: cue };
    el.setAttribute("data-bcast-anchor", id);
  }
  (root.getAttribute("data-cue-transition") || "").split(/\s+/).forEach(function (sid) {
    var s = sid && document.getElementById(sid);
    if (s) anchor(s.querySelector(".label") || s, "transition", "transition:" + sid);
  });
  anchor(document.querySelector(".wire-sec .lt.boomer"), "boomer", "boomer");
  secs.forEach(function (s) { if (s.id) anchor(s.querySelector(".lt.kenny"), "kenny", "kenny:" + s.id); });
  var closeSec = document.getElementById(root.getAttribute("data-cue-closing") || "");
  if (closeSec) {
    var lts = closeSec.querySelectorAll(".lt");
    if (lts.length) anchor(lts[lts.length - 1], "closing", "closing");
  }

  function fire(id) {
    if (!started || played[id] || !anchors[id]) return;
    played[id] = 1;
    playCue(anchors[id].cue);
  }
  // The implicit root is the top-level viewport even inside the MFL frame, so
  // "in view" means on the reader's screen, not merely inside a tall iframe.
  var io = null;
  if ("IntersectionObserver" in window) {
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var id = en.target.getAttribute("data-bcast-anchor");
        var seen = en.isIntersecting && (en.intersectionRatio >= 0.5 || en.intersectionRect.height >= 120);
        visible[id] = seen;
        if (seen) fire(id);
      });
    }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
    Object.keys(anchors).forEach(function (id) { io.observe(anchors[id].el); });
  }
  // Arming mid-article (the sound switch instead of Start) spends whatever is
  // already on screen, so turning sound on never fires a burst of old cues.
  function spendVisible() {
    Object.keys(visible).forEach(function (id) { if (visible[id]) { played[id] = 1; note("spent", id); } });
  }

  // ---- the show opening -----------------------------------------------------
  function restart(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }
  function onAir(sec) {
    if (!sec) return;
    [].slice.call(sec.querySelectorAll(".lt")).slice(0, 2).forEach(function (el, i) {
      el.style.animationDelay = (reduce ? 0 : 0.9 * i) + "s";
      restart(el, "bcast-onair");
    });
  }
  function goFirst() {
    var pill = document.querySelector(".wire-rail-pill");
    if (pill && docEl.classList.contains("wire-paged")) pill.click();
    var first = secs[0];
    if (first && !embedded) {
      try { first.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }); } catch (e) { first.scrollIntoView(); }
    }
    onAir(first);
  }

  function start() {
    unlock();
    var wasStarted = started;
    started = true;
    docEl.classList.add("bcast-opened");
    if (!wasStarted) note("started", "start");
    render();
    if (!reduce) restart(document.querySelector(".wire-hero"), "bcast-intro");
    playCue("opening");
    setTimeout(goFirst, reduce ? 0 : 1300);
  }

  function toggle() {
    muted = !muted;
    writePref(muted ? "off" : "on");
    if (muted) {
      stopCurrent();
    } else {
      unlock();
      if (!started) { started = true; spendVisible(); note("started", "switch"); }
    }
    render();
    note(muted ? "mute" : "unmute");
  }

  if (startBtn) startBtn.addEventListener("click", start);
  toggles.forEach(function (b) { b.addEventListener("click", toggle); });

  // Inside the auto-sized MFL frame a fixed control cannot follow the reader,
  // so each segment label gets its own copy of the switch once the show starts.
  if (inMfl && toggles.length) {
    docEl.classList.add("bcast-inframe");
    secs.forEach(function (s) {
      var lab = s.querySelector(".label");
      if (!lab) return;
      var c = toggles[0].cloneNode(true);
      c.classList.add("wire-bcast-mini");
      c.addEventListener("click", toggle);
      toggles.push(c);
      lab.appendChild(c);
    });
  }

  // ---- leaving and coming back ----------------------------------------------
  document.addEventListener("visibilitychange", function () {
    if (!ctx) return;
    if (document.hidden) {
      stopCurrent();
      try { var p = ctx.suspend(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
      note("suspended");
    } else if (started && !muted) {
      try { var q = ctx.resume(); if (q && q.catch) q.catch(function () {}); } catch (e) {}
      note("resumed");
    }
  });
  window.addEventListener("pagehide", function () {
    if (!ctx) return;
    stopCurrent();
    try { ctx.close(); } catch (e) {}
    ctx = null; master = null; noiseBuf = null;
    note("closed");
  });
  window.addEventListener("pageshow", function (e) {
    // Back/forward cache: the old audio is gone; wait for a fresh tap.
    if (e.persisted) { started = false; render(); note("restored"); }
  });

  root.removeAttribute("hidden");
  render();
  note("ready", muted ? "off" : "on");
})();
