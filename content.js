/* Deserif content script.
 *
 * Strategy: read each element's computed font-family (which is the author's
 * specified list, e.g. `"Playfair Display", serif`), decide whether the first
 * recognisable family is a serif, and if so tag the element with an attribute.
 * One injected stylesheet maps that attribute to the replacement stack with
 * !important and a very high specificity. Tagging by attribute (instead of
 * writing inline styles) keeps the page's own style attributes untouched, works
 * inside open shadow roots, and makes toggling a one-line operation.
 */
(() => {
  'use strict';
  // One live instance per frame. After the extension is reloaded or updated the
  // old instance is orphaned (its chrome.runtime is gone); it steps aside and
  // the freshly injected one takes over.
  const prev = window.__deserif;
  if (prev && typeof prev === 'object' && prev.alive && prev.alive()) return;
  if (prev && typeof prev === 'object' && prev.retire) { try { prev.retire(); } catch (e) { /* ignore */ } }
  const api = {
    alive: () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } },
    retire: () => {
      if (observer) observer.disconnect();
      started = false;
      try { deactivate(); } catch (e) { /* ignore */ }
      try { chrome.runtime.onMessage.removeListener(onMessage); } catch (e) { /* runtime already gone */ }
      try { chrome.storage.onChanged.removeListener(onStorage); } catch (e) { /* same */ }
    }
  };
  window.__deserif = api;

  const ATTR = 'data-deserif';
  const ATTR_B = 'data-deserif-before';
  const ATTR_A = 'data-deserif-after';
  const BOOST = ':not(#_):not(#_):not(#_)';
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'BASE']);
  const MAX_INCREMENTAL = 4000;   // bigger mutation batches become a full rescan
  const FULL_SCAN_MIN_GAP = 1000; // ms between mutation-triggered full rescans

  const DEFAULTS = {
    enabled: true,
    mode: 'all', // 'all' = every serif, 'ai' = only the AI-favorite list
    stack: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    deitalic: true,
    disabledHosts: []
  };

  /* ------------------------------------------------------------------ */
  /* Font classification                                                 */
  /* ------------------------------------------------------------------ */

  const GENERIC_SERIF = new Set(['serif', 'ui-serif']);
  const GENERIC_KEEP = new Set([
    'sans-serif', 'ui-sans-serif', 'system-ui', 'monospace', 'ui-monospace', 'cursive',
    'fantasy', 'ui-rounded', 'math', 'emoji', 'fangsong', '-webkit-body', '-webkit-pictograph',
    'inherit', 'initial', 'unset', 'revert', 'revert-layer'
  ]);

  // Anything matching this is never touched, even if a serif pattern would also match.
  // Covers sans variants ("Merriweather Sans"), monospace, and icon fonts.
  const PRE_KEEP = /sans|mono|\bcode\b|icon|awesome|glyph|symbol|emoji|material|dingbat|wingding|webding|courier|consolas|menlo|monaco|pictogram/i;

  // The fonts every LLM-generated landing page reaches for.
  const AI_SERIF = [
    '\\bplayfair', '\\binstrument serif', '\\bdm serif', '\\bfraunces', '\\bcormorant', '\\blora\\b',
    '\\bnewsreader', '\\blibre baskerville', '\\blibre caslon', '\\beb garamond', '\\bcrimson',
    '\\bspectral\\b', '\\bliterata', '\\bmerriweather', '\\bsource serif', '\\byoung serif', '\\bgloock',
    '\\bbodoni moda', '\\babril', '\\bprata\\b', '\\bitaliana', '\\bcinzel', '\\bmarcellus', '\\bgambarino',
    '\\bsentient', '\\berode\\b', '\\bzodiak', '\\bboska', '\\brecoleta', '\\beditorial', '\\bmigra\\b',
    '\\bgambetta', '\\bbespoke serif', '\\btiempos', '\\bcanela', '\\bgt super', '\\bsectra', '\\breckless',
    '\\bsignifier', '\\bogg\\b', '\\bnoe\\b', '\\bibm plex serif', '\\bpt serif', '\\bnoto serif',
    '\\broboto serif', '\\broboto slab', '\\bzilla slab', '\\bdomine', '\\bvollkorn', '\\balegreya',
    '\\bcardo\\b', '\\bgelasio', '\\bbitter\\b', '\\bcastoro', '\\bpetrona', '\\bpiazzolla', '\\bbrygada'
  ];

  // Everything else we recognise as a serif (system fonts, classics, slabs, CJK serifs).
  const OTHER_SERIF = [
    'serif', '\\bslab', '\\bgeorgia', '\\btimes\\b', '\\bgaramond', '\\bbaskerville', '\\bcaslon',
    '\\bbodoni', '\\bdidot', '\\bpalatino', '\\bantiqua', '\\bcambria', '\\bconstantia',
    '\\bcentury schoolbook', '\\bnew century', '\\bbookman', '\\bcharter\\b', '\\bathelas', '\\bhoefler',
    '\\biowan', '\\bnew york\\b', '\\bcochin', '\\bgoudy', '\\bminion', '\\bsabon', '\\bbembo', '\\bjenson',
    '\\bjanson', '\\bplantin', '\\bperpetua', '\\brockwell', 'clarendon', '\\bamerican typewriter',
    '\\bbell mt', '\\bcalisto', '\\bcentaur', '\\bcalifornian', '\\bhigh tower', '\\bfootlight', '\\bsitka',
    '\\blucida bright', '\\blucida fax', '\\bstix', '\\bcomputer modern', '\\blatin modern',
    '\\bnimbus roman', '\\btermes', '\\bpagella', '\\bschola', '\\bbonum', '\\blibertin', '\\butopia',
    '\\bwarnock', '\\barno\\b', '\\bscala\\b', '\\bfreight', '\\badelle', '\\barcher\\b', '\\bsentinel',
    '\\bchronicle', '\\bmercury', '\\bmiller\\b', '\\bsurveyor', '\\blyon\\b', '\\bpublico', '\\bivar\\b',
    '\\bdomaine', '\\bfinancier', '\\bbutler\\b', '\\broslindale', '\\btobias', '\\blouize', '\\bmencken',
    '\\bself modern', '\\btinos', '\\bold standard', '\\bibarra', '\\bfrank ruhl', '\\bdavid libre',
    '\\barvo\\b', '\\brokkitt', '\\baleo\\b', '\\bkreon', '\\bcrete round', '\\benriqueta', '\\btrocchi',
    '\\bkameron', '\\bsanchez', '\\bpodkova', '\\bglegoo', '\\bcopse', '\\bcoustard', '\\bneuton',
    '\\bjudson', '\\blusitana', '\\besteban', '\\bfenix', '\\bgilda', '\\bhabibi', '\\binika', '\\bjunge',
    '\\bledger', '\\bmate\\b', '\\bmontaga', '\\bquando', '\\brosarivo', '\\bvidaloka', '\\bvesper',
    '\\bbentham', '\\bcaudex', '\\bdella respira', '\\blinden hill', '\\bfanwood', '\\bim fell',
    '\\bgentium', '\\bbrawler', '\\bbuenard', '\\barapey', '\\bradley', '\\brufina', '\\bovo\\b',
    '\\bunna\\b', '\\blustria', '\\byeseva', '\\bbona nova', '\\bimbue', '\\bandada', '\\balice\\b',
    '\\bkurale', '\\boranienbaum', 'myeongjo', 'myungjo', 'mincho', '\\bbatang', '\\bsong myung',
    '\\bsongti', '\\bstsong', '\\bsimsun', '\\bmingliu', '\\bxiaowei', '\\bzen antique', '\\bamiri',
    '\\bscheherazade', '\\bnaskh', '\\btiro\\b', '\\bmartel\\b', '\\bhalant', '\\brozha', '\\bsahitya',
    '\\bsumana', '\\bkarma\\b', '\\brasa\\b', '\\byrsa', '\\beczar', '\\bsuranna', '\\bultra\\b',
    '\\bbevan', '\\bpatua', '\\bnoticia', '\\btrajan', '\\bforum\\b', '\\bpridi', '\\btaviraj',
    '\\btrirong', '\\bmaitree', '\\bchonburi', '\\bkaisei', '\\bshippori'
  ];

  // Known non-serif families: stop evaluating the stack here.
  const KEEP = [
    'helvetica', 'arial', '\\binter\\b', 'roboto', 'segoe', 'apple-system', 'blinkmacsystemfont',
    'san francisco', '\\bsf pro', 'verdana', 'tahoma', 'geneva', 'futura', 'avenir', '\\bgill\\b',
    'ubuntu', '\\blato\\b', 'montserrat', 'poppins', 'manrope', 'plus jakarta', '\\boutfit\\b',
    'grotesk', 'grotesque', '\\bsora\\b', 'figtree', '\\bgeist\\b', 'satoshi', 'switzer', 's[oö]hne',
    'graphik', 'circular', 'gt america', 'gt walsheim', 'neue haas', 'univers', 'akzidenz', 'franklin',
    'proxima', 'gotham', 'brandon', 'raleway', 'nunito', 'rubik', 'karla', 'mulish', 'quicksand',
    'barlow', 'oswald', 'bebas', '\\banton\\b', 'spartan', 'archivo', 'cantarell', 'lucida grande',
    'lucida console', 'trebuchet', 'century gothic', 'optima', 'myriad', 'calibri', 'candara', 'corbel',
    'whitney', 'tungsten', 'ringside', 'suisse', 'aktiv', 'acumin', 'neuzeit', '\\bdin\\b', 'jetbrains',
    'cascadia', '\\bhack\\b', 'inconsolata', 'overpass', 'heebo', 'assistant', 'varela', 'questrial',
    'urbanist', 'lexend', 'be vietnam', 'red hat', 'epilogue', '\\bsyne\\b', 'chivo', 'commissioner',
    'kumbh', '\\bjost\\b', 'onest', 'golos', 'unbounded', 'hanken', 'bricolage', 'schibsted',
    'wix madefor', 'atkinson', 'readex', 'gabarito', 'afacad', 'rethink', 'funnel', 'mozilla',
    'google sans', 'product sans', 'amazon ember', '\\bember\\b', 'polaris', 'basel', 'maison neue',
    'neue montreal', 'pp neue', 'founders', 'work sans', 'dm sans', 'open sans', 'source sans',
    'ibm plex sans', 'fira', 'droid sans', 'noto sans', 'dejavu sans', 'liberation sans', 'nimbus sans',
    'comic'
  ];

  const AI_RE = new RegExp(AI_SERIF.join('|'), 'i');
  const SERIF_RE = new RegExp(OTHER_SERIF.join('|'), 'i');
  const KEEP_RE = new RegExp(KEEP.join('|'), 'i');
  const NONE = Object.freeze({ serif: false, family: null, ai: false });

  function splitFamilies(str) {
    return str.split(',')
      .map(s => s.trim().replace(/^["']|["']$/g, '').trim())
      .filter(Boolean);
  }

  const cache = new Map();
  let ownSerialized = '';

  function classify(computed) {
    if (!computed) return NONE;
    const key = settings.mode + '|' + computed;
    const hit = cache.get(key);
    if (hit) return hit;
    let result = NONE;
    if (computed !== ownSerialized) {
      for (const fam of splitFamilies(computed)) {
        const lower = fam.toLowerCase();
        if (GENERIC_KEEP.has(lower)) break;
        if (GENERIC_SERIF.has(lower)) {
          if (settings.mode === 'all') result = { serif: true, family: fam === 'ui-serif' ? 'ui-serif (system serif)' : 'serif (browser default)', ai: false };
          break;
        }
        if (PRE_KEEP.test(lower)) break;
        if (AI_RE.test(lower)) { result = { serif: true, family: fam, ai: true }; break; }
        if (settings.mode === 'all' && SERIF_RE.test(lower)) { result = { serif: true, family: fam, ai: false }; break; }
        if (KEEP_RE.test(lower)) break;
        // Unknown family: look at the next fallback.
      }
    }
    cache.set(key, result);
    return result;
  }

  function hasPseudoContent(content) {
    return content && content !== 'none' && content !== 'normal';
  }

  function decide(el) {
    const cs = getComputedStyle(el);
    const main = classify(cs.fontFamily);
    let before = NONE, after = NONE;
    const b = getComputedStyle(el, '::before');
    if (hasPseudoContent(b.content)) before = classify(b.fontFamily);
    const a = getComputedStyle(el, '::after');
    if (hasPseudoContent(a.content)) after = classify(a.fontFamily);
    return { main, before, after };
  }

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  let settings = Object.assign({}, DEFAULTS);
  let active = false;   // replacing right now (enabled + host allowed)
  let started = false;  // DOM ready, observer running
  let sheet = null;     // constructable stylesheet, null when unsupported
  const styleEls = [];  // fallback <style> elements
  const observedRoots = new WeakSet();
  const familyCounts = new Map(); // family -> element count
  const familyIsAI = new Map();   // family -> boolean
  let elFamilies = new WeakMap(); // element -> [families counted for it]
  const inlineFixed = new Map();  // element -> original inline {value, priority}
  let lastFullScan = 0;
  let scanTimer = 0;
  let statsTimer = 0;

  function computeActive() {
    const host = location.hostname;
    active = !!settings.enabled && !(settings.disabledHosts || []).includes(host);
  }

  function computeOwnSerialized() {
    const probe = document.createElement('div');
    probe.style.setProperty('font-family', settings.stack, 'important');
    ownSerialized = probe.style.getPropertyValue('font-family');
  }

  /* ------------------------------------------------------------------ */
  /* Stylesheet                                                          */
  /* ------------------------------------------------------------------ */

  function cssText() {
    const stack = settings.stack;
    let css = `[${ATTR}]${BOOST}{font-family:${stack} !important}` +
      `[${ATTR_B}]${BOOST}::before{font-family:${stack} !important}` +
      `[${ATTR_A}]${BOOST}::after{font-family:${stack} !important}`;
    if (settings.deitalic) {
      const H = ':is(h1,h2,h3,h4)';
      css += `${H}[${ATTR}]${BOOST},${H}[${ATTR}]${BOOST} *,${H} [${ATTR}]${BOOST},${H} [${ATTR}]${BOOST} *{font-style:normal !important}`;
    }
    return css;
  }

  function ensureSheet() {
    if (sheet) return;
    try {
      const s = new CSSStyleSheet();
      s.replaceSync(cssText());
      sheet = s;
    } catch (e) { sheet = null; }
  }

  function adopt(root) {
    ensureSheet();
    if (sheet) {
      try {
        if (!root.adoptedStyleSheets.includes(sheet)) {
          root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
        }
        return;
      } catch (e) { /* fall through to <style> */ }
    }
    const existing = styleEls.find(s => s.getRootNode() === root);
    if (existing && existing.isConnected) return;
    const st = document.createElement('style');
    st.__deserif = true;
    st.textContent = cssText();
    const parent = root === document ? (document.head || document.documentElement) : root;
    if (!parent) return;
    parent.appendChild(st);
    if (st.sheet) st.sheet.disabled = !active;
    styleEls.push(st);
  }

  function setSheetEnabled(on) {
    if (sheet) sheet.disabled = !on;
    for (const st of styleEls) if (st.sheet) st.sheet.disabled = !on;
  }

  function updateSheetText() {
    const css = cssText();
    if (sheet) { try { sheet.replaceSync(css); } catch (e) { /* ignore */ } }
    for (const st of styleEls) st.textContent = css;
  }

  /* ------------------------------------------------------------------ */
  /* Traversal                                                           */
  /* ------------------------------------------------------------------ */

  function observeRoot(root) {
    if (!observer || observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root, OBS_OPTS);
  }

  function collect(root, out) {
    const list = root.querySelectorAll('*');
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (SKIP_TAGS.has(el.nodeName)) continue;
      out.push(el);
      if (el.shadowRoot) {
        adopt(el.shadowRoot);
        observeRoot(el.shadowRoot);
        collect(el.shadowRoot, out);
      }
    }
    return out;
  }

  function subtree(el) {
    const out = [];
    if (!SKIP_TAGS.has(el.nodeName)) out.push(el);
    if (el.shadowRoot) { adopt(el.shadowRoot); observeRoot(el.shadowRoot); collect(el.shadowRoot, out); }
    return collect(el, out);
  }

  /* ------------------------------------------------------------------ */
  /* Apply / strip                                                       */
  /* ------------------------------------------------------------------ */

  function countFamilies(el, fams) {
    const prev = elFamilies.get(el);
    if (prev) for (const f of prev) bump(f, -1);
    if (fams.length) { elFamilies.set(el, fams); for (const f of fams) bump(f, 1); }
    else if (prev) elFamilies.delete(el);
  }

  function bump(f, n) {
    const v = (familyCounts.get(f) || 0) + n;
    if (v > 0) familyCounts.set(f, v); else familyCounts.delete(f);
  }

  function isOurInline(el) {
    return el.style.getPropertyPriority('font-family') === 'important' &&
      el.style.getPropertyValue('font-family') === ownSerialized;
  }

  function needsInlineFix(el) {
    // Only an inline `font-family: X !important` can beat our stylesheet rule.
    return el.style && el.style.getPropertyPriority('font-family') === 'important' && !isOurInline(el);
  }

  function fixInline(el) {
    if (!inlineFixed.has(el)) {
      inlineFixed.set(el, {
        value: el.style.getPropertyValue('font-family'),
        priority: el.style.getPropertyPriority('font-family')
      });
    }
    el.style.setProperty('font-family', settings.stack, 'important');
  }

  function restoreInline(el) {
    const orig = inlineFixed.get(el);
    if (!orig) return;
    inlineFixed.delete(el);
    el.style.removeProperty('font-family');
    if (orig.value) el.style.setProperty('font-family', orig.value, orig.priority);
  }

  function apply(el, d) {
    const fams = [];
    if (d.main.serif) {
      el.setAttribute(ATTR, '');
      if (needsInlineFix(el)) fixInline(el);
      fams.push(d.main.family);
      familyIsAI.set(d.main.family, d.main.ai);
    } else {
      if (el.hasAttribute(ATTR)) el.removeAttribute(ATTR);
      if (inlineFixed.has(el)) restoreInline(el);
    }
    if (d.before.serif) { el.setAttribute(ATTR_B, ''); fams.push(d.before.family); familyIsAI.set(d.before.family, d.before.ai); }
    else if (el.hasAttribute(ATTR_B)) el.removeAttribute(ATTR_B);
    if (d.after.serif) { el.setAttribute(ATTR_A, ''); fams.push(d.after.family); familyIsAI.set(d.after.family, d.after.ai); }
    else if (el.hasAttribute(ATTR_A)) el.removeAttribute(ATTR_A);
    countFamilies(el, fams);
  }

  function strip(el) {
    if (el.hasAttribute(ATTR)) el.removeAttribute(ATTR);
    if (el.hasAttribute(ATTR_B)) el.removeAttribute(ATTR_B);
    if (el.hasAttribute(ATTR_A)) el.removeAttribute(ATTR_A);
    if (inlineFixed.has(el)) restoreInline(el);
  }

  function forget(el) {
    // Element left the DOM: drop it from the stats.
    if (elFamilies.has(el)) countFamilies(el, []);
    inlineFixed.delete(el);
    const tagged = el.querySelectorAll(`[${ATTR}],[${ATTR_B}],[${ATTR_A}]`);
    for (let i = 0; i < tagged.length; i++) {
      if (elFamilies.has(tagged[i])) countFamilies(tagged[i], []);
      inlineFixed.delete(tagged[i]);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Scans                                                               */
  /* ------------------------------------------------------------------ */

  function fullScan() {
    if (!started || !active) return;
    lastFullScan = performance.now();
    adopt(document);
    const els = collect(document, []);
    // Switch our rules off so computed values reflect the page's own CSS.
    setSheetEnabled(false);
    for (const el of Array.from(inlineFixed.keys())) restoreInline(el);
    const decisions = new Array(els.length);
    for (let i = 0; i < els.length; i++) decisions[i] = decide(els[i]);
    familyCounts.clear();
    elFamilies = new WeakMap();
    for (let i = 0; i < els.length; i++) apply(els[i], decisions[i]);
    setSheetEnabled(true);
    queueStats();
  }

  function scheduleFullScan(delay) {
    if (scanTimer) return;
    const since = performance.now() - lastFullScan;
    const wait = Math.max(delay == null ? 250 : delay, FULL_SCAN_MIN_GAP - since);
    scanTimer = setTimeout(() => { scanTimer = 0; fullScan(); }, Math.max(0, wait));
  }

  function incrementalScan(roots, singles) {
    // Drop roots nested inside other roots in the same batch.
    const rootList = Array.from(new Set(roots)).filter(r => r.isConnected);
    if (rootList.length > 300) { scheduleFullScan(0); return; }
    const tops = rootList.filter(r => !rootList.some(o => o !== r && o.contains(r)));
    const els = [];
    for (const r of tops) subtree(r).forEach(e => els.push(e));
    for (const s of singles) {
      if (!s.isConnected || SKIP_TAGS.has(s.nodeName)) continue;
      if (!tops.some(t => t.contains(s))) els.push(s);
    }
    if (!els.length) return;
    if (els.length > MAX_INCREMENTAL) { scheduleFullScan(0); return; }
    for (const el of els) strip(el);                 // writes
    const decisions = els.map(decide);               // reads (one recalc)
    for (let i = 0; i < els.length; i++) apply(els[i], decisions[i]); // writes
    queueStats();
  }

  function detectOnly() {
    // Used while the extension is off for this site: report, touch nothing.
    const counts = new Map(); const ai = new Map();
    const wasOn = sheet ? !sheet.disabled : false;
    setSheetEnabled(false);
    for (const el of collect(document, [])) {
      const d = decide(el);
      for (const r of [d.main, d.before, d.after]) {
        if (!r.serif) continue;
        counts.set(r.family, (counts.get(r.family) || 0) + 1);
        ai.set(r.family, r.ai);
      }
    }
    setSheetEnabled(wasOn);
    return { counts, ai };
  }

  function deactivate() {
    setSheetEnabled(false);
    for (const el of Array.from(inlineFixed.keys())) restoreInline(el);
    const roots = [document];
    const tagged = [];
    // Tagged elements inside shadow roots are reached via the document walk.
    for (const el of collect(document, [])) {
      if (el.hasAttribute(ATTR) || el.hasAttribute(ATTR_B) || el.hasAttribute(ATTR_A)) tagged.push(el);
    }
    for (const el of tagged) strip(el);
    familyCounts.clear();
    elFamilies = new WeakMap();
    void roots;
    queueStats();
  }

  /* ------------------------------------------------------------------ */
  /* Mutation handling                                                   */
  /* ------------------------------------------------------------------ */

  const OBS_OPTS = { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'data-theme'] };
  let observer = null;

  function isStylesheetNode(n) {
    return n.nodeName === 'STYLE' || (n.nodeName === 'LINK' && /\bstylesheet\b/i.test(n.rel || ''));
  }

  function onMutations(records) {
    if (!started) return;
    if (!api.alive()) { api.retire(); return; }   // orphaned by an extension reload
    let sheetsTouched = false;
    const roots = [];
    const singles = [];
    for (const r of records) {
      if (r.type === 'childList') {
        if (r.target.nodeName === 'STYLE') sheetsTouched = true;
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1 || n.__deserif) continue;
          if (isStylesheetNode(n)) {
            sheetsTouched = true;
            if (n.nodeName === 'LINK') n.addEventListener('load', () => scheduleFullScan(0), { once: true });
            continue;
          }
          if (SKIP_TAGS.has(n.nodeName)) continue;
          roots.push(n);
        }
        for (const n of r.removedNodes) if (n.nodeType === 1 && !n.__deserif) forget(n);
      } else {
        const el = r.target;
        if (r.attributeName === 'style') {
          if (inlineFixed.has(el)) { if (!isOurInline(el)) singles.push(el); }
          else if (el.hasAttribute(ATTR) || (el.style && el.style.getPropertyValue('font-family'))) singles.push(el);
        } else {
          roots.push(el); // class / data-theme can restyle the whole subtree
        }
      }
    }
    if (sheetsTouched) scheduleFullScan();
    if (!active) return;
    if (roots.length || singles.length) incrementalScan(roots, singles);
  }

  /* ------------------------------------------------------------------ */
  /* Stats + messaging                                                   */
  /* ------------------------------------------------------------------ */

  function familiesPayload(counts, aiMap) {
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count, ai: !!aiMap.get(name) }))
      .sort((a, b) => b.count - a.count);
  }

  function statsPayload() {
    const detected = active ? { counts: familyCounts, ai: familyIsAI } : detectOnly();
    return {
      host: location.hostname,
      active,
      enabled: !!settings.enabled,
      ready: started,
      families: familiesPayload(detected.counts, detected.ai)
    };
  }

  function queueStats() {
    if (window !== window.top) return;
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = 0;
      try {
        chrome.runtime.sendMessage({ type: 'stats', active, families: familyCounts.size }).catch(() => {});
      } catch (e) { /* extension reloaded; nothing to do */ }
    }, 200);
  }

  function loadSettings() {
    return new Promise(resolve => {
      try {
        chrome.storage.sync.get(DEFAULTS, items => resolve(Object.assign({}, DEFAULTS, items || {})));
      } catch (e) { resolve(Object.assign({}, DEFAULTS)); }
    });
  }

  function applySettings(next) {
    const prevStack = settings.stack;
    const prevMode = settings.mode;
    const prevDeitalic = settings.deitalic;
    const wasActive = active;
    settings = Object.assign({}, DEFAULTS, next);
    computeActive();
    if (settings.stack !== prevStack) { computeOwnSerialized(); cache.clear(); }
    if (settings.mode !== prevMode) cache.clear();
    if (settings.stack !== prevStack || settings.deitalic !== prevDeitalic) updateSheetText();
    if (!started) return;
    if (!active) { if (wasActive) deactivate(); return; }
    fullScan();
  }

  function onMessage(msg, sender, sendResponse) {
    if (!msg || window !== window.top) return;
    if (msg.type === 'getStats') {
      sendResponse(statsPayload());
    } else if (msg.type === 'refresh') {
      loadSettings().then(s => { applySettings(s); sendResponse(statsPayload()); });
      return true;
    }
  }
  chrome.runtime.onMessage.addListener(onMessage);

  function onStorage(changes, area) {
    if (area !== 'sync') return;
    const next = Object.assign({}, settings);
    for (const k of Object.keys(changes)) next[k] = changes[k].newValue;
    applySettings(next);
  }
  chrome.storage.onChanged.addListener(onStorage);

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  function waitForStylesheets() {
    const pending = Array.from(document.querySelectorAll('link[rel~="stylesheet"]'))
      .filter(l => !l.sheet && !l.disabled && (!l.media || matchMedia(l.media).matches));
    if (!pending.length) return Promise.resolve();
    return new Promise(resolve => {
      let left = pending.length;
      const done = () => { if (--left <= 0) resolve(); };
      for (const l of pending) {
        l.addEventListener('load', done, { once: true });
        l.addEventListener('error', done, { once: true });
      }
      setTimeout(resolve, 1500);
    });
  }

  function whenReady() {
    return new Promise(resolve => {
      const go = () => waitForStylesheets().then(resolve);
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
      else go();
    });
  }

  async function boot() {
    settings = await loadSettings();
    computeActive();
    computeOwnSerialized();
    ensureSheet();
    await whenReady();
    started = true;
    observer = new MutationObserver(onMutations);
    observeRoot(document);
    adopt(document);
    setSheetEnabled(active);
    if (active) fullScan();
    window.addEventListener('load', () => scheduleFullScan(0), { once: true });
    if (document.fonts) {
      document.fonts.addEventListener('loadingdone', () => scheduleFullScan());
      document.fonts.ready.then(() => scheduleFullScan()).catch(() => {});
    }
  }

  boot();
})();
