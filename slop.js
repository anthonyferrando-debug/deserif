/* Deserif: hides AI-slop images on facebook.com.
 *
 * Feed and comment images that are big enough to be content (not avatars,
 * emoji or icons) are handed to the service worker, which downscales them and
 * asks Claude whether they look AI-generated. A slop verdict swaps the image's
 * pixels for a transparent SVG with the same intrinsic size and paints the grey
 * "AI SLOP" card as the element's background, so the layout does not move and
 * nothing is inserted into Facebook's DOM. One click puts the original back.
 * Verdicts are cached by CDN path in the service worker.
 */
(() => {
  'use strict';
  if (window.__deserifSlop) return;
  window.__deserifSlop = true;
  if (window !== window.top) return;

  const ATTR = 'data-deserif-slop';   // pending | blocked | shown | ok
  const MIN_SIDE = 100;               // px; anything smaller is an avatar, emoji or icon
  const NEAR = '900px';               // ask this far ahead of the viewport
  const PENDING_TIMEOUT = 20000;      // fail open when no verdict arrives
  const RETRY_AFTER = 30000;          // after a transient error, ask again on the next scroll-in
  const FBCDN = /^https?:\/\/[^/]*\.fbcdn\.net\//i;
  const STATIC = /\/(?:emoji\.php|rsrc\.php)\//i;
  const BOOST = ':not(#_):not(#_):not(#_)';
  const BLANK_PREFIX = 'data:image/svg+xml';
  const DEFAULTS = { enabled: true, disabledHosts: [], slopEnabled: true, slopThreshold: 60, slopBlur: true };

  // The card: grey box, red prohibition sign, "AI SLOP". Painted as a CSS
  // background on the blocked <img> and scaled by the element's height.
  const CARD = [
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 160'>",
    "<circle cx='100' cy='56' r='38' fill='none' stroke='#e10600' stroke-width='11'/>",
    "<line x1='73.1' y1='29.1' x2='126.9' y2='82.9' stroke='#e10600' stroke-width='11' stroke-linecap='round'/>",
    "<text x='100' y='128' text-anchor='middle' font-family='Helvetica Neue,Helvetica,Arial,sans-serif' font-size='30' font-weight='700' fill='#fff' letter-spacing='2'>AI SLOP</text>",
    "<text x='100' y='150' text-anchor='middle' font-family='Helvetica Neue,Helvetica,Arial,sans-serif' font-size='12' fill='#fff' fill-opacity='.85'>click to show</text>",
    '</svg>'
  ].join('');
  const CARD_URL = 'data:image/svg+xml;utf8,' + encodeURIComponent(CARD);

  let settings = Object.assign({}, DEFAULTS);
  let active = false;   // feature on for this page
  let paused = true;    // on, but waiting for a usable key
  let reason = '';      // why paused: 'nokey' | 'badkey' | ''
  let checked = 0;
  let io = null;
  let sheet = null;
  let statsTimer = 0;
  const state = new WeakMap();   // img -> { url, src, status, ... }
  const tracked = new Set();     // imgs with state, for enumeration
  const SEL = v => `img[${ATTR}="${v}"]`;

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  function send(msg) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, resp => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(resp === undefined ? null : resp);
        });
      } catch (e) { resolve(null); }
    });
  }

  // The src attribute, not currentSrc: after Facebook swaps src on a recycled
  // element, currentSrc still reports the old picture until the next stable state.
  function srcOf(img) {
    const a = img.getAttribute('src') || '';
    return /^https?:/i.test(a) ? a : (img.currentSrc || img.src || '');
  }
  function eligible(url) { return FBCDN.test(url) && !STATIC.test(url); }

  function blankSrc(w, h) {
    return BLANK_PREFIX + ';utf8,' + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'/>`);
  }

  function cssText() {
    let css = `${SEL('blocked')}${BOOST}{background-color:#8a8a8a!important;background-image:url("${CARD_URL}")!important;` +
      'background-position:center!important;background-size:auto min(150px,62%)!important;background-repeat:no-repeat!important;' +
      'cursor:pointer!important;filter:none!important;opacity:1!important;visibility:visible!important;}';
    if (settings.slopBlur) css += `${SEL('pending')}${BOOST}{filter:blur(16px)!important;}`;
    return css;
  }

  function ensureSheet() {
    if (sheet) return;
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(cssText());
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch (e) {
      sheet = document.createElement('style');
      sheet.textContent = cssText();
      (document.head || document.documentElement).appendChild(sheet);
    }
  }

  function updateSheet() {
    if (!sheet) return;
    if (sheet instanceof CSSStyleSheet) sheet.replaceSync(cssText()); else sheet.textContent = cssText();
  }

  /* ------------------------------------------------------------------ */
  /* Tracking                                                            */
  /* ------------------------------------------------------------------ */

  function watch(img) {
    if (!active || state.has(img)) return;
    const url = srcOf(img);
    if (!eligible(url)) return;
    state.set(img, { url, src: img.getAttribute('src'), status: 'new' });
    tracked.add(img);
    io.observe(img);
  }

  function forget(img) {
    const s = state.get(img);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    if (s.status === 'blocked') {
      if (s.title == null) img.removeAttribute('title'); else img.setAttribute('title', s.title);
    }
    img.removeAttribute(ATTR);
    if (io) io.unobserve(img);
    state.delete(img);
    tracked.delete(img);
  }

  // Facebook recycles <img> elements in its virtualised feed, so a src change
  // means "different picture": drop what we knew and start over.
  function onSrcChange(img) {
    const s = state.get(img);
    if (!s) return watch(img);
    const attr = img.getAttribute('src') || '';
    if (s.status === 'blocked') {
      if (img.getAttribute('srcset')) { s.srcset = img.getAttribute('srcset'); img.removeAttribute('srcset'); }
      if (attr.startsWith(BLANK_PREFIX)) return;
      if (attr === s.src) { img.setAttribute('src', blankSrc(s.w, s.h)); return; }   // React put the original back
    } else if (attr === s.src) {
      return;   // srcset or a no-op src write; same picture
    }
    forget(img);
    watch(img);
  }

  function onMutations(records) {
    for (const r of records) {
      if (r.type === 'attributes') {
        if (r.target.tagName === 'IMG') onSrcChange(r.target);
        continue;
      }
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IMG') watch(n);
        else if (n.getElementsByTagName) for (const img of n.getElementsByTagName('img')) watch(img);
      }
    }
  }
  const mo = new MutationObserver(onMutations);

  function onIntersect(entries) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      const s = state.get(img);
      if (!s) { io.unobserve(img); continue; }
      if (s.status === 'error' && Date.now() < s.retryAt) continue;
      if (s.status !== 'new' && s.status !== 'error') continue;
      if (paused) continue;
      const r = e.boundingClientRect;
      let w = r.width, h = r.height;
      if (!w || !h) { w = img.naturalWidth; h = img.naturalHeight; }
      if (!w || !h) {
        if (!s.waitingLoad) {
          s.waitingLoad = true;
          img.addEventListener('load', () => { if (state.get(img) === s && io) { io.unobserve(img); io.observe(img); } }, { once: true });
        }
        continue;
      }
      if (w < MIN_SIDE || h < MIN_SIDE) { s.status = 'small'; io.unobserve(img); continue; }
      ask(img, s);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Verdicts                                                            */
  /* ------------------------------------------------------------------ */

  function ask(img, s) {
    const url = srcOf(img);
    s.url = url;
    s.src = img.getAttribute('src');
    s.status = 'pending';
    img.setAttribute(ATTR, 'pending');
    s.timer = setTimeout(() => settle(img, url, { state: 'timeout' }), PENDING_TIMEOUT);
    send({ type: 'slop:classify', url, alt: (img.getAttribute('alt') || '').slice(0, 300) })
      .then(resp => settle(img, url, resp || { state: 'error' }));
  }

  function settle(img, url, resp) {
    const s = state.get(img);
    if (!s || s.status !== 'pending' || s.url !== url) return;
    clearTimeout(s.timer);
    s.timer = 0;
    if (resp.state === 'nokey' || resp.state === 'badkey') {
      s.status = 'new';
      img.removeAttribute(ATTR);
      idle(resp.state);
      return;
    }
    if (resp.state === 'done') {
      checked++;
      s.slop = !!resp.slop;
      s.confidence = resp.confidence | 0;
      if (s.slop && s.confidence >= settings.slopThreshold) { block(img, s); return; }
      s.status = 'ok';
      img.setAttribute(ATTR, 'ok');
      io.unobserve(img);
      queueStats();
      return;
    }
    if (resp.state === 'skip') {
      s.status = 'ok';
      img.setAttribute(ATTR, 'ok');
      io.unobserve(img);
      return;
    }
    // busy, error, timeout: fail open, try again if it scrolls back in later
    s.status = 'error';
    s.retryAt = Date.now() + RETRY_AFTER;
    img.setAttribute(ATTR, 'ok');
  }

  function block(img, s) {
    s.src = img.getAttribute('src');
    s.srcset = img.hasAttribute('srcset') ? img.getAttribute('srcset') : null;
    s.title = img.hasAttribute('title') ? img.getAttribute('title') : null;
    s.sources = [];
    const pic = img.parentElement;
    if (pic && pic.tagName === 'PICTURE') {
      for (const src of pic.querySelectorAll('source[srcset]')) { s.sources.push([src, src.getAttribute('srcset')]); src.removeAttribute('srcset'); }
    }
    const r = img.getBoundingClientRect();
    s.w = img.naturalWidth || Math.round(r.width) || 400;
    s.h = img.naturalHeight || Math.round(r.height) || 300;
    s.status = 'blocked';
    if (s.srcset != null) img.removeAttribute('srcset');
    img.setAttribute('src', blankSrc(s.w, s.h));
    img.setAttribute('title', 'AI slop hidden by Deserif. Click to show it.');
    img.setAttribute(ATTR, 'blocked');
    if (io) io.unobserve(img);
    queueStats();
  }

  function restore(img, s) {
    if (s.srcset != null) img.setAttribute('srcset', s.srcset);
    for (const [src, val] of s.sources || []) src.setAttribute('srcset', val);
    img.setAttribute('src', s.src);
    if (s.title == null) img.removeAttribute('title'); else img.setAttribute('title', s.title);
  }

  function reveal(img) {
    const s = state.get(img);
    if (!s || s.status !== 'blocked') return;
    s.status = 'shown';
    restore(img, s);
    img.setAttribute(ATTR, 'shown');
    queueStats();
  }

  function rehide(img) {
    const s = state.get(img);
    if (!s || s.status !== 'shown') return;
    block(img, s);
  }

  // Threshold moved: verdicts are kept per element, so no new requests needed.
  function rethreshold() {
    for (const img of tracked) {
      const s = state.get(img);
      if (!s || s.slop === undefined) continue;
      const hide = s.slop && s.confidence >= settings.slopThreshold;
      if (s.status === 'ok' && hide) block(img, s);
      else if (s.status === 'blocked' && !hide) { s.status = 'ok'; restore(img, s); img.setAttribute(ATTR, 'ok'); queueStats(); }
    }
  }

  // Click anywhere on a blocked image (or on whatever Facebook overlays on it)
  // shows the original instead of opening the photo viewer.
  function onClick(e) {
    if (!active) return;
    let img = null;
    const t = e.target;
    if (t && t.nodeType === 1 && t.matches(SEL('blocked'))) img = t;
    else if (typeof e.clientX === 'number') {
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      img = stack.find(el => el.nodeType === 1 && el.matches(SEL('blocked'))) || null;
    }
    if (!img) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    reveal(img);
  }
  document.addEventListener('click', onClick, true);

  /* ------------------------------------------------------------------ */
  /* Stats                                                               */
  /* ------------------------------------------------------------------ */

  function stats() {
    const q = v => document.querySelectorAll(SEL(v)).length;
    return { active, paused, reason, blocked: q('blocked'), shown: q('shown'), pending: q('pending'), checked };
  }

  function queueStats() {
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = 0;
      for (const img of tracked) if (!img.isConnected) { state.delete(img); tracked.delete(img); }
      send({ type: 'slop:stats', blocked: document.querySelectorAll(SEL('blocked')).length });
    }, 250);
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  function idle(why) {
    paused = true;
    reason = why;
    for (const img of document.querySelectorAll(SEL('pending'))) {
      const s = state.get(img);
      if (s) { clearTimeout(s.timer); s.timer = 0; s.status = 'new'; }
      img.removeAttribute(ATTR);
    }
    queueStats();
  }

  function resume() {
    if (!active) return;
    send({ type: 'slop:status' }).then(st => {
      if (!active) return;
      if (!st || !st.hasKey) return idle('nokey');
      if (st.bad) return idle('badkey');
      paused = false;
      reason = '';
      for (const img of tracked) {
        const s = state.get(img);
        if (s && (s.status === 'new' || s.status === 'error')) { s.status = 'new'; io.unobserve(img); io.observe(img); }
      }
      queueStats();
    });
  }

  function start() {
    if (active) return;
    active = true;
    paused = true;
    reason = '';
    ensureSheet();
    io = new IntersectionObserver(onIntersect, { rootMargin: NEAR });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
    for (const img of document.images) watch(img);
    resume();
  }

  function stop() {
    if (!active) return;
    active = false;
    mo.disconnect();
    if (io) io.disconnect();
    io = null;
    for (const img of tracked) {
      const s = state.get(img);
      if (s && s.timer) clearTimeout(s.timer);
      if (s && s.status === 'blocked') restore(img, s);
      img.removeAttribute(ATTR);
      state.delete(img);
    }
    tracked.clear();
    queueStats();
  }

  function shouldRun() {
    return !!(settings.enabled && settings.slopEnabled && !(settings.disabledHosts || []).includes(location.hostname));
  }

  function apply(next) {
    const prev = settings;
    settings = Object.assign({}, DEFAULTS, next);
    if (settings.slopBlur !== prev.slopBlur) updateSheet();
    if (shouldRun()) start(); else stop();
    if (active && settings.slopThreshold !== prev.slopThreshold) rethreshold();
  }

  function load() {
    return new Promise(resolve => {
      try { chrome.storage.sync.get(DEFAULTS, items => resolve(Object.assign({}, DEFAULTS, items || {}))); }
      catch (e) { resolve(Object.assign({}, DEFAULTS)); }
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      const next = Object.assign({}, settings);
      for (const k of Object.keys(changes)) next[k] = changes[k].newValue;
      apply(next);
    } else if (area === 'local' && (changes.slopKey || changes.slopKeyError)) {
      resume();
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('slop:') !== 0) return;
    if (msg.type === 'slop:getStats') sendResponse(stats());
    else if (msg.type === 'slop:recheck') { resume(); sendResponse(stats()); }
    else if (msg.type === 'slop:showAll') { for (const img of document.querySelectorAll(SEL('blocked'))) reveal(img); sendResponse(stats()); }
    else if (msg.type === 'slop:hideAll') { for (const img of document.querySelectorAll(SEL('shown'))) rehide(img); sendResponse(stats()); }
  });

  load().then(apply);
})();
